#!/usr/bin/env bun
import { Conductor } from "../conductor"
import { createTaskNode } from "../dag/engine"
import { defaultConfig } from "../dag/types"
import type { ConductorConfig } from "../dag/types"
import { writeFileSync } from "fs"
import { join } from "path"
import { loadTaskFile } from "./task-file"
import { goalToTaskGraph } from "./goal-planner"
import { InteractiveRunner } from "./interactive"
import { LiveView, type VerboseLevel } from "./live-view"

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m", gray: "\x1b[90m",
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


// ─── Final report ─────────────────────────────────────────────────────────────

function printFinalReport(conductor: Conductor, wallMs: number, outputPath: string | null): void {
  const tasks  = conductor.taskDag.allTasks()
  const done   = tasks.filter(t => t.status === "done")
  const failed = tasks.filter(t => t.status === "failed")
  const timings = done
    .filter(t => t.startedAt && t.completedAt)
    .map(t => t.completedAt! - t.startedAt!)

  console.log()
  console.log(`${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`)
  console.log(`${C.bold}║  RUN SUMMARY                                     ║${C.reset}`)
  console.log(`${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`)
  console.log()
  console.log(`  Tasks   ${C.green}${done.length} done${C.reset}  ${failed.length > 0 ? `${C.red}${failed.length} failed${C.reset}` : `${C.dim}0 failed${C.reset}`}  / ${tasks.length} total`)
  if (timings.length > 0) {
    const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length / 1000)
    console.log(`  Timing  avg ${avg}s  wall ${Math.round(wallMs / 1000)}s`)
  }

  // Token usage breakdown
  try {
    const tok = conductor.store.tokenStats()
    if (tok.totalTokens > 0) {
      console.log()
      console.log(`${C.bold}  Token Usage${C.reset}`)
      console.log(`  ${"─".repeat(60)}`)
      console.log(`  Total      ${C.bold}${tok.totalTokens.toLocaleString()}${C.reset} tokens`)
      console.log(`  Input      ${tok.inputTokens.toLocaleString()}  (${C.yellow}cache hit: ${tok.cacheHitTokens.toLocaleString()}${C.reset}  miss: ${tok.cacheMissTokens.toLocaleString()})`)
      console.log(`  Output     ${tok.outputTokens.toLocaleString()}`)
      console.log(`  Cache rate ${C.green}${tok.cacheHitRate}%${C.reset}  ${tok.cacheHitRate >= 50 ? "(good)" : tok.cacheHitRate > 0 ? "(low — consider fork_context)" : "(no cache)"}`)
      // Per-task breakdown
      const withUsage = done.filter(t => t.tokenUsage)
      if (withUsage.length > 0) {
        console.log()
        console.log(`  ${C.dim}${"Task".padEnd(38)} ${"Input".padStart(8)} ${"Output".padStart(7)} ${"CacheHit%".padStart(10)}${C.reset}`)
        for (const t of withUsage) {
          const u = t.tokenUsage!
          const hitPct = u.inputTokens > 0 ? Math.round(u.cacheHitTokens / u.inputTokens * 100) : 0
          const hitColor = hitPct >= 50 ? C.green : hitPct > 0 ? C.yellow : C.red
          console.log(`  ${t.title.slice(0, 38).padEnd(38)} ${u.inputTokens.toLocaleString().padStart(8)} ${u.outputTokens.toLocaleString().padStart(7)} ${hitColor}${String(hitPct + "%").padStart(10)}${C.reset}`)
        }
      }
    }
  } catch { /* db closed or no data */ }
  console.log(`  Run ID  ${C.dim}${conductor.runId}${C.reset}`)
  console.log()

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
      for (const r of (t.output?.risks ?? []).slice(0, 2)) {
        console.log(`    ${C.yellow}⚠${C.reset} ${r.trim()}`)
      }
      for (const b of (t.output?.blockers ?? []).slice(0, 2)) {
        console.log(`    ${C.red}✗${C.reset} ${b.trim()}`)
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

  const dest = outputPath ?? join(process.cwd(), ".conductor", `report-${conductor.runId}.json`)
  const report = {
    runId: conductor.runId,
    timestamp: new Date().toISOString(),
    result: failed.length === 0 ? "completed" : "partial",
    wallMs,
    tasks: { total: tasks.length, done: done.length, failed: failed.length },
    summaries: done.map(t => ({
      id: t.id, title: t.title, type: t.type,
      summary: t.output?.summary ?? "",
      risks: t.output?.risks ?? [],
      blockers: t.output?.blockers ?? [],
      changes: t.output?.changes ?? [],
      durationMs: (t.startedAt && t.completedAt) ? t.completedAt - t.startedAt : null,
      tokenUsage: t.tokenUsage ?? null,
    })),
    errors: failed.map(t => ({ id: t.id, title: t.title, error: t.error })),
    tokenTotals: (() => { try { return conductor.store.tokenStats() } catch { return null } })(),
  }
  writeFileSync(dest, JSON.stringify(report, null, 2))
  console.log(`  ${C.dim}Full output  → .conductor/conductor.db${C.reset}`)
  console.log(`  ${C.dim}JSON report  → ${dest}${C.reset}`)
  console.log()
}

// ─── CLI argument parsing ─────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [, , command = "help", ...rest] = argv
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
  return { command: command ?? "help", flags }
}

// ─── Demo mode ────────────────────────────────────────────────────────────────

async function runDemo(config: ConductorConfig): Promise<void> {
  console.log("Swarm Conductor — architecture demo")
  console.log(`Project: ${config.projectPath}`)
  console.log()

  const conductor = new Conductor(config)
  await conductor.initialize()

  const e1 = createTaskNode({ type: "explore", title: "Scan file structure",         prompt: "p", scope: [config.projectPath], priority: 100 })
  const e2 = createTaskNode({ type: "explore", title: "Analyze test coverage",       prompt: "p", scope: [config.projectPath], priority: 90 })
  const e3 = createTaskNode({ type: "explore", title: "Map API boundaries",           prompt: "p", scope: [config.projectPath], priority: 90 })
  const p1 = createTaskNode({ type: "plan",    title: "Generate implementation plan", prompt: "p", scope: [], priority: 80, dependsOn: [e1.id, e2.id, e3.id] })

  conductor.taskDag.addTasks([e1, e2, e3, p1])

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
  console.log("How to run:")
  console.log(`  ${C.cyan}swarm run --goal "描述你的目标"${C.reset}`)
  console.log(`  ${C.cyan}swarm run --tasks tasks.yaml${C.reset}`)
  console.log(`  ${C.cyan}swarm run --goal "..." --no-interact${C.reset}  ${C.dim}(全自动，不打断)${C.reset}`)
}

// ─── Core run logic ───────────────────────────────────────────────────────────

async function runLive(config: ConductorConfig, flags: Record<string, string>): Promise<void> {
  const tasksFile  = flags["tasks"]  ?? null
  const goal       = flags["goal"]   ?? null
  const outputPath = flags["output"] ?? null
  const noInteract = flags["no-interact"] === "true" || flags["auto-approve"] === "true"
  const verbose: VerboseLevel =
    flags["stream"] === "true"  ? "stream"  :
    flags["quiet"]  === "true"  ? "quiet"   : "summary"

  if (!tasksFile && !goal) {
    console.error(`${C.red}Error:${C.reset} Provide --goal "..." or --tasks <file>`)
    console.error(`  swarm run --goal "重构 src/auth 模块"`)
    console.error(`  swarm run --tasks tasks.yaml`)
    process.exit(1)
  }

  const conductor = new Conductor(config)
  await conductor.initialize()

  // ── Load tasks ─────────────────────────────────────────────────────────────
  let taskNodes = []
  let preamble = ""

  if (tasksFile) {
    const result = loadTaskFile(tasksFile)
    taskNodes = result.nodes
    preamble = result.goal ? `Goal: ${result.goal}\n` : ""
    if (result.agents && !flags["agents"]) config.maxConcurrentAgents = result.agents
    if (result.autoApprove !== null && !flags["auto-approve"]) config.autoApprove = result.autoApprove
  } else {
    const result = goalToTaskGraph(goal!, config.projectPath)
    taskNodes = result.nodes
    preamble = `Goal: ${goal}\n\n${result.description}`
  }

  if (preamble) {
    console.log(preamble)
    console.log()
  }

  console.log(`Tasks: ${taskNodes.length}`)
  for (const t of taskNodes) {
    const dep = t.dependsOn.length > 0 ? ` ${C.dim}(after ${t.dependsOn.length} task(s))${C.reset}` : ""
    console.log(`  ${C.dim}[${t.type.padEnd(10)}]${C.reset} ${t.title}${dep}`)
  }
  console.log()

  conductor.taskDag.addTasks(taskNodes)

  // ── Spawn agents ───────────────────────────────────────────────────────────
  const agentCount = Math.min(config.maxConcurrentAgents, taskNodes.length)
  const roles = Array(agentCount).fill("general") as "general"[]
  console.log(`Spawning ${agentCount} agents...`)
  await conductor.spawnAgents(roles)
  console.log(`✓ Ready\n`)

  // ── Start LiveView (replaces old dashboard + interactive runner) ───────────
  const liveView = new LiveView(conductor, verbose)
  liveView.start()

  const interactive = new InteractiveRunner(conductor, noInteract, liveView)
  interactive.attach()

  const startMs = Date.now()
  conductor.startScheduler()
  const result = await conductor.waitForCompletion(3_600_000)
  const wallMs = Date.now() - startMs

  liveView.stop()

  // Clear screen, then print final report
  process.stdout.write("\x1b[2J\x1b[H")
  console.log(result === "completed"
    ? `${C.green}${C.bold}✓ Run completed${C.reset}`
    : `${C.red}${C.bold}✗ Run finished with status: ${result}${C.reset}`)

  printFinalReport(conductor, wallMs, outputPath)
  await conductor.shutdown()
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`${C.bold}Swarm Conductor v0.1.1${C.reset}`)
  console.log()
  console.log(`${C.bold}Usage${C.reset}`)
  console.log(`  swarm demo                          验证架构（无需 CodeWhale）`)
  console.log(`  swarm run --goal "..."              用自然语言描述目标`)
  console.log(`  swarm run --tasks <file>            从 YAML 任务文件运行`)
  console.log()
  console.log(`${C.bold}Options${C.reset}`)
  console.log(`  --goal <text>          自然语言描述任务目标`)
  console.log(`  --tasks <path>         YAML 任务文件路径`)
  console.log(`  --project <path>       目标项目目录 ${C.dim}(默认: cwd)${C.reset}`)
  console.log(`  --agents <n>           最大并发 agent 数 ${C.dim}(默认: 5)${C.reset}`)
  console.log(`  --auto-approve         自动批准所有 tool call`)
  console.log(`  --no-interact          全自动模式，不在任务间暂停`)
  console.log(`  --quiet                只显示任务完成一行（无摘要）`)
  console.log(`  --stream               显示完整 token 流（调试用）`)
  console.log(`  --output <path>        JSON 报告保存路径`)
  console.log(`  --dynamic-tasks false  关闭动态任务生成`)
  console.log(`  --bin <path>           CodeWhale 二进制路径`)
  console.log()
  console.log(`${C.bold}Examples${C.reset}`)
  console.log(`  swarm run --goal "重构 src/auth 模块，把 JWT 换成 session"`)
  console.log(`  swarm run --tasks tasks.yaml --agents 8`)
  console.log(`  swarm run --goal "找出所有性能问题" --no-interact --output report.json`)
  console.log()
  console.log(`${C.bold}Task file format${C.reset}  ${C.dim}(tasks.yaml)${C.reset}`)
  console.log(`  goal: "整体目标描述"`)
  console.log(`  agents: 5`)
  console.log(`  phases:`)
  console.log(`    - name: explore`)
  console.log(`      tasks:`)
  console.log(`        - title: "分析 auth 模块"`)
  console.log(`          type: explore`)
  console.log(`          scope: ["src/auth"]`)
  console.log(`    - name: implement`)
  console.log(`      tasks:`)
  console.log(`        - title: "替换 JWT"`)
  console.log(`          type: implement`)
  console.log(`          depends_on_phase: explore`)
  console.log()
  console.log(`  ${C.dim}Docs: https://github.com/DataSky/SwarmConductor/tree/main/docs${C.reset}`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv)

  const config = defaultConfig({
    projectPath: flags["project"] ?? process.cwd(),
    maxConcurrentAgents: flags["agents"] ? parseInt(flags["agents"]) : 5,
    autoApprove: flags["auto-approve"] === "true",
    codewhalebin: flags["bin"] ?? "codewhale",
    dynamicTasks: flags["dynamic-tasks"] !== "false",
  })

  switch (command) {
    case "demo":
      await runDemo(config)
      break
    case "run":
      await runLive(config, flags)
      break
    default:
      printHelp()
  }
}

main().catch(err => { console.error(`${C.red}Fatal:${C.reset}`, err.message ?? err); process.exit(1) })
