import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"
import type { TaskNode, MemoryEntry, MemoryLayerKind, Artifact, ArtifactKind, ArtifactRef, ConductorEvent } from "../dag/types"

// ─── ConductorStore (SQLite via bun:sqlite) ───────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  project     TEXT NOT NULL,
  phase       INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'running',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  type          TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  priority      INTEGER NOT NULL,
  role          TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  scope         TEXT NOT NULL,
  depends_on    TEXT NOT NULL,
  assigned_to   TEXT,
  output        TEXT,
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  max_retries   INTEGER NOT NULL DEFAULT 2,
  fork_context  INTEGER NOT NULL DEFAULT 0,
  token_usage   TEXT,            -- JSON {inputTokens,outputTokens,cacheHitTokens,cacheMissTokens}
  input_artifact_ids TEXT,        -- JSON string[] of upstream artifact IDs to inline (data-flow)
  input_from_deps    INTEGER NOT NULL DEFAULT 0,  -- inline all dependency artifacts at dispatch
  dataflow           INTEGER NOT NULL DEFAULT 0,  -- explicit data-flow node: skip code-edit heuristics
  executor_kind      TEXT,           -- routing hint: which executor backend runs this task
  failure_policy     TEXT,           -- fan-in failure handling: "tolerate" | "all"
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_run    ON tasks(run_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(run_id, status);

CREATE TABLE IF NOT EXISTS memory (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  layer      TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT NOT NULL,
  timestamp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_run_layer ON memory(run_id, layer);

-- Tag lookup table: O(1) per tag instead of LIKE scan on JSON column
CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id  TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  layer      TEXT NOT NULL,
  tag        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_tags_lookup ON memory_tags(run_id, layer, tag);

CREATE TABLE IF NOT EXISTS event_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  timestamp  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON event_log(run_id);

-- Persistent restart counter so CrashRecovery survives conductor restarts.
-- Keyed by (run_id, agent_id) — reset when a new run starts.
CREATE TABLE IF NOT EXISTS agent_restarts (
  run_id    TEXT NOT NULL,
  agent_id  TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, agent_id)
);

-- Typed, full-fidelity task results (data-flow). Unlike memory.context, the
-- content here is NEVER truncated — downstream tasks consume complete data.
CREATE TABLE IF NOT EXISTS artifacts (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  label       TEXT,
  content     TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  source_artifact_ids TEXT,   -- JSON string[]: lineage (artifacts fed into the producing task)
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run  ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(run_id, task_id);
`

export interface RunRecord {
  id: string
  project: string
  phase: number
  status: "running" | "completed" | "failed" | "interrupted"
  createdAt: number
  updatedAt: number
}

export class ConductorStore {
  private db: Database
  private runId: string

  constructor(conductorDir: string, runId: string, busyTimeoutMs = 5_000) {
    mkdirSync(conductorDir, { recursive: true })
    this.db = new Database(join(conductorDir, "conductor.db"))
    this.db.exec(
      "PRAGMA journal_mode=WAL;\n" +
      "PRAGMA synchronous=NORMAL;\n" +
      `PRAGMA busy_timeout=${busyTimeoutMs};\n` +   // wait instead of failing immediately on lock
      SCHEMA
    )
    // Migrate DBs created before the input_artifact_ids column existed.
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN input_artifact_ids TEXT`) }
    catch { /* column already present */ }
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN input_from_deps INTEGER NOT NULL DEFAULT 0`) }
    catch { /* column already present */ }
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN dataflow INTEGER NOT NULL DEFAULT 0`) }
    catch { /* column already present */ }
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN executor_kind TEXT`) }
    catch { /* column already present */ }
    try { this.db.exec(`ALTER TABLE tasks ADD COLUMN failure_policy TEXT`) }
    catch { /* column already present */ }
    // artifacts table predates the lineage column in older DBs — migrate it too.
    try { this.db.exec(`ALTER TABLE artifacts ADD COLUMN source_artifact_ids TEXT`) }
    catch { /* column already present (or table created fresh with it) */ }
    this.runId = runId
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  initRun(project: string, phase = 0): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO runs (id,project,phase,status,created_at,updated_at) VALUES (?,?,?,'running',?,?)`
    ).run(this.runId, project, phase, Date.now(), Date.now())
  }

  updateRunPhase(phase: number): void {
    this.db.prepare(`UPDATE runs SET phase=?,updated_at=? WHERE id=?`)
      .run(phase, Date.now(), this.runId)
  }

  updateRunStatus(status: RunRecord["status"]): void {
    this.db.prepare(`UPDATE runs SET status=?,updated_at=? WHERE id=?`)
      .run(status, Date.now(), this.runId)
  }

  getRun(): RunRecord | null {
    const r = this.db.prepare(`SELECT * FROM runs WHERE id=?`).get(this.runId) as Record<string,unknown> | null
    if (!r) return null
    return { id: r["id"] as string, project: r["project"] as string, phase: r["phase"] as number,
             status: r["status"] as RunRecord["status"], createdAt: r["created_at"] as number, updatedAt: r["updated_at"] as number }
  }

  listRuns(project: string): RunRecord[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE project=? ORDER BY created_at DESC`).all(project) as Record<string,unknown>[])
      .map(r => ({ id: r["id"] as string, project: r["project"] as string, phase: r["phase"] as number,
                   status: r["status"] as RunRecord["status"], createdAt: r["created_at"] as number, updatedAt: r["updated_at"] as number }))
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  upsertTask(task: TaskNode): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO tasks
       (id,run_id,type,title,status,priority,role,prompt,scope,depends_on,
        assigned_to,output,error,retry_count,max_retries,fork_context,
        token_usage,input_artifact_ids,input_from_deps,dataflow,executor_kind,failure_policy,created_at,started_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      task.id, this.runId, task.type, task.title, task.status,
      task.priority, task.role, task.prompt,
      JSON.stringify(task.scope), JSON.stringify(task.dependsOn),
      task.assignedTo ?? null,
      task.output ? JSON.stringify(task.output) : null,
      task.error ?? null,
      task.retryCount, task.maxRetries, task.forkContext ? 1 : 0,
      task.tokenUsage ? JSON.stringify(task.tokenUsage) : null,
      task.inputArtifactIds && task.inputArtifactIds.length > 0 ? JSON.stringify(task.inputArtifactIds) : null,
      task.inputFromDeps ? 1 : 0,
      task.dataflow ? 1 : 0,
      task.executorKind ?? null,
      task.failurePolicy ?? null,
      task.createdAt, task.startedAt ?? null, task.completedAt ?? null,
    )
  }

  loadTasks(): TaskNode[] {
    return (this.db.prepare(`SELECT * FROM tasks WHERE run_id=?`).all(this.runId) as Record<string,unknown>[])
      .map(r => ({
        id: r["id"] as string,
        type: r["type"] as TaskNode["type"],
        title: r["title"] as string,
        status: r["status"] as TaskNode["status"],
        priority: r["priority"] as number,
        role: r["role"] as TaskNode["role"],
        prompt: r["prompt"] as string,
        scope: JSON.parse(r["scope"] as string) as string[],
        dependsOn: JSON.parse(r["depends_on"] as string) as string[],
        blocks: [] as string[],
        assignedTo: r["assigned_to"] as string | null,
        output: r["output"] ? JSON.parse(r["output"] as string) : null,
        error: r["error"] as string | null,
        retryCount: r["retry_count"] as number,
        maxRetries: r["max_retries"] as number,
        forkContext: (r["fork_context"] as number) === 1,
        tokenUsage: r["token_usage"] ? JSON.parse(r["token_usage"] as string) : null,
        inputArtifactIds: r["input_artifact_ids"] ? JSON.parse(r["input_artifact_ids"] as string) as string[] : undefined,
        inputFromDeps: (r["input_from_deps"] as number) === 1 ? true : undefined,
        dataflow: (r["dataflow"] as number) === 1 ? true : undefined,
        executorKind: (r["executor_kind"] as string | null) ?? undefined,
        failurePolicy: (r["failure_policy"] as "tolerate" | "all" | null) ?? undefined,
        createdAt: r["created_at"] as number,
        startedAt: r["started_at"] as number | null,
        completedAt: r["completed_at"] as number | null,
      }))
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  writeMemory(entry: Omit<MemoryEntry, "id" | "timestamp">): MemoryEntry {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const timestamp = Date.now()
    this.db.prepare(
      `INSERT INTO memory (id,run_id,layer,agent_id,task_id,content,tags,timestamp) VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, this.runId, entry.layer, entry.agentId, entry.taskId, entry.content, JSON.stringify(entry.tags), timestamp)
    // Populate the tag lookup table for O(1) indexed queries
    for (const tag of entry.tags) {
      this.db.prepare(
        `INSERT INTO memory_tags (memory_id,run_id,layer,tag) VALUES (?,?,?,?)`
      ).run(id, this.runId, entry.layer, tag)
    }
    return { ...entry, id, timestamp }
  }

  readMemory(layer: MemoryLayerKind, tags?: string[]): MemoryEntry[] {
    let rows: Record<string,unknown>[]
    if (tags && tags.length > 0) {
      // Use indexed join instead of LIKE on JSON column
      const placeholders = tags.map(() => "?").join(",")
      rows = this.db.prepare(
        `SELECT DISTINCT m.* FROM memory m
         JOIN memory_tags t ON t.memory_id = m.id
         WHERE m.run_id=? AND m.layer=? AND t.tag IN (${placeholders})
         ORDER BY m.timestamp ASC`
      ).all(this.runId, layer, ...tags) as Record<string,unknown>[]
    } else {
      rows = this.db.prepare(
        `SELECT * FROM memory WHERE run_id=? AND layer=? ORDER BY timestamp ASC`
      ).all(this.runId, layer) as Record<string,unknown>[]
    }
    return rows.map(r => ({
      id: r["id"] as string,
      layer: r["layer"] as MemoryLayerKind,
      agentId: r["agent_id"] as string,
      taskId: r["task_id"] as string,
      content: r["content"] as string,
      tags: JSON.parse(r["tags"] as string) as string[],
      timestamp: r["timestamp"] as number,
    }))
  }

  getProjectMap(): MemoryEntry | null {
    const all = this.readMemory("project_map")
    return all[all.length - 1] ?? null
  }

  getContext(taskScope: string[]): MemoryEntry[] {
    if (taskScope.length === 0) {
      // scope=[] tasks (explore/plan/review/verify) can see all run context
      return this.readMemory("context")
    }
    // Exact tag match first — uses the index and covers the common case
    const exact = this.readMemory("context", taskScope)
    if (exact.length > 0) return exact
    // Fallback: prefix/ancestor match in application layer.
    // Context entry count is small (<100 per run), so a full scan is fine.
    const all = this.readMemory("context")
    return all.filter(entry =>
      entry.tags.some(tag =>
        taskScope.some(s =>
          tag === s || tag.startsWith(s + "/") || s.startsWith(tag + "/")
        )
      )
    )
  }

  // ── Artifacts (full-fidelity data-flow results) ───────────────────────────

  /** Persist an artifact and return its ref. Content is stored verbatim — no
   *  truncation — so downstream tasks receive complete data. */
  writeArtifact(input: { taskId: string; kind: ArtifactKind; label?: string | null; content: string; sourceArtifactIds?: string[] }): ArtifactRef {
    const id = `art-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const byteSize = Buffer.byteLength(input.content, "utf8")
    const sources = input.sourceArtifactIds && input.sourceArtifactIds.length > 0
      ? JSON.stringify(input.sourceArtifactIds) : null
    this.db.prepare(
      `INSERT INTO artifacts (id,run_id,task_id,kind,label,content,byte_size,source_artifact_ids,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(id, this.runId, input.taskId, input.kind, input.label ?? null, input.content, byteSize, sources, Date.now())
    return { id, kind: input.kind, label: input.label ?? null, byteSize }
  }

  getArtifact(id: string): Artifact | null {
    const r = this.db.prepare(`SELECT * FROM artifacts WHERE id=? AND run_id=?`)
      .get(id, this.runId) as Record<string, unknown> | null
    if (!r) return null
    return {
      id: r["id"] as string,
      taskId: r["task_id"] as string,
      kind: r["kind"] as ArtifactKind,
      label: (r["label"] as string | null) ?? null,
      content: r["content"] as string,
      byteSize: r["byte_size"] as number,
      sourceArtifactIds: r["source_artifact_ids"] ? JSON.parse(r["source_artifact_ids"] as string) as string[] : undefined,
      createdAt: r["created_at"] as number,
    }
  }

  getArtifactsByTask(taskId: string): Artifact[] {
    return (this.db.prepare(`SELECT * FROM artifacts WHERE run_id=? AND task_id=? ORDER BY created_at ASC`)
      .all(this.runId, taskId) as Record<string, unknown>[]).map(r => ({
        id: r["id"] as string,
        taskId: r["task_id"] as string,
        kind: r["kind"] as ArtifactKind,
        label: (r["label"] as string | null) ?? null,
        content: r["content"] as string,
        byteSize: r["byte_size"] as number,
        sourceArtifactIds: r["source_artifact_ids"] ? JSON.parse(r["source_artifact_ids"] as string) as string[] : undefined,
        createdAt: r["created_at"] as number,
      }))
  }

  // ── Event log ──────────────────────────────────────────────────────────────

  logEvent(agentId: string, taskId: string, kind: string, payload: Record<string,unknown>): void {
    this.db.prepare(
      `INSERT INTO event_log (run_id,agent_id,task_id,kind,payload,timestamp) VALUES (?,?,?,?,?,?)`
    ).run(this.runId, agentId, taskId, kind, JSON.stringify(payload), Date.now())
  }

  getRecentEvents(n = 100): Array<{id:number,agentId:string,taskId:string,kind:string,payload:Record<string,unknown>,timestamp:number}> {
    return (this.db.prepare(
      `SELECT * FROM event_log WHERE run_id=? ORDER BY id DESC LIMIT ?`
    ).all(this.runId, n) as Record<string,unknown>[]).reverse().map(r => ({
      id: r["id"] as number,
      agentId: r["agent_id"] as string,
      taskId: r["task_id"] as string,
      kind: r["kind"] as string,
      payload: JSON.parse(r["payload"] as string) as Record<string,unknown>,
      timestamp: r["timestamp"] as number,
    }))
  }

  /** Persist a full ConductorEvent to event_log. Called by Conductor.emit()
   *  so every broadcast is also durable. Errors are best-effort — closed DB
   *  during shutdown is silently ignored; anything else is logged. */
  logConductorEvent(event: ConductorEvent, agentId = "_conductor", taskId = "_"): void {
    try {
      this.db.prepare(
        `INSERT INTO event_log (run_id,agent_id,task_id,kind,payload,timestamp) VALUES (?,?,?,?,?,?)`
      ).run(this.runId, agentId, taskId, event.kind, JSON.stringify(event.payload), event.timestamp)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("closed database")) console.error(`[store] logConductorEvent failed: ${msg}`)
    }
  }

  /** Return all events for this run in chronological order. Supports cursor-
   *  based pagination: pass `sinceSeq` (the last seen event `id`) to get only
   *  newer events; pass `limit` to cap the page size (default unlimited). */
  getRunTrace(opts?: { sinceSeq?: number; limit?: number }): Array<{
    id: number; agentId: string; taskId: string; kind: string;
    payload: Record<string, unknown>; timestamp: number
  }> {
    const since = opts?.sinceSeq ?? 0
    const rows = opts?.limit !== undefined
      ? this.db.prepare(
          `SELECT * FROM event_log WHERE run_id=? AND id>? ORDER BY id ASC LIMIT ?`
        ).all(this.runId, since, opts.limit) as Record<string, unknown>[]
      : this.db.prepare(
          `SELECT * FROM event_log WHERE run_id=? AND id>? ORDER BY id ASC`
        ).all(this.runId, since) as Record<string, unknown>[]
    return rows.map(r => ({
      id: r["id"] as number,
      agentId: r["agent_id"] as string,
      taskId: r["task_id"] as string,
      kind: r["kind"] as string,
      payload: JSON.parse(r["payload"] as string) as Record<string, unknown>,
      timestamp: r["timestamp"] as number,
    }))
  }

  // ── Diagnostics (M3) ──────────────────────────────────────────────────────

  /** Recursively walk the artifact lineage tree rooted at `artifactId`.
   *  Returns a flat list of all ancestor artifacts in topological order
   *  (the root artifact is always last). Stops at depth 50 to guard against
   *  malformed circular references in old data. */
  getArtifactLineage(artifactId: string): Artifact[] {
    const visited = new Set<string>()
    const result: Artifact[] = []

    const walk = (id: string, depth: number) => {
      if (depth > 50 || visited.has(id)) return
      visited.add(id)
      const art = this.getArtifact(id)
      if (!art) return
      for (const srcId of art.sourceArtifactIds ?? []) walk(srcId, depth + 1)
      result.push(art)
    }
    walk(artifactId, 0)
    return result
  }

  /** Aggregate view of a run: task stats, token stats, failed-task list, and
   *  key events (crash / deadlock / approval). Used by the diagnose-run CLI and
   *  the /api/runs/{id}/summary HTTP endpoint. */
  getRunSummary(): {
    taskStats: ReturnType<ConductorStore["taskStats"]>
    tokenStats: ReturnType<ConductorStore["tokenStats"]>
    failedTasks: Array<{ id: string; title: string; error: string | null }>
    keyEvents: Array<{ kind: string; payload: Record<string, unknown>; timestamp: number }>
  } {
    const failedRows = this.db.prepare(
      `SELECT id, title, error FROM tasks WHERE run_id=? AND status='failed'`
    ).all(this.runId) as { id: string; title: string; error: string | null }[]

    const keyKinds = ["agent.crashed", "deadlock.detected", "approval.required", "approval.resolved", "run.completed", "run.failed"]
    const placeholders = keyKinds.map(() => "?").join(",")
    const eventRows = this.db.prepare(
      `SELECT kind, payload, timestamp FROM event_log WHERE run_id=? AND kind IN (${placeholders}) ORDER BY id ASC`
    ).all(this.runId, ...keyKinds) as { kind: string; payload: string; timestamp: number }[]

    return {
      taskStats: this.taskStats(),
      tokenStats: this.tokenStats(),
      failedTasks: failedRows,
      keyEvents: eventRows.map(r => ({
        kind: r.kind,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        timestamp: r.timestamp,
      })),
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  taskStats(): { total:number, done:number, failed:number, interrupted:number, avgDurationMs:number } {
    const s = this.db.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
              SUM(CASE WHEN status='interrupted' THEN 1 ELSE 0 END) as interrupted
       FROM tasks WHERE run_id=?`
    ).get(this.runId) as {total:number,done:number,failed:number,interrupted:number}

    const d = this.db.prepare(
      `SELECT AVG(completed_at - started_at) as avg_ms
       FROM tasks WHERE run_id=? AND status='done' AND started_at IS NOT NULL`
    ).get(this.runId) as {avg_ms:number|null}

    return { ...s, avgDurationMs: d.avg_ms ?? 0 }
  }

  tokenStats(): { inputTokens:number, outputTokens:number, cacheHitTokens:number, cacheMissTokens:number, totalTokens:number, cacheHitRate:number } {
    const rows = (this.db.prepare(
      `SELECT token_usage FROM tasks WHERE run_id=? AND token_usage IS NOT NULL`
    ).all(this.runId) as { token_usage: string }[])

    let input = 0, output = 0, hit = 0, miss = 0
    for (const r of rows) {
      const u = JSON.parse(r.token_usage) as { inputTokens:number, outputTokens:number, cacheHitTokens:number, cacheMissTokens:number }
      input  += u.inputTokens  ?? 0
      output += u.outputTokens ?? 0
      hit    += u.cacheHitTokens  ?? 0
      miss   += u.cacheMissTokens ?? 0
    }
    const total = input + output
    return {
      inputTokens:  input,
      outputTokens: output,
      cacheHitTokens:  hit,
      cacheMissTokens: miss,
      totalTokens: total,
      cacheHitRate: (input > 0) ? Math.round((hit / input) * 100) : 0,
    }
  }

  // ── Agent restart counters (persistent across conductor restarts) ─────────

  /** Increment the restart counter for an agent and return the new count. */
  incrementAgentRestarts(agentId: string): number {
    this.db.prepare(
      `INSERT INTO agent_restarts (run_id, agent_id, count) VALUES (?,?,1)
       ON CONFLICT(run_id, agent_id) DO UPDATE SET count = count + 1`
    ).run(this.runId, agentId)
    const row = this.db.prepare(
      `SELECT count FROM agent_restarts WHERE run_id=? AND agent_id=?`
    ).get(this.runId, agentId) as { count: number } | undefined
    return row?.count ?? 1
  }

  /** Read the current restart count for an agent (0 if never restarted). */
  getAgentRestarts(agentId: string): number {
    const row = this.db.prepare(
      `SELECT count FROM agent_restarts WHERE run_id=? AND agent_id=?`
    ).get(this.runId, agentId) as { count: number } | undefined
    return row?.count ?? 0
  }

  private closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
