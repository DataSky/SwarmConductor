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
