/**
 * Benchmark: 10 agents on oh-my-opencode (418 TS files).
 * Measures: spawn time, parallel dispatch throughput, token usage, total wall time.
 *
 * Run: bun run src/bench/run-benchmark.ts
 * (Requires DEEPSEEK_API_KEY in env)
 */
import { Conductor } from "../conductor"
import { createTaskNode } from "../dag/engine"
import { defaultConfig } from "../dag/types"
import { readdirSync, writeFileSync, existsSync } from "fs"
import { join, relative } from "path"

const TARGET = "/Users/wangteng06/AiCode/oh-my-opencode"
const CONDUCTOR_DIR = join(process.cwd(), ".conductor-bench")
const AGENT_COUNT = 10
const BASE_PORT = 18500

// ─── Collect TypeScript files grouped by directory ────────────────────────────

function collectTsDirs(root: string): Map<string, string[]> {
  const dirs = new Map<string, string[]>()
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist") {
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const rel = relative(root, dir)
        const existing = dirs.get(rel) ?? []
        existing.push(full)
        dirs.set(rel, existing)
      }
    }
  }
  walk(root)
  return dirs
}

// ─── Main benchmark ───────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(TARGET)) {
    console.error(`Target not found: ${TARGET}`)
    process.exit(1)
  }

  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  SWARM CONDUCTOR BENCHMARK — M4                         ║")
  console.log("╚══════════════════════════════════════════════════════════╝")
  console.log()
  console.log(`Target   : ${TARGET}`)
  console.log(`Agents   : ${AGENT_COUNT}`)
  console.log()

  // Collect directory-level explore tasks
  const dirs = collectTsDirs(TARGET)
  console.log(`Dirs with TS files: ${dirs.size}`)

  // Group into at most AGENT_COUNT buckets for parallel exploration
  const buckets: Array<{ label: string; files: string[] }> = []
  const entries = Array.from(dirs.entries()).sort(([, a], [, b]) => b.length - a.length)

  for (const [dir, files] of entries) {
    const existing = buckets.find(b => b.files.length < 8)
    if (existing) {
      existing.label += `, ${dir}`
      existing.files.push(...files)
    } else {
      buckets.push({ label: dir || "root", files: [...files] })
    }
  }

  const taskCount = Math.min(buckets.length, AGENT_COUNT)
  console.log(`Explore tasks: ${taskCount} (${buckets.slice(0, taskCount).map(b => b.files.length + " files").join(", ")})`)
  console.log()

  const config = defaultConfig({
    projectPath: TARGET,
    maxConcurrentAgents: AGENT_COUNT,
    basePort: BASE_PORT,
    schedulerTickMs: 300,
    autoApprove: true,
    dynamicTasks: false,
    heartbeatIntervalMs: 60_000,
    heartbeatTimeoutMs: 120_000,
  })

  const conductor = new Conductor(config)
  await conductor.initialize()
  conductor.store.initRun(TARGET)

  // Write project map skeleton to shared memory
  conductor.store.writeMemory({
    layer: "project_map",
    agentId: "bench-init",
    taskId: "init",
    content: `Project: oh-my-opencode\nLanguage: TypeScript\nFiles: ${Array.from(dirs.values()).flat().length}\nDirs: ${dirs.size}`,
    tags: [],
  })

  // Create explore tasks
  const tasks = buckets.slice(0, taskCount).map((bucket, i) => createTaskNode({
    type: "explore",
    title: `Explore: ${bucket.label.slice(0, 50)}`,
    prompt: [
      `You are exploring a TypeScript codebase. Analyze these source files:`,
      bucket.files.slice(0, 5).map(f => `- ${relative(TARGET, f)}`).join("\n"),
      bucket.files.length > 5 ? `... and ${bucket.files.length - 5} more` : "",
      ``,
      `Provide a brief summary of what each file does and identify key patterns.`,
      `Be concise — one line per file.`,
    ].join("\n"),
    scope: bucket.files.slice(0, 3),
    priority: 100 - i,
  }))

  for (const t of tasks) conductor.taskDag.addTask(t)

  console.log(`Spawning ${taskCount} agents...`)
  const spawnStart = Date.now()
  await conductor.spawnAgents(Array(taskCount).fill("general") as "general"[])
  const spawnMs = Date.now() - spawnStart
  console.log(`✓ Spawned ${taskCount} agents in ${spawnMs}ms`)
  console.log()

  // Event tracking
  let completedCount = 0
  let totalTokens = 0
  const taskTimings: number[] = []

  conductor.onEvent(e => {
    if (e.kind === "task.status_changed" && e.payload["next"] === "done") {
      completedCount++
      const task = conductor.taskDag.getTask(e.payload["taskId"] as string)
      if (task?.startedAt && task.completedAt) {
        taskTimings.push(task.completedAt - task.startedAt)
      }
      process.stdout.write(`\r  Progress: ${completedCount}/${taskCount} tasks done`)
    }
  })

  console.log("Running benchmark...")
  const runStart = Date.now()
  conductor.startScheduler()

  const result = await conductor.waitForCompletion(600_000)
  const totalMs = Date.now() - runStart
  console.log() // newline after progress

  // Collect stats
  const stats = conductor.store.taskStats()
  const allTasks = conductor.taskDag.allTasks()
  const doneTasks = allTasks.filter(t => t.status === "done")

  console.log()
  console.log("╔══════════════════════════════════════════════════════════╗")
  console.log("║  BENCHMARK RESULTS                                       ║")
  console.log("╚══════════════════════════════════════════════════════════╝")
  console.log()
  console.log(`Result          : ${result}`)
  console.log(`Total wall time : ${(totalMs / 1000).toFixed(1)}s`)
  console.log(`Agent spawn     : ${spawnMs}ms`)
  console.log()
  console.log(`Tasks total     : ${stats.total}`)
  console.log(`Tasks done      : ${stats.done}`)
  console.log(`Tasks failed    : ${stats.failed}`)
  console.log()
  if (taskTimings.length > 0) {
    const avg = taskTimings.reduce((a, b) => a + b, 0) / taskTimings.length
    const min = Math.min(...taskTimings)
    const max = Math.max(...taskTimings)
    console.log(`Task duration   : avg=${(avg/1000).toFixed(1)}s  min=${(min/1000).toFixed(1)}s  max=${(max/1000).toFixed(1)}s`)
  }
  console.log()
  console.log(`SQLite write perf: ${stats.total > 0 ? `${stats.total} tasks persisted` : "n/a"}`)
  console.log(`AGENTS.md found : ${conductor["agentInstructions"] ? "yes" : "no"}`)

  // Write JSON report
  const report = {
    timestamp: new Date().toISOString(),
    target: TARGET,
    agentCount: taskCount,
    result,
    totalWallMs: totalMs,
    spawnMs,
    tasks: { total: stats.total, done: stats.done, failed: stats.failed },
    taskTimings: { avg: stats.avgDurationMs, min: Math.min(...taskTimings, Infinity), max: Math.max(...taskTimings, 0) },
    runId: conductor.runId,
  }
  writeFileSync(join(CONDUCTOR_DIR, "benchmark-report.json"), JSON.stringify(report, null, 2))
  console.log(`\nReport saved to .conductor-bench/benchmark-report.json`)

  await conductor.shutdown()
}

main().catch(err => { console.error("Benchmark failed:", err); process.exit(1) })
