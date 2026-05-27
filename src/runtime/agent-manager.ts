import { spawn, type Subprocess } from "bun"
import type { AgentInstance, AgentRole, ConductorConfig } from "../dag/types"
import { CodeWhaleClient } from "./client"

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

    // Pass only the env vars codewhale actually needs.
    // Never forward arbitrary secrets from the parent environment.
    const proc = spawn({
      cmd: [
        this.config.codewhalebin,
        "serve",
        "--http",
        "--port", String(port),
        "--insecure",
      ],
      cwd: this.config.projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: this.safeEnv(),
    })

    instance.pid = proc.pid
    this.instances.set(id, instance)
    this.processes.set(id, proc)

    const client = new CodeWhaleClient(port)
    this.clients.set(id, client)

    try {
      await client.waitUntilReady(30_000)
      instance.status = "idle"
    } catch (err) {
      instance.status = "crashed"
      proc.kill()
      this.instances.delete(id)
      this.processes.delete(id)
      this.clients.delete(id)
      throw new Error(`Agent ${id} (port ${port}) failed to start: ${err}`)
    }

    return instance
  }

  async spawnPool(roles: AgentRole[]): Promise<AgentInstance[]> {
    // Spawn concurrently
    return Promise.all(roles.map(r => this.spawn(r)))
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
    oldProc?.kill()

    inst.status = "starting"
    inst.currentTaskId = null
    inst.threadId = null

    const proc = spawn({
      cmd: [
        this.config.codewhalebin,
        "serve",
        "--http",
        "--port", String(inst.port),
        "--insecure",
      ],
      cwd: this.config.projectPath,
      stdout: "pipe",
      stderr: "pipe",
      env: this.safeEnv(),
    })

    inst.pid = proc.pid
    this.processes.set(agentId, proc)

    const client = new CodeWhaleClient(inst.port)
    this.clients.set(agentId, client)

    await client.waitUntilReady(30_000)
    inst.status = "idle"
  }

  async stopAll(): Promise<void> {
    for (const [id, proc] of this.processes) {
      proc.kill()
      const inst = this.instances.get(id)
      if (inst) inst.status = "stopped"
    }
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

  // Only forward env vars codewhale actually needs — never leak arbitrary secrets.
  private safeEnv(): Record<string, string> {
    const allowed = ["DEEPSEEK_", "OPENAI_", "ANTHROPIC_", "HOME", "PATH", "USER", "SHELL", "TERM", "LANG", "LC_", "XDG_"]
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v && allowed.some(p => k.startsWith(p))) env[k] = v
    }
    return env
  }
}
