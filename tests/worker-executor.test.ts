import { describe, it, expect } from "bun:test"
import { WorkerExecutor } from "../src/executor/worker-executor"
import { createTaskNode } from "../src/dag/engine"
import type { TaskNode } from "../src/dag/types"

const task = (over: Partial<TaskNode> = {}): TaskNode =>
  ({ ...createTaskNode({ type: "verify", title: "t", prompt: "SELECT 1", scope: [] }), ...over })

const opts = { autoApprove: true, forkContext: false, timeoutMs: 5_000 }

describe("WorkerExecutor", () => {
  it("reports the worker kind and slot capacity", () => {
    const ex = new WorkerExecutor(async () => "ok", 2)
    expect(ex.kind).toBe("worker")
    expect(ex.availableSlots()).toBe(2)
  })

  it("runs the runner and returns its result as rawText (no LLM usage)", async () => {
    const ex = new WorkerExecutor(async (t) => `ran:${t.prompt}`, 1)
    const h = ex.reserve(task({ prompt: "SELECT 42" }))!
    const r = await h.execute("ignored-prompt", opts)
    expect(r.status).toBe("completed")
    expect(r.rawText).toBe("ran:SELECT 42")
    expect(r.usage.inputTokens).toBe(0)
    expect(r.model).toBeNull()
    h.release()
  })

  it("decrements/restores slots across reserve and release", () => {
    const ex = new WorkerExecutor(async () => "x", 1)
    const h = ex.reserve(task())!
    expect(ex.availableSlots()).toBe(0)
    expect(ex.reserve(task())).toBeNull()   // pool exhausted
    h.release()
    expect(ex.availableSlots()).toBe(1)
  })

  it("release is idempotent", () => {
    const ex = new WorkerExecutor(async () => "x", 1)
    const h = ex.reserve(task())!
    h.release(); h.release()
    expect(ex.availableSlots()).toBe(1)
  })

  it("returns failed (not throw) when the runner throws", async () => {
    const ex = new WorkerExecutor(async () => { throw new Error("boom") }, 1)
    const h = ex.reserve(task())!
    const r = await h.execute("p", opts)
    expect(r.status).toBe("failed")
    expect(r.rawText).toContain("boom")
    h.release()
  })

  it("times out a hung runner instead of wedging the slot", async () => {
    const ex = new WorkerExecutor(() => new Promise<string>(() => {}), 1)  // never resolves
    const h = ex.reserve(task())!
    const r = await h.execute("p", { ...opts, timeoutMs: 30 })
    expect(r.status).toBe("failed")
    expect(r.rawText).toContain("timed out")
    h.release()
  })
})
