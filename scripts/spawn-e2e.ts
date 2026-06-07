#!/usr/bin/env bun
/**
 * Real end-to-end validation of the AUTONOMOUS fan-out loop: a single planner
 * agent decides the children and emits a `## SPAWN` directive; the conductor
 * parses it and materializes the fan-out — no graph is seeded by hand.
 *
 * Requires `codewhale` + API credits. Manual run only:
 *   bun run scripts/spawn-e2e.ts [projectPath]
 */
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { homedir } from "os"
import { join } from "path"

const projectPath = process.argv[2] ?? join(homedir(), "swarm-fanout-sandbox")
console.log(`[spawn-e2e] target: ${projectPath}`)

const config = defaultConfig({
  projectPath,
  maxConcurrentAgents: 4,
  autoApprove: true,
  dynamicTasks: true,        // REQUIRED — enables ## SPAWN parsing
})

const conductor = new Conductor(config)
await conductor.initialize()

// Track dynamic insertions so we can prove the planner drove the fan-out.
const dynamicInserts: string[] = []
conductor.onEvent(e => {
  if (e.kind === "task.dynamic_inserted") dynamicInserts.push(String(e.payload["title"]))
})

// A single planner task. Its prompt teaches the exact SPAWN schema so the model
// can emit a valid fan-out directive. The conductor parses it on completion.
const planner = createTaskNode({
  type: "plan",
  title: "Plan analysis fan-out",
  scope: [],
  prompt: [
    `This project has three modules: src/module-a.ts, src/module-b.ts, src/module-c.ts.`,
    `Design a fan-out: one analysis task per module, plus ONE comparison task that`,
    `depends on all three analyses and ranks them by urgency.`,
    ``,
    `Emit your plan as a "## SPAWN" section containing a JSON array of task specs.`,
    `Each spec has these fields:`,
    `  - "type": one of explore|plan|implement|review|verify`,
    `  - "title": short title`,
    `  - "prompt": the full instruction for that task (self-contained)`,
    `  - "scope": array of file paths (use the module path for analyses, [] for the comparison)`,
    `  - "key": a short handle (e.g. "a","b","c","cmp") so specs can reference each other`,
    `  - "dependsOnParent": true for the three analyses`,
    `  - "dependsOnKeys": for the comparison, list the analysis keys it depends on`,
    `  - "inputFromDeps": true for the comparison (so it receives the full analyses)`,
    ``,
    `Example shape:`,
    '## SPAWN',
    '```json',
    '[',
    '  {"type":"review","title":"Analyze A","prompt":"...","scope":["src/module-a.ts"],"key":"a","dependsOnParent":true},',
    '  {"type":"review","title":"Compare","prompt":"...","scope":[],"key":"cmp","dependsOnKeys":["a","b","c"],"inputFromDeps":true}',
    ']',
    '```',
    ``,
    `---`,
    `Output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS, and ## SPAWN`,
  ].join("\n"),
  priority: 100,
})

conductor.taskDag.addTasks([planner])
await conductor.spawnAgents(Array(4).fill("general"))

console.log(`[spawn-e2e] seeded 1 planner; starting…`)
conductor.startScheduler()
const result = await conductor.waitForCompletion(600_000)

// ── Collect results BEFORE shutdown (DB closes on shutdown) ──────────────────
const allTasks = conductor.taskDag.allTasks()
const report = allTasks.map(t => ({
  title: t.title, type: t.type, status: t.status,
  deps: t.dependsOn.length, fromDeps: !!t.inputFromDeps,
  artifacts: conductor.store.getArtifactsByTask(t.id).length,
}))
await conductor.shutdown()

console.log(`\n[spawn-e2e] run result: ${result}`)
console.log(`[spawn-e2e] planner spawned ${dynamicInserts.length} task(s): ${dynamicInserts.join(", ")}`)
console.table(report)

// ── Verdict ──────────────────────────────────────────────────────────────────
const spawned = allTasks.length - 1                       // minus the planner
const comparator = allTasks.find(t => t.inputFromDeps && t.dependsOn.length >= 2)
const allDone = allTasks.every(t => t.status === "done")
const ok = result === "completed" && spawned >= 3 && !!comparator && allDone
console.log(`\n[spawn-e2e] autonomous fan-out: planner→${spawned} children, comparator wired=${!!comparator}, allDone=${allDone}`)
console.log(`[spawn-e2e] ${ok ? "✅ AUTONOMOUS SPAWN E2E PASSED" : "⚠️ review output above"}`)
process.exit(ok ? 0 : 1)
