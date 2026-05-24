import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"
import type { TaskNode, MemoryEntry, MemoryLayerKind } from "../dag/types"

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

  constructor(conductorDir: string, runId: string) {
    mkdirSync(conductorDir, { recursive: true })
    this.db = new Database(join(conductorDir, "conductor.db"))
    this.db.exec(
      "PRAGMA journal_mode=WAL;\n" +
      "PRAGMA synchronous=NORMAL;\n" +
      "PRAGMA busy_timeout=5000;\n" +   // wait up to 5s instead of failing immediately on lock
      SCHEMA
    )
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
        created_at,started_at,completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      task.id, this.runId, task.type, task.title, task.status,
      task.priority, task.role, task.prompt,
      JSON.stringify(task.scope), JSON.stringify(task.dependsOn),
      task.assignedTo ?? null,
      task.output ? JSON.stringify(task.output) : null,
      task.error ?? null,
      task.retryCount, task.maxRetries, task.forkContext ? 1 : 0,
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

  getContext(tags: string[]): MemoryEntry[] {
    return this.readMemory("context", tags)
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

  private closed = false

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}
