/**
 * Self-analysis benchmark: Swarm Conductor analyzes its own codebase.
 *
 * Phase 0 (parallel): 5 explore agents, each owns one module
 * Phase 1 (parallel): 3 review agents, cross-module concerns
 * Phase 2 (sequential gate): 1 plan agent synthesizes findings
 *
 * Run: bun run bench
 */
import { Conductor } from "../conductor"
import { createTaskNode } from "../dag/engine"
import { defaultConfig } from "../dag/types"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

const PROJECT = process.cwd()             // codewhale_debug itself
const REPORT_DIR = join(PROJECT, ".conductor-bench")
const BASE_PORT = 18600

// ─── Read source file contents for inclusion in prompts ──────────────────────

function src(rel: string): string {
  const full = join(PROJECT, rel)
  if (!existsSync(full)) return `(file not found: ${rel})`
  return readFileSync(full, "utf8")
}

// ─── Build the task graph ─────────────────────────────────────────────────────

function buildTaskGraph(conductor: Conductor) {
  const dag = conductor.taskDag

  // ── Phase 0: module-level exploration (5 agents, all parallel) ─────────────

  const exploreDAG = createTaskNode({
    type: "explore",
    title: "Explore: DAG engine & types",
    prompt: `You are doing a code review of a multi-agent orchestration system called Swarm Conductor.

Analyze these two source files:

## src/dag/types.ts
\`\`\`typescript
${src("src/dag/types.ts")}
\`\`\`

## src/dag/engine.ts
\`\`\`typescript
${src("src/dag/engine.ts")}
\`\`\`

Focus on:
1. Is the TaskNode state machine correct and complete?
2. Are there edge cases in dependency resolution (blocked→ready transitions)?
3. Any type safety gaps?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/dag/types.ts", "src/dag/engine.ts"],
    priority: 100,
  })

  const exploreRuntime = createTaskNode({
    type: "explore",
    title: "Explore: Runtime client & agent manager",
    prompt: `Analyze the CodeWhale HTTP runtime integration:

## src/runtime/client.ts
\`\`\`typescript
${src("src/runtime/client.ts")}
\`\`\`

## src/runtime/agent-manager.ts
\`\`\`typescript
${src("src/runtime/agent-manager.ts")}
\`\`\`

Focus on:
1. Is the SSE parsing robust? What happens on malformed events?
2. Could waitForTurn leak memory or leave open connections?
3. Is the process spawn/kill lifecycle correct?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/runtime/client.ts", "src/runtime/agent-manager.ts"],
    priority: 100,
  })

  const exploreConductor = createTaskNode({
    type: "explore",
    title: "Explore: Conductor scheduler & dispatch",
    prompt: `Analyze the core orchestration loop:

## src/conductor/index.ts
\`\`\`typescript
${src("src/conductor/index.ts")}
\`\`\`

Focus on:
1. Is tick() re-entrant safe? Could two ticks overlap and double-dispatch a task?
2. Is the approval gate pause/resume logic race-condition free?
3. Does dispatch() handle all failure modes correctly?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/conductor/index.ts"],
    priority: 100,
  })

  const exploreMemory = createTaskNode({
    type: "explore",
    title: "Explore: SQLite store & memory bus",
    prompt: `Analyze the persistence layer:

## src/memory/store.ts
\`\`\`typescript
${src("src/memory/store.ts")}
\`\`\`

Focus on:
1. Are the SQL queries safe from injection?
2. Is WAL mode correctly configured for concurrent writes from multiple agents?
3. Any missing indexes that would hurt at scale (100+ tasks)?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/memory/store.ts"],
    priority: 100,
  })

  const exploreWorkspace = createTaskNode({
    type: "explore",
    title: "Explore: File lock & Git workspace",
    prompt: `Analyze workspace isolation:

## src/workspace/file-lock.ts
\`\`\`typescript
${src("src/workspace/file-lock.ts")}
\`\`\`

## src/workspace/git-manager.ts
\`\`\`typescript
${src("src/workspace/git-manager.ts")}
\`\`\`

Focus on:
1. Is the file lock TTL eviction thread-safe in JavaScript's single-threaded model?
2. Does tryMerge correctly handle all git conflict scenarios?
3. What happens if the process dies while holding locks?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/workspace/file-lock.ts", "src/workspace/git-manager.ts"],
    priority: 100,
  })

  dag.addTasks([exploreDAG, exploreRuntime, exploreConductor, exploreMemory, exploreWorkspace])

  // ── Phase 1: cross-cutting reviews (wait for all phase-0 explores) ──────────

  const phase0Ids = [exploreDAG.id, exploreRuntime.id, exploreConductor.id, exploreMemory.id, exploreWorkspace.id]

  const reviewCrashRecovery = createTaskNode({
    type: "review",
    title: "Review: Crash recovery correctness",
    prompt: `Review the crash recovery implementation:

## src/conductor/crash-recovery.ts
\`\`\`typescript
${src("src/conductor/crash-recovery.ts")}
\`\`\`

## src/conductor/dynamic-tasks.ts
\`\`\`typescript
${src("src/conductor/dynamic-tasks.ts")}
\`\`\`

The explore phase found issues in related modules. Evaluate:
1. If an agent crashes mid-task, are its SQLite writes rolled back or left partial?
2. Does the heartbeat interval interact badly with the scheduler tick interval?
3. Is the dynamic task deduplication logic correct under concurrent insertion?

Provide a severity score 1-10 for each finding.

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/conductor/crash-recovery.ts", "src/conductor/dynamic-tasks.ts"],
    priority: 80,
    dependsOn: phase0Ids,
  })

  const reviewTests = createTaskNode({
    type: "review",
    title: "Review: Test coverage gaps",
    prompt: `Review the test suite for coverage gaps:

## tests/dag.test.ts
\`\`\`typescript
${src("tests/dag.test.ts")}
\`\`\`

## tests/m3-unit.test.ts
\`\`\`typescript
${src("tests/m3-unit.test.ts")}
\`\`\`

Identify:
1. Which failure modes in the DAG engine are NOT covered by tests?
2. Which approval gate scenarios are missing?
3. What's the highest-risk untested path in the whole system?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["tests/dag.test.ts", "tests/m3-unit.test.ts"],
    priority: 80,
    dependsOn: phase0Ids,
  })

  const reviewPerf = createTaskNode({
    type: "review",
    title: "Review: Performance & scalability limits",
    prompt: `Evaluate performance characteristics for scaling to 20 agents on a 1000-file project:

Key files to consider (you've seen them from context):
- src/dag/engine.ts — O(n) scans on readyTasks(), conflictingRunning()
- src/memory/store.ts — SQLite tag filtering via LIKE
- src/conductor/index.ts — tick() loops over all idle agents every 500ms

Questions:
1. What's the complexity of the scheduler tick as tasks scale to 1000?
2. Will the SQLite tag LIKE query degrade with 10,000 memory entries?
3. At what agent count does the current architecture break down?

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: ["src/dag/engine.ts", "src/memory/store.ts", "src/conductor/index.ts"],
    priority: 70,
    dependsOn: phase0Ids,
  })

  dag.addTasks([reviewCrashRecovery, reviewTests, reviewPerf])

  // ── Phase 2: synthesis plan (waits for all reviews) ─────────────────────────

  const planTask = createTaskNode({
    type: "plan",
    title: "Synthesize: Improvement roadmap",
    prompt: `You are the lead architect reviewing findings from 5 explore agents and 3 review agents who analyzed the Swarm Conductor codebase.

Based on all shared context available to you, produce:

1. **Top 3 critical bugs** that need immediate fixing (with file:line if possible)
2. **Top 3 performance improvements** for scaling beyond 10 agents
3. **Top 3 missing features** for production readiness
4. **Recommended next sprint** (what to implement first and why)

Be specific and actionable. Reference actual code patterns you observed.

## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS`,
    scope: [],
    priority: 50,
    dependsOn: [reviewCrashRecovery.id, reviewTests.id, reviewPerf.id],
    forkContext: false,
  })

  dag.addTask(planTask)

  return {
    phase0: [exploreDAG, exploreRuntime, exploreConductor, exploreMemory, exploreWorkspace],
    phase1: [reviewCrashRecovery, reviewTests, reviewPerf],
    phase2: [planTask],
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true })

  console.log("╔═══════════════════════════════════════════════════════════╗")
  console.log("║  SWARM CONDUCTOR — SELF-ANALYSIS BENCHMARK                ║")
  console.log("╚═══════════════════════════════════════════════════════════╝")
  console.log()
  console.log(`Target   : ${PROJECT} (self)`)
  console.log(`Agents   : 5 explore + 3 review + 1 plan = 9 total`)
  console.log(`Phases   : 0 (explore) → 1 (review) → 2 (synthesize)`)
  console.log()

  const config = defaultConfig({
    projectPath: PROJECT,
    maxConcurrentAgents: 9,
    basePort: BASE_PORT,
    schedulerTickMs: 300,
    autoApprove: true,
    dynamicTasks: false,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
  })

  const conductor = new Conductor(config)
  await conductor.initialize()
  conductor.store.initRun(PROJECT)

  const { phase0, phase1, phase2 } = buildTaskGraph(conductor)
  const totalTasks = phase0.length + phase1.length + phase2.length
  console.log(`Task DAG: ${totalTasks} tasks`)
  console.log(`  Phase 0: ${phase0.length} explore (parallel)`)
  console.log(`  Phase 1: ${phase1.length} review  (parallel, after phase 0)`)
  console.log(`  Phase 2: ${phase2.length} plan    (sequential, after phase 1)`)
  console.log()

  // Spawn enough agents to cover phase 0 fully in parallel
  console.log("Spawning 9 agents...")
  const spawnStart = Date.now()
  await conductor.spawnAgents([
    "explore", "explore", "explore", "explore", "explore",
    "review", "review", "review",
    "general",
  ])
  const spawnMs = Date.now() - spawnStart
  console.log(`✓ Spawned 9 agents in ${(spawnMs / 1000).toFixed(1)}s`)
  console.log()

  // Live progress
  let doneCount = 0
  const phaseNames: Record<string, string> = {}
  for (const t of phase0) phaseNames[t.id] = "explore"
  for (const t of phase1) phaseNames[t.id] = "review"
  for (const t of phase2) phaseNames[t.id] = "plan"

  conductor.onEvent(e => {
    if (e.kind === "task.status_changed" && e.payload["next"] === "done") {
      doneCount++
      const id = e.payload["taskId"] as string
      const task = conductor.taskDag.getTask(id)
      const phase = phaseNames[id] ?? "?"
      process.stdout.write(`\r  [${doneCount}/${totalTasks}] done — last: [${phase}] ${task?.title?.slice(0, 50) ?? id}   `)
    }
  })

  console.log("Running self-analysis...")
  const runStart = Date.now()
  conductor.startScheduler()
  const result = await conductor.waitForCompletion(900_000)
  const totalMs = Date.now() - runStart
  console.log("\n")

  // ── Results ──────────────────────────────────────────────────────────────────

  const stats = conductor.store.taskStats()
  const allTasks = conductor.taskDag.allTasks()
  const doneTasks = allTasks.filter(t => t.status === "done")
  const timings = doneTasks
    .filter(t => t.startedAt && t.completedAt)
    .map(t => t.completedAt! - t.startedAt!)

  console.log("╔═══════════════════════════════════════════════════════════╗")
  console.log("║  RESULTS                                                  ║")
  console.log("╚═══════════════════════════════════════════════════════════╝")
  console.log()
  console.log(`Status          : ${result}`)
  console.log(`Wall time       : ${(totalMs / 1000).toFixed(1)}s`)
  console.log(`Agent spawn     : ${(spawnMs / 1000).toFixed(1)}s`)
  console.log()
  console.log(`Tasks done      : ${stats.done}/${stats.total}`)
  console.log(`Tasks failed    : ${stats.failed}`)
  if (timings.length > 0) {
    const avg = timings.reduce((a, b) => a + b, 0) / timings.length
    console.log(`Task avg time   : ${(avg / 1000).toFixed(1)}s`)
    console.log(`Task min/max    : ${(Math.min(...timings) / 1000).toFixed(1)}s / ${(Math.max(...timings) / 1000).toFixed(1)}s`)
  }
  console.log()

  // Print synthesis output
  const planNode = allTasks.find(t => t.title.startsWith("Synthesize"))
  if (planNode?.output) {
    console.log("╔═══════════════════════════════════════════════════════════╗")
    console.log("║  SYNTHESIS: IMPROVEMENT ROADMAP                           ║")
    console.log("╚═══════════════════════════════════════════════════════════╝")
    console.log()
    console.log(planNode.output.summary)
    console.log()
    if (planNode.output.risks.length > 0) {
      console.log("Risks flagged:")
      for (const r of planNode.output.risks) console.log(`  • ${r}`)
    }
    if (planNode.output.blockers.length > 0) {
      console.log("Blockers:")
      for (const b of planNode.output.blockers) console.log(`  • ${b}`)
    }
  }

  // Write report
  const report = {
    timestamp: new Date().toISOString(),
    target: PROJECT,
    mode: "self-analysis",
    agentCount: 9,
    result,
    totalWallMs: totalMs,
    spawnMs,
    tasks: { total: stats.total, done: stats.done, failed: stats.failed },
    timings: timings.length > 0 ? {
      avg: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
      min: Math.min(...timings),
      max: Math.max(...timings),
    } : null,
    synthesis: planNode?.output?.summary ?? null,
    runId: conductor.runId,
  }
  const reportPath = join(REPORT_DIR, "self-analysis-report.json")
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`\nFull report → ${reportPath}`)

  await conductor.shutdown()
}

main().catch(err => { console.error("Failed:", err); process.exit(1) })
