#!/usr/bin/env bun
import { Conductor } from "../conductor"
import { createTaskNode } from "../dag/engine"
import type { ConductorConfig } from "../dag/types"

// ─── Default config ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ConductorConfig = {
  projectPath: process.cwd(),
  maxConcurrentAgents: 10,
  basePort: 7878,
  fileLockTtlMs: 300_000,
  deadlockTimeoutMs: 300_000,
  schedulerTickMs: 500,
  autoApprove: false,
  codewhalebin: "codewhale",
}

// ─── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [, , command = "status", ...rest] = argv
  const flags: Record<string, string> = {}

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg?.startsWith("--")) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith("--")) {
        flags[key] = next
        i++
      } else {
        flags[key] = "true"
      }
    }
  }

  return { command: command ?? "status", flags }
}

// ─── Demo: build a DAG and verify architecture ───────────────────────────────

async function runDemo(config: ConductorConfig): Promise<void> {
  console.log("Starting Swarm Conductor demo (no live CodeWhale instances)...")
  console.log(`Project: ${config.projectPath}`)
  console.log()

  const conductor = new Conductor(config)
  await conductor.initialize()

  // Phase 0: exploration tasks (all run in parallel, no deps)
  const exploreFiles = createTaskNode({
    type: "explore",
    title: "Scan file structure",
    prompt: "List all source files, their sizes, and module boundaries.",
    scope: [config.projectPath],
    priority: 100,
  })

  const exploreTests = createTaskNode({
    type: "explore",
    title: "Analyze test coverage",
    prompt: "Find all test files and identify untested modules.",
    scope: [config.projectPath],
    priority: 90,
  })

  const exploreAPIs = createTaskNode({
    type: "explore",
    title: "Map API boundaries",
    prompt: "Document all public interfaces and external dependencies.",
    scope: [config.projectPath],
    priority: 90,
  })

  // Phase 1: planning (waits for all explore tasks)
  const planTask = createTaskNode({
    type: "plan",
    title: "Generate implementation plan",
    prompt: "Based on exploration results, generate a prioritized implementation plan.",
    scope: [],
    priority: 80,
    dependsOn: [exploreFiles.id, exploreTests.id, exploreAPIs.id],
  })

  conductor.taskDag.addTasks([exploreFiles, exploreTests, exploreAPIs, planTask])

  conductor.onEvent(e => {
    const ts = new Date(e.timestamp).toISOString().slice(11, 19)
    console.log(`[${ts}] ${e.kind}`)
  })

  const s = conductor.status()
  console.log("Task DAG initialized:")
  console.log(`  Total tasks : ${s.tasks.total}`)
  console.log(`  Ready now   : ${s.tasks.ready}  (no dependencies — can run in parallel)`)
  console.log(`  Blocked     : ${s.tasks.total - s.tasks.ready}  (waiting for deps)`)
  console.log()

  for (const task of conductor.taskDag.allTasks()) {
    const deps = task.dependsOn.length > 0 ? ` → blocked by ${task.dependsOn.length} task(s)` : " → ready"
    const line = `  [${task.status.padEnd(9)}] [${task.type.padEnd(10)}] [${task.role.padEnd(11)}] ${task.title}${deps}`
    console.log(line)
  }

  console.log()
  console.log("Scope conflict check:")
  const conflicts = conductor.taskDag.conflictingRunning(exploreFiles.scope)
  console.log(`  Conflicts for exploreFiles scope: ${conflicts.length} (expected 0 — nothing running yet)`)

  console.log()
  console.log("Deadlock check:")
  const cycle = conductor.taskDag.detectDeadlock()
  console.log(`  Cycle detected: ${cycle.length > 0 ? cycle.join(" -> ") : "none ✓"}`)

  console.log()
  console.log("Architecture verified. Milestone 1 complete.")
  console.log()
  console.log("Next: bun run dev demo --project /your/real/project --agents 5")
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)

  const config: ConductorConfig = {
    ...DEFAULT_CONFIG,
    projectPath: flags["project"] ?? DEFAULT_CONFIG.projectPath,
    maxConcurrentAgents: flags["agents"] ? parseInt(flags["agents"]) : DEFAULT_CONFIG.maxConcurrentAgents,
    autoApprove: flags["auto-approve"] === "true",
    codewhalebin: flags["bin"] ?? DEFAULT_CONFIG.codewhalebin,
  }

  switch (command) {
    case "demo":
    case "run":
      await runDemo(config)
      break

    default:
      console.log("Swarm Conductor v0.1.0")
      console.log()
      console.log("Commands:")
      console.log("  demo     Verify architecture with a sample task DAG (no live agents)")
      console.log()
      console.log("Options:")
      console.log("  --project <path>    Target project directory (default: cwd)")
      console.log("  --agents <n>        Max concurrent agents (default: 10)")
      console.log("  --auto-approve      Auto-approve all tool calls")
      console.log("  --bin <path>        Path to codewhale binary")
  }
}

main().catch(err => {
  console.error("Fatal:", err)
  process.exit(1)
})
