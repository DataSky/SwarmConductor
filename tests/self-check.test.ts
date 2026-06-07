import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { runSelfCheck } from "../src/conductor/self-check"
import type { Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback } from "../src/executor/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// ─── Fake executors ───────────────────────────────────────────────────────────

class FakeExecutor implements Executor {
  readonly kind = "fake"
  private free = 4
  availableSlots() { return this.free }
  reserve(task: { id: string }): ExecutionHandle | null {
    if (this.free <= 0) return null
    this.free--
    const self = this
    return {
      workerId: `fake-${task.id}`,
      async execute(_p: string, _o: ExecutionOptions, _d?: DeltaCallback): Promise<ExecutionResult> {
        return {
          status: "completed",
          rawText: ["## SUMMARY", "done", "## CHANGES", "none", "## EVIDENCE", "none", "## RISKS", "none", "## BLOCKERS", "none"].join("\n"),
          usage: { inputTokens: 5, outputTokens: 3, cacheHitTokens: 1, cacheMissTokens: 4 },
          model: "fake",
          malformedLines: 0,
        }
      },
      release() { self.free++ },
    }
  }
}

const DIR = join(process.cwd(), ".test-self-check")
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function runAndCheck(label: string, tasks: Parameters<typeof Conductor.prototype.addPhase>[0]) {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  const fake = new FakeExecutor()
  const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 4, dynamicTasks: false, autoApprove: true })
  const conductor = new Conductor(config, `run-sc-${label}`, fake)
  await conductor.initialize()
  conductor.addPhase(tasks)
  conductor.startScheduler()
  await conductor.waitForCompletion(10_000)
  const report = runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
  await conductor.shutdown()
  return report
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("M4 – self-check: clean run passes all invariants", () => {
  it("two tasks, no violations", async () => {
    const report = await runAndCheck("ok", [
      { type: "explore", title: "T1", prompt: "p1", scope: [], role: "general", priority: 1 },
      { type: "explore", title: "T2", prompt: "p2", scope: [], role: "general", priority: 1 },
    ])
    expect(report.passed).toBe(true)
    expect(report.violations.filter(v => v.severity === "error")).toHaveLength(0)
  })
})

describe("M4 – self-check: worker_zero_tokens", () => {
  it("worker task with non-zero tokens triggers warning", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    // Make a worker executor that lies about tokens
    const { WorkerExecutor } = await import("../src/executor/worker-executor")
    const runner = async () => JSON.stringify({ ok: true })
    const workerEx = new WorkerExecutor(runner, 2)
    ;(workerEx as unknown as { kind: string }).kind = "badworker"

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 2, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-sc-tokens", undefined, [workerEx])
    await conductor.initialize()

    const { createTaskNode } = await import("../src/dag/engine")
    const t = createTaskNode({ type: "verify", title: "W", prompt: "q", scope: [], executorKind: "badworker" })
    conductor.taskDag.addTasks([t])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)

    // Manually inject fake token usage to simulate the bug we're checking
    const tNode = conductor.taskDag.getTask(t.id)!
    tNode.tokenUsage = { inputTokens: 100, outputTokens: 50, cacheHitTokens: 0, cacheMissTokens: 100 }

    const report = runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
    await conductor.shutdown()

    const warnings = report.violations.filter(v => v.rule === "worker_zero_tokens")
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(warnings[0]!.severity).toBe("warning")
  })
})

describe("M4 – self-check: no_dangling_artifact_ref", () => {
  it("detects a missing source artifact", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const { WorkerExecutor } = await import("../src/executor/worker-executor")
    const runnerA = async () => JSON.stringify({ r: "A" })
    const runnerB = async () => JSON.stringify({ r: "B" })
    const wA = new WorkerExecutor(runnerA, 1)
    ;(wA as unknown as { kind: string }).kind = "wA"
    const wB = new WorkerExecutor(runnerB, 1)
    ;(wB as unknown as { kind: string }).kind = "wB"

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 4, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-sc-dangling", undefined, [wA, wB])
    await conductor.initialize()

    const { createTaskNode } = await import("../src/dag/engine")
    const tA = createTaskNode({ type: "verify", title: "A", prompt: "q", scope: [], executorKind: "wA" })
    const tB = createTaskNode({
      type: "verify", title: "B", prompt: "q", scope: [], executorKind: "wB",
      dependsOn: [tA.id], inputFromDeps: true,
    })
    conductor.taskDag.addTasks([tA, tB])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)

    // Corrupt: manually inject a dangling source artifact reference on tB's artifact
    const artB = conductor.store.getArtifactsByTask(tB.id)[0]
    if (artB) {
      // Use SQL directly to corrupt the data
      const db = (conductor.store as unknown as { db: import("bun:sqlite").Database }).db
      db.prepare(`UPDATE artifacts SET source_artifact_ids=? WHERE id=?`)
        .run(JSON.stringify(["art-nonexistent-id"]), artB.id)
    }

    const report = runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
    await conductor.shutdown()

    const dangling = report.violations.filter(v => v.rule === "no_dangling_artifact_ref")
    expect(dangling.length).toBeGreaterThanOrEqual(1)
    expect(dangling[0]!.severity).toBe("error")
    expect(report.passed).toBe(false)
  })
})

describe("M4 – self-check: event_log records selfcheck.completed", () => {
  it("selfcheck event appears in trace after check runs", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const fake = new FakeExecutor()
    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 2, dynamicTasks: false, autoApprove: true })
    const conductor = new Conductor(config, "run-sc-evt", fake)
    await conductor.initialize()
    conductor.addPhase([
      { type: "explore", title: "T1", prompt: "p", scope: [], role: "general", priority: 1 },
    ])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)
    runSelfCheck(conductor.runId, conductor.store, conductor.taskDag)
    const trace = conductor.store.getRunTrace()
    await conductor.shutdown()

    const scEvent = trace.find(e => e.kind === "selfcheck.completed")
    expect(scEvent).toBeDefined()
    expect((scEvent!.payload as { passed: boolean }).passed).toBe(true)
  })
})
