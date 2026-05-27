import { Database } from "bun:sqlite"
import { join } from "path"
import { mkdirSync } from "fs"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GoalRecord {
  id:        string
  text:      string
  project:   string
  createdAt: number
}

export interface RunMetaRecord {
  id:           string
  goalId:       string
  goalText?:    string
  project:      string
  agents:       number
  status:       "running" | "completed" | "failed" | "interrupted"
  createdAt:    number
  finishedAt:   number | null
  tokenTotal:   number
  costUsd:      number
  conductorDir: string | null
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS goals (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  project    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_project ON goals(project, created_at DESC);

CREATE TABLE IF NOT EXISTS run_meta (
  id            TEXT PRIMARY KEY,
  goal_id       TEXT NOT NULL REFERENCES goals(id),
  project       TEXT NOT NULL,
  agents        INTEGER NOT NULL DEFAULT 3,
  status        TEXT NOT NULL DEFAULT 'running',
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  token_total   INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0,
  conductor_dir TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_meta_goal   ON run_meta(goal_id);
CREATE INDEX IF NOT EXISTS idx_run_meta_project ON run_meta(project, created_at DESC);
`

// ─── GoalStore ────────────────────────────────────────────────────────────────

export class GoalStore {
  private db: Database

  constructor(conductorDir: string) {
    mkdirSync(conductorDir, { recursive: true })
    this.db = new Database(join(conductorDir, "goals.db"))
    this.db.exec(SCHEMA)
    // Migrate existing databases that predate the conductor_dir column
    try {
      this.db.exec(`ALTER TABLE run_meta ADD COLUMN conductor_dir TEXT`)
    } catch { /* column already exists — ignore */ }
  }

  /** Create a new goal, returning its id. */
  createGoal(text: string, project: string): string {
    const id = this.nanoid()
    this.db.prepare(
      `INSERT INTO goals (id, text, project, created_at) VALUES (?, ?, ?, ?)`
    ).run(id, text.trim(), project, Date.now())
    return id
  }

  /** Return most recent goals for a project. */
  listGoals(project: string, limit = 20): GoalRecord[] {
    return (this.db.prepare(
      `SELECT id, text, project, created_at FROM goals WHERE project=? ORDER BY created_at DESC LIMIT ?`
    ).all(project, limit) as Record<string, unknown>[]).map(r => ({
      id:        r["id"] as string,
      text:      r["text"] as string,
      project:   r["project"] as string,
      createdAt: r["created_at"] as number,
    }))
  }

  /** Insert or update a run record. */
  upsertRunMeta(runId: string, goalId: string, project: string, agents: number, conductorDir: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO run_meta (id, goal_id, project, agents, status, created_at, conductor_dir)
       VALUES ($id, $goalId, $project, $agents, 'running', $now, $dir)`
    ).run({ $id: runId, $goalId: goalId, $project: project, $agents: agents, $now: Date.now(), $dir: conductorDir })
  }

  /** Mark a run as finished with final stats. */
  finishRunMeta(runId: string, status: string, tokenTotal: number, costUsd: number): void {
    this.db.prepare(
      `UPDATE run_meta SET status=$status, finished_at=$now, token_total=$tok, cost_usd=$cost WHERE id=$id`
    ).run({ $status: status, $now: Date.now(), $tok: tokenTotal, $cost: costUsd, $id: runId })
  }

  /** List runs, optionally filtered by goalId, joined with goal text. */
  listRunMeta(project?: string, goalId?: string, limit = 50): RunMetaRecord[] {
    let sql = `SELECT r.*, g.text as goal_text
               FROM run_meta r JOIN goals g ON r.goal_id = g.id`
    const params: unknown[] = []
    const where: string[] = []
    if (project) { where.push("r.project=?"); params.push(project) }
    if (goalId)  { where.push("r.goal_id=?");  params.push(goalId) }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`
    sql += ` ORDER BY r.created_at DESC LIMIT ?`
    params.push(limit)

    return (this.db.prepare(sql).all(...(params as import("bun:sqlite").SQLQueryBindings[])) as Record<string, unknown>[]).map(r => ({
      id:           r["id"] as string,
      goalId:       r["goal_id"] as string,
      goalText:     r["goal_text"] as string | undefined,
      project:      r["project"] as string,
      agents:       r["agents"] as number,
      status:       r["status"] as RunMetaRecord["status"],
      createdAt:    r["created_at"] as number,
      finishedAt:   r["finished_at"] as number | null,
      tokenTotal:   r["token_total"] as number,
      costUsd:      r["cost_usd"] as number,
      conductorDir: r["conductor_dir"] as string | null,
    }))
  }

  /** On server startup, mark any rows still 'running' as 'interrupted' (stale from crashed session). */
  reconcileStaleRuns(): number {
    const result = this.db.prepare(
      `UPDATE run_meta SET status='interrupted', finished_at=$now WHERE status='running'`
    ).run({ $now: Date.now() })
    return result.changes
  }

  /** Return a single run by id (for replay). */
  getRunMeta(runId: string): RunMetaRecord | null {
    const sql = `SELECT r.*, g.text as goal_text
                 FROM run_meta r JOIN goals g ON r.goal_id = g.id
                 WHERE r.id = $id`
    const r = this.db.prepare(sql).get({ $id: runId }) as Record<string, unknown> | null
    if (!r) return null
    return {
      id:           r["id"] as string,
      goalId:       r["goal_id"] as string,
      goalText:     r["goal_text"] as string | undefined,
      project:      r["project"] as string,
      agents:       r["agents"] as number,
      status:       r["status"] as RunMetaRecord["status"],
      createdAt:    r["created_at"] as number,
      finishedAt:   r["finished_at"] as number | null,
      tokenTotal:   r["token_total"] as number,
      costUsd:      r["cost_usd"] as number,
      conductorDir: r["conductor_dir"] as string | null,
    }
  }

  close(): void { this.db.close() }

  private nanoid(len = 8): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    let id = ""
    for (let i = 0; i < len; i++) id += chars[Math.floor(Math.random() * chars.length)]
    return id
  }
}
