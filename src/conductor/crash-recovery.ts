import type { ConductorConfig, AgentInstance } from "../dag/types"
import type { AgentProcessManager } from "../runtime/agent-manager"
import type { TaskDAG } from "../dag/engine"
import type { FileLockRegistry } from "../workspace/file-lock"

// ─── Crash Recovery Monitor ───────────────────────────────────────────────────
// Polls agent heartbeats, detects crashes, restarts agents, requeues tasks.

export class CrashRecovery {
  private config: ConductorConfig
  private agentMgr: AgentProcessManager
  private dag: TaskDAG
  private lockRegistry: FileLockRegistry
  private restartCounts: Map<string, number> = new Map()
  private interval: ReturnType<typeof setInterval> | null = null
  private checking = false  // mutex: prevent overlapping check() calls
  private onCrash: (agentId: string) => void = () => {}
  private onRestart: (agentId: string) => void = () => {}

  constructor(
    config: ConductorConfig,
    agentMgr: AgentProcessManager,
    dag: TaskDAG,
    lockRegistry: FileLockRegistry,
  ) {
    this.config = config
    this.agentMgr = agentMgr
    this.dag = dag
    this.lockRegistry = lockRegistry
  }

  onAgentCrash(cb: (agentId: string) => void): void { this.onCrash = cb }
  onAgentRestart(cb: (agentId: string) => void): void { this.onRestart = cb }

  start(): void {
    if (this.interval) return
    this.interval = setInterval(() => this.check(), this.config.heartbeatIntervalMs)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async check(): Promise<void> {
    if (this.checking) return
    this.checking = true
    try {
      await this.doCheck()
    } finally {
      this.checking = false
    }
  }

  private async doCheck(): Promise<void> {
    const now = Date.now()
    const busyAgents = Array.from(
      (this.agentMgr as unknown as { instances: Map<string, AgentInstance> }).instances.values()
    ).filter(a => a.status === "busy" || a.status === "starting")

    for (const agent of busyAgents) {
      const staleSince = now - agent.lastHeartbeat

      // Verify health via HTTP
      const client = this.agentMgr.getClient(agent.id)
      const alive = await client.health()

      if (!alive && staleSince > this.config.heartbeatTimeoutMs) {
        await this.handleCrash(agent)
      } else if (alive) {
        // Refresh heartbeat
        this.agentMgr.heartbeat(agent.id)
      }
    }
  }

  private async handleCrash(agent: AgentInstance): Promise<void> {
    const agentId = agent.id
    this.onCrash(agentId)
    this.agentMgr.markCrashed(agentId)

    // Requeue any task this agent was running
    if (agent.currentTaskId) {
      const task = this.dag.getTask(agent.currentTaskId)
      if (task && task.status === "running") {
        this.dag.fail(agent.currentTaskId, `Agent ${agentId} crashed`)
      }
    }

    // Release any locks held by this agent
    this.lockRegistry.releaseByAgent(agentId)

    // Try to restart unless we've hit max restarts
    const restarts = this.restartCounts.get(agentId) ?? 0
    if (restarts >= this.config.maxAgentRestarts) {
      console.error(`[recovery] Agent ${agentId} exceeded max restarts (${this.config.maxAgentRestarts}), giving up`)
      return
    }

    try {
      this.restartCounts.set(agentId, restarts + 1)
      await this.agentMgr.restart(agentId)
      this.onRestart(agentId)
    } catch (err) {
      console.error(`[recovery] Failed to restart agent ${agentId}:`, err)
    }
  }
}
