import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import type { Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback } from "../src/executor/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// ─── Fake executor with configurable outcomes ─────────────────────────────────

class FakeExecutor implements Executor {
  readonly kind = "fake"
  private free = 4
  constructor(private readonly failIds: Set<string> = new Set()) {}
  availableSlots() { return this.free }
  reserve(task: { id: string }): ExecutionHandle | null {
    if (this.free <= 0) return null
    this.free--
    const self = this
    return {
      workerId: `fake-${task.id}`,
      async execute(_p: string, _o: ExecutionOptions, _d?: DeltaCallback): Promise<ExecutionResult> {
        if (self.failIds.has(task.id)) {
          return { status: "failed", rawText: "injected failure", usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, model: null, malformedLines: 0 }
        }
        return {
          status: "completed",
          rawText: ["## SUMMARY", "done", "## CHANGES", "none", "## EVIDENCE", "none", "## RISKS", "none", "## BLOCKERS", "none"].join("\n"),
          usage: { inputTokens: 10, outputTokens: 5, cacheHitTokens: 2, cacheMissTokens: 8 },
          model: "fake",
          malformedLines: 0,
        }
      },
      release() { self.free++ },
    }
  }
}

const DIR = join(process.cwd(), ".test-diagnostics")
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe("M3 – diagnostics: getRunSummary", () => {
  it("reports correct stats for a successful run", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const fake = new FakeExecutor()
    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 2, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-summary-ok", fake)
    await conductor.initialize()
    conductor.addPhase([
      { type: "explore", title: "T1", prompt: "p1", scope: [], role: "general", priority: 1 },
      { type: "explore", title: "T2", prompt: "p2", scope: [], role: "general", priority: 1 },
    ])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)
    const summary = conductor.store.getRunSummary()
    await conductor.shutdown()

    expect(summary.taskStats.total).toBe(2)
    expect(summary.taskStats.done).toBe(2)
    expect(summary.taskStats.failed).toBe(0)
    expect(summary.tokenStats.inputTokens).toBe(20)  // 10 × 2 tasks
    expect(summary.failedTasks).toHaveLength(0)
    // run.completed should appear in keyEvents
    const kinds = summary.keyEvents.map(e => e.kind)
    expect(kinds).toContain("run.completed")
  })

  it("reports failed tasks in summary", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    // We need to know the task ID before it's created. Easier: just run a 1-task
    // run and inject failure by making the executor always fail.
    const fake = new FakeExecutor(new Set())
    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 2, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-summary-fail", fake)
    await conductor.initialize()
    conductor.addPhase([
      { type: "explore", title: "WillFail", prompt: "p1", scope: [], role: "general", priority: 1 },
    ])
    // Override the fake to always fail
    ;(fake as unknown as { failIds: Set<string> }).failIds.add("*")

    // Patch reserve to return a failing handle
    const origReserve = fake.reserve.bind(fake)
    fake.reserve = (task: { id: string }): ExecutionHandle | null => {
      const h = origReserve(task)
      if (!h) return null
      const origExec = h.execute.bind(h)
      h.execute = async (_p: string, _o: ExecutionOptions): Promise<ExecutionResult> => {
        return { status: "failed", rawText: "forced failure", usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }, model: null, malformedLines: 0 }
      }
      return h
    }

    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)
    const summary = conductor.store.getRunSummary()
    await conductor.shutdown()

    expect(summary.taskStats.failed).toBe(1)
    expect(summary.failedTasks).toHaveLength(1)
    expect(summary.failedTasks[0]!.title).toBe("WillFail")
  })
})

describe("M3 – diagnostics: getArtifactLineage", () => {
  it("returns the root artifact when there are no ancestors", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const fake = new FakeExecutor()
    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 1, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-lineage-single", fake)
    await conductor.initialize()
    conductor.addPhase([
      { type: "explore", title: "T1", prompt: "p1", scope: [], role: "general", priority: 1 },
    ])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)

    // Find the artifact
    const allTasks = conductor.taskDag.allTasks()
    const t1 = allTasks.find(t => t.title === "T1")!
    expect(t1.artifacts).toBeDefined()
    const artId = t1.artifacts![0]!.id
    const lineage = conductor.store.getArtifactLineage(artId)
    await conductor.shutdown()

    // A single artifact with no sourceArtifactIds — lineage is just [itself]
    expect(lineage).toHaveLength(1)
    expect(lineage[0]!.id).toBe(artId)
  })

  it("traverses multi-hop lineage for fan-out → compare graph", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const { WorkerExecutor } = await import("../src/executor/worker-executor")
    // Workers: two "analysis" tasks produce artifacts; one "compare" consumes both
    const runnerA = async () => JSON.stringify({ result: "A" })
    const runnerB = async () => JSON.stringify({ result: "B" })
    const runnerCmp = async () => JSON.stringify({ compared: true })

    const workerA = new WorkerExecutor(runnerA, 1)
    ;(workerA as unknown as { kind: string }).kind = "wA"
    const workerB = new WorkerExecutor(runnerB, 1)
    ;(workerB as unknown as { kind: string }).kind = "wB"
    const workerCmp = new WorkerExecutor(runnerCmp, 1)
    ;(workerCmp as unknown as { kind: string }).kind = "wCmp"

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 4, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-lineage-fanout", undefined, [workerA, workerB, workerCmp])
    await conductor.initialize()

    const { createTaskNode } = await import("../src/dag/engine")
    const tA = createTaskNode({ type: "verify", title: "A", prompt: "q", scope: [], executorKind: "wA" })
    const tB = createTaskNode({ type: "verify", title: "B", prompt: "q", scope: [], executorKind: "wB" })
    const tCmp = createTaskNode({
      type: "verify", title: "Cmp", prompt: "q", scope: [], executorKind: "wCmp",
      dependsOn: [tA.id, tB.id], inputFromDeps: true,
    })
    conductor.taskDag.addTasks([tA, tB, tCmp])

    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)

    const tasks = conductor.taskDag.allTasks()
    const cmp = tasks.find(t => t.title === "Cmp")!
    expect(cmp.status).toBe("done")
    const cmpArtId = cmp.artifacts![0]!.id
    const lineage = conductor.store.getArtifactLineage(cmpArtId)
    await conductor.shutdown()

    // lineage should contain: artA, artB, artCmp (3 artifacts, cmpArt last)
    const lineageIds = lineage.map(a => a.id)
    expect(lineage.length).toBe(3)
    expect(lineageIds[lineageIds.length - 1]).toBe(cmpArtId)  // root last
    // The two source artifacts come before the compare artifact
    const cmpArt = conductor.store  // already closed, use in-memory data
    const srcArtA = lineage.find(a => a.taskId === tA.id)
    const srcArtB = lineage.find(a => a.taskId === tB.id)
    expect(srcArtA).toBeDefined()
    expect(srcArtB).toBeDefined()
  })
})
