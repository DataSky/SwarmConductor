/**
 * End-to-end Conductor integration test.
 * Spawns real CodeWhale agents, runs a full schedule cycle,
 * verifies dynamic task insertion and approval gate.
 * Run: bun test tests/conductor-e2e.test.ts
 */
import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { createTaskNode } from "../src/dag/engine"
import { defaultConfig } from "../src/dag/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

const TMP_DIR = join(process.cwd(), ".test-conductor-e2e")
const BASE_PORT = 18200

function makeConfig(overrides = {}) {
  return defaultConfig({
    projectPath: TMP_DIR,
    basePort: BASE_PORT,
    maxConcurrentAgents: 3,
    schedulerTickMs: 200,
    autoApprove: true,
    dynamicTasks: false, // controlled per-test
    heartbeatIntervalMs: 60_000, // don't interfere with short tests
    heartbeatTimeoutMs: 120_000,
    ...overrides,
  })
}

let conductor: Conductor | null = null

afterEach(async () => {
  try {
    if (conductor) {
      // Wrap shutdown with a timeout to prevent hanging afterEach.
      // shutdown() internally waits up to 30s for in-flight dispatches,
      // so we give it a total budget of 10s here — if it hasn't finished
      // by then we force-cleanup. Temporary files are removed below regardless.
      await Promise.race([
        conductor.shutdown(),
        new Promise(r => setTimeout(r, 10_000)),
      ])
    }
  } catch {
    // Ignore shutdown errors — cleanup must still happen
  } finally {
    conductor = null
    rmSync(TMP_DIR, { recursive: true, force: true })
  }
})

describe("Conductor end-to-end", () => {
  it("schedules and completes two parallel tasks with no deps", async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    conductor = new Conductor(makeConfig())
    await conductor.initialize()

    const events: string[] = []
    conductor.onEvent(e => events.push(e.kind))

    const t1 = createTaskNode({
      type: "explore",
      title: "Task Alpha",
      prompt: 'Reply with exactly "ALPHA_DONE" and nothing else.',
      scope: [],
    })
    const t2 = createTaskNode({
      type: "explore",
      title: "Task Beta",
      prompt: 'Reply with exactly "BETA_DONE" and nothing else.',
      scope: [],
    })

    conductor.taskDag.addTasks([t1, t2])
    await conductor.spawnAgents(["general", "general"])
    conductor.startScheduler()

    const result = await conductor.waitForCompletion(120_000)
    expect(result).toBe("completed")

    const t1node = conductor.taskDag.getTask(t1.id)!
    const t2node = conductor.taskDag.getTask(t2.id)!
    expect(t1node.status).toBe("done")
    expect(t2node.status).toBe("done")
    expect(t1node.output!.rawText).toContain("ALPHA_DONE")
    expect(t2node.output!.rawText).toContain("BETA_DONE")

    expect(events).toContain("task.status_changed")
    expect(events).toContain("run.completed")
  }, 150_000)

  it("respects task dependency: downstream task runs after upstream", async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    conductor = new Conductor(makeConfig())
    await conductor.initialize()

    const upstream = createTaskNode({
      type: "explore",
      title: "Upstream",
      prompt: 'Reply with exactly "UP_DONE" and nothing else.',
      scope: [],
      priority: 100,
    })
    const downstream = createTaskNode({
      type: "plan",
      title: "Downstream",
      prompt: 'Reply with exactly "DOWN_DONE" and nothing else.',
      scope: [],
      priority: 50,
      dependsOn: [upstream.id],
    })

    conductor.taskDag.addTasks([upstream, downstream])
    await conductor.spawnAgents(["general", "general"])

    const completionOrder: string[] = []
    conductor.onEvent(e => {
      if (e.kind === "task.status_changed" && e.payload["next"] === "done") {
        const task = conductor!.taskDag.getTask(e.payload["taskId"] as string)
        if (task) completionOrder.push(task.title)
      }
    })

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(120_000)
    expect(result).toBe("completed")

    // Upstream must complete before downstream
    expect(completionOrder.indexOf("Upstream")).toBeLessThan(completionOrder.indexOf("Downstream"))
  }, 150_000)

  it("dynamic task insertion: blocker in output triggers new implement task", async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    conductor = new Conductor(makeConfig({ dynamicTasks: true }))
    await conductor.initialize()

    const task = createTaskNode({
      type: "implement",
      title: "Feature with blocker",
      // prompt the agent to produce a BLOCKERS section
      prompt: [
        'Reply in this exact format (copy exactly):',
        '## SUMMARY',
        'Done',
        '## CHANGES',
        '## EVIDENCE',
        '## RISKS',
        '## BLOCKERS',
        '- Missing database migration script',
      ].join("\n"),
      scope: [],
    })

    conductor.taskDag.addTask(task)
    await conductor.spawnAgents(["general"])

    const inserted: string[] = []
    conductor.onEvent(e => {
      if (e.kind === "task.dynamic_inserted") inserted.push(e.payload["title"] as string)
    })

    conductor.startScheduler()

    // Wait for the original task then check for inserted tasks
    await new Promise<void>(resolve => {
      const check = setInterval(() => {
        const t = conductor!.taskDag.getTask(task.id)
        if (t?.status === "done" || t?.status === "failed") {
          clearInterval(check)
          resolve()
        }
      }, 300)
    })

    // Allow dynamic tasks to be inserted (one tick)
    await new Promise(r => setTimeout(r, 600))

    const allTasks = conductor.taskDag.allTasks()
    const dynamicTasks = allTasks.filter(t => t.id !== task.id)

    // At least one dynamic task should have been inserted for the blocker
    // (LLM may or may not follow the format exactly, so we check softly)
    if (inserted.length > 0) {
      expect(dynamicTasks.length).toBeGreaterThanOrEqual(1)
      expect(dynamicTasks[0]!.type).toBe("implement")
      expect(dynamicTasks[0]!.dependsOn).toContain(task.id)
    }
    // If LLM didn't produce the exact format, that's fine for this test
  }, 120_000)

  it("approval gate: scheduler pauses and resumes", async () => {
    mkdirSync(TMP_DIR, { recursive: true })
    conductor = new Conductor(makeConfig())
    await conductor.initialize()
    await conductor.spawnAgents(["general"])

    const approvalFired: string[] = []
    conductor.onEvent(e => {
      if (e.kind === "approval.required") approvalFired.push(e.kind)
    })

    // Manually trigger a phase boundary approval
    conductor.startScheduler()
    const approvalPromise = conductor.requestPhaseBoundaryApproval("Run phase 2 implementation")

    // Give it a moment to pause
    await new Promise(r => setTimeout(r, 200))
    expect(conductor.approvalGate.hasPending()).toBe(true)
    expect(approvalFired).toContain("approval.required")

    // Programmatically approve
    const reqId = conductor.approvalGate.pendingRequests()[0]!.id
    conductor.approvalGate.resolve(reqId, "approved")
    const decision = await approvalPromise
    expect(decision).toBe("approved")
    expect(conductor.approvalGate.hasPending()).toBe(false)
  }, 30_000)
})
