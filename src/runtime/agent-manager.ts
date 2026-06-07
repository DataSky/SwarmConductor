import { spawn, type Subprocess } from "bun"
import type { AgentInstance, AgentRole, ConductorConfig } from "../dag/types"
import { CodeWhaleClient } from "./client"

// Only forward env vars codewhale actually needs — never leak arbitrary secrets.
const SAFE_ENV_PREFIXES = ["DEEPSEEK_", "OPENAI_", "ANTHROPIC_", "HOME", "PATH", "USER", "SHELL", "TERM", "LANG", "LC_", "XDG_"]

export function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v && SAFE_ENV_PREFIXES.some(p => k.startsWith(p))) env[k] = v
  }
  return env
}

const SIGKILL_GRACE_MS = 3_000  // wait this long for SIGTERM before escalating to SIGKILL

/**
 * Gracefully terminate a subprocess: send SIGTERM, wait up to `graceMs` for it
 * to exit, then escalate to SIGKILL. Safe to call on an already-exited process
 * (kill becomes a no-op) and never throws. Awaiting this guarantees the OS has
 * released the process's resources — notably its TCP port — before the caller
 * reuses them, which prevents the restart-on-same-port race.
 */
export async function terminate(proc: Subprocess, graceMs = SIGKILL_GRACE_MS): Promise<void> {
  if (proc.killed) return
  try { proc.kill() } catch { /* already gone */ }
  const timeout = new Promise<"timeout">(r => setTimeout(() => r("timeout"), graceMs))
  const result = await Promise.race([proc.exited.then(() => "exited" as const), timeout])
  if (result === "timeout") {
    try { proc.kill("SIGKILL") } catch { /* already gone */ }
    await proc.exited.catch(() => {})
  }
}

export class AgentProcessManager {
  private instances: Map<string, AgentInstance> = new Map()
  private processes: Map<string, Subprocess> = new Map()
  private clients: Map<string, CodeWhaleClient> = new Map()
  private config: ConductorConfig
  private nextPort: number

  constructor(config: ConductorConfig) {
    this.config = config
    this.nextPort = config.basePort
  }

  /** Build the spawn options for a codewhale serve process on the given port.
   *  Shared by spawn() and restart() so the two never drift apart.
   *  stdout/stderr must be "ignore" (not "pipe") — codewhale-tui is a Ratatui
   *  program that exits immediately when isatty() returns false (piped fd). */
  private spawnServe(port: number): Subprocess {
    return spawn({
      cmd: [
        this.config.codewhalebin,
        "serve",
        "--http",
        "--port", String(port),
        "--insecure",
      ],
      cwd: this.config.projectPath,
      stdout: "ignore",
      stderr: "ignore",
      env: this.safeEnv(),
    })
  }

  async spawn(role: AgentRole): Promise<AgentInstance> {
    const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const port = this.nextPort++

    const instance: AgentInstance = {
      id,
      port,
      role,
      status: "starting",
      pid: null,
      currentTaskId: null,
      threadId: null,
      model: this.config.modelMap[role] ?? null,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }

    const proc = this.spawnServe(port)

    instance.pid = proc.pid
    this.instances.set(id, instance)
    this.processes.set(id, proc)

    const client = new CodeWhaleClient(port)
    this.clients.set(id, client)

    try {
      // Race readiness against the process exiting. If our freshly-spawned
      // process dies during startup (e.g. the port is already held by a stale
      // codewhale, so bind fails), we must NOT treat the port answering as
      // "ready" — that would adopt the wrong process. proc.exited winning the
      // race means startup failed.
      const readyOrDied = await Promise.race([
        client.waitUntilReady(90_000).then(() => "ready" as const),
        proc.exited.then(() => "exited" as const),
      ])
      if (readyOrDied === "exited") {
        throw new Error(`process exited during startup (port ${port} likely already in use)`)
      }
      instance.status = "idle"
    } catch (err) {
      instance.status = "crashed"
      await terminate(proc)
      this.instances.delete(id)
      this.processes.delete(id)
      this.clients.delete(id)
      throw new Error(`Agent ${id} (port ${port}) failed to start: ${err}`)
    }

    return instance
  }

  /**
   * Spawn agents concurrently, tolerating partial failure. Returns whichever
   * agents started successfully along with the errors for those that didn't,
   * so the caller can degrade to a smaller pool instead of aborting the whole
   * run when a transient port conflict or slow codewhale startup hits one slot.
   * Throws only if EVERY agent fails (a degraded run with zero agents is no run).
   */
  async spawnPool(roles: AgentRole[]): Promise<{ started: AgentInstance[]; failures: Error[] }> {
    const results = await Promise.allSettled(roles.map(r => this.spawn(r)))
    const started: AgentInstance[] = []
    const failures: Error[] = []
    for (const r of results) {
      if (r.status === "fulfilled") started.push(r.value)
      else failures.push(r.reason instanceof Error ? r.reason : new Error(String(r.reason)))
    }
    if (started.length === 0) {
      throw new Error(
        `All ${roles.length} agent(s) failed to spawn:\n` +
        failures.map(e => `  • ${e.message}`).join("\n"),
      )
    }
    return { started, failures }
  }

  getClient(agentId: string): CodeWhaleClient {
    const client = this.clients.get(agentId)
    if (!client) throw new Error(`No client for agent ${agentId}`)
    return client
  }

  getInstance(agentId: string): AgentInstance | undefined {
    return this.instances.get(agentId)
  }

  idleInstances(): AgentInstance[] {
    return Array.from(this.instances.values()).filter(i => i.status === "idle")
  }

  idleByRole(role: AgentRole): AgentInstance[] {
    return this.idleInstances().filter(i => i.role === role)
  }

  markBusy(agentId: string, taskId: string, threadId: string, model?: string): void {
    const inst = this.mustGet(agentId)
    inst.status = "busy"
    inst.currentTaskId = taskId
    inst.threadId = threadId
    if (model) inst.model = model
    inst.lastHeartbeat = Date.now()
  }

  markIdle(agentId: string): void {
    const inst = this.mustGet(agentId)
    inst.status = "idle"
    inst.currentTaskId = null
    inst.threadId = null
  }

  markCrashed(agentId: string): void {
    const inst = this.mustGet(agentId)
    inst.status = "crashed"
  }

  heartbeat(agentId: string): void {
    const inst = this.instances.get(agentId)
    if (inst) inst.lastHeartbeat = Date.now()
  }

  /** Restart a crashed agent on its same port. */
  async restart(agentId: string): Promise<void> {
    const inst = this.mustGet(agentId)
    const oldProc = this.processes.get(agentId)

    inst.status = "starting"
    inst.currentTaskId = null
    inst.threadId = null

    // Wait for the old process to fully exit before reusing its port — a bare
    // kill() is async, so spawning immediately would race the OS releasing the
    // TCP port and the new serve would fail to bind.
    if (oldProc) await terminate(oldProc)

    const proc = this.spawnServe(inst.port)

    inst.pid = proc.pid
    this.processes.set(agentId, proc)

    const client = new CodeWhaleClient(inst.port)
    this.clients.set(agentId, client)

    await client.waitUntilReady(90_000)  // codewhale needs ~20s to start in spawned env
    inst.status = "idle"
  }

  /** Transfer ownership of an externally-spawned agent (e.g. from WarmPool) into this manager. */
  adopt(instance: AgentInstance, process: Subprocess, client: CodeWhaleClient): void {
    const adopted: AgentInstance = { ...instance, status: "idle" }
    this.instances.set(adopted.id, adopted)
    this.processes.set(adopted.id, process)
    this.clients.set(adopted.id, client)
  }

  getAllInstances(): AgentInstance[] {
    return Array.from(this.instances.values())
  }

  async stopAll(): Promise<void> {
    // Terminate concurrently and wait for every process to actually exit, so a
    // graceful shutdown leaves no orphaned codewhale processes holding ports.
    const procs = Array.from(this.processes.entries())
    await Promise.all(procs.map(async ([id, proc]) => {
      await terminate(proc)
      const inst = this.instances.get(id)
      if (inst) inst.status = "stopped"
    }))
    this.processes.clear()
    this.clients.clear()
  }

  stats() {
    const all = Array.from(this.instances.values())
    return {      total: all.length,
      idle: all.filter(i => i.status === "idle").length,
      busy: all.filter(i => i.status === "busy").length,
      crashed: all.filter(i => i.status === "crashed").length,
    }
  }

  private mustGet(id: string): AgentInstance {
    const inst = this.instances.get(id)
    if (!inst) throw new Error(`Agent instance ${id} not found`)
    return inst
  }

  private safeEnv(): Record<string, string> { return buildSafeEnv() }
}
