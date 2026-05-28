/**
 * Scheduler latency micro-benchmark.
 *
 * Measures the actual inter-task dispatch gap with the event-driven scheduler
 * by running a synthetic 8-task linear chain (each task "completes" instantly
 * after a tiny async delay, simulating a fast agent).
 *
 * Expected result: with event-driven dispatch the gap between consecutive tasks
 * should be <10ms instead of up to 500ms (old polling interval) or 5000ms
 * (new safety-net interval).
 *
 * Run: bun run src/bench/scheduler-bench.ts
 */

import { Conductor } from "../conductor"
import { createTaskNode } from "../dag/engine"
import { defaultConfig } from "../dag/types"
import type { TaskOutput } from "../dag/types"
import { AgentProcessManager } from "../runtime/agent-manager"
import { CodeWhaleClient } from "../runtime/client"
import type { AgentInstance } from "../dag/types"
import type { Subprocess } from "bun"

// ─── Fake agent infrastructure ────────────────────────────────────────────────

/** Minimal fake turn output that satisfies parseTaskOutput */
const FAKE_OUTPUT: TaskOutput = {
  summary: "done",
  changes:  [],
  evidence: [],
  risks:    [],
  blockers: [],
  rawText: [
    "## SUMMARY\ndone",
    "## CHANGES\nnone",
    "## EVIDENCE\nnone",
    "## RISKS\nnone",
    "## BLOCKERS\nnone",
  ].join("\n\n"),
}

/**
 * Patch a Conductor so its internal AgentProcessManager uses a fake agent
 * that immediately completes every turn with FAKE_OUTPUT.
 *
 * The fake bypasses the real CodeWhale HTTP API entirely.
 */
function injectFakeAgents(conductor: Conductor, count: number): void {
  const mgr = (conductor as unknown as { agentMgr: AgentProcessManager }).agentMgr

  for (let i = 0; i < count; i++) {
    const port = 29100 + i
    const instance: AgentInstance = {
      id:            `fake-agent-${i}`,
      port,
      role:          "general",
      status:        "idle",
      pid:           null,
      currentTaskId: null,
      threadId:      null,
      model:         null,
      startedAt:     Date.now(),
      lastHeartbeat: Date.now(),
    }

    // Fake subprocess — kill() is a no-op
    const fakeProc = { pid: 0, kill: () => {}, exited: Promise.resolve(0) } as unknown as Subprocess

    // Fake client — returns canned responses instantly
    const fakeClient = new CodeWhaleClient(port)

    // Override createThread
    fakeClient.createThread = async () => ({
      id: `thread-fake-${i}-${Date.now()}`,
      created_at: new Date().toISOString(),
      workspace: ".",
      mode: "agent",
      auto_approve: true,
      model: "fake-model",
    })

    // Override postTurn
    fakeClient.postTurn = async (threadId: string) => ({
      id: `turn-fake-${Date.now()}`,
      thread_id: threadId,
      status: "completed" as const,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      duration_ms: 1,
      input_summary: "",
    })

    // Override waitForTurn — resolves instantly with the fake output
    fakeClient.waitForTurn = async () => ({
      status: "completed" as const,
      fullText: FAKE_OUTPUT.rawText,
      usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 },
    })

    mgr.adopt(instance, fakeProc, fakeClient)
  }
}

// ─── Build task graph ─────────────────────────────────────────────────────────

function buildLinearChain(length: number) {
  const nodes: ReturnType<typeof createTaskNode>[] = []
  for (let i = 0; i < length; i++) {
    nodes.push(createTaskNode({
      type:  "implement",
      title: `Task ${i + 1}`,
      prompt: `Do task ${i + 1}.\n\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS`,
      scope: [],
      priority: 100 - i,
      dependsOn: i > 0 ? [nodes[i - 1]!.id] : [],
    }))
  }
  return nodes
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const CHAIN_LEN = 8
  const AGENTS    = 2

  console.log("╔══════════════════════════════════════════════╗")
  console.log("║  SCHEDULER LATENCY MICRO-BENCHMARK           ║")
  console.log("╚══════════════════════════════════════════════╝")
  console.log()
  console.log(`Chain length  : ${CHAIN_LEN} tasks (linear, each depends on previous)`)
  console.log(`Fake agents   : ${AGENTS}`)
  console.log(`Agent latency : ~0ms (instant mock)`)
  console.log()

  const config = defaultConfig({
    projectPath: process.cwd(),
    maxConcurrentAgents: AGENTS,
    autoApprove: true,
    dynamicTasks: false,
  })

  const conductor = new Conductor(config)
  await conductor.initialize()

  // Inject fake agents — no real codewhale needed
  injectFakeAgents(conductor, AGENTS)

  const tasks = buildLinearChain(CHAIN_LEN)
  conductor.taskDag.addTasks(tasks)

  // Record timestamps when each task starts/completes
  const taskStartMs:    Record<string, number> = {}
  const taskCompleteMs: Record<string, number> = {}

  conductor.onEvent(e => {
    if (e.kind === "task.status_changed") {
      const { taskId, next } = e.payload as { taskId: string; next: string }
      if (next === "running")  taskStartMs[taskId]    = Date.now()
      if (next === "done")     taskCompleteMs[taskId] = Date.now()
    }
  })

  const wallStart = Date.now()
  conductor.startScheduler()
  const result = await conductor.waitForCompletion(30_000)
  const wallMs = Date.now() - wallStart

  await conductor.shutdown()

  // ── Report ────────────────────────────────────────────────────────────────

  console.log(`Result        : ${result}`)
  console.log(`Wall time     : ${wallMs}ms`)
  console.log()

  // Inter-task gaps: gap between task[i] completing and task[i+1] starting
  const gaps: number[] = []
  for (let i = 0; i < tasks.length - 1; i++) {
    const prevId = tasks[i]!.id
    const nextId = tasks[i + 1]!.id
    const prevDone  = taskCompleteMs[prevId]
    const nextStart = taskStartMs[nextId]
    if (prevDone && nextStart) gaps.push(nextStart - prevDone)
  }

  if (gaps.length > 0) {
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length
    const max = Math.max(...gaps)
    const min = Math.min(...gaps)
    console.log("Inter-task dispatch gaps (complete → next start):")
    gaps.forEach((g, i) => console.log(`  task${i + 1}→task${i + 2}: ${g}ms`))
    console.log()
    console.log(`  avg: ${avg.toFixed(1)}ms   min: ${min}ms   max: ${max}ms`)
    console.log()

    const threshold = 50  // ms — event-driven should be well under this
    if (max < threshold) {
      console.log(`✓ All gaps < ${threshold}ms — event-driven dispatch working correctly`)
    } else {
      console.log(`✗ Gap exceeded ${threshold}ms — scheduler may be falling back to polling`)
    }
  } else {
    console.log("No gap data (tasks may have run in parallel or timing not captured)")
  }

  console.log()
  console.log("Note: with old 500ms polling the avg gap would be ~250ms (random offset).")
  console.log("With event-driven dispatch it should be <10ms.")
}

main().catch(err => { console.error("bench failed:", err.message ?? err); process.exit(1) })
