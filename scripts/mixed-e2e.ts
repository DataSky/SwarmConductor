#!/usr/bin/env bun
/**
 * Real end-to-end validation of MIXED execution (P1 routing + P3 lineage):
 *   - 3 deterministic WorkerExecutor tasks compute a file metric (NO LLM/tokens)
 *   - 1 LLM task consumes all three worker artifacts (inputFromDeps) and ranks
 *
 * Proves: executorKind routes to the worker; worker artifacts flow to the LLM
 * comparator; the comparator's artifact records lineage to the worker outputs.
 *
 * Requires `codewhale` + API credits. Manual run only:
 *   bun run scripts/mixed-e2e.ts [projectPath]
 */
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { WorkerExecutor, type WorkerRunner } from "../src/executor/worker-executor"
import { readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const projectPath = process.argv[2] ?? join(homedir(), "swarm-fanout-sandbox")
console.log(`[mixed-e2e] target: ${projectPath}`)

// Deterministic metric runner — reads the file in task.scope[0] and returns a
// JSON metric. Pure code, zero tokens. This is the "cheap worker" path.
const runner: WorkerRunner = (task) => {
  const file = task.scope[0]
  if (!file) return JSON.stringify({ error: "no file in scope" })
  const src = readFileSync(file, "utf8")
  const lines = src.split("\n").length
  const loops = (src.match(/\bfor\b|\bwhile\b/g) ?? []).length
  const nonNullAssert = (src.match(/!\./g) ?? []).length
  // crude complexity score: nested-loop & non-null-assertion heuristic
  const score = loops * 2 + nonNullAssert * 3
  return JSON.stringify({ file: file.split("/").pop(), lines, loops, nonNullAssert, score })
}

const config = defaultConfig({
  projectPath,
  maxConcurrentAgents: 2,    // LLM agents (only the comparator needs one)
  autoApprove: true,
  dynamicTasks: false,
})

// Default = LLM; plus a WorkerExecutor (kind "worker") with 3 slots.
const conductor = new Conductor(config, "run-mixed", undefined, [new WorkerExecutor(runner, 3)])
await conductor.initialize()

const OUT = `\n\n---\nOutput MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`
const mods = ["src/module-a.ts", "src/module-b.ts", "src/module-c.ts"]

// Worker metric tasks — routed to the worker executor (no LLM).
const metrics = mods.map(f => createTaskNode({
  type: "verify", title: `Metric ${f}`, prompt: `compute metric for ${f}`,
  scope: [join(projectPath, f)], executorKind: "worker", priority: 100,
}))

// LLM comparator — consumes all three worker metrics in full, ranks by score.
const compare = createTaskNode({
  type: "review", title: "Rank modules by metric score", scope: [],
  prompt: [
    `You are given three JSON metric objects (lines, loops, nonNullAssert, score)`,
    `as input data above — one per module. Do NOT read files.`,
    `Rank the modules from highest to lowest "score". State the ranking in SUMMARY.`,
    OUT,
  ].join("\n"),
  dependsOn: metrics.map(m => m.id),
  inputFromDeps: true,
  priority: 50,
})

conductor.taskDag.addTasks([...metrics, compare])
// Spawn just 1 LLM agent for the comparator; workers need no process.
await conductor.spawnAgents(["general"])

console.log(`[mixed-e2e] seeded 3 worker metrics + 1 LLM comparator; starting…`)
conductor.startScheduler()
const result = await conductor.waitForCompletion(300_000)

// ── Collect before shutdown ──────────────────────────────────────────────────
const metricArtifacts = metrics.map(m => ({ task: m, arts: conductor.store.getArtifactsByTask(m.id) }))
const compareArts = conductor.store.getArtifactsByTask(compare.id)
const tokenStats = conductor.store.tokenStats()
const statuses = [...metrics, compare].map(t => ({ title: t.title, status: conductor.taskDag.getTask(t.id)?.status }))
await conductor.shutdown()

console.log(`\n[mixed-e2e] run result: ${result}`)
console.table(statuses)
for (const { task, arts } of metricArtifacts) {
  console.log(`── ${task.title}: ${arts[0]?.content ?? "(no artifact)"}`)
}
console.log(`── comparator artifact summary: ${(() => {
  try { return JSON.parse(compareArts[0]?.content ?? "{}").summary?.slice(0, 200) } catch { return "(parse fail)" }
})()}`)
console.log(`── comparator lineage (sourceArtifactIds): ${JSON.stringify(compareArts[0]?.sourceArtifactIds ?? [])}`)

// ── Verdict ──────────────────────────────────────────────────────────────────
const allDone = statuses.every(s => s.status === "done")
const workerArtifactsExist = metricArtifacts.every(m => m.arts.length === 1 && m.arts[0]!.content.includes("score"))
const lineageOk = (compareArts[0]?.sourceArtifactIds ?? []).length === 3
// Worker tasks spend 0 tokens; only the single LLM comparator consumes tokens.
console.log(`\n[mixed-e2e] tokens: input=${tokenStats.inputTokens} output=${tokenStats.outputTokens} (only the 1 LLM comparator should cost)`)
const ok = result === "completed" && allDone && workerArtifactsExist && lineageOk
console.log(`[mixed-e2e] allDone=${allDone} workerArtifacts=${workerArtifactsExist} lineage=${lineageOk}`)
console.log(`[mixed-e2e] ${ok ? "✅ MIXED EXECUTION E2E PASSED" : "⚠️ review output above"}`)
process.exit(ok ? 0 : 1)
