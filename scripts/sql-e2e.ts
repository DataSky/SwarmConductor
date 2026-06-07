#!/usr/bin/env bun
/**
 * Real end-to-end: DuckDB-backed SQL workers feeding an LLM judge.
 * Proves the generic worker core wired to a REAL analytical engine:
 *   - synthetic orders dataset (generated, READ_ONLY reopened)
 *   - 3 SQL aggregate tasks routed to the DuckDB worker (executorKind:"sql", 0 tokens)
 *   - 1 LLM task consumes all three result sets (inputFromDeps) and interprets
 *
 * Requires `codewhale` + DMXAPI key. Manual run only:
 *   bun run scripts/sql-e2e.ts
 */
import { DuckDBInstance } from "@duckdb/node-api"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { WorkerExecutor } from "../src/executor/worker-executor"
import { makeSqlWorker } from "../src/worker/sql-worker"
import { rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const DB = join(tmpdir(), "sql-e2e.duckdb")
const PROJECT = join(tmpdir(), "sql-e2e-project")

// ── Step 4: synthetic dataset ────────────────────────────────────────────────
rmSync(DB, { force: true })
rmSync(PROJECT, { recursive: true, force: true })
const { mkdirSync } = await import("fs")
mkdirSync(PROJECT, { recursive: true })

console.log("[sql-e2e] generating synthetic orders dataset …")
{
  const w = await DuckDBInstance.create(DB)
  const c = await w.connect()
  await c.run(`CREATE TABLE orders (id INTEGER, region VARCHAR, category VARCHAR, amount DECIMAL(10,2), ts TIMESTAMP)`)
  // 5000 rows across 4 regions / 3 categories, deterministic-ish via random.
  await c.run(`
    INSERT INTO orders
    SELECT
      i AS id,
      ['EU','US','APAC','LATAM'][1 + (i % 4)] AS region,
      ['hardware','software','services'][1 + (i % 3)] AS category,
      round(10 + random() * 990, 2)::DECIMAL(10,2) AS amount,
      TIMESTAMP '2026-01-01' + (i % 120) * INTERVAL 1 DAY AS ts
    FROM range(1, 5001) t(i)
  `)
  const n = (await c.runAndReadAll(`SELECT COUNT(*) c FROM orders`)).getRowObjects()[0]!
  console.log(`[sql-e2e] dataset ready: ${String((n as { c: bigint }).c)} rows`)
  c.closeSync?.(); w.closeSync?.()
}

// Reopen READ_ONLY — analytical safety: workers can never mutate.
const instance = await DuckDBInstance.create(DB, { access_mode: "READ_ONLY" })
const sqlWorker = makeSqlWorker(instance)

// ── Conductor: default LLM + DuckDB sql worker (3 slots) ─────────────────────
const config = defaultConfig({ projectPath: PROJECT, maxConcurrentAgents: 2, autoApprove: true, dynamicTasks: false })
const sqlExec = new WorkerExecutor(sqlWorker, 3)
;(sqlExec as unknown as { kind: string }).kind = "sql"   // distinct kind; routes by actsDirectly
const conductor = new Conductor(config, "run-sql", undefined, [sqlExec])
await conductor.initialize()

const OUT = `\n\n---\nOutput MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`

// 3 SQL aggregate tasks → DuckDB worker (0 tokens)
const byRegion = createTaskNode({ type: "verify", title: "revenue by region", executorKind: "sql", scope: [],
  prompt: `SELECT region, COUNT(*) orders, SUM(amount) revenue FROM orders GROUP BY region ORDER BY revenue DESC` })
const byCategory = createTaskNode({ type: "verify", title: "revenue by category", executorKind: "sql", scope: [],
  prompt: `SELECT category, COUNT(*) orders, ROUND(AVG(amount),2) avg_amount FROM orders GROUP BY category ORDER BY avg_amount DESC` })
const topDays = createTaskNode({ type: "verify", title: "top 5 revenue days", executorKind: "sql", scope: [],
  prompt: `SELECT ts::DATE AS order_day, SUM(amount) revenue FROM orders GROUP BY order_day ORDER BY revenue DESC LIMIT 5` })

// LLM judge consumes all three result sets in full.
const judge = createTaskNode({
  type: "review", title: "interpret the sales analysis", scope: [],
  dependsOn: [byRegion.id, byCategory.id, topDays.id], inputFromDeps: true,
  prompt: [
    `You are given three SQL result sets (JSON) as input data above: revenue by region,`,
    `revenue by category, and the top revenue days. Do NOT run queries yourself.`,
    `In SUMMARY: name the top region by revenue, the highest-avg category, and whether`,
    `revenue looks evenly spread across regions. Base every claim on the provided numbers.`,
    OUT,
  ].join("\n"),
})

conductor.taskDag.addTasks([byRegion, byCategory, topDays, judge])
await conductor.spawnAgents(["general"])   // 1 LLM agent for the judge

console.log("[sql-e2e] seeded 3 SQL workers + 1 LLM judge; starting …")
conductor.startScheduler()
const result = await conductor.waitForCompletion(300_000)

// ── Collect before shutdown ──────────────────────────────────────────────────
const sqlTasks = [byRegion, byCategory, topDays]
const sqlArts = sqlTasks.map(t => ({ t, a: conductor.store.getArtifactsByTask(t.id) }))
const judgeArts = conductor.store.getArtifactsByTask(judge.id)
const tokens = conductor.store.tokenStats()
const statuses = [...sqlTasks, judge].map(t => ({ title: t.title, status: conductor.taskDag.getTask(t.id)?.status }))
await conductor.shutdown()
instance.closeSync?.()

console.log(`\n[sql-e2e] run result: ${result}`)
console.table(statuses)
for (const { t, a } of sqlArts) console.log(`── ${t.title}: ${(a[0]?.content ?? "(none)").slice(0, 160)}`)
console.log(`── judge summary: ${(() => { try { return JSON.parse(judgeArts[0]?.content ?? "{}").summary?.slice(0, 260) } catch { return "(parse fail)" } })()}`)
console.log(`── judge lineage: ${JSON.stringify(judgeArts[0]?.sourceArtifactIds ?? [])}`)

// ── Verdict ──────────────────────────────────────────────────────────────────
const allDone = statuses.every(s => s.status === "done")
const sqlClean = sqlArts.every(({ a }) => {
  if (a.length !== 1) return false
  try { const o = JSON.parse(a[0]!.content); return Array.isArray(o.rows) && o.rows.length > 0 && !o.error } catch { return false }
})
const lineageOk = (judgeArts[0]?.sourceArtifactIds ?? []).length === 3
console.log(`\n[sql-e2e] tokens: input=${tokens.inputTokens} output=${tokens.outputTokens} (only the LLM judge should cost; SQL workers = 0)`)
const ok = result === "completed" && allDone && sqlClean && lineageOk
console.log(`[sql-e2e] allDone=${allDone} sqlClean=${sqlClean} lineage=${lineageOk}`)
console.log(`[sql-e2e] ${ok ? "✅ DUCKDB SQL E2E PASSED" : "⚠️ review output above"}`)
rmSync(DB, { force: true }); rmSync(PROJECT, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
