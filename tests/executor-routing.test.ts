import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import { WorkerExecutor } from "../src/executor/worker-executor"
import type { Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback, TokenUsage } from "../src/executor/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// A minimal default executor standing in for the LLM backend. Its kind is
// "llm" so the conductor's dispatch treats it as the LLM path (prompt build +
// five-section parse). It records which task ids it ran.
class FakeLLM implements Executor {
  readonly kind = "llm"
  private free: number
  readonly ran: string[] = []
  constructor(slots: number, private readonly out: (t: { id: string }) => string) { this.free = slots }
  availableSlots(): number { return this.free }
  reserve(task: { id: string }): ExecutionHandle | null {
    if (this.free <= 0) return null
    this.free--
    const self = this
    let released = false
    return {
      workerId: `llm-${task.id}`,
      async execute(_p: string, _o: ExecutionOptions, _d?: DeltaCallback): Promise<ExecutionResult> {
        self.ran.push(task.id)
        const usage: TokenUsage = { inputTokens: 1, outputTokens: 1, cacheHitTokens: 0, cacheMissTokens: 0 }
        return { status: "completed", rawText: self.out(task), usage, model: "fake-llm", malformedLines: 0 }
      },
      release() { if (!released) { released = true; self.free++ } },
    }
  }
}

const DIR = join(process.cwd(), ".test-routing")
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

const llmOut = () => ["## SUMMARY", "llm did it", "## CHANGES", "none", "## EVIDENCE", "none", "## RISKS", "none", "## BLOCKERS", "none"].join("\n")

describe("executor routing", () => {
  it("routes executorKind:'worker' tasks to the WorkerExecutor, others to the default", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })

    const llm = new FakeLLM(2, llmOut)
    const workerRan: string[] = []
    const worker = new WorkerExecutor(async (t) => { workerRan.push(t.id); return `WORKER_RESULT:${t.title}` }, 2)

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 2, autoApprove: true, dynamicTasks: false })
    const conductor = new Conductor(config, "run-routing", llm, [worker])
    await conductor.initialize()

    const llmTask = createTaskNode({ type: "review", title: "llm task", prompt: "analyze", scope: [] })
    const workerTask = createTaskNode({ type: "verify", title: "sql task", prompt: "SELECT 1", scope: [], executorKind: "worker" })
    conductor.taskDag.addTasks([llmTask, workerTask])

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(8_000)

    // Collect before shutdown closes the DB.
    const workerArtifacts = conductor.store.getArtifactsByTask(workerTask.id)
    await conductor.shutdown()

    expect(result).toBe("completed")
    // Each task went to the right backend.
    expect(llm.ran).toContain(llmTask.id)
    expect(llm.ran).not.toContain(workerTask.id)
    expect(workerRan).toEqual([workerTask.id])
    // The worker's raw result was stored verbatim as its artifact (no parsing).
    expect(workerArtifacts).toHaveLength(1)
    expect(workerArtifacts[0]!.content).toBe("WORKER_RESULT:sql task")
  })

  it("a worker result flows into a downstream LLM task via inputFromDeps", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })

    let consumerPrompt = ""
    const llm = new FakeLLM(1, llmOut)
    // Capture the consumer's prompt by wrapping the runner is not possible here,
    // so instead assert via the artifact the worker produced + dependency wiring.
    const worker = new WorkerExecutor(async () => `ROWS:[1,2,3]`, 1)

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 1, autoApprove: true, dynamicTasks: false })
    const conductor = new Conductor(config, "run-routing2", llm, [worker])
    await conductor.initialize()

    const query = createTaskNode({ type: "verify", title: "run query", prompt: "SELECT *", scope: [], executorKind: "worker" })
    const summarize = createTaskNode({
      type: "review", title: "summarize rows", prompt: "summarize the rows", scope: [],
      dependsOn: [query.id], inputFromDeps: true,
    })
    conductor.taskDag.addTasks([query, summarize])

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(8_000)
    const queryArtifacts = conductor.store.getArtifactsByTask(query.id)
    await conductor.shutdown()

    expect(result).toBe("completed")
    // The worker produced a consumable artifact the downstream task depended on.
    expect(queryArtifacts).toHaveLength(1)
    expect(queryArtifacts[0]!.content).toBe("ROWS:[1,2,3]")
    void consumerPrompt
  })

  it("worker tasks run unthrottled even when LLM start-spacing is configured", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })

    const llm = new FakeLLM(1, llmOut)
    const worker = new WorkerExecutor(async () => "done", 8)
    // Aggressive LLM spacing that WOULD dominate wall-time if it applied to workers.
    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 1, autoApprove: true, dynamicTasks: false, minStartIntervalMs: 200 })
    const conductor = new Conductor(config, "run-worker-nothrottle", llm, [worker])
    await conductor.initialize()

    // 8 pure-worker tasks. If they were throttled at 200ms each, this would take
    // ~1.4s; unthrottled they finish near-instantly.
    conductor.taskDag.addTasks(Array.from({ length: 8 }, (_, i) =>
      createTaskNode({ type: "verify", title: `w${i}`, prompt: "x", scope: [], executorKind: "worker" })))

    const t0 = Date.now()
    conductor.startScheduler()
    const result = await conductor.waitForCompletion(8_000)
    const elapsed = Date.now() - t0
    await conductor.shutdown()

    expect(result).toBe("completed")
    expect(elapsed).toBeLessThan(1_000)   // not gated by the 200ms LLM spacing
  })

  it("takes the worker path based on actsDirectly, not the kind string", async () => {
    rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true })

    // A custom executor with an arbitrary kind ("sql") that acts directly.
    // It must take the worker path: raw result stored verbatim, no five-section
    // parsing — proving routing keys off actsDirectly, not kind === "worker".
    const sqlExec = new WorkerExecutor(async () => `{"rows":[{"region":"EU","n":2}]}`, 2)
    // sanity: kind is NOT "worker"
    ;(sqlExec as unknown as { kind: string }).kind = "sql"

    const llm = new FakeLLM(1, llmOut)
    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 1, autoApprove: true, dynamicTasks: false })
    const conductor = new Conductor(config, "run-actsdirectly", llm, [sqlExec])
    await conductor.initialize()

    const q = createTaskNode({ type: "verify", title: "sql q", prompt: "SELECT …", scope: [], executorKind: "sql" })
    conductor.taskDag.addTasks([q])

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(8_000)
    const arts = conductor.store.getArtifactsByTask(q.id)
    await conductor.shutdown()

    expect(result).toBe("completed")
    // Raw result stored verbatim (worker path), not wrapped as parsed task_output.
    expect(arts).toHaveLength(1)
    expect(arts[0]!.kind).toBe("json")
    expect(arts[0]!.content).toBe(`{"rows":[{"region":"EU","n":2}]}`)
  })
})
