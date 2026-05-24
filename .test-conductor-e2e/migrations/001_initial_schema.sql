-- Migration: 001_initial_schema
-- Description: Initial database schema for conductor e2e tests
-- Created: 2026-05-24

BEGIN;

-- Tasks table: tracks work items managed by the conductor
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'blocked')),
    title       TEXT NOT NULL,
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    blocked_by  TEXT,
    FOREIGN KEY (blocked_by) REFERENCES tasks(id) ON DELETE SET NULL
);

-- DAG edges: defines dependencies between tasks
CREATE TABLE IF NOT EXISTS dag_edges (
    id          TEXT PRIMARY KEY,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (from_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id)   REFERENCES tasks(id) ON DELETE CASCADE,
    UNIQUE(from_id, to_id)
);

-- Artifacts: stores outputs produced by tasks
CREATE TABLE IF NOT EXISTS artifacts (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'file',
    path        TEXT NOT NULL,
    size_bytes  INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- Index for fast lookup of artifacts by task
CREATE INDEX IF NOT EXISTS idx_artifacts_task_id ON artifacts(task_id);

-- Index for fast lookup of edges by source or target
CREATE INDEX IF NOT EXISTS idx_dag_edges_from ON dag_edges(from_id);
CREATE INDEX IF NOT EXISTS idx_dag_edges_to   ON dag_edges(to_id);

COMMIT;
