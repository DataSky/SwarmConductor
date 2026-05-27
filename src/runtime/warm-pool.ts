import { spawn, type Subprocess } from "bun"
import type { AgentInstance } from "../dag/types"
import { CodeWhaleClient } from "./client"
import { buildSafeEnv } from "./agent-manager"

export interface WarmSlot {
  instance: AgentInstance
  process:  Subprocess
  client:   CodeWhaleClient
}

export interface WarmPoolOpts {
  projectPath:   string
  codewhalebin:  string
  poolSize:      number
  basePort:      number
  /** Override process spawner — used in tests to avoid real codewhale dependency. */
  _spawnFn?:     (port: number) => { process: Subprocess; waitReady: () => Promise<void> }
}

export class WarmPool {
  private ready:      WarmSlot[] = []
  private refilling = 0
  private stopped   = false
  private nextPort:   number

  constructor(private opts: WarmPoolOpts) {
    this.nextPort = opts.basePort
  }

  /** Non-blocking: spawn poolSize agents in background. Errors per-slot are swallowed. */
  start(): void {
    void this.refill()
  }

  /** Synchronously take up to n ready slots. Triggers a background refill automatically. */
  acquire(n: number): WarmSlot[] {
    const taken = this.ready.splice(0, n)
    if (taken.length > 0) void this.refill()
    return taken
  }

  /** Kill all remaining warm agents and prevent future refills. */
  stop(): void {
    this.stopped = true
    for (const slot of this.ready) {
      try { slot.process.kill() } catch { /* ignore */ }
    }
    this.ready = []
  }

  stats(): { ready: number; refilling: number; total: number } {
    return {
      ready:     this.ready.length,
      refilling: this.refilling,
      total:     this.ready.length + this.refilling,
    }
  }

  private async refill(): Promise<void> {
    if (this.stopped) return
    const needed = this.opts.poolSize - this.ready.length - this.refilling
    if (needed <= 0) return

    const results = await Promise.allSettled(
      Array.from({ length: needed }, () => this.spawnOne())
    )

    for (const r of results) {
      if (r.status === "fulfilled" && !this.stopped) {
        this.ready.push(r.value)
      } else if (r.status === "rejected") {
        console.warn(`[warm-pool] slot failed to start: ${(r.reason as Error)?.message ?? r.reason}`)
      }
    }
  }

  private async spawnOne(): Promise<WarmSlot> {
    const port = this.nextPort++
    const id   = `warm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    const instance: AgentInstance = {
      id,
      port,
      role: "general",
      status: "starting",
      pid: null,
      currentTaskId: null,
      threadId: null,
      model: null,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }

    this.refilling++
    try {
      let proc: Subprocess
      let client: CodeWhaleClient

      if (this.opts._spawnFn) {
        const result = this.opts._spawnFn(port)
        proc = result.process
        instance.pid = proc.pid
        client = new CodeWhaleClient(port)
        await result.waitReady()
      } else {
        proc = spawn({
          cmd: [
            this.opts.codewhalebin,
            "serve",
            "--http",
            "--port", String(port),
            "--insecure",
          ],
          cwd:    this.opts.projectPath,
          stdout: "ignore",
          stderr: "ignore",
          env:    buildSafeEnv(),
        })
        instance.pid = proc.pid
        client = new CodeWhaleClient(port)
        await client.waitUntilReady(90_000)
      }

      if (this.stopped) {
        proc.kill()
        throw new Error("pool stopped during startup")
      }

      instance.status = "idle"
      return { instance, process: proc, client }
    } finally {
      this.refilling--
    }
  }
}

