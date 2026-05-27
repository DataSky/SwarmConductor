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
