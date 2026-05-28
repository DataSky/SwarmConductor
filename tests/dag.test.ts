import { describe, it, expect } from "bun:test"
import { TaskDAG, createTaskNode } from "../src/dag/engine"
import { FileLockRegistry } from "../src/workspace/file-lock"

describe("TaskDAG", () => {
  it("transitions nodes with no deps to ready immediately", () => {
    const dag = new TaskDAG("/tmp/test")
    const task = createTaskNode({ type: "explore", title: "T1", prompt: "p", scope: [] })
    dag.addTask(task)
    expect(dag.getTask(task.id)?.status).toBe("ready")
  })

  it("blocks tasks with unmet deps", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "explore", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "plan", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    expect(dag.getTask(a.id)?.status).toBe("ready")
    expect(dag.getTask(b.id)?.status).toBe("blocked")
  })

  it("unblocks downstream when dep completes", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "explore", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "plan", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    dag.assign(a.id, "agent-1")
    dag.complete(a.id, {
      summary: "done", changes: [], evidence: [], risks: [], blockers: [], rawText: "## SUMMARY\ndone\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS",
    })

    expect(dag.getTask(b.id)?.status).toBe("ready")
  })

  it("retries on failure up to maxRetries", () => {
    const dag = new TaskDAG("/tmp/test")
    const task = createTaskNode({ type: "implement", title: "T", prompt: "p", scope: [], maxRetries: 2 })
    dag.addTask(task)

    dag.assign(task.id, "agent-1")
    dag.fail(task.id, "err1")
    expect(dag.getTask(task.id)?.status).toBe("ready")
    expect(dag.getTask(task.id)?.retryCount).toBe(1)

    dag.assign(task.id, "agent-1")
    dag.fail(task.id, "err2")
    expect(dag.getTask(task.id)?.status).toBe("ready")

    dag.assign(task.id, "agent-1")
    dag.fail(task.id, "err3")
    expect(dag.getTask(task.id)?.status).toBe("failed")
  })

  it("detects scope conflicts among running tasks", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: ["/src/foo.ts", "/src/bar.ts"] })
    const b = createTaskNode({ type: "implement", title: "B", prompt: "p", scope: ["/src/bar.ts"] })
    dag.addTasks([a, b])

    dag.assign(a.id, "agent-1")
    const conflicts = dag.conflictingRunning(b.scope)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.id).toBe(a.id)
  })

  it("unblocks downstream when dependency permanently fails (RC1 fix)", () => {
    const dag = new TaskDAG("/tmp/test")
    // A → B  (B depends on A)
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 0 })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    // A starts running, then fails with no retries left
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "fatal error")

    expect(dag.getTask(a.id)?.status).toBe("failed")
    // B should be unblocked (ready), not stuck at blocked and not cascaded to failed
    expect(dag.getTask(b.id)?.status).toBe("ready")
    expect(dag.getTask(b.id)?.error).toBeNull()
  })

  it("unblocks through multi-hop dependency chain when dep fails", () => {
    const dag = new TaskDAG("/tmp/test")
    // A → B → C
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 0 })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    const c = createTaskNode({ type: "verify", title: "C", prompt: "p", scope: [], dependsOn: [b.id] })
    dag.addTasks([a, b, c])

    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "fatal")

    // A is failed; B is unblocked (ready); C still blocked on B (B not terminal yet)
    expect(dag.getTask(a.id)?.status).toBe("failed")
    expect(dag.getTask(b.id)?.status).toBe("ready")
    expect(dag.getTask(c.id)?.status).toBe("blocked")

    // After B completes, C is unblocked
    dag.assign(b.id, "agent-2")
    dag.complete(b.id, {
      summary: "review done", changes: [], evidence: [], risks: [], blockers: [], rawText: "## SUMMARY\nreview done",
    })
    expect(dag.getTask(c.id)?.status).toBe("ready")
  })

  it("isComplete returns true when all tasks reach terminal state", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 0 })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    // A fails permanently
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "fatal")

    // B is unblocked (ready), not failed — it can still run
    expect(dag.getTask(b.id)?.status).toBe("ready")
    expect(dag.isComplete()).toBe(false)

    // B completes
    dag.assign(b.id, "agent-2")
    dag.complete(b.id, {
      summary: "review done", changes: [], evidence: [], risks: [], blockers: [], rawText: "## SUMMARY\nreview done",
    })

    expect(dag.isComplete()).toBe(true)
  })

  it("keeps downstream blocked when only some deps fail (mixed terminal)", () => {
    const dag = new TaskDAG("/tmp/test")
    // C depends on A and B — A fails permanently, B is still pending
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 0 })
    const b = createTaskNode({ type: "implement", title: "B", prompt: "p", scope: [] })
    const c = createTaskNode({ type: "review", title: "C", prompt: "p", scope: [], dependsOn: [a.id, b.id] })
    dag.addTasks([a, b, c])

    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "fatal")

    expect(dag.getTask(a.id)?.status).toBe("failed")
    // B is independent and ready; C still blocked because B is not terminal yet
    expect(dag.getTask(b.id)?.status).toBe("ready")
    expect(dag.getTask(c.id)?.status).toBe("blocked")
  })

  it("unblocks downstream when all deps reach terminal state (mix of failed + done)", () => {
    const dag = new TaskDAG("/tmp/test")
    // C depends on A and B — A fails permanently, B succeeds
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 0 })
    const b = createTaskNode({ type: "implement", title: "B", prompt: "p", scope: [] })
    const c = createTaskNode({ type: "review", title: "C", prompt: "p", scope: [], dependsOn: [a.id, b.id] })
    dag.addTasks([a, b, c])

    // A fails
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "fatal")
    expect(dag.getTask(a.id)?.status).toBe("failed")
    // C still blocked: B is not terminal
    expect(dag.getTask(c.id)?.status).toBe("blocked")

    // B completes
    dag.assign(b.id, "agent-2")
    dag.complete(b.id, {
      summary: "done", changes: [], evidence: [], risks: [], blockers: [], rawText: "## SUMMARY\ndone",
    })
    expect(dag.getTask(b.id)?.status).toBe("done")
    // C is now unblocked: all deps are terminal
    expect(dag.getTask(c.id)?.status).toBe("ready")
    expect(dag.isComplete()).toBe(false)
  })

  it("unblocks downstream when dependency is interrupted", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    dag.assign(a.id, "agent-1")
    dag.interrupt(a.id)

    expect(dag.getTask(a.id)?.status).toBe("interrupted")
    expect(dag.getTask(b.id)?.status).toBe("ready")
    expect(dag.isComplete()).toBe(false)
  })

  it("unblocks through multi-hop chain when dependency is interrupted", () => {
    const dag = new TaskDAG("/tmp/test")
    // A → B → C
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    const c = createTaskNode({ type: "verify", title: "C", prompt: "p", scope: [], dependsOn: [b.id] })
    dag.addTasks([a, b, c])

    dag.assign(a.id, "agent-1")
    dag.interrupt(a.id)

    // A interrupted → B unblocked (ready); C still blocked (B not terminal)
    expect(dag.getTask(a.id)?.status).toBe("interrupted")
    expect(dag.getTask(b.id)?.status).toBe("ready")
    expect(dag.getTask(c.id)?.status).toBe("blocked")

    // B completes → C unblocked
    dag.assign(b.id, "agent-2")
    dag.complete(b.id, {
      summary: "review done", changes: [], evidence: [], risks: [], blockers: [], rawText: "## SUMMARY\nreview done",
    })
    expect(dag.getTask(c.id)?.status).toBe("ready")
  })

  it("unblocks downstream after dependency exhausts retries (maxRetries > 0)", () => {
    const dag = new TaskDAG("/tmp/test")
    // A (maxRetries=2) → B
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 2 })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    // Retry 1
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "err1")
    expect(dag.getTask(a.id)?.status).toBe("ready")
    expect(dag.getTask(a.id)?.retryCount).toBe(1)
    // B still blocked — A not terminal yet
    expect(dag.getTask(b.id)?.status).toBe("blocked")

    // Retry 2
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "err2")
    expect(dag.getTask(a.id)?.status).toBe("ready")
    expect(dag.getTask(a.id)?.retryCount).toBe(2)
    expect(dag.getTask(b.id)?.status).toBe("blocked")

    // Final attempt — exhausts maxRetries, permanently fails
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "err3")
    expect(dag.getTask(a.id)?.status).toBe("failed")
    // B now unblocked — A reached terminal state
    expect(dag.getTask(b.id)?.status).toBe("ready")
  })

  it("unblocks downstream after single retry exhaustion (maxRetries=1)", () => {
    const dag = new TaskDAG("/tmp/test")
    // A (maxRetries=1) → B
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], maxRetries: 1 })
    const b = createTaskNode({ type: "review", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])

    // First attempt fails but retry remains
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "err1")
    expect(dag.getTask(a.id)?.status).toBe("ready")
    expect(dag.getTask(a.id)?.retryCount).toBe(1)
    expect(dag.getTask(b.id)?.status).toBe("blocked")

    // Retry also fails — exhausted
    dag.assign(a.id, "agent-1")
    dag.fail(a.id, "err2")
    expect(dag.getTask(a.id)?.status).toBe("failed")
    expect(dag.getTask(b.id)?.status).toBe("ready")
  })

  it("detects no false positive deadlocks when tasks are independent", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "implement", title: "B", prompt: "p", scope: [] })
    dag.addTasks([a, b])
    dag.assign(a.id, "agent-1")
    dag.assign(b.id, "agent-2")

    expect(dag.detectDeadlock()).toHaveLength(0)
  })

  it("detects no false positive deadlocks when tasks form a running chain (A→B both running)", () => {
    const dag = new TaskDAG("/tmp/test")
    // A has no deps; B depends on A.  Both running is normal concurrency.
    const a = createTaskNode({ type: "explore", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "plan", title: "B", prompt: "p", scope: [], dependsOn: [a.id] })
    dag.addTasks([a, b])
    // A starts running; B becomes ready after A is assigned (its dep is now A which is running, not terminal yet — but B can be assigned before A finishes)
    dag.assign(a.id, "agent-1")
    // Manually force B to running to simulate the concurrent scenario
    dag.assign(b.id, "agent-2")

    expect(dag.getTask(a.id)?.status).toBe("running")
    expect(dag.getTask(b.id)?.status).toBe("running")
    expect(dag.detectDeadlock()).toHaveLength(0)
  })

  it("detects a true cycle (A→B→C→A) among running tasks", () => {
    const dag = new TaskDAG("/tmp/test")
    // Create a cycle: A→B→C→A
    // We must create them with dependsOn and manually override since the engine
    // normally prevents cycles at construction time
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], dependsOn: [] })
    const b = createTaskNode({ type: "implement", title: "B", prompt: "p", scope: [], dependsOn: [] })
    const c = createTaskNode({ type: "implement", title: "C", prompt: "p", scope: [], dependsOn: [] })
    dag.addTasks([a, b, c])

    // Manually wire a cycle: b depends on a, c depends on b, a depends on c
    const ta = dag.getTask(a.id)!
    const tb = dag.getTask(b.id)!
    const tc = dag.getTask(c.id)!
    ta.dependsOn = [c.id]
    tb.dependsOn = [a.id]
    tc.dependsOn = [b.id]
    // Wire reverse edges
    ta.blocks = []
    tb.blocks = [a.id]  // b blocks a (a depends on b)
    tc.blocks = [b.id]
    // Set all to running
    ta.status = "running"
    tb.status = "running"
    tc.status = "running"

    const cycle = dag.detectDeadlock()
    expect(cycle.length).toBeGreaterThanOrEqual(3)
    // The cycle should contain all three nodes (order may vary)
    expect(new Set(cycle)).toEqual(new Set([a.id, b.id, c.id]))
  })

  it("detects a simple 2-node cycle (A→B, B→A)", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "implement", title: "A", prompt: "p", scope: [], dependsOn: [] })
    const b = createTaskNode({ type: "implement", title: "B", prompt: "p", scope: [], dependsOn: [] })
    dag.addTasks([a, b])

    const ta = dag.getTask(a.id)!
    const tb = dag.getTask(b.id)!
    ta.dependsOn = [b.id]
    tb.dependsOn = [a.id]
    ta.status = "running"
    tb.status = "running"

    const cycle = dag.detectDeadlock()
    expect(cycle.length).toBeGreaterThanOrEqual(2)
    expect(new Set(cycle)).toEqual(new Set([a.id, b.id]))
  })

  // ── Serialization ──────────────────────────────────────────────────────────

  it("survives toJSON/fromJSON round-trip", () => {
    const dag = new TaskDAG("/tmp/proj")
    const a = createTaskNode({ type: "explore", title: "Scan", prompt: "p1", scope: ["src"] })
    const b = createTaskNode({ type: "plan", title: "Plan", prompt: "p2", scope: ["src"], dependsOn: [a.id] })
    dag.addTasks([a, b])
    dag.assign(a.id, "agent-1")
    dag.complete(a.id, {
      summary: "ok", changes: [{ file: "src/a.ts", description: "added" }],
      evidence: ["test pass"], risks: [], blockers: [], rawText: "## SUMMARY\nok",
    })

    const json = dag.toJSON()
    const restored = TaskDAG.fromJSON(json as ReturnType<TaskDAG["toJSON"]> & { tasks: [string, any][], id: string, projectPath: string, phase: number, createdAt: number, updatedAt: number })

    expect(restored.id).toBe(dag.id)
    expect(restored.phase).toBe(dag.phase)
    expect(restored.projectPath).toBe(dag.projectPath)
    expect(restored.allTasks()).toHaveLength(2)
    expect(restored.getTask(b.id)?.status).toBe("ready")
    expect(restored.getTask(a.id)?.status).toBe("done")
    expect(restored.getTask(a.id)?.output?.summary).toBe("ok")
  })

  // ── Error paths ────────────────────────────────────────────────────────────

  it("throws when adding a task with duplicate ID", () => {
    const dag = new TaskDAG("/tmp/test")
    const task = createTaskNode({ type: "explore", title: "T", prompt: "p", scope: [] })
    dag.addTask(task)
    expect(() => dag.addTask(task)).toThrow(/already exists/)
  })

  it("throws when adding a single task that depends on an unknown task", () => {
    const dag = new TaskDAG("/tmp/test")
    const task = createTaskNode({ type: "plan", title: "Bad", prompt: "p", scope: [], dependsOn: ["nonexistent"] })
    expect(() => dag.addTask(task)).toThrow(/unknown task/)
  })

  it("throws when addTasks includes a task that depends on an unknown task", () => {
    const dag = new TaskDAG("/tmp/test")
    const a = createTaskNode({ type: "explore", title: "A", prompt: "p", scope: [] })
    const b = createTaskNode({ type: "plan", title: "B", prompt: "p", scope: [], dependsOn: ["ghost"] })
    expect(() => dag.addTasks([a, b])).toThrow(/unknown task/)
  })
})

describe("FileLockRegistry", () => {
  it("grants lock on free file", () => {
    const reg = new FileLockRegistry()
    expect(reg.tryAcquire(["/src/a.ts"], "agent-1", "task-1")).toBe(true)
  })

  it("denies lock on held file", () => {
    const reg = new FileLockRegistry()
    reg.tryAcquire(["/src/a.ts"], "agent-1", "task-1")
    expect(reg.tryAcquire(["/src/a.ts"], "agent-2", "task-2")).toBe(false)
  })

  it("releases by task and allows re-acquisition", () => {
    const reg = new FileLockRegistry()
    reg.tryAcquire(["/src/a.ts"], "agent-1", "task-1")
    reg.releaseByTask("task-1")
    expect(reg.tryAcquire(["/src/a.ts"], "agent-2", "task-2")).toBe(true)
  })

  it("expires locks after TTL", async () => {
    const reg = new FileLockRegistry(50) // 50ms TTL
    reg.tryAcquire(["/src/b.ts"], "agent-1", "task-1")
    await new Promise(r => setTimeout(r, 80))
    expect(reg.isLocked("/src/b.ts")).toBe(false)
  })
})
