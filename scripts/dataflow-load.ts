#!/usr/bin/env bun
/**
 * Load test for the data-flow core: a realistic burst of deterministic worker
 * tasks (NO LLM — so it runs offline, no codewhale, no tokens) to answer the
 * real question: does it run efficiently and stably under load?
 *
 *   bun run scripts/dataflow-load.ts [taskCount]
 *
 * Measures: total wall time, throughput, peak RSS, memory growth, and verifies
 * every task completed exactly once (no double-dispatch, no starvation).
 */
import { DuckDBInstance } from "@duckdb/node-api"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { WorkerExecutor } from "../src/executor/worker-executor"
import { makeSqlWorker } from "../src/worker/sql-worker"
import { makeValidateWorker } from "../src/worker/validate-compare"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const N = parseInt(process.argv[2] ?? "60", 10)   // SQL tasks (each gets a validate child)
const rss = () => Math.round(process.memoryUsage().rss / 1_048_576)

// ── Larger synthetic dataset ──────────────────────────────────────────────────
const DB = join(tmpdir(), `load-${process.pid}.duckdb`)
rmSync(DB, { force: true })
console.log(`[load] generating dataset (50k rows) …`)
{
  const w = await DuckDBInstance.create(DB)
  const c = await w.connect()
  await c.run(`CREATE TABLE events (id BIGINT, region VARCHAR, kind VARCHAR, amount DECIMAL(12,2), ts TIMESTAMP)`)
  await c.run(`INSERT INTO events SELECT i,
    ['EU','US','APAC','LATAM','MEA'][1+(i%5)],
    ['view','click','buy','refund'][1+(i%4)],
    round(random()*1000,2)::DECIMAL(12,2),
    TIMESTAMP '2026-01-01' + (i % 200) * INTERVAL 1 HOUR
    FROM range(1, 50001) t(i)`)
  c.closeSync?.(); w.closeSync?.()
}
const startRss = rss()
console.log(`[load] dataset ready. baseline RSS=${startRss}MB. building ${N} sql + ${N} validate tasks …`)

// ── Conductor with sql + validate workers (8 concurrent slots each) ──────────
const instance = await DuckDBInstance.create(DB, { access_mode: "READ_ONLY" })
const sqlExec = new WorkerExecutor(makeSqlWorker(instance), 8)
;(sqlExec as unknown as { kind: string }).kind = "sql"
const valExec = new WorkerExecutor(makeValidateWorker(), 8)
;(valExec as unknown as { kind: string }).kind = "validate"

const projectDir = mkdtempSync(join(tmpdir(), "load-"))
const config = defaultConfig({ projectPath: projectDir, dynamicTasks: false })
const conductor = new Conductor(config, "run-load", undefined, [sqlExec, valExec])
await conductor.initialize()

// N varied SQL aggregates, each with a validate child (fan-out shape).
const regions = ["EU", "US", "APAC", "LATAM", "MEA"]
const kinds = ["view", "click", "buy", "refund"]
const nodes = []
for (let i = 0; i < N; i++) {
  const region = regions[i % regions.length]
  const kind = kinds[i % kinds.length]
  const sql = createTaskNode({ type: "verify", title: `agg ${i}`, executorKind: "sql", scope: [],
    prompt: `SELECT kind, COUNT(*) n, SUM(amount) total FROM events WHERE region='${region}' AND kind='${kind}' GROUP BY kind` })
  const check = createTaskNode({ type: "verify", title: `check ${i}`, executorKind: "validate", scope: [],
    dependsOn: [sql.id], inputFromDeps: true,
    prompt: JSON.stringify({ rules: [{ type: "noError" }, { type: "rowCount", min: 0 }] }) })
  nodes.push(sql, check)
}
conductor.taskDag.addTasks(nodes)

// ── Run + sample memory ───────────────────────────────────────────────────────
let peakRss = startRss
const sampler = setInterval(() => { peakRss = Math.max(peakRss, rss()) }, 50)

const t0 = Date.now()
conductor.startScheduler()
const result = await conductor.waitForCompletion(120_000)
const elapsed = Date.now() - t0
clearInterval(sampler)

const all = conductor.taskDag.allTasks()
const done = all.filter(t => t.status === "done").length
const failed = all.filter(t => t.status === "failed").length
const tokens = conductor.store.tokenStats()
await conductor.shutdown()
instance.closeSync?.()
rmSync(DB, { force: true }); rmSync(projectDir, { recursive: true, force: true })
const endRss = rss()

// ── Report ──────────────────────────────────────────────────────────────────
const total = nodes.length
console.log(`\n[load] ─────────────────────────────────────────`)
console.log(`[load] tasks:        ${total} (${N} sql + ${N} validate)`)
console.log(`[load] result:       ${result}`)
console.log(`[load] done/failed:  ${done}/${failed}`)
console.log(`[load] wall time:    ${elapsed}ms`)
console.log(`[load] throughput:   ${(total / (elapsed / 1000)).toFixed(1)} tasks/sec`)
console.log(`[load] RSS:          baseline=${startRss}MB peak=${peakRss}MB end=${endRss}MB (growth=${endRss - startRss}MB)`)
console.log(`[load] tokens:       input=${tokens.inputTokens} output=${tokens.outputTokens} (worker-only → expect 0)`)

const ok = result === "completed" && done === total && failed === 0 && tokens.inputTokens === 0
console.log(`[load] ${ok ? "✅ LOAD TEST PASSED — all tasks completed, zero tokens" : "⚠️ review output above"}`)
process.exit(ok ? 0 : 1)
