import { describe, it, expect } from "bun:test"
import { AgentProcessManager } from "../src/runtime/agent-manager"
import { defaultConfig } from "../src/dag/types"
import type { AgentInstance } from "../src/dag/types"
import { CodeWhaleClient } from "../src/runtime/client"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig() {
  return defaultConfig({ projectPath: "/tmp/test-adopt", basePort: 29000 })
}

function fakeInstance(port: number): AgentInstance {
  return {
    id:             `fake-agent-${port}`,
    port,
    role:           "general",
    status:         "idle",
    pid:            99999,
    currentTaskId:  null,
    threadId:       null,
    model:          null,
    startedAt:      Date.now(),
    lastHeartbeat:  Date.now(),
  }
}

// Minimal Subprocess stub — just needs .kill() and .pid
function fakeProcess(): { kill: () => void; pid: number; exited: Promise<number> } {
  return {
    pid:    99999,
    kill:   () => {},
    exited: Promise.resolve(0),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AgentProcessManager.adopt()", () => {
  it("registers adopted agent as idle in idleInstances()", () => {
    const mgr  = new AgentProcessManager(makeConfig())
    const inst = fakeInstance(29001)
    const proc = fakeProcess() as unknown as import("bun").Subprocess
    const cli  = new CodeWhaleClient(29001)

    mgr.adopt(inst, proc, cli)

    const idle = mgr.idleInstances()
    expect(idle).toHaveLength(1)
    expect(idle[0]!.id).toBe(inst.id)
    expect(idle[0]!.status).toBe("idle")
  })

  it("forces status to idle even if instance was marked starting", () => {
    const mgr  = new AgentProcessManager(makeConfig())
    const inst = fakeInstance(29002)
    inst.status = "starting"  // simulate warm agent still marked starting
    const proc = fakeProcess() as unknown as import("bun").Subprocess
    const cli  = new CodeWhaleClient(29002)

    mgr.adopt(inst, proc, cli)

    expect(mgr.idleInstances()[0]!.status).toBe("idle")
  })

  it("adopted agent appears in stats().idle", () => {
    const mgr = new AgentProcessManager(makeConfig())
    expect(mgr.stats().idle).toBe(0)

    mgr.adopt(
      fakeInstance(29003),
      fakeProcess() as unknown as import("bun").Subprocess,
      new CodeWhaleClient(29003),
    )

    expect(mgr.stats().idle).toBe(1)
    expect(mgr.stats().total).toBe(1)
  })

  it("adopted agent can be retrieved via getInstance()", () => {
    const mgr  = new AgentProcessManager(makeConfig())
    const inst = fakeInstance(29004)

    mgr.adopt(
      inst,
      fakeProcess() as unknown as import("bun").Subprocess,
      new CodeWhaleClient(29004),
    )

    const retrieved = mgr.getInstance(inst.id)
    expect(retrieved).not.toBeUndefined()
    expect(retrieved!.id).toBe(inst.id)
  })

  it("adopted agent can be retrieved via getClient()", () => {
    const mgr  = new AgentProcessManager(makeConfig())
    const inst = fakeInstance(29005)
    const cli  = new CodeWhaleClient(29005)

    mgr.adopt(
      inst,
      fakeProcess() as unknown as import("bun").Subprocess,
      cli,
    )

    // getClient throws if not found — so just expect no throw
    expect(() => mgr.getClient(inst.id)).not.toThrow()
  })

  it("adopting multiple agents accumulates them all as idle", () => {
    const mgr = new AgentProcessManager(makeConfig())

    for (let i = 0; i < 3; i++) {
      mgr.adopt(
        fakeInstance(29010 + i),
        fakeProcess() as unknown as import("bun").Subprocess,
        new CodeWhaleClient(29010 + i),
      )
    }

    expect(mgr.idleInstances()).toHaveLength(3)
    expect(mgr.stats().idle).toBe(3)
  })

  it("markBusy on adopted agent works correctly", () => {
    const mgr  = new AgentProcessManager(makeConfig())
    const inst = fakeInstance(29020)

    mgr.adopt(
      inst,
      fakeProcess() as unknown as import("bun").Subprocess,
      new CodeWhaleClient(29020),
    )

    mgr.markBusy(inst.id, "task-1", "thread-abc")
    expect(mgr.idleInstances()).toHaveLength(0)
    expect(mgr.stats().busy).toBe(1)

    mgr.markIdle(inst.id)
    expect(mgr.idleInstances()).toHaveLength(1)
  })

  it("getAllInstances() returns all agents regardless of status", () => {
    const mgr = new AgentProcessManager(makeConfig())

    const inst1 = fakeInstance(29030)
    const inst2 = fakeInstance(29031)
    const proc  = fakeProcess() as unknown as import("bun").Subprocess

    mgr.adopt(inst1, proc, new CodeWhaleClient(29030))
    mgr.adopt(inst2, proc, new CodeWhaleClient(29031))
    mgr.markBusy(inst1.id, "t1", "thread-1")  // inst1 is now busy

    const all = mgr.getAllInstances()
    expect(all).toHaveLength(2)
    const ids = new Set(all.map(a => a.id))
    expect(ids.has(inst1.id)).toBe(true)
    expect(ids.has(inst2.id)).toBe(true)
  })
})
