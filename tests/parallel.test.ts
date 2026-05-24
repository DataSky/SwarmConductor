/**
 * Parallel agents integration test.
 * Spawns 3 real CodeWhale instances and dispatches tasks concurrently.
 * Run: bun test tests/parallel.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { AgentProcessManager } from "../src/runtime/agent-manager"
import { FileLockRegistry } from "../src/workspace/file-lock"
import { SharedMemoryBus } from "../src/memory/bus"
import { defaultConfig } from "../src/dag/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

const TMP_DIR = join(process.cwd(), ".test-parallel-run")
const BASE_PORT = 18100

const config = defaultConfig({
  projectPath: TMP_DIR,
  maxConcurrentAgents: 5,
  basePort: BASE_PORT,
  fileLockTtlMs: 120_000,
  deadlockTimeoutMs: 120_000,
  schedulerTickMs: 200,
  autoApprove: true,
  codewhalebin: "codewhale",
})

let agentMgr: AgentProcessManager

beforeAll(async () => {
  mkdirSync(TMP_DIR, { recursive: true })
  agentMgr = new AgentProcessManager(config)
  // Spawn 3 agents in parallel
  await agentMgr.spawnPool(["general", "general", "general"])
}, 60_000)

afterAll(async () => {
  await agentMgr.stopAll()
  rmSync(TMP_DIR, { recursive: true, force: true })
})

describe("AgentProcessManager", () => {
  it("spawns 3 idle agents", () => {
    const stats = agentMgr.stats()
    expect(stats.total).toBe(3)
    expect(stats.idle).toBe(3)
    expect(stats.crashed).toBe(0)
  })
})

describe("Parallel dispatch", () => {
  it("dispatches 3 tasks concurrently and all complete", async () => {
    const prompts = [
      'Say only "ONE"',
      'Say only "TWO"',
      'Say only "THREE"',
    ]

    const idle = agentMgr.idleInstances()
    expect(idle.length).toBeGreaterThanOrEqual(3)

    const results = await Promise.all(
      prompts.map(async (prompt, i) => {
        const agent = idle[i]!
        const client = agentMgr.getClient(agent.id)
        agentMgr.markBusy(agent.id, `task-${i}`, "pending")

        const thread = await client.createThread()
        agentMgr.markBusy(agent.id, `task-${i}`, thread.id)

        const turn = await client.postTurn(thread.id, { prompt, auto_approve: true })
        const result = await client.waitForTurn(thread.id, turn.id, undefined, 60_000)
        agentMgr.markIdle(agent.id)
        return result
      })
    )

    expect(results[0]!.status).toBe("completed")
    expect(results[1]!.status).toBe("completed")
    expect(results[2]!.status).toBe("completed")

    expect(results[0]!.fullText).toContain("ONE")
    expect(results[1]!.fullText).toContain("TWO")
    expect(results[2]!.fullText).toContain("THREE")

    const stats = agentMgr.stats()
    expect(stats.idle).toBe(3) // all back to idle
  }, 120_000)
})

describe("FileLock + parallel conflict prevention", () => {
  it("prevents two tasks from acquiring the same file simultaneously", () => {
    const reg = new FileLockRegistry(60_000)
    const fileA = `${TMP_DIR}/src/shared.ts`

    const gotA = reg.tryAcquire([fileA], "agent-1", "task-1")
    const gotB = reg.tryAcquire([fileA], "agent-2", "task-2")

    expect(gotA).toBe(true)
    expect(gotB).toBe(false)

    reg.releaseByTask("task-1")
    const gotC = reg.tryAcquire([fileA], "agent-2", "task-2")
    expect(gotC).toBe(true)
  })
})

describe("SharedMemoryBus cross-agent", () => {
  it("agent-1 writes context, agent-2 reads it", () => {
    const memDir = join(TMP_DIR, ".conductor-mem-test")
    mkdirSync(memDir, { recursive: true })
    const bus = new SharedMemoryBus(memDir)

    bus.write({
      layer: "context",
      agentId: "agent-1",
      taskId: "task-explore",
      content: "Found 42 source files. Main entry: src/index.ts",
      tags: ["src/index.ts", "structure"],
    })

    const entries = bus.getContext(["src/index.ts"])
    expect(entries.length).toBeGreaterThanOrEqual(1)
    expect(entries[0]!.content).toContain("src/index.ts")
    expect(entries[0]!.agentId).toBe("agent-1")
  })

  it("event log is append-only and readable", () => {
    const memDir = join(TMP_DIR, ".conductor-mem-test2")
    mkdirSync(memDir, { recursive: true })
    const bus = new SharedMemoryBus(memDir)

    bus.write({ layer: "event_log", agentId: "a1", taskId: "t1", content: '{"event":"task.completed"}', tags: ["event"] })
    bus.write({ layer: "event_log", agentId: "a2", taskId: "t2", content: '{"event":"task.failed"}', tags: ["event", "error"] })

    const events = bus.getRecentEvents(10)
    expect(events.length).toBe(2)
    expect(events[0]!.agentId).toBe("a1")
    expect(events[1]!.agentId).toBe("a2")
  })
})
