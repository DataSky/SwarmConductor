import { describe, it, expect } from "bun:test"
import type { Subprocess } from "bun"
import { terminate } from "../src/runtime/agent-manager"

// ─── Mock Subprocess factory ────────────────────────────────────────────────
// Models the three states terminate() must handle: already dead, exits
// promptly on SIGTERM, and ignores SIGTERM (forcing SIGKILL escalation).

interface MockProc {
  proc: Subprocess
  signals: string[]
  killCount: () => number
}

function makeProc(opts: {
  alreadyKilled?: boolean
  /** ms before the process "exits" after the first kill() call; never if undefined. */
  exitsAfterMs?: number
  /** if true, only a SIGKILL causes exit (SIGTERM is ignored). */
  ignoresSigterm?: boolean
} = {}): MockProc {
  const signals: string[] = []
  let resolveExited: (code: number) => void = () => {}
  const exited = new Promise<number>(r => { resolveExited = r })

  if (opts.alreadyKilled) resolveExited(0)

  const proc = {
    pid: 12345,
    killed: opts.alreadyKilled ?? false,
    exited,
    kill: (sig?: string | number) => {
      const name = sig === "SIGKILL" || sig === 9 ? "SIGKILL" : "SIGTERM"
      signals.push(name)
      const shouldExit = opts.ignoresSigterm ? name === "SIGKILL" : true
      if (shouldExit && opts.exitsAfterMs !== undefined) {
        setTimeout(() => resolveExited(0), opts.exitsAfterMs)
      } else if (shouldExit && opts.exitsAfterMs === undefined) {
        // default: exit on next tick for the graceful case
        queueMicrotask(() => resolveExited(0))
      }
    },
  } as unknown as Subprocess

  return { proc, signals, killCount: () => signals.length }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("terminate()", () => {
  it("is a no-op on an already-killed process", async () => {
    const m = makeProc({ alreadyKilled: true })
    await terminate(m.proc, 50)
    expect(m.killCount()).toBe(0)   // killed flag short-circuits before any signal
  })

  it("sends SIGTERM and resolves when the process exits gracefully", async () => {
    const m = makeProc({ exitsAfterMs: 5 })
    await terminate(m.proc, 1_000)
    expect(m.signals).toEqual(["SIGTERM"])   // no escalation needed
  })

  it("escalates to SIGKILL when SIGTERM is ignored past the grace period", async () => {
    const m = makeProc({ ignoresSigterm: true, exitsAfterMs: 5 })
    await terminate(m.proc, 30)   // short grace so the timeout fires
    expect(m.signals).toEqual(["SIGTERM", "SIGKILL"])
  })

  it("does not throw if kill() throws (process vanished mid-call)", async () => {
    const proc = {
      killed: false,
      exited: Promise.resolve(0),
      kill: () => { throw new Error("ESRCH: no such process") },
    } as unknown as Subprocess
    // Should swallow the kill() error and resolve cleanly.
    await terminate(proc, 20)
  })
})
