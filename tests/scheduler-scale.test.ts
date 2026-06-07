import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import type { Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback, TokenUsage } from "../src/executor/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// A timing-aware fake LLM executor: records the wall-clock start of every
// execute() and how many times each task ran. Fixed slot pool. Returns fast.
class TimingExecutor implements Executor {
  readonly kind = "llm"
  private free: number
  readonly starts: number[] = []                 // execute() start timestamps (ms)
  readonly runCount = new Map<string, number>()  // taskId → times executed
  constructor(slots: number) { this.free = slots }
  availableSlots(): number { return this.free }
  reserve(task: { id: string }): ExecutionHandle | null {
    if (this.free <= 0) return null
    this.free--
    const self = this
    let released = false
    return {
      workerId: `t-${task.id}`,
      async execute(_p: string, _o: ExecutionOptions, _d?: DeltaCallback): Promise<ExecutionResult> {
        self.starts.push(Date.now())
        self.runCount.set(task.id, (self.runCount.get(task.id) ?? 0) + 1)
        await new Promise(r => setTimeout(r, 1))   // tiny work
        const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
        return { status: "completed", rawText: "## SUMMARY\nok\n## CHANGES\nnone\n## EVIDENCE\nnone\n## RISKS\nnone\n## BLOCKERS\nnone", usage, model: "fake", malformedLines: 0 }
      },
      release() { if (!released) { released = true; self.free++ } },
    }
  }
}

const DIR = join(process.cwd(), ".test-scale")
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe("scheduler at scale + backpressure", () => {
  it("runs 60 independent tasks to completion, each dispatched exactly once", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })
    const exec = new TimingExecutor(8)   // 8 concurrent slots
    const config = defaultConfig({ projectPath: DIR, dynamicTasks: false })
    const conductor = new Conductor(config, "run-scale", exec)
    await conductor.initialize()

    const tasks = Array.from({ length: 60 }, (_, i) =>
      createTaskNode({ type: "review", title: `t${i}`, prompt: "p", scope: [] }))
    conductor.taskDag.addTasks(tasks)

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(20_000)
    await conductor.shutdown()

    expect(result).toBe("completed")
    expect(conductor.taskDag.allTasks().every(t => t.status === "done")).toBe(true)
    // No double-dispatch: every task ran exactly once.
    expect(exec.runCount.size).toBe(60)
    expect([...exec.runCount.values()].every(n => n === 1)).toBe(true)
    expect(exec.starts.length).toBe(60)
  }, 25_000)

  it("honors minStartIntervalMs across the real scheduler loop", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })
    const exec = new TimingExecutor(8)
    const SPACING = 15
    // Many slots free, but the rate limiter must serialize starts >= SPACING apart.
    const config = defaultConfig({ projectPath: DIR, dynamicTasks: false, minStartIntervalMs: SPACING })
    const conductor = new Conductor(config, "run-bp", exec)
    await conductor.initialize()

    const N = 20
    conductor.taskDag.addTasks(Array.from({ length: N }, (_, i) =>
      createTaskNode({ type: "review", title: `t${i}`, prompt: "p", scope: [] })))

    const t0 = Date.now()
    conductor.startScheduler()
    const result = await conductor.waitForCompletion(20_000)
    const elapsed = Date.now() - t0
    await conductor.shutdown()

    expect(result).toBe("completed")
    expect(exec.starts.length).toBe(N)
    // Total wall time must reflect spacing: (N-1)*SPACING is the floor.
    expect(elapsed).toBeGreaterThanOrEqual((N - 1) * SPACING * 0.8)
    // Consecutive starts should be spaced (allow scheduling jitter slack).
    const sorted = [...exec.starts].sort((a, b) => a - b)
    const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!)
    const tooClose = gaps.filter(g => g < SPACING * 0.5).length
    // Almost all gaps respect spacing; tolerate a couple of jittery outliers.
    expect(tooClose).toBeLessThanOrEqual(2)
  }, 25_000)

  it("without spacing, starts are not artificially throttled", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })
    const exec = new TimingExecutor(16)
    const config = defaultConfig({ projectPath: DIR, dynamicTasks: false })  // minStartIntervalMs=0
    const conductor = new Conductor(config, "run-nobp", exec)
    await conductor.initialize()
    conductor.taskDag.addTasks(Array.from({ length: 16 }, (_, i) =>
      createTaskNode({ type: "review", title: `t${i}`, prompt: "p", scope: [] })))

    const t0 = Date.now()
    conductor.startScheduler()
    const result = await conductor.waitForCompletion(20_000)
    const elapsed = Date.now() - t0
    await conductor.shutdown()

    expect(result).toBe("completed")
    // 16 slots, no spacing → all start near-simultaneously, well under a second.
    expect(elapsed).toBeLessThan(1_000)
  }, 25_000)
})
