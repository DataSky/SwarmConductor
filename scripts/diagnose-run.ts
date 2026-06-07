#!/usr/bin/env bun
// diagnose-run.ts <runId> [--db path/to/conductor.db]
// Prints a human-readable timeline + failed-root-cause + artifact lineage for a run.

import { ConductorStore } from "../src/memory/store"
import { join } from "path"

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === "--help") {
  console.error("Usage: bun run scripts/diagnose-run.ts <runId> [--db <path>]")
  console.error("  --db  path to the conductor.db file (default: .conductor/conductor.db)")
  process.exit(1)
}

const runId = args[0]!
const dbIdx = args.indexOf("--db")
const dbDir = dbIdx !== -1 && args[dbIdx + 1]
  ? args[dbIdx + 1]!
  : join(process.cwd(), ".conductor")

const store = new ConductorStore(dbDir, runId)

// ── Summary ────────────────────────────────────────────────────────────────
const summary = store.getRunSummary()
const ts = summary.taskStats
const tok = summary.tokenStats

console.log(`\n═══ Run: ${runId} ═══`)
console.log(`\n── Tasks ──────────────────────────────`)
console.log(`  Total: ${ts.total}   Done: ${ts.done}   Failed: ${ts.failed}   Interrupted: ${ts.interrupted}`)
console.log(`  Avg duration: ${Math.round(ts.avgDurationMs)}ms`)

console.log(`\n── Tokens ─────────────────────────────`)
console.log(`  Input: ${tok.inputTokens}   Output: ${tok.outputTokens}   Cache hits: ${tok.cacheHitRate}%`)

if (summary.failedTasks.length > 0) {
  console.log(`\n── Failed Tasks ────────────────────────`)
  for (const t of summary.failedTasks) {
    console.log(`  [${t.id}] ${t.title}`)
    if (t.error) console.log(`    Error: ${t.error}`)
  }
}

if (summary.keyEvents.length > 0) {
  console.log(`\n── Key Events ──────────────────────────`)
  for (const e of summary.keyEvents) {
    const time = new Date(e.timestamp).toISOString()
    const detail = e.payload["taskId"] ?? e.payload["agentId"] ?? e.payload["cycle"] ?? ""
    console.log(`  ${time}  [${e.kind}]${detail ? "  " + JSON.stringify(detail) : ""}`)
  }
}

// ── Event Timeline ─────────────────────────────────────────────────────────
console.log(`\n── Event Timeline ──────────────────────`)
const trace = store.getRunTrace()
const SHOW_KINDS = new Set([
  "phase.started", "phase.completed",
  "task.status_changed",
  "task.dynamic_inserted",
  "agent.crashed", "agent.restarted",
  "deadlock.detected",
  "approval.required", "approval.resolved",
  "run.completed", "run.failed",
])
for (const e of trace) {
  if (!SHOW_KINDS.has(e.kind)) continue
  const time = new Date(e.timestamp).toLocaleTimeString("en-GB", { hour12: false })
  const p = e.payload
  let detail = ""
  if (e.kind === "task.status_changed") detail = `${p["taskId"]}  ${p["prev"]} → ${p["next"]}`
  else if (e.kind === "agent.crashed")   detail = `agent=${p["agentId"]}`
  else if (e.kind === "deadlock.detected") detail = `cycle=${JSON.stringify(p["cycle"])}`
  else detail = Object.entries(p).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join("  ")
  console.log(`  ${time}  [${e.kind}]  ${detail}`)
}

console.log()
store.close()
