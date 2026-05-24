/**
 * Regression tests for bugs found by the self-analysis benchmark.
 */
import { describe, it, expect } from "bun:test"
import { TaskDAG, createTaskNode } from "../src/dag/engine"
import { ConductorStore } from "../src/memory/store"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"

// ── Bug 1: addTask without reverse-edge wiring ────────────────────────────────
// addTask (single) was not wiring blocks[], so downstream tasks never unblocked.

describe("addTask reverse-edge wiring (Bug 1)", () => {
  it("addTask wires blocks[] so downstream unblocks when dep completes", () => {
    const dag = new TaskDAG("/tmp")
    const a = createTaskNode({ type: "explore", title: "A", prompt: "p", scope: [] })
    dag.addTask(a)

    const b = createTaskNode({ type: "plan", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTask(b)  // single addTask — the bug was here

    expect(dag.getTask(b.id)!.status).toBe("blocked")

    dag.assign(a.id, "agent-1")
    dag.complete(a.id, { summary: "", changes: [], evidence: [], risks: [], blockers: [], rawText: "" })

    expect(dag.getTask(b.id)!.status).toBe("ready")
  })

  it("addTask throws on unknown dependency ID", () => {
    const dag = new TaskDAG("/tmp")
    const t = createTaskNode({ type: "plan", title: "T", prompt: "p", scope: [], dependsOn: ["nonexistent-id"] })
    expect(() => dag.addTask(t)).toThrow("depends on unknown task nonexistent-id")
  })

  it("addTasks throws on unknown dependency ID", () => {
    const dag = new TaskDAG("/tmp")
    const t = createTaskNode({ type: "plan", title: "T", prompt: "p", scope: [], dependsOn: ["ghost-id"] })
    expect(() => dag.addTasks([t])).toThrow("depends on unknown task ghost-id")
  })
})

// ── Bug 2: SSE finalStatus defaulting to "completed" ─────────────────────────
// Covered implicitly via integration tests — verified by code inspection here.

describe("SSE finalStatus default (Bug 2)", () => {
  it("waitForTurn source defaults finalStatus to 'failed', not 'completed'", async () => {
    // Read the source and verify the fix is present
    const src = await Bun.file("src/runtime/client.ts").text()
    expect(src).toContain(`let finalStatus: CWTurn["status"] = "failed"`)
    expect(src).not.toContain(`let finalStatus: CWTurn["status"] = "completed"`)
  })
})

// ── Bug 3: CrashRecovery heartbeat mutex ─────────────────────────────────────

describe("CrashRecovery heartbeat mutex (Bug 3)", () => {
  it("crash-recovery source has checking mutex guard", async () => {
    const src = await Bun.file("src/conductor/crash-recovery.ts").text()
    expect(src).toContain("if (this.checking) return")
    expect(src).toContain("this.checking = true")
    expect(src).toContain("this.checking = false")
  })
})

// ── Bug 4: SQLite busy_timeout + tag join table ───────────────────────────────

describe("SQLite tag join table (Bug 4)", () => {
  const TMP = join(process.cwd(), ".test-store-bugs")

  it("tag-indexed lookup returns correct entries", () => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    const store = new ConductorStore(TMP, "run-bugfix")
    store.initRun(TMP)

    store.writeMemory({ layer: "context", agentId: "a1", taskId: "t1", content: "auth code", tags: ["src/auth.ts"] })
    store.writeMemory({ layer: "context", agentId: "a2", taskId: "t2", content: "parser code", tags: ["src/parser.ts"] })
    store.writeMemory({ layer: "context", agentId: "a3", taskId: "t3", content: "both", tags: ["src/auth.ts", "src/parser.ts"] })

    const authOnly = store.getContext(["src/auth.ts"])
    expect(authOnly.length).toBe(2)
    expect(authOnly.every(e => e.tags.includes("src/auth.ts"))).toBe(true)

    const parserOnly = store.getContext(["src/parser.ts"])
    expect(parserOnly.length).toBe(2)

    store.close()
    rmSync(TMP, { recursive: true, force: true })
  })

  it("busy_timeout pragma is set in schema", async () => {
    const src = await Bun.file("src/memory/store.ts").text()
    expect(src).toContain("busy_timeout")
  })
})

// ── Bug 5: tryMerge double-throw ──────────────────────────────────────────────

describe("tryMerge nested catch safety (Bug 5)", () => {
  it("git-manager source has nested try/catch in tryMerge", async () => {
    const src = await Bun.file("src/workspace/git-manager.ts").text()
    // The fix wraps diff and abort in their own try/catch blocks
    const diffTryCatch = src.includes("try {\n        const out = this.git(\"diff\"")
    const abortTryCatch = src.includes("try {\n        this.git(\"merge\", \"--abort\")")
    expect(diffTryCatch).toBe(true)
    expect(abortTryCatch).toBe(true)
  })
})

// ── Bug 6: dispatch double-dispatch race ─────────────────────────────────────

describe("dispatch pre-await markBusy (Bug 6)", () => {
  it("conductor source marks agent busy before first await", async () => {
    const src = await Bun.file("src/conductor/index.ts").text()
    const dispatchFn = src.slice(src.indexOf("private async dispatch("))
    const markBusyPos  = dispatchFn.indexOf("markBusy(agentId")
    const firstAwaitPos = dispatchFn.indexOf("await client.createThread()")
    // markBusy must come before the first await
    expect(markBusyPos).toBeGreaterThan(0)
    expect(markBusyPos).toBeLessThan(firstAwaitPos)
  })
})
