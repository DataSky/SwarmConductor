import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import type { Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback } from "../src/executor/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// ─── Minimal fake executor ────────────────────────────────────────────────────

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
          rawText: [
            "## SUMMARY", "done",
            "## CHANGES", "none",
            "## EVIDENCE", "none",
            "## RISKS", "none",
            "## BLOCKERS", "none",
          ].join("\n"),
          usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
          model: "fake",
          malformedLines: 0,
        }
      },
      release() { self.free++ },
    }
  }
}

const DIR = join(process.cwd(), ".test-event-trace")
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

describe("M1 – full event trace persistence", () => {
  it("persists all conductor events to DB and getRunTrace returns them in order", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const fake = new FakeExecutor()
    const config = defaultConfig({
      projectPath: DIR,
      maxConcurrentAgents: 2,
      dynamicTasks: false,
      autoApprove: true,
    })
    const runId = "run-trace-test"
    const conductor = new Conductor(config, runId, fake)
    await conductor.initialize()

    conductor.addPhase([
      { type: "explore", title: "T1", prompt: "do T1", scope: [], role: "general", priority: 1 },
      { type: "explore", title: "T2", prompt: "do T2", scope: [], role: "general", priority: 1 },
    ])

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(10_000)
    // Query trace BEFORE shutdown (shutdown closes the DB)
    const store = conductor.store
    const trace = (store as unknown as { getRunTrace: (opts?: unknown) => unknown[] }).getRunTrace()

    // Pagination: sinceSeq round-trip (must run before shutdown)
    const ids = trace.map((e: unknown) => (e as { id: number }).id)
    let paged: unknown[] = []
    if (ids.length >= 2) {
      const firstId = ids[0]!
      paged = (store as unknown as { getRunTrace: (opts?: { sinceSeq?: number; limit?: number }) => unknown[] })
        .getRunTrace({ sinceSeq: firstId })
    }

    await conductor.shutdown()

    expect(result).toBe("completed")

    // Must have events of every expected kind
    const kinds = new Set(trace.map((e: unknown) => (e as { kind: string }).kind))
    expect(kinds.has("phase.started")).toBe(true)
    expect(kinds.has("task.status_changed")).toBe(true)
    expect(kinds.has("task.completed")).toBe(true)
    expect(kinds.has("run.completed")).toBe(true)

    // Ordering: ids must be monotonically increasing (chronological)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]!).toBeGreaterThan(ids[i - 1]!)
    }

    // Pagination correctness
    if (ids.length >= 2) {
      expect(paged.length).toBe(trace.length - 1)
    }

    // All events JSON-serialisable
    for (const e of trace) {
      expect(() => JSON.stringify(e)).not.toThrow()
    }
  })

  it("getRunTrace with limit caps the result set", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    const fake = new FakeExecutor()
    const config = defaultConfig({
      projectPath: DIR,
      maxConcurrentAgents: 2,
      dynamicTasks: false,
      autoApprove: true,
    })
    const conductor = new Conductor(config, "run-limit-test", fake)
    await conductor.initialize()

    conductor.addPhase([
      { type: "explore", title: "T1", prompt: "p1", scope: [], role: "general", priority: 1 },
    ])
    conductor.startScheduler()
    await conductor.waitForCompletion(10_000)
    const store = conductor.store
    const all = (store as unknown as { getRunTrace: (opts?: unknown) => unknown[] }).getRunTrace()
    const limited = (store as unknown as { getRunTrace: (opts?: { limit?: number }) => unknown[] })
      .getRunTrace({ limit: 2 })
    await conductor.shutdown()
    expect(limited.length).toBe(Math.min(2, all.length))
  })
})
