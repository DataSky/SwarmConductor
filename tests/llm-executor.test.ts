import { describe, it, expect } from "bun:test"
import { AgentProcessManager } from "../src/runtime/agent-manager"
import { LLMExecutor } from "../src/executor/llm-executor"
import { CodeWhaleClient } from "../src/runtime/client"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import type { AgentInstance, AgentRole, TaskNode } from "../src/dag/types"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function task(role?: AgentRole): TaskNode {
  return createTaskNode({
    type: "explore", title: "t", prompt: "p", scope: [],
    ...(role ? { role } : {}),
  })
}

function fakeInstance(port: number, role: AgentRole = "general"): AgentInstance {
  return {
    id: `fake-agent-${port}`, port, role, status: "idle", pid: 99999,
    currentTaskId: null, threadId: null, model: null,
    startedAt: Date.now(), lastHeartbeat: Date.now(),
  }
}
const fakeProc = () => ({ pid: 99999, kill: () => {}, exited: Promise.resolve(0) }) as unknown as import("bun").Subprocess

function mgrWith(...insts: AgentInstance[]): AgentProcessManager {
  const mgr = new AgentProcessManager(defaultConfig({ projectPath: "/tmp/test-exec", basePort: 31000 }))
  for (const i of insts) mgr.adopt(i, fakeProc(), new CodeWhaleClient(i.port))
  return mgr
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("LLMExecutor.availableSlots", () => {
  it("reflects the number of idle agents", () => {
    const exec = new LLMExecutor(mgrWith(fakeInstance(31001), fakeInstance(31002)))
    expect(exec.availableSlots()).toBe(2)
  })

  it("is zero when there are no agents", () => {
    expect(new LLMExecutor(mgrWith()).availableSlots()).toBe(0)
  })
})

describe("LLMExecutor.reserve", () => {
  it("returns a handle and marks the worker busy synchronously", () => {
    const exec = new LLMExecutor(mgrWith(fakeInstance(31010)))
    const handle = exec.reserve(task("general"))
    expect(handle).not.toBeNull()
    // Reserving consumed the only slot — availableSlots drops immediately,
    // before any execute() call.
    expect(exec.availableSlots()).toBe(0)
  })

  it("returns null when no slot is free", () => {
    const exec = new LLMExecutor(mgrWith(fakeInstance(31020)))
    exec.reserve(task())   // take the only slot
    expect(exec.reserve(task())).toBeNull()
  })

  it("prefers an agent whose role matches the task", () => {
    const general = fakeInstance(31030, "general")
    const verifier = fakeInstance(31031, "verifier")
    const exec = new LLMExecutor(mgrWith(general, verifier))
    const handle = exec.reserve(task("verifier"))
    expect(handle!.workerId).toBe(verifier.id)
  })

  it("falls back to a general agent when the exact role is unavailable", () => {
    const general = fakeInstance(31040, "general")
    const exec = new LLMExecutor(mgrWith(general))
    const handle = exec.reserve(task("verifier"))
    expect(handle!.workerId).toBe(general.id)
  })
})

describe("LLMExecutionHandle.release", () => {
  it("returns the slot to the pool", () => {
    const exec = new LLMExecutor(mgrWith(fakeInstance(31050)))
    const handle = exec.reserve(task())!
    expect(exec.availableSlots()).toBe(0)
    handle.release()
    expect(exec.availableSlots()).toBe(1)
  })

  it("is idempotent — double release does not over-credit the pool", () => {
    const exec = new LLMExecutor(mgrWith(fakeInstance(31060)))
    const handle = exec.reserve(task())!
    handle.release()
    handle.release()
    expect(exec.availableSlots()).toBe(1)   // still just one agent
  })
})
