import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { DuckDBInstance } from "@duckdb/node-api"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { WorkerExecutor } from "../src/executor/worker-executor"
import { makeSqlWorker } from "../src/worker/sql-worker"
import { makeValidateWorker, makeCompareWorker } from "../src/worker/validate-compare"
import { runSelfCheck } from "../src/conductor/self-check"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// ─── M1-M4 integration test with real DuckDB workers ─────────────────────────
// Validates that the changes from M1 (event persistence), M2 (config),
// M3 (diagnostics), and M4 (self-check) work correctly end-to-end through the
// real WorkerExecutor + DuckDB SQL path — not through FakeExecutor.

const DB = join(tmpdir(), `m1m4-int-${process.pid}.duckdb`)
let instance: DuckDBInstance

beforeAll(async () => {
  rmSync(DB, { force: true })
  const w = await DuckDBInstance.create(DB)
  const c = await w.connect()
  await c.run(`CREATE TABLE sales (id INTEGER, region VARCHAR, amount DECIMAL(10,2))`)
  await c.run(`INSERT INTO sales VALUES
    (1,'EU',100),(2,'US',200),(3,'EU',50),
    (4,'APAC',300),(5,'US',150),(6,'EU',80)`)
  c.closeSync?.()
  w.closeSync?.()
  instance = await DuckDBInstance.create(DB, { access_mode: "READ_ONLY" })
})

afterAll(() => {
  instance.closeSync?.()
  rmSync(DB, { force: true })
})

function makeWorkers(sqlWorkerMaxRows = 10_000) {
  const sqlEx = new WorkerExecutor(makeSqlWorker(instance, { maxRows: sqlWorkerMaxRows }), 4)
  ;(sqlEx as unknown as { kind: string }).kind = "sql"
  const valEx = new WorkerExecutor(makeValidateWorker(), 4)
  ;(valEx as unknown as { kind: string }).kind = "validate"
  const cmpEx = new WorkerExecutor(makeCompareWorker(), 4)
  ;(cmpEx as unknown as { kind: string }).kind = "compare"
  return { sqlEx, valEx, cmpEx }
}

async function buildAndRun(
  label: string,
  buildNodes: (projectDir: string) => { nodes: ReturnType<typeof createTaskNode>[]; config?: object },
  sqlWorkerMaxRows?: number,
) {
  const projectDir = mkdtempSync(join(tmpdir(), `m1m4-${label}-`))
  const { sqlEx, valEx, cmpEx } = makeWorkers(sqlWorkerMaxRows)
  const config = defaultConfig({ projectPath: projectDir, maxConcurrentAgents: 6, dynamicTasks: false, autoApprove: true })
  const conductor = new Conductor(config, `run-${label}`, undefined, [sqlEx, valEx, cmpEx])
  await conductor.initialize()
  const { nodes } = buildNodes(projectDir)
  conductor.taskDag.addTasks(nodes)
  conductor.startScheduler()
  const status = await conductor.waitForCompletion(30_000)
  // NOTE: do NOT rmSync projectDir here — callers need the store open for queries.
  // Each caller must call conductor.shutdown() then rmSync themselves.
  return { conductor, status, config, projectDir }
}

// ─── M1: all events land in event_log via real Worker path ───────────────────

describe("M1 – event persistence through real WorkerExecutor", () => {
  it("persists phase.started, task.status_changed, task.completed, run.completed", async () => {
    const { conductor, status, projectDir } = await buildAndRun("m1-events", () => ({
      nodes: [
        createTaskNode({ type: "verify", title: "Q1", prompt: `SELECT COUNT(*) n FROM sales`, scope: [], executorKind: "sql" }),
        createTaskNode({ type: "verify", title: "Q2", prompt: `SELECT SUM(amount) t FROM sales WHERE region='EU'`, scope: [], executorKind: "sql" }),
      ],
    }))

    const trace = conductor.store.getRunTrace()
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(status).toBe("completed")
    const kinds = new Set(trace.map(e => e.kind))
    // task.status_changed fires for every pending→ready→running→done transition
    expect(kinds.has("task.status_changed")).toBe(true)
    expect(kinds.has("run.completed")).toBe(true)
    // task.completed is logged via the legacy logEvent path inside persistCompletion
    const taskCompletedEvents = trace.filter(e => e.kind === "task.completed")
    expect(taskCompletedEvents.length).toBe(2)  // one per task
    // lock.released fires after each worker task (scope is [], but lock path still
    // emits on the finally block — verifies M1 persists non-task-completed events too)
    expect(kinds.has("lock.released")).toBe(true)
  })

  it("trace pagination works (sinceSeq) over real worker events", async () => {
    const { conductor, projectDir } = await buildAndRun("m1-page", () => ({
      nodes: [createTaskNode({ type: "verify", title: "P1", prompt: `SELECT 1`, scope: [], executorKind: "sql" })],
    }))

    const all = conductor.store.getRunTrace()
    const firstId = all[0]!.id
    const paged = conductor.store.getRunTrace({ sinceSeq: firstId })
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(paged.length).toBe(all.length - 1)
    expect(paged.every(e => e.id > firstId)).toBe(true)
  })
})

// ─── M2: config values flow through to real workers ──────────────────────────

describe("M2 – config values flow through real DuckDB worker", () => {
  it("sqlWorkerMaxRows truncates result when exceeded", async () => {
    // Insert enough rows to exceed a tiny cap
    const projectDir = mkdtempSync(join(tmpdir(), "m2-maxrows-"))
    const { sqlEx, valEx } = makeWorkers(2)   // cap at 2 rows
    const config = defaultConfig({ projectPath: projectDir, maxConcurrentAgents: 2, dynamicTasks: false, autoApprove: true, sqlWorkerMaxRows: 2 })
    const conductor = new Conductor(config, "run-m2-maxrows", undefined, [sqlEx, valEx])
    await conductor.initialize()
    // Query returns 6 rows; worker should truncate to 2
    const t = createTaskNode({ type: "verify", title: "BigQ", prompt: `SELECT * FROM sales`, scope: [], executorKind: "sql" })
    conductor.taskDag.addTasks([t])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)
    const arts = conductor.store.getArtifactsByTask(t.id)
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(arts.length).toBe(1)
    const out = JSON.parse(arts[0]!.content) as { rows: unknown[]; rowCount: number; truncated: boolean }
    expect(out.truncated).toBe(true)
    expect(out.rows.length).toBe(2)       // capped at maxRows
    expect(out.rowCount).toBe(6)          // original count preserved
  })

  it("maxContextEntries from config is respected (not hardcoded 5)", async () => {
    // This is a structural test: verify defaultConfig plumbs the value
    const config = defaultConfig({ projectPath: "/tmp/x", maxContextEntries: 3 })
    expect(config.maxContextEntries).toBe(3)
    // And the old default still works
    expect(defaultConfig({ projectPath: "/tmp/x" }).maxContextEntries).toBe(5)
  })
})

// ─── M3: diagnostics work on real worker artifacts ───────────────────────────

describe("M3 – diagnostics on real WorkerExecutor artifacts", () => {
  it("getRunSummary reports correct stats for a sql → validate chain", async () => {
    const { conductor, status, projectDir } = await buildAndRun("m3-summary", () => ({
      nodes: (() => {
        const q = createTaskNode({ type: "verify", title: "Q", prompt: `SELECT region, COUNT(*) n FROM sales GROUP BY region`, scope: [], executorKind: "sql" })
        const v = createTaskNode({ type: "verify", title: "V", prompt: JSON.stringify({ rules: [{ type: "rowCount", min: 1 }] }), scope: [], executorKind: "validate", dependsOn: [q.id], inputFromDeps: true })
        return [q, v]
      })(),
    }))
    const summary = conductor.store.getRunSummary()
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(status).toBe("completed")
    expect(summary.taskStats.total).toBe(2)
    expect(summary.taskStats.done).toBe(2)
    expect(summary.taskStats.failed).toBe(0)
    expect(summary.tokenStats.inputTokens).toBe(0)  // workers: zero tokens
    const kindSet = new Set(summary.keyEvents.map(e => e.kind))
    expect(kindSet.has("run.completed")).toBe(true)
  })

  it("getArtifactLineage traverses sql → validate artifact chain", async () => {
    const q = createTaskNode({ type: "verify", title: "Src", prompt: `SELECT * FROM sales LIMIT 3`, scope: [], executorKind: "sql" })
    const v = createTaskNode({ type: "verify", title: "Consume", prompt: JSON.stringify({ rules: [{ type: "noError" }] }), scope: [], executorKind: "validate", dependsOn: [q.id], inputFromDeps: true })

    const { conductor, status, projectDir } = await buildAndRun("m3-lineage", () => ({ nodes: [q, v] }))
    const vTask = conductor.taskDag.getTask(v.id)!
    const vArtId = vTask.artifacts![0]!.id
    const lineage = conductor.store.getArtifactLineage(vArtId)
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(status).toBe("completed")
    expect(lineage.length).toBe(2)   // src artifact + consume artifact
    const ids = lineage.map(a => a.id)
    expect(ids[ids.length - 1]).toBe(vArtId)  // consume artifact is last (root)
    const srcArt = lineage.find(a => a.taskId === q.id)
    expect(srcArt).toBeDefined()
  })
})

// ─── M4: self-check on real worker run ───────────────────────────────────────

describe("M4 – self-check on real WorkerExecutor run", () => {
  it("passes all invariants for a clean sql + validate run", async () => {
    const q = createTaskNode({ type: "verify", title: "Q", prompt: `SELECT region, SUM(amount) s FROM sales GROUP BY region`, scope: [], executorKind: "sql" })
    const v = createTaskNode({ type: "verify", title: "V", prompt: JSON.stringify({ rules: [{ type: "rowCount", min: 1 }] }), scope: [], executorKind: "validate", dependsOn: [q.id], inputFromDeps: true })

    const { conductor, status, projectDir } = await buildAndRun("m4-ok", () => ({ nodes: [q, v] }))
    const report = runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
    const trace = conductor.store.getRunTrace()
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(status).toBe("completed")
    expect(report.passed).toBe(true)
    expect(report.violations.filter(r => r.severity === "error")).toHaveLength(0)
    const tokenWarnings = report.violations.filter(r => r.rule === "worker_zero_tokens")
    expect(tokenWarnings).toHaveLength(0)
    const scEvent = trace.find(e => e.kind === "selfcheck.completed")
    expect(scEvent).toBeDefined()
    expect((scEvent!.payload as { passed: boolean }).passed).toBe(true)
  })

  it("detects done task with no artifact (forced via direct DB manipulation)", async () => {
    const q = createTaskNode({ type: "verify", title: "Q", prompt: `SELECT 1`, scope: [], executorKind: "sql" })
    const { conductor, projectDir } = await buildAndRun("m4-noart", () => ({ nodes: [q] }))

    const db = (conductor.store as unknown as { db: import("bun:sqlite").Database }).db
    db.prepare(`DELETE FROM artifacts WHERE task_id=?`).run(q.id)

    const report = runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    const artViolation = report.violations.find(v => v.rule === "done_task_has_artifact")
    expect(artViolation).toBeDefined()
    expect(artViolation!.severity).toBe("error")
    expect(report.passed).toBe(false)
  })

  it("worker tasks produce zero tokens — worker_zero_tokens check stays clean", async () => {
    const tasks = [
      createTaskNode({ type: "verify", title: "SQL1", prompt: `SELECT COUNT(*) FROM sales`, scope: [], executorKind: "sql" }),
      createTaskNode({ type: "verify", title: "SQL2", prompt: `SELECT MAX(amount) FROM sales`, scope: [], executorKind: "sql" }),
    ]
    const { conductor, projectDir } = await buildAndRun("m4-tokens", () => ({ nodes: tasks }))
    const report = runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
    await conductor.shutdown()
    rmSync(projectDir, { recursive: true, force: true })

    expect(report.violations.filter(v => v.rule === "worker_zero_tokens")).toHaveLength(0)
  })
})
