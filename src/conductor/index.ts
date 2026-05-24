import type { TaskNode, TaskOutput, ConductorConfig, AgentRole, ConductorEvent, ConductorEventKind } from "../dag/types"
import { TaskDAG, createTaskNode } from "../dag/engine"
import { AgentProcessManager } from "../runtime/agent-manager"
import { FileLockRegistry } from "../workspace/file-lock"
import { SharedMemoryBus } from "../memory/bus"
import { GitWorkspaceManager } from "../workspace/git-manager"
import { CrashRecovery } from "./crash-recovery"
import { ApprovalGate } from "./approval-gate"
import { generateFollowupTasks } from "./dynamic-tasks"
import { join } from "path"
import { mkdirSync } from "fs"

// ─── Output parser ────────────────────────────────────────────────────────────

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
  private crashRecovery: CrashRecovery
  readonly approvalGate: ApprovalGate
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
    this.approvalGate = new ApprovalGate()

    this.crashRecovery = new CrashRecovery(config, this.agentMgr, this.dag, this.lockRegistry)
    this.crashRecovery.onAgentCrash(id => this.emit("agent.crashed", { agentId: id }))
    this.crashRecovery.onAgentRestart(id => this.emit("agent.restarted", { agentId: id }))

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

  // ── Agent pool ────────────────────────────────────────────────────────────

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
    this.crashRecovery.start()
  }

  stopScheduler(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
    this.crashRecovery.stop()
  }

  private async tick(): Promise<void> {
    // Don't schedule new work while an approval is pending
    if (this.approvalGate.hasPending()) return

    this.checkDeadlocks()

    if (this.dag.isComplete()) {
      this.stopScheduler()
      if (this.dag.hasCriticalFailure()) {
        this.emit("run.failed", { phase: this.dag.phase })
      } else {
        this.emit("run.completed", { phase: this.dag.phase })
      }
      return
    }

    const idleAgents = this.agentMgr.idleInstances()
    if (idleAgents.length === 0) return

    const readyTasks = this.dag.readyTasks()

    for (const task of readyTasks) {
      if (idleAgents.length === 0) break

      const conflicts = this.dag.conflictingRunning(task.scope)
      if (conflicts.length > 0) continue

      const agent =
        this.agentMgr.idleByRole(task.role)[0] ??
        this.agentMgr.idleByRole("general")[0] ??
        idleAgents[0]
      if (!agent) continue

      if (task.scope.length > 0) {
        const locked = this.lockRegistry.tryAcquire(task.scope, agent.id, task.id)
        if (!locked) continue
        this.emit("lock.acquired", { agentId: agent.id, taskId: task.id, scope: task.scope })
      }

      const idx = idleAgents.indexOf(agent)
      if (idx !== -1) idleAgents.splice(idx, 1)

      this.dispatch(agent.id, task).catch(err => {
        console.error(`[conductor] dispatch error for task ${task.id}:`, err)
      })
    }
  }

  private async dispatch(agentId: string, task: TaskNode): Promise<void> {
    const client = this.agentMgr.getClient(agentId)

    const contextEntries = this.memoryBus.getContext(task.scope)
    const contextBlock = contextEntries.length > 0
      ? `\n\n## Shared Context from Previous Agents\n${contextEntries.map(e => e.content).join("\n\n")}`
      : ""

    const projectMap = this.memoryBus.getProjectMap()
    const projectMapBlock = projectMap ? `\n\n## Project Map\n${projectMap.content}` : ""

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

      const { fullText, status } = await client.waitForTurn(
        thread.id,
        turn.id,
        undefined,
        this.config.fileLockTtlMs,
      )

      if (status === "failed" || status === "interrupted") {
        this.dag.fail(task.id, `Turn ended with status: ${status}`)
        return
      }

      const output = parseTaskOutput(fullText)
      this.dag.complete(task.id, output)

      // Write to shared memory so subsequent agents see this work
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

      // Dynamic task generation
      if (this.config.dynamicTasks) {
        await this.insertDynamicTasks(task, output)
      }

      // High-risk approval gate
      const highRisks = output.risks.filter(r => /\b(critical|high|severe|security|data loss|breaking)\b/i.test(r))
      if (highRisks.length > 0) {
        this.stopScheduler()
        this.emit("approval.required", { taskId: task.id, risks: highRisks })
        const decision = await this.approvalGate.request(
          "high_risk",
          `Task "${task.title}" completed with ${highRisks.length} high-severity risk(s):\n${highRisks.map(r => `  • ${r}`).join("\n")}\n\nApprove to continue scheduling?`,
          { taskId: task.id, risks: highRisks },
        )
        this.emit("approval.resolved", { decision, taskId: task.id })
        if (decision === "approved") {
          this.startScheduler()
        }
        // if rejected, scheduler stays stopped — human must manually resume
      }

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

  private async insertDynamicTasks(completedTask: TaskNode, output: TaskOutput): Promise<void> {
    const existingTitles = new Set(this.dag.allTasks().map(t => t.title))
    const { inserted } = generateFollowupTasks(completedTask, output, existingTitles)

    if (inserted.length === 0) return

    this.dag.addTasks(inserted)
    for (const t of inserted) {
      this.emit("task.dynamic_inserted", { taskId: t.id, title: t.title, type: t.type, parentTaskId: completedTask.id })
    }
  }

  // ── Phase boundary approval ───────────────────────────────────────────────

  /** Call between phases when interactive confirmation is needed. */
  async requestPhaseBoundaryApproval(nextPhaseDescription: string): Promise<"approved" | "rejected"> {
    this.stopScheduler()
    this.emit("approval.required", { kind: "phase_boundary", nextPhaseDescription })

    const decision = await this.approvalGate.request(
      "phase_boundary",
      `Phase ${this.dag.phase} complete.\n\nNext phase: ${nextPhaseDescription}\n\nProceed?`,
      { currentPhase: this.dag.phase },
    )

    this.emit("approval.resolved", { decision, kind: "phase_boundary" })
    if (decision === "approved") this.startScheduler()
    return decision
  }

  // ── Deadlock detection ────────────────────────────────────────────────────

  private checkDeadlocks(): void {
    const cycle = this.dag.detectDeadlock()
    if (cycle.length === 0) return

    this.emit("deadlock.detected", { cycle })

    const tasks = cycle
      .map(id => this.dag.getTask(id))
      .filter((t): t is TaskNode => t !== undefined)
      .sort((a, b) => a.priority - b.priority)

    const victim = tasks[0]
    if (victim) {
      this.dag.interrupt(victim.id)
      const agentId = victim.assignedTo
      if (agentId) {
        this.lockRegistry.releaseByAgent(agentId)
        this.agentMgr.markIdle(agentId)
      }
    }
  }

  // ── Phase management ──────────────────────────────────────────────────────

  addPhase(tasks: Parameters<typeof createTaskNode>[0][]): void {
    this.dag.advancePhase()
    const nodes = tasks.map(t => createTaskNode(t))
    this.dag.addTasks(nodes)
    this.emit("phase.started", { phase: this.dag.phase })
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

  /** Wait until all tasks finish (or run.failed fires). */
  waitForCompletion(timeoutMs = 3_600_000): Promise<"completed" | "failed" | "timeout"> {
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        off()
        resolve("timeout")
      }, timeoutMs)

      const off = () => {
        const idx = this.eventListeners.indexOf(handler)
        if (idx !== -1) this.eventListeners.splice(idx, 1)
        clearTimeout(timer)
      }

      const handler = (e: ConductorEvent) => {
        if (e.kind === "run.completed") { off(); resolve("completed") }
        if (e.kind === "run.failed") { off(); resolve("failed") }
      }
      this.eventListeners.push(handler)
    })
  }

  status() {
    const all = this.dag.allTasks()
    return {
      phase: this.dag.phase,
      tasks: {
        total: all.length,
        ready: this.dag.readyTasks().length,
        running: this.dag.runningTasks().length,
        done: all.filter(t => t.status === "done").length,
        failed: all.filter(t => t.status === "failed").length,
        blocked: all.filter(t => t.status === "blocked").length,
        interrupted: all.filter(t => t.status === "interrupted").length,
      },
      agents: this.agentMgr.stats(),
      locks: this.lockRegistry.allLocks().length,
      pendingApprovals: this.approvalGate.pendingRequests().length,
    }
  }
}
