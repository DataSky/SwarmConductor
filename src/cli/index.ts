#!/usr/bin/env bun
import { Conductor } from "../conductor"
import { createTaskNode } from "../dag/engine"
import { defaultConfig } from "../dag/types"
import type { ConductorConfig, ConductorEvent } from "../dag/types"
import { writeFileSync } from "fs"
import { join } from "path"

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
}

function statusColor(s: string): string {
  switch (s) {
    case "done":        return C.green
    case "running":     return C.cyan
    case "ready":       return C.blue
    case "blocked":     return C.dim
    case "failed":      return C.red
    case "interrupted": return C.yellow
    default:            return C.reset
  }
}

function bar(done: number, total: number, width = 28): string {
  if (total === 0) return `[${" ".repeat(width)}]`
  const filled = Math.round((done / total) * width)
  return `[${C.green}${"█".repeat(filled)}${C.reset}${"░".repeat(width - filled)}]`
}

function renderDashboard(conductor: Conductor, eventLog: string[]): void {
  const s = conductor.status()
  const tasks = conductor.taskDag.allTasks()
  const now = new Date().toISOString().slice(11, 19)

  process.stdout.write("\x1b[2J\x1b[H")

  console.log(`${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}║         SWARM CONDUCTOR  v0.1.0    ${C.gray}${now}${C.reset}${C.bold}  ║${C.reset}`)
  console.log(`${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`)
  console.log()

  const done = s.tasks.done
  const total = s.tasks.total
  const pct = total === 0 ? 0 : Math.round((done / total) * 100)
  console.log(`  Phase ${C.bold}${s.phase}${C.reset}  ${bar(done, total)}  ${done}/${total} (${pct}%)`)
  console.log(`  ${C.cyan}running:${s.tasks.running}${C.reset}  ${C.blue}ready:${s.tasks.ready}${C.reset}  ${C.dim}blocked:${s.tasks.blocked}${C.reset}  ${C.red}failed:${s.tasks.failed}${C.reset}`)
  console.log()

  console.log(`  ${C.bold}Agents${C.reset}  idle:${C.green}${s.agents.idle}${C.reset}  busy:${C.cyan}${s.agents.busy}${C.reset}  crashed:${C.red}${s.agents.crashed}${C.reset}  locks:${s.locks}`)
  if (s.pendingApprovals > 0) {
    console.log(`  ${C.yellow}${C.bold}⏸  ${s.pendingApprovals} approval(s) pending — scheduler paused${C.reset}`)
  }
  console.log()

  const shown = tasks.slice(0, 15)
  console.log(`  ${C.bold}${"STATUS".padEnd(11)} ${"TYPE".padEnd(11)} ${"TITLE".padEnd(36)}${C.reset}`)
  console.log(`  ${"─".repeat(60)}`)
  for (const t of shown) {
    const sc = statusColor(t.status)
    const dyn = t.dependsOn.length > 0 && t.retryCount === 0 && t.status === "ready" ? `${C.magenta}↑${C.reset}` : " "
    console.log(`  ${sc}${t.status.padEnd(11)}${C.reset} ${C.dim}${t.type.padEnd(11)}${C.reset} ${dyn}${t.title.slice(0, 36)}`)
  }
  if (tasks.length > 15) {
    console.log(`  ${C.dim}... and ${tasks.length - 15} more tasks${C.reset}`)
  }
  console.log()

  console.log(`  ${C.bold}Recent events${C.reset}`)
  console.log(`  ${"─".repeat(60)}`)
  for (const line of eventLog.slice(-6)) {
    console.log(`  ${C.gray}${line}${C.reset}`)
  }
}

// ─── Final report printed to terminal after run ───────────────────────────────

function printFinalReport(conductor: Conductor, wallMs: number, outputPath: string | null): void {
  const tasks = conductor.taskDag.allTasks()
  const done  = tasks.filter(t => t.status === "done")
  const failed = tasks.filter(t => t.status === "failed")
  const timings = done
    .filter(t => t.startedAt && t.completedAt)
    .map(t => t.completedAt! - t.startedAt!)

  // ── Terminal output ────────────────────────────────────────────────────────
  console.log()
  console.log(`${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}║  RUN SUMMARY                                     ║${C.reset}`)
  console.log(`${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`)
  console.log()
  console.log(`  Tasks   ${C.green}${done.length} done${C.reset}  ${failed.length > 0 ? `${C.red}${failed.length} failed${C.reset}` : `${C.dim}0 failed${C.reset}`}  / ${tasks.length} total`)
  if (timings.length > 0) {
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length / 1000)
    const min = Math.round(Math.min(...timings) / 1000)
    const max = Math.round(Math.max(...timings) / 1000)
    console.log(`  Timing  avg ${avg}s  min ${min}s  max ${max}s  wall ${Math.round(wallMs / 1000)}s`)
  }
  console.log(`  Run ID  ${C.dim}${conductor.runId}${C.reset}`)
  console.log()

  // Per-task summaries
  if (done.length > 0) {
    console.log(`${C.bold}  Task Summaries${C.reset}`)
    console.log(`  ${"─".repeat(60)}`)
    for (const t of done) {
      console.log()
      console.log(`  ${C.green}✓${C.reset} ${C.bold}${t.title}${C.reset}  ${C.dim}[${t.type}]${C.reset}`)
      if (t.output?.summary) {
        for (const line of t.output.summary.split("\n").slice(0, 4)) {
          if (line.trim()) console.log(`    ${line.trim()}`)
        }
      }
      if (t.output?.risks.length) {
        for (const r of t.output.risks.slice(0, 2)) {
          console.log(`    ${C.yellow}⚠${C.reset} ${r.trim()}`)
        }
      }
      if (t.output?.blockers.length) {
        for (const b of t.output.blockers.slice(0, 2)) {
          console.log(`    ${C.red}✗${C.reset} ${b.trim()}`)
        }
      }
    }
    console.log()
  }

  if (failed.length > 0) {
    console.log(`${C.bold}  Failed Tasks${C.reset}`)
    console.log(`  ${"─".repeat(60)}`)
    for (const t of failed) {
      console.log(`  ${C.red}✗${C.reset} ${t.title}  ${C.dim}${t.error ?? "unknown error"}${C.reset}`)
    }
    console.log()
  }

  // DB hint
  console.log(`  ${C.dim}Full output → .conductor/conductor.db (run: ${conductor.runId})${C.reset}`)

  // ── JSON output ────────────────────────────────────────────────────────────
  const report = {
    runId: conductor.runId,
    timestamp: new Date().toISOString(),
    result: failed.length === 0 ? "completed" : "partial",
    wallMs,
    tasks: {
      total: tasks.length,
      done: done.length,
      failed: failed.length,
    },
    timings: timings.length > 0 ? {
      avgMs: Math.round(timings.reduce((a, b) => a + b, 0) / timings.length),
      minMs: Math.min(...timings),
      maxMs: Math.max(...timings),
    } : null,
    summaries: done.map(t => ({
      id: t.id,
      title: t.title,
      type: t.type,
      summary: t.output?.summary ?? "",
      risks: t.output?.risks ?? [],
      blockers: t.output?.blockers ?? [],
      changes: t.output?.changes ?? [],
      durationMs: (t.startedAt && t.completedAt) ? t.completedAt - t.startedAt : null,
    })),
    errors: failed.map(t => ({ id: t.id, title: t.title, error: t.error })),
  }

  const dest = outputPath ?? join(process.cwd(), ".conductor", `report-${conductor.runId}.json`)
  writeFileSync(dest, JSON.stringify(report, null, 2))
  console.log(`  ${C.dim}JSON report  → ${dest}${C.reset}`)
  console.log()
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [, , command = "status", ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg?.startsWith("--")) {
      const key = arg.slice(2)
      const next = rest[i + 1]
      if (next && !next.startsWith("--")) { flags[key] = next; i++ }
      else flags[key] = "true"
    }
  }
  return { command: command ?? "status", flags }
}

// ─── Demo run ─────────────────────────────────────────────────────────────────

async function runDemo(config: ConductorConfig): Promise<void> {
  console.log("Swarm Conductor — architecture demo")
  console.log(`Project: ${config.projectPath}`)
  console.log()

  const conductor = new Conductor(config)
  await conductor.initialize()

  const exploreFiles = createTaskNode({ type: "explore", title: "Scan file structure",        prompt: "p", scope: [config.projectPath], priority: 100 })
  const exploreTests = createTaskNode({ type: "explore", title: "Analyze test coverage",      prompt: "p", scope: [config.projectPath], priority: 90 })
  const exploreAPIs  = createTaskNode({ type: "explore", title: "Map API boundaries",          prompt: "p", scope: [config.projectPath], priority: 90 })
  const planTask     = createTaskNode({ type: "plan",    title: "Generate implementation plan", prompt: "p", scope: [], priority: 80, dependsOn: [exploreFiles.id, exploreTests.id, exploreAPIs.id] })

  conductor.taskDag.addTasks([exploreFiles, exploreTests, exploreAPIs, planTask])

  const s = conductor.status()
  console.log(`Task DAG: ${s.tasks.total} tasks  |  ${s.tasks.ready} ready (parallel)  |  ${s.tasks.blocked} blocked`)
  console.log()

  for (const task of conductor.taskDag.allTasks()) {
    const sc = statusColor(task.status)
    const dep = task.dependsOn.length > 0 ? `→ blocked by ${task.dependsOn.length}` : "→ ready"
    console.log(`  ${sc}[${task.status.padEnd(9)}]${C.reset} [${task.type.padEnd(10)}] ${task.title.padEnd(40)} ${dep}`)
  }

  console.log()
  console.log(`Deadlock check: ${conductor.taskDag.detectDeadlock().length === 0 ? `${C.green}clean${C.reset}` : `${C.red}cycle detected!${C.reset}`}`)
  console.log()
  console.log("Features:")
  console.log(`  ${C.green}✓${C.reset} Dynamic task insertion (BLOCKERS → new implement tasks)`)
  console.log(`  ${C.green}✓${C.reset} Approval gate (phase boundary / high-risk)`)
  console.log(`  ${C.green}✓${C.reset} Crash recovery (heartbeat + auto-restart)`)
  console.log(`  ${C.green}✓${C.reset} Real-time dashboard + final summary report`)
  console.log(`  ${C.green}✓${C.reset} JSON report saved after every run`)
  console.log()
  console.log(`To run with live agents:`)
  console.log(`  swarm run --project /path/to/repo --agents 5 --auto-approve`)
}

// ─── Live run ─────────────────────────────────────────────────────────────────

async function runLive(config: ConductorConfig, outputPath: string | null): Promise<void> {
  const conductor = new Conductor(config)
  await conductor.initialize()

  const eventLog: string[] = []
  conductor.onEvent((e: ConductorEvent) => {
    const ts = new Date(e.timestamp).toISOString().slice(11, 19)
    const detail = e.payload["taskId"] ? ` task:${String(e.payload["taskId"]).slice(0, 8)}` : ""
    eventLog.push(`[${ts}] ${e.kind}${detail}`)
  })

  const exploreTask = createTaskNode({
    type: "explore",
    title: "Explore project",
    prompt: [
      "Explore the current directory and provide a summary.",
      "",
      "## SUMMARY",
      "[your summary here]",
      "## CHANGES",
      "## EVIDENCE",
      "## RISKS",
      "## BLOCKERS",
    ].join("\n"),
    scope: [config.projectPath],
    priority: 100,
  })

  conductor.taskDag.addTask(exploreTask)
  await conductor.spawnAgents(["general"])

  const renderInterval = setInterval(() => renderDashboard(conductor, eventLog), 500)

  const startMs = Date.now()
  conductor.startScheduler()
  const result = await conductor.waitForCompletion(600_000)
  const wallMs = Date.now() - startMs

  clearInterval(renderInterval)

  // Clear dashboard, print persistent final report
  process.stdout.write("\x1b[2J\x1b[H")
  console.log(result === "completed"
    ? `${C.green}${C.bold}✓ Run completed${C.reset}`
    : `${C.red}${C.bold}✗ Run finished with status: ${result}${C.reset}`)

  printFinalReport(conductor, wallMs, outputPath)

  await conductor.shutdown()
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)

  const config = defaultConfig({
    projectPath: flags["project"] ?? process.cwd(),
    maxConcurrentAgents: flags["agents"] ? parseInt(flags["agents"]) : 10,
    autoApprove: flags["auto-approve"] === "true",
    codewhalebin: flags["bin"] ?? "codewhale",
    dynamicTasks: flags["dynamic-tasks"] !== "false",
  })

  const outputPath = flags["output"] ?? null

  switch (command) {
    case "demo":
      await runDemo(config)
      break
    case "run":
      await runLive(config, outputPath)
      break
    default:
      console.log(`${C.bold}Swarm Conductor v0.1.0${C.reset}`)
      console.log()
      console.log("Commands:")
      console.log("  demo    Verify architecture (no live agents)")
      console.log("  run     Live run with dashboard + final summary report")
      console.log()
      console.log("Options:")
      console.log("  --project <path>       Target project (default: cwd)")
      console.log("  --agents <n>           Max concurrent agents (default: 10)")
      console.log("  --auto-approve         Auto-approve all tool calls")
      console.log("  --dynamic-tasks false  Disable dynamic task insertion")
      console.log("  --output <path>        Save JSON report to this path")
      console.log("  --bin <path>           Path to codewhale binary")
  }
}

main().catch(err => { console.error("Fatal:", err); process.exit(1) })
