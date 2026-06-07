import { describe, it, expect, afterEach } from "bun:test"
import { ConductorStore } from "../src/memory/store"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DIR = join(process.cwd(), ".test-artifacts")
function freshStore(runId = "run-art-test"): ConductorStore {
  rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
  const store = new ConductorStore(DIR, runId)
  store.initRun(DIR)
  return store
}
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ConductorStore artifacts", () => {
  it("writes and reads back full content without truncation", () => {
    const store = freshStore()
    // A payload far larger than the 8KB context truncation limit.
    const big = "x".repeat(50_000)
    const ref = store.writeArtifact({ taskId: "t1", kind: "json", label: "big", content: big })
    expect(ref.byteSize).toBe(50_000)

    const got = store.getArtifact(ref.id)
    expect(got).not.toBeNull()
    expect(got!.content.length).toBe(50_000)   // complete, not truncated
    expect(got!.content).toBe(big)
    store.close()
  })

  it("returns null for an unknown artifact id", () => {
    const store = freshStore()
    expect(store.getArtifact("art-does-not-exist")).toBeNull()
    store.close()
  })

  it("getArtifactsByTask returns all artifacts for a task in creation order", () => {
    const store = freshStore()
    store.writeArtifact({ taskId: "t1", kind: "rows", label: "a", content: "[1]" })
    store.writeArtifact({ taskId: "t1", kind: "rows", label: "b", content: "[2]" })
    store.writeArtifact({ taskId: "t2", kind: "rows", label: "c", content: "[3]" })

    const t1 = store.getArtifactsByTask("t1")
    expect(t1).toHaveLength(2)
    expect(t1.map(a => a.label)).toEqual(["a", "b"])
    expect(store.getArtifactsByTask("t2")).toHaveLength(1)
    store.close()
  })

  it("isolates artifacts by run id", () => {
    const store1 = freshStore("run-A")
    const ref = store1.writeArtifact({ taskId: "t1", kind: "text", content: "hello" })
    store1.close()

    // A different run on the same DB file must not see run-A's artifact.
    const store2 = new ConductorStore(DIR, "run-B")
    store2.initRun(DIR)
    expect(store2.getArtifact(ref.id)).toBeNull()
    store2.close()
  })

  it("computes byteSize from UTF-8 length, not character count", () => {
    const store = freshStore()
    const multibyte = "数据"   // 2 chars, 6 UTF-8 bytes
    const ref = store.writeArtifact({ taskId: "t1", kind: "text", content: multibyte })
    expect(ref.byteSize).toBe(6)
    store.close()
  })

  it("records and reads back artifact lineage (sourceArtifactIds)", () => {
    const store = freshStore()
    const a = store.writeArtifact({ taskId: "q1", kind: "json", content: "[1]" })
    const b = store.writeArtifact({ taskId: "q2", kind: "json", content: "[2]" })
    // A comparison artifact fed by the two query artifacts.
    const cmp = store.writeArtifact({
      taskId: "cmp", kind: "task_output", content: "ranking",
      sourceArtifactIds: [a.id, b.id],
    })
    const got = store.getArtifact(cmp.id)!
    expect(got.sourceArtifactIds).toEqual([a.id, b.id])
    // No lineage → undefined, not an empty array.
    expect(store.getArtifact(a.id)!.sourceArtifactIds).toBeUndefined()
    store.close()
  })
})

describe("ConductorStore task inputArtifactIds persistence", () => {
  it("round-trips inputArtifactIds through upsert/load", () => {
    const store = freshStore()
    const task = {
      id: "t-flow", type: "verify" as const, title: "verify", status: "ready" as const,
      priority: 50, role: "verifier" as const, prompt: "p", scope: [],
      dependsOn: [], blocks: [], assignedTo: null, output: null, error: null,
      createdAt: Date.now(), startedAt: null, completedAt: null,
      retryCount: 0, maxRetries: 2, forkContext: false, tokenUsage: null,
      inputArtifactIds: ["art-1", "art-2"],
    }
    store.upsertTask(task)
    const loaded = store.loadTasks().find(t => t.id === "t-flow")
    expect(loaded?.inputArtifactIds).toEqual(["art-1", "art-2"])
    store.close()
  })

  it("loads undefined inputArtifactIds for tasks that have none", () => {
    const store = freshStore()
    store.upsertTask({
      id: "t-plain", type: "explore", title: "x", status: "ready",
      priority: 50, role: "explore", prompt: "p", scope: [],
      dependsOn: [], blocks: [], assignedTo: null, output: null, error: null,
      createdAt: Date.now(), startedAt: null, completedAt: null,
      retryCount: 0, maxRetries: 2, forkContext: false, tokenUsage: null,
    })
    const loaded = store.loadTasks().find(t => t.id === "t-plain")
    expect(loaded?.inputArtifactIds).toBeUndefined()
    store.close()
  })

  it("round-trips inputFromDeps through upsert/load", () => {
    const store = freshStore()
    const base = {
      type: "review" as const, priority: 50, role: "review" as const, prompt: "p", scope: [],
      dependsOn: ["d1", "d2"], blocks: [], assignedTo: null, output: null, error: null,
      createdAt: Date.now(), startedAt: null, completedAt: null,
      retryCount: 0, maxRetries: 2, forkContext: false, tokenUsage: null,
    }
    store.upsertTask({ ...base, id: "t-cmp", title: "compare", status: "ready", inputFromDeps: true })
    store.upsertTask({ ...base, id: "t-plain", title: "plain", status: "ready" })
    const tasks = store.loadTasks()
    expect(tasks.find(t => t.id === "t-cmp")?.inputFromDeps).toBe(true)
    // false persists as undefined (not stored as a truthy flag)
    expect(tasks.find(t => t.id === "t-plain")?.inputFromDeps).toBeUndefined()
    store.close()
  })
})
