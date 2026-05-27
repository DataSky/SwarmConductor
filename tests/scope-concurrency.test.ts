import { describe, it, expect } from "bun:test"
import { TaskDAG, createTaskNode } from "../src/dag/engine"

// ─── scope=[] 完全并发行为 ────────────────────────────────────────────────────

describe("scope=[] concurrency", () => {
  it("scopesConflict([], [...]) always returns false", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict([], ["/proj/src/auth.ts"])).toBe(false)
    expect(dag.scopesConflict(["/proj/src/auth.ts"], [])).toBe(false)
    expect(dag.scopesConflict([], [])).toBe(false)
  })

  it("conflictingRunning returns [] for a scope=[] task even with running tasks", () => {
    const dag = new TaskDAG("/tmp/t")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: ["/proj/src/auth.ts"] })
    dag.addTask(a)
    dag.assign(a.id, "agent-1")  // a is now running with a scope

    expect(dag.conflictingRunning([])).toHaveLength(0)
  })

  it("three scope=[] tasks can all be assigned simultaneously", () => {
    const dag = new TaskDAG("/tmp/t")
    const e1 = createTaskNode({ type: "explore", title: "E1", prompt: "p", scope: [] })
    const e2 = createTaskNode({ type: "explore", title: "E2", prompt: "p", scope: [] })
    const e3 = createTaskNode({ type: "review",  title: "R1", prompt: "p", scope: [] })
    dag.addTasks([e1, e2, e3])

    dag.assign(e1.id, "agent-1")
    dag.assign(e2.id, "agent-2")
    dag.assign(e3.id, "agent-3")

    expect(dag.getTask(e1.id)!.status).toBe("running")
    expect(dag.getTask(e2.id)!.status).toBe("running")
    expect(dag.getTask(e3.id)!.status).toBe("running")
    // None of them conflict with each other
    expect(dag.conflictingRunning([])).toHaveLength(0)
  })

  it("scope=[] task does not conflict with a scope=[...] running task", () => {
    const dag = new TaskDAG("/tmp/t")
    const impl    = createTaskNode({ type: "implement", title: "Impl", prompt: "p", scope: ["/proj/src"] })
    const explore = createTaskNode({ type: "explore",   title: "Expl", prompt: "p", scope: [] })
    dag.addTasks([impl, explore])

    dag.assign(impl.id, "agent-1")
    expect(dag.conflictingRunning([])).toHaveLength(0)
  })
})

// ─── 前缀匹配 scopesConflict ──────────────────────────────────────────────────

describe("scopesConflict prefix matching", () => {
  it("exact path match still conflicts (backward compat)", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/src/foo.ts"], ["/src/foo.ts"])).toBe(true)
  })

  it("existing dag.test exact-match case still passes", () => {
    const dag = new TaskDAG("/tmp/t")
    // Original test: a=["/src/foo.ts", "/src/bar.ts"], b=["/src/bar.ts"] → conflict
    expect(dag.scopesConflict(["/src/foo.ts", "/src/bar.ts"], ["/src/bar.ts"])).toBe(true)
  })

  it("directory scope conflicts with child file scope", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/proj/src"], ["/proj/src/auth.ts"])).toBe(true)
  })

  it("child file scope conflicts with parent directory scope (reverse)", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/proj/src/auth.ts"], ["/proj/src"])).toBe(true)
  })

  it("different files under same directory do NOT conflict", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/proj/src/auth.ts"], ["/proj/src/user.ts"])).toBe(false)
  })

  it("prevents false match: /src/auth does NOT match /src/authz", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/src/auth"], ["/src/authz"])).toBe(false)
    expect(dag.scopesConflict(["/src/authz"], ["/src/auth"])).toBe(false)
  })

  it("root ancestor conflicts with deep descendant", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/proj"], ["/proj/src/deep/nested/file.ts"])).toBe(true)
  })

  it("sibling directories do NOT conflict", () => {
    const dag = new TaskDAG("/tmp/t")
    expect(dag.scopesConflict(["/proj/src/auth"], ["/proj/src/users"])).toBe(false)
  })

  it("multi-element scopes: conflict if any pair overlaps", () => {
    const dag = new TaskDAG("/tmp/t")
    // a has two paths, b overlaps with one of them via prefix
    expect(dag.scopesConflict(
      ["/proj/lib/utils.ts", "/proj/src/auth"],
      ["/proj/src/auth/middleware.ts"]
    )).toBe(true)
  })

  it("conflictingRunning uses prefix semantics", () => {
    const dag = new TaskDAG("/tmp/t")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: ["/proj/src"] })
    dag.addTask(a)
    dag.assign(a.id, "agent-1")

    // Task with child path should be seen as conflicting
    const conflicts = dag.conflictingRunning(["/proj/src/auth.ts"])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.id).toBe(a.id)
  })
})
