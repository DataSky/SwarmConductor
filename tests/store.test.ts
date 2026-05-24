import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { ConductorStore } from "../src/memory/store"
import { createTaskNode } from "../src/dag/engine"
import { rmSync, mkdirSync } from "fs"
import { join } from "path"

const TMP = join(process.cwd(), ".test-store-db")

let store: ConductorStore

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  store = new ConductorStore(TMP, "run-test-001")
  store.initRun("/test/project")
})

afterEach(() => {
  store.close()
  rmSync(TMP, { recursive: true, force: true })
})

describe("ConductorStore", () => {
  it("creates and retrieves a run", () => {
    const run = store.getRun()
    expect(run).not.toBeNull()
    expect(run!.id).toBe("run-test-001")
    expect(run!.project).toBe("/test/project")
    expect(run!.status).toBe("running")
    expect(run!.phase).toBe(0)
  })

  it("updates run phase and status", () => {
    store.updateRunPhase(2)
    store.updateRunStatus("completed")
    const run = store.getRun()
    expect(run!.phase).toBe(2)
    expect(run!.status).toBe("completed")
  })

  it("lists runs for a project", () => {
    const s2 = new ConductorStore(TMP, "run-test-002")
    s2.initRun("/test/project")

    const runs = store.listRuns("/test/project")
    expect(runs.length).toBe(2)
    s2.close()
  })

  it("upserts and loads tasks round-trip", () => {
    const t = createTaskNode({
      type: "implement",
      title: "Fix auth bug",
      prompt: "Fix the auth module",
      scope: ["src/auth.ts"],
      priority: 80,
    })
    t.status = "ready"
    store.upsertTask(t)

    const tasks = store.loadTasks()
    expect(tasks.length).toBe(1)
    expect(tasks[0]!.id).toBe(t.id)
    expect(tasks[0]!.type).toBe("implement")
    expect(tasks[0]!.scope).toEqual(["src/auth.ts"])
    expect(tasks[0]!.status).toBe("ready")
  })

  it("persists task status updates", () => {
    const t = createTaskNode({ type: "explore", title: "Scan", prompt: "p", scope: [] })
    store.upsertTask(t)

    t.status = "done"
    t.completedAt = Date.now()
    store.upsertTask(t)

    const loaded = store.loadTasks()
    expect(loaded[0]!.status).toBe("done")
    expect(loaded[0]!.completedAt).toBeGreaterThan(0)
  })

  it("writes and reads memory entries by layer", () => {
    store.writeMemory({ layer: "context", agentId: "a1", taskId: "t1", content: "found 42 files", tags: ["src/"] })
    store.writeMemory({ layer: "context", agentId: "a2", taskId: "t2", content: "found 3 bugs in auth", tags: ["src/auth.ts"] })
    store.writeMemory({ layer: "project_map", agentId: "a1", taskId: "t1", content: "project map", tags: [] })

    const ctx = store.readMemory("context")
    expect(ctx.length).toBe(2)

    const map = store.getProjectMap()
    expect(map).not.toBeNull()
    expect(map!.content).toBe("project map")
  })

  it("filters context by tags", () => {
    store.writeMemory({ layer: "context", agentId: "a1", taskId: "t1", content: "auth work", tags: ["src/auth.ts"] })
    store.writeMemory({ layer: "context", agentId: "a2", taskId: "t2", content: "parser work", tags: ["src/parser.ts"] })

    const authCtx = store.getContext(["src/auth.ts"])
    expect(authCtx.length).toBe(1)
    expect(authCtx[0]!.content).toBe("auth work")
  })

  it("event log is append-only, returns recent N", () => {
    store.logEvent("a1", "t1", "task.completed", { title: "T1" })
    store.logEvent("a2", "t2", "task.failed", { title: "T2", error: "timeout" })
    store.logEvent("a1", "t3", "task.completed", { title: "T3" })

    const events = store.getRecentEvents(10)
    expect(events.length).toBe(3)
    expect(events[0]!.kind).toBe("task.completed")
    expect(events[1]!.kind).toBe("task.failed")
    expect(events[2]!.agentId).toBe("a1")
  })

  it("taskStats returns correct counts and avg duration", () => {
    const t1 = createTaskNode({ type: "implement", title: "T1", prompt: "p", scope: [] })
    const t2 = createTaskNode({ type: "implement", title: "T2", prompt: "p", scope: [] })
    const t3 = createTaskNode({ type: "implement", title: "T3", prompt: "p", scope: [] })

    t1.status = "done"; t1.startedAt = 1000; t1.completedAt = 3000   // 2000ms
    t2.status = "done"; t2.startedAt = 1000; t2.completedAt = 5000   // 4000ms
    t3.status = "failed"

    store.upsertTask(t1); store.upsertTask(t2); store.upsertTask(t3)

    const s = store.taskStats()
    expect(s.total).toBe(3)
    expect(s.done).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.avgDurationMs).toBe(3000) // (2000+4000)/2
  })

  it("handles 1000 task upserts without error (write throughput)", () => {
    const start = Date.now()
    for (let i = 0; i < 1000; i++) {
      const t = createTaskNode({ type: "implement", title: `Task ${i}`, prompt: "p", scope: [] })
      store.upsertTask(t)
    }
    const ms = Date.now() - start
    const tasks = store.loadTasks()
    expect(tasks.length).toBe(1000)
    console.log(`  1000 upserts in ${ms}ms (${(ms / 1000).toFixed(2)}ms each)`)
    expect(ms).toBeLessThan(2000) // should be well under 2s
  })
})
