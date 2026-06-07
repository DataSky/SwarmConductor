#!/usr/bin/env bun
/**
 * Real end-to-end data-flow validation (requires a working `codewhale` binary
 * and API credits — costs real tokens, takes minutes). Manual run only:
 *
 *   bun run scripts/dataflow-e2e.ts [projectPath]
 *
 * Seeds a fan-out → cross-comparison DAG against the target project:
 *   3 parallel analyses (one per module)  →  1 comparison task that pulls ALL
 *   three analyses' FULL artifacts via inputFromDeps and ranks them.
 *
 * Validates the data-flow claim with REAL agents: the comparator must reach a
 * conclusion that's only possible if it actually received all three analyses.
 */
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { homedir } from "os"
import { join } from "path"

const projectPath = process.argv[2] ?? join(homedir(), "swarm-fanout-sandbox")
console.log(`[e2e] target project: ${projectPath}`)

const config = defaultConfig({
  projectPath,
  maxConcurrentAgents: 4,     // 3 analyses in parallel + headroom for the comparator
  autoApprove: true,
  dynamicTasks: false,        // we seed the graph explicitly; no heuristic follow-ups
})

const conductor = new Conductor(config)
await conductor.initialize()

const OUT = `\n\n---\nOutput MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`

// One analysis per module. Distinct scopes → run in parallel. Each must emit a
// 1-10 severity score in its SUMMARY so the comparator has something to rank.
const mods = [
  { id: "a", file: "src/module-a.ts" },
  { id: "b", file: "src/module-b.ts" },
  { id: "c", file: "src/module-c.ts" },
]
const analyses = mods.map(m => createTaskNode({
  type: "review",
  title: `Analyze ${m.file}`,
  prompt: [
    `Analyze ONLY the file ${m.file} in this project.`,
    `Identify its single most significant issue (performance, correctness, or none).`,
    `In your SUMMARY, state: the file name, the issue category, and an URGENCY score 1-10`,
    `(10 = will crash/break in production, 1 = no change needed).`,
    OUT,
  ].join("\n"),
  scope: [join(projectPath, m.file)],
  priority: 100,
}))

// Comparator depends on all three and pulls their FULL artifacts in.
const compare = createTaskNode({
  type: "review",
  title: "Cross-compare and rank modules",
  prompt: [
    `You are given the COMPLETE analyses of three modules as input data above.`,
    `Do NOT re-read the files — use only the provided analyses.`,
    `Rank the three modules from most to least urgent to fix, using their URGENCY scores.`,
    `In your SUMMARY, list the ranking explicitly (e.g. "1. module-X (score), 2. ...").`,
    OUT,
  ].join("\n"),
  scope: [],
  dependsOn: analyses.map(a => a.id),
  inputFromDeps: true,
  priority: 50,
})

conductor.taskDag.addTasks([...analyses, compare])
await conductor.spawnAgents(Array(4).fill("general"))

console.log(`[e2e] seeded ${analyses.length} analyses + 1 comparator; starting scheduler…`)
conductor.startScheduler()
const result = await conductor.waitForCompletion(600_000)

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n[e2e] run result: ${result}\n`)
// Read everything from the store BEFORE shutdown closes the DB.
const cmpArts = conductor.store.getArtifactsByTask(compare.id)
for (const t of [...analyses, compare]) {
  const arts = conductor.store.getArtifactsByTask(t.id)
  console.log(`── ${t.title} [${conductor.taskDag.getTask(t.id)?.status}] — ${arts.length} artifact(s)`)
  for (const a of arts) {
    try {
      const o = JSON.parse(a.content) as { summary?: string }
      console.log(`   SUMMARY: ${(o.summary ?? "").slice(0, 300)}`)
    } catch { console.log(`   (raw ${a.byteSize}B)`) }
  }
}

await conductor.shutdown()

// ── Verdict ─────────────────────────────────────────────────────────────────
const cmpText = cmpArts.map(a => a.content).join(" ").toLowerCase()
const mentionsAll = ["module-a", "module-b", "module-c"].every(m => cmpText.includes(m))
console.log(`\n[e2e] comparator mentions all three modules: ${mentionsAll ? "✅ YES" : "❌ NO"}`)
console.log(`[e2e] ${result === "completed" && mentionsAll ? "✅ DATA-FLOW E2E PASSED" : "⚠️ review output above"}`)
process.exit(result === "completed" && mentionsAll ? 0 : 1)
