import type { TaskNode, TaskOutput, ConductorConfig, AgentRole, ConductorEvent, ConductorEventKind } from "../dag/types"
import { TaskDAG, createTaskNode } from "../dag/engine"
import { AgentProcessManager } from "../runtime/agent-manager"
import { FileLockRegistry } from "../workspace/file-lock"
import { SharedMemoryBus } from "../memory/bus"
import { GitWorkspaceManager } from "../workspace/git-manager"
import { join } from "path"
import { mkdirSync } from "fs"

// ─── Output parser ───────────────────────────────────────────────────────────
// Parses the 5-section contract from CodeWhale subagent output

function parseTaskOutput(rawText: string): TaskOutput {
  const extract = (section: string): string => {
    const re = new RegExp(`##\\s*${section}[\\s\\S]*?(?=\\n##|$)`, "i")
    const m = rawText.match(re)
    return m ? m[0].replace(/^##\s*\w+\s*/i, "").trim() : ""
  }

  const changesText = extract("CHANGES")
  const changes = changesText
    .split("\n")
    .filter(l => l.match(/^[-*]\s/))
    .map(l => {
      const [file, ...desc] = l.replace(/^[-*]\s/, "").split(":")
      return { file: (file ?? "").trim(), description: desc.join(":").trim() }
    })

  return {
    summary: extract("SUMMARY"),
    changes,
    evidence: extract("EVIDENCE").split("\n").filter(Boolean),
    risks: extract("RISKS").split("\n").filter(Boolean),
    blockers: extract("BLOCKERS").split("\n").filter(Boolean),
    rawText,
  }
}

// ─── Conductor ───────────────────────────────────────────────────────────────

export class Conductor {
  private dag: TaskDAG
  private agentMgr: AgentProcessManager
  private lockRegistry: FileLockRegistry
  private memoryBus: SharedMemoryBus
  private gitMgr: GitWorkspaceManager | null = null
  private config: ConductorConfig
  private conductorDir: string
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private eventListeners: Array<(e: ConductorEvent) => void> = []

  constructor(config: ConductorConfig) {
    this.config = config
    this.conductorDir = join(config.projectPath, ".conductor")
    mkdirSync(this.conductorDir, { recursive: true })

    this.dag = new TaskDAG(config.projectPath)
    this.agentMgr = new AgentProcessManager(config)
    this.lockRegistry = new FileLockRegistry(config.fileLockTtlMs)
    this.memoryBus = new SharedMemoryBus(this.conductorDir)

    // Wire DAG status change events to conductor event bus
    this.dag.onStatusChange((taskId, prev, next) => {
      this.emit("task.status_changed", { taskId, prev, next })
    })
  }

  get taskDag() { return this.dag }
  get memory() { return this.memoryBus }

  // ── Setup ─────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    const gitMgr = new GitWorkspaceManager(this.config.projectPath)
    if (gitMgr.isGitRepo()) {
      this.gitMgr = gitMgr
    }
  }

  // ── Agent pool management ─────────────────────────────────────────────────

  async spawnAgents(roles: AgentRole[]): Promise<void> {
    if (roles.length > this.config.maxConcurrentAgents) {
      throw new Error(`Requested ${roles.length} agents exceeds max ${this.config.maxConcurrentAgents}`)
    }
    await this.agentMgr.spawnPool(roles)
    this.emit("phase.started", { phase: this.dag.phase, agentCount: roles.length })
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  startScheduler(): void {
    if (this.tickInterval) return
    this.tickInterval = setInterval(() => this.tick(), this.config.schedulerTickMs)
  }

  stopScheduler(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
  }

  private async tick(): Promise<void> {
    this.checkDeadlocks()

    if (this.dag.isComplete()) {
      this.stopScheduler()
      this.emit("phase.completed", { phase: this.dag.phase })
      return
    }

    const idleAgents = this.agentMgr.idleInstances()
    if (idleAgents.length === 0) return

    const readyTasks = this.dag.readyTasks()

    for (const task of readyTasks) {
      if (idleAgents.length === 0) break

      // Skip if scope conflicts with a running task
      const conflicts = this.dag.conflictingRunning(task.scope)
      if (conflicts.length > 0) continue

      // Find a compatible idle agent (prefer role match)
      const agent =
        this.agentMgr.idleByRole(task.role)[0] ??
        this.agentMgr.idleByRole("general")[0] ??
        idleAgents[0]

      if (!agent) continue

      // Acquire file locks
      if (task.scope.length > 0) {
        const locked = this.lockRegistry.tryAcquire(task.scope, agent.id, task.id)
        if (!locked) continue
        this.emit("lock.acquired", { agentId: agent.id, taskId: task.id, scope: task.scope })
      }

      // Remove from idle list for this tick
      const idx = idleAgents.indexOf(agent)
      if (idx !== -1) idleAgents.splice(idx, 1)

      // Dispatch asynchronously
      this.dispatch(agent.id, task).catch(err => {
        console.error(`[conductor] dispatch error for task ${task.id}:`, err)
      })
    }
  }

  private async dispatch(agentId: string, task: TaskNode): Promise<void> {
    const client = this.agentMgr.getClient(agentId)

    // Build context-aware prompt
    const contextEntries = this.memoryBus.getContext(task.scope)
    const contextBlock = contextEntries.length > 0
      ? `\n\n## Shared Context from Previous Agents\n${contextEntries.map(e => e.content).join("\n\n")}`
      : ""

    const projectMap = this.memoryBus.getProjectMap()
    const projectMapBlock = projectMap
      ? `\n\n## Project Map\n${projectMap.content}`
      : ""

    const fullPrompt = [
      task.prompt,
      projectMapBlock,
      contextBlock,
      "\n\n---\nYour output MUST contain these 5 sections: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS",
    ].join("")

    try {
      const thread = await client.createThread()
      this.agentMgr.markBusy(agentId, task.id, thread.id)
      this.dag.assign(task.id, agentId)

      const turn = await client.postTurn(thread.id, {
        prompt: fullPrompt,
        auto_approve: this.config.autoApprove,
        fork_context: task.forkContext,
      })

      const { fullText } = await client.waitForTurn(
        thread.id,
        turn.id,
        undefined,
        this.config.fileLockTtlMs
      )

      const output = parseTaskOutput(fullText)
      this.dag.complete(task.id, output)

      // Write agent's findings to shared memory
      this.memoryBus.write({
        layer: "context",
        agentId,
        taskId: task.id,
        content: `[Task: ${task.title}]\n${output.summary}\n\nChanges:\n${output.changes.map(c => `- ${c.file}: ${c.description}`).join("\n")}`,
        tags: task.scope,
      })

      this.memoryBus.write({
        layer: "event_log",
        agentId,
        taskId: task.id,
        content: JSON.stringify({ event: "task.completed", title: task.title, risks: output.risks }),
        tags: ["event"],
      })

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.dag.fail(task.id, msg)

      this.memoryBus.write({
        layer: "event_log",
        agentId,
        taskId: task.id,
        content: JSON.stringify({ event: "task.failed", title: task.title, error: msg }),
        tags: ["event", "error"],
      })
    } finally {
      this.lockRegistry.releaseByTask(task.id)
      this.emit("lock.released", { taskId: task.id })
      this.agentMgr.markIdle(agentId)
    }
  }

  // ── Deadlock detection ────────────────────────────────────────────────────

  private checkDeadlocks(): void {
    const cycle = this.dag.detectDeadlock()
    if (cycle.length === 0) return

    this.emit("deadlock.detected", { cycle })

    // Find lowest-priority task in the cycle and interrupt it
    const tasks = cycle
      .map(id => this.dag.getTask(id))
      .filter((t): t is TaskNode => t !== undefined)
      .sort((a, b) => a.priority - b.priority)

    const victim = tasks[0]
    if (victim) {
      console.warn(`[conductor] Deadlock detected, interrupting task ${victim.id}`)
      this.dag.interrupt(victim.id)
      const agentId = victim.assignedTo
      if (agentId) {
        this.lockRegistry.releaseByAgent(agentId)
        this.agentMgr.markIdle(agentId)
      }
    }
  }

  // ── Phase management ──────────────────────────────────────────────────────

  /** Add tasks for the next phase and advance the phase counter. */
  addPhase(tasks: Omit<Parameters<typeof createTaskNode>[0], never>[]): void {
    this.dag.advancePhase()
    const nodes = tasks.map(t => createTaskNode(t))
    this.dag.addTasks(nodes)
    this.emit("phase.started", { phase: this.dag.phase })
  }

  // ── Approvals (human-in-the-loop) ─────────────────────────────────────────

  requestApproval(message: string): void {
    this.stopScheduler()
    this.emit("approval.required", { message })
  }

  resumeAfterApproval(): void {
    this.startScheduler()
  }

  // ── Events ────────────────────────────────────────────────────────────────

  onEvent(cb: (e: ConductorEvent) => void): void {
    this.eventListeners.push(cb)
  }

  private emit(kind: ConductorEventKind, payload: Record<string, unknown>): void {
    const event: ConductorEvent = { kind, payload, timestamp: Date.now() }
    for (const cb of this.eventListeners) cb(event)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this.stopScheduler()
    await this.agentMgr.stopAll()
  }

  status() {
    return {
      phase: this.dag.phase,
      tasks: {
        total: this.dag.allTasks().length,
        ready: this.dag.readyTasks().length,
        running: this.dag.runningTasks().length,
        done: this.dag.allTasks().filter(t => t.status === "done").length,
        failed: this.dag.allTasks().filter(t => t.status === "failed").length,
      },
      agents: this.agentMgr.stats(),
      locks: this.lockRegistry.allLocks().length,
    }
  }
}
