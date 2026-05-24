import type { Database } from "bun:sqlite"

// ─── Database Migration System ────────────────────────────────────────────────
// Versioned, idempotent migrations for the Conductor SQLite store.
// Each migration receives the db handle and must be safe to re-run.

export interface Migration {
  version: number
  description: string
  up: (db: Database) => void
}

// ─── Schema version tracking ──────────────────────────────────────────────────

const VERSION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version   INTEGER NOT NULL,
  applied_at INTEGER NOT NULL
);
`

function ensureVersionTable(db: Database): void {
  db.exec(VERSION_TABLE_SQL)
}

function currentVersion(db: Database): number {
  ensureVersionTable(db)
  const row = db.prepare(
    `SELECT MAX(version) as version FROM schema_version`
  ).get() as { version: number | null } | null
  return row?.version ?? 0
}

function recordMigration(db: Database, version: number): void {
  db.prepare(
    `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`
  ).run(version, Date.now())
}

// ─── Migration definitions ────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema: runs, tasks, memory, memory_tags, event_log",
    up: (db: Database) => {
      db.exec(`
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
      `)
    },
  },
]

// ─── Runner ───────────────────────────────────────────────────────────────────

export function runMigrations(db: Database): void {
  ensureVersionTable(db)
  const current = currentVersion(db)

  for (const migration of MIGRATIONS) {
    if (migration.version > current) {
      migration.up(db)
      recordMigration(db, migration.version)
    }
  }

  // Apply PRAGMAs after migrations (safe to re-apply)
  db.exec(
    "PRAGMA journal_mode=WAL;\n" +
    "PRAGMA synchronous=NORMAL;\n" +
    "PRAGMA busy_timeout=5000;"
  )
}

export { currentVersion, MIGRATIONS }
