import type { TaskNode, TaskOutput, ConductorConfig, AgentRole, ConductorEvent, ConductorEventKind } from "../dag/types"
import { TaskDAG, createTaskNode } from "../dag/engine"
import { AgentProcessManager } from "../runtime/agent-manager"
import { FileLockRegistry } from "../workspace/file-lock"
import { ConductorStore } from "../memory/store"
import { GitWorkspaceManager } from "../workspace/git-manager"
import { CrashRecovery } from "./crash-recovery"
import { ApprovalGate } from "./approval-gate"
import { generateFollowupTasks } from "./dynamic-tasks"
import { join } from "path"
import { mkdirSync, existsSync, readFileSync } from "fs"

// ─── Structured agent instruction protocol ────────────────────────────────────
// Each sub-agent receives a prompt with clearly delimited sections so the model
// knows exactly: what its role is, what context it inherits, what it must produce.

const MAX_CONTEXT_CHARS = 8_000   // cap inherited context to avoid prompt bloat
const MAX_OUTPUT_CHARS  = 80_000  // truncate runaway output before parsing

interface PromptParts {
  task: import("../dag/types").TaskNode
  agentInstructions: string
  projectMapBlock: string
  contextBlock: string
}

function buildAgentPrompt(p: PromptParts): string {
  const { task, agentInstructions, projectMapBlock, contextBlock } = p

  // Trim inherited context to avoid unbounded prompt growth
  const safeContext = contextBlock.length > MAX_CONTEXT_CHARS
    ? contextBlock.slice(0, MAX_CONTEXT_CHARS) + "\n[…context truncated…]"
    : contextBlock

  return [
    // ── Section 1: Identity ────────────────────────────────────────────────
    `<agent_role>`,
    `You are a software-engineering agent with role: ${task.role}.`,
    `Task type: ${task.type} | Priority: ${task.priority}`,
    `Task ID: ${task.id}`,
    `</agent_role>`,
    ``,
    // ── Section 2: Task instruction ────────────────────────────────────────
    `<task_instruction>`,
    task.prompt,
    `</task_instruction>`,
    ``,
    // ── Section 3: Scope (files/modules you may touch) ─────────────────────
    task.scope.length > 0
      ? [`<scope>`, ...task.scope.map(s => `  - ${s}`), `</scope>`, ``].join("\n")
      : "",
    // ── Section 4: Inherited context from prior agents ─────────────────────
    safeContext
      ? [`<inherited_context>`, safeContext.trim(), `</inherited_context>`, ``].join("\n")
      : "",
    // ── Section 5: Project map ─────────────────────────────────────────────
    projectMapBlock
      ? [`<project_map>`, projectMapBlock.trim(), `</project_map>`, ``].join("\n")
      : "",
    // ── Section 6: Project-level agent instructions ────────────────────────
    agentInstructions
      ? [`<project_instructions>`, agentInstructions.trim(), `</project_instructions>`, ``].join("\n")
      : "",
    // ── Section 7: Required output contract ───────────────────────────────
    `<output_contract>`,
    `Your response MUST contain exactly these five sections in order:`,
    `## SUMMARY      — 2-5 sentence summary of what you did`,
    `## CHANGES      — bullet list: "- path/to/file: what changed"`,
    `## EVIDENCE     — concrete evidence (test output, grep, file diff snippets)`,
    `## RISKS        — risks, label severity: [low|medium|high|critical]`,
    `## BLOCKERS     — unresolved blockers that downstream tasks must know about`,
    ``,
    `Do NOT omit any section. If a section has nothing to report, write "none".`,
    `</output_contract>`,
  ].filter(Boolean).join("\n")
}

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

// ─── AGENTS.md / CLAUDE.md loader ────────────────────────────────────────────

function loadAgentInstructions(projectPath: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md", ".conductor/AGENTS.md"]) {
    const p = join(projectPath, name)
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8").trim()
      if (content) return `\n\n---\n## Project Agent Instructions (from ${name})\n${content}\n---`
    }
  }
  return ""
}

// ─── Conductor ───────────────────────────────────────────────────────────────

export class Conductor {
  private dag: TaskDAG
  private agentMgr: AgentProcessManager
  private lockRegistry: FileLockRegistry
  readonly store: ConductorStore
  private gitMgr: GitWorkspaceManager | null = null
  private crashRecovery: CrashRecovery
  readonly approvalGate: ApprovalGate
  private config: ConductorConfig
  private conductorDir: string
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private eventListeners: Array<(e: ConductorEvent) => void> = []
  private streamListeners: Array<(agentId: string, task: TaskNode, delta: string) => void> = []
  private agentInstructions: string
  readonly runId: string

  constructor(config: ConductorConfig, runId?: string) {
    this.config = config
    this.conductorDir = join(config.projectPath, ".conductor")
    mkdirSync(this.conductorDir, { recursive: true })
    this.runId = runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    this.dag = new TaskDAG(config.projectPath)
    this.agentMgr = new AgentProcessManager(config)
    this.lockRegistry = new FileLockRegistry(config.fileLockTtlMs)
    this.store = new ConductorStore(this.conductorDir, this.runId)
    this.approvalGate = new ApprovalGate()
    this.agentInstructions = loadAgentInstructions(config.projectPath)

    this.crashRecovery = new CrashRecovery(config, this.agentMgr, this.dag, this.lockRegistry)
    this.crashRecovery.onAgentCrash(id => this.emit("agent.crashed", { agentId: id }))
    this.crashRecovery.onAgentRestart(id => this.emit("agent.restarted", { agentId: id }))

    // Persist every task status change to SQLite
    this.dag.onStatusChange((taskId, prev, next) => {
      this.emit("task.status_changed", { taskId, prev, next })
      const task = this.dag.getTask(taskId)
      if (task) {
        try { this.store.upsertTask(task) } catch { /* db may be closed during shutdown */ }
      }
    })
  }

  get taskDag() { return this.dag }

  // ── Setup ─────────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.store.initRun(this.config.projectPath, this.dag.phase)
    const gitMgr = new GitWorkspaceManager(this.config.projectPath)
    if (gitMgr.isGitRepo()) this.gitMgr = gitMgr
  }

  /** Restore a previous run's task graph from SQLite (for crash recovery). */
  restoreFromStore(): boolean {
    const run = this.store.getRun()
    if (!run || run.status === "completed") return false

    const tasks = this.store.loadTasks()
    if (tasks.length === 0) return false

    // Reset running tasks to ready (they were interrupted by the crash)
    for (const t of tasks) {
      if (t.status === "running") {
        t.status = "ready"
        t.assignedTo = null
        t.startedAt = null
      }
    }
    this.dag.addTasks(tasks)
    return true
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
    if (this.approvalGate.hasPending()) return
    this.checkDeadlocks()

    if (this.dag.isComplete()) {
      this.stopScheduler()
      const finalStatus = this.dag.hasCriticalFailure() ? "failed" : "completed"
      this.store.updateRunStatus(finalStatus)
      this.emit(finalStatus === "completed" ? "run.completed" : "run.failed", { phase: this.dag.phase })
      return
    }

    const idleAgents = this.agentMgr.idleInstances()
    if (idleAgents.length === 0) return

    for (const task of this.dag.readyTasks()) {
      if (idleAgents.length === 0) break
      if (this.dag.conflictingRunning(task.scope).length > 0) continue

      const agent =
        this.agentMgr.idleByRole(task.role)[0] ??
        this.agentMgr.idleByRole("general")[0] ??
        idleAgents[0]
      if (!agent) continue

      if (task.scope.length > 0) {
        if (!this.lockRegistry.tryAcquire(task.scope, agent.id, task.id)) continue
        this.emit("lock.acquired", { agentId: agent.id, taskId: task.id, scope: task.scope })
      }

      idleAgents.splice(idleAgents.indexOf(agent), 1)
      this.dispatch(agent.id, task).catch(err =>
        console.error(`[conductor] dispatch error task=${task.id}:`, err)
      )
    }
  }

  private async dispatch(agentId: string, task: TaskNode): Promise<void> {
    this.activeDispatches++
    const client = this.agentMgr.getClient(agentId)

    const contextEntries = this.store.getContext(task.scope)
    const contextBlock = contextEntries.length > 0
      ? `\n\n## Shared Context from Previous Agents\n${contextEntries.map(e => e.content).join("\n\n")}`
      : ""
    const projectMap = this.store.getProjectMap()
    const projectMapBlock = projectMap ? `\n\n## Project Map\n${projectMap.content}` : ""

    const fullPrompt = buildAgentPrompt({
      task,
      agentInstructions: this.agentInstructions,
      projectMapBlock,
      contextBlock,
    })

    // Mark busy synchronously before any await to prevent double-dispatch
    // within the same scheduler tick.
    this.agentMgr.markBusy(agentId, task.id, "pending")
    this.dag.assign(task.id, agentId)

    try {
      const thread = await client.createThread()
      this.agentMgr.markBusy(agentId, task.id, thread.id)

      const turn = await client.postTurn(thread.id, {
        prompt: fullPrompt,
        auto_approve: this.config.autoApprove,
        fork_context: task.forkContext,
      })

      const { fullText: rawText, status, usage } = await client.waitForTurn(
        thread.id, turn.id,
        this.streamListeners.length > 0
          ? (delta) => { for (const cb of this.streamListeners) cb(agentId, task, delta) }
          : undefined,
        this.config.fileLockTtlMs,
      )

      if (status === "failed" || status === "interrupted") {
        this.dag.fail(task.id, `Turn ended with status: ${status}`)
        return
      }

      // Guard against runaway output that would explode the parser / memory
      const fullText = rawText.length > MAX_OUTPUT_CHARS
        ? rawText.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated by conductor]"
        : rawText

      const output = parseTaskOutput(fullText)
      // Attach token usage to the task before completing
      task.tokenUsage = usage
      this.dag.complete(task.id, output)

      this.store.writeMemory({
        layer: "context", agentId, taskId: task.id,
        content: `[Task: ${task.title}]\n${output.summary}\n\nChanges:\n${output.changes.map(c => `- ${c.file}: ${c.description}`).join("\n")}`,
        tags: task.scope,
      })
      this.store.logEvent(agentId, task.id, "task.completed",
        { title: task.title, risks: output.risks })

      if (this.config.dynamicTasks) await this.insertDynamicTasks(task, output)

      const highRisks = output.risks.filter(r => /\b(critical|high|severe|security|data loss|breaking)\b/i.test(r))
      if (highRisks.length > 0) {
        this.stopScheduler()
        this.emit("approval.required", { taskId: task.id, risks: highRisks })
        const decision = await this.approvalGate.request(
          "high_risk",
          `Task "${task.title}" completed with ${highRisks.length} high-severity risk(s):\n${highRisks.map(r => `  • ${r}`).join("\n")}\n\nApprove to continue?`,
          { taskId: task.id, risks: highRisks },
        )
        this.emit("approval.resolved", { decision, taskId: task.id })
        if (decision === "approved") this.startScheduler()
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Ignore writes to a closed DB (happens when shutdown races an in-flight dispatch)
      if (!msg.includes("closed database")) {
        this.dag.fail(task.id, msg)
        try { this.store.logEvent(agentId, task.id, "task.failed", { title: task.title, error: msg }) } catch { /* db closed */ }
      }
    } finally {
      this.lockRegistry.releaseByTask(task.id)
      this.emit("lock.released", { taskId: task.id })
      this.agentMgr.markIdle(agentId)
      this.activeDispatches--
    }
  }

  private async insertDynamicTasks(completedTask: TaskNode, output: TaskOutput): Promise<void> {
    const existingTitles = new Set(this.dag.allTasks().map(t => t.title))
    const { inserted } = generateFollowupTasks(completedTask, output, existingTitles)
    if (inserted.length === 0) return
    this.dag.addTasks(inserted)
    for (const t of inserted) {
      this.store.upsertTask(t)
      this.emit("task.dynamic_inserted", { taskId: t.id, title: t.title, type: t.type, parentTaskId: completedTask.id })
    }
  }

  // ── Phase boundary ────────────────────────────────────────────────────────

  async requestPhaseBoundaryApproval(nextPhaseDescription: string): Promise<"approved" | "rejected"> {
    this.stopScheduler()
    this.emit("approval.required", { kind: "phase_boundary", nextPhaseDescription })
    const decision = await this.approvalGate.request(
      "phase_boundary",
      `Phase ${this.dag.phase} complete.\nNext: ${nextPhaseDescription}\nProceed?`,
      { currentPhase: this.dag.phase },
    )
    this.emit("approval.resolved", { decision, kind: "phase_boundary" })
    if (decision === "approved") this.startScheduler()
    return decision
  }

  // ── Deadlocks ─────────────────────────────────────────────────────────────

  private checkDeadlocks(): void {
    const cycle = this.dag.detectDeadlock()
    if (cycle.length === 0) return
    this.emit("deadlock.detected", { cycle })
    const victim = cycle
      .map(id => this.dag.getTask(id))
      .filter((t): t is TaskNode => t !== undefined)
      .sort((a, b) => a.priority - b.priority)[0]
    if (victim) {
      this.dag.interrupt(victim.id)
      if (victim.assignedTo) {
        this.lockRegistry.releaseByAgent(victim.assignedTo)
        this.agentMgr.markIdle(victim.assignedTo)
      }
    }
  }

  // ── Phase management ──────────────────────────────────────────────────────

  addPhase(tasks: Parameters<typeof createTaskNode>[0][]): void {
    this.dag.advancePhase()
    this.store.updateRunPhase(this.dag.phase)
    const nodes = tasks.map(t => createTaskNode(t))
    this.dag.addTasks(nodes)
    for (const n of nodes) this.store.upsertTask(n)
    this.emit("phase.started", { phase: this.dag.phase })
  }

  // ── Events ────────────────────────────────────────────────────────────────

  onEvent(cb: (e: ConductorEvent) => void): void { this.eventListeners.push(cb) }

  // Subscribe to real-time token deltas from running agents
  onStream(cb: (agentId: string, task: TaskNode, delta: string) => void): void {
    this.streamListeners.push(cb)
  }

  private emit(kind: ConductorEventKind, payload: Record<string, unknown>): void {
    const event: ConductorEvent = { kind, payload, timestamp: Date.now() }
    for (const cb of this.eventListeners) cb(event)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // Active dispatch count — shutdown waits for all to drain
  private activeDispatches = 0

  async shutdown(): Promise<void> {
    this.stopScheduler()
    // Wait for in-flight dispatches to finish before closing the DB
    const deadline = Date.now() + 30_000
    while (this.activeDispatches > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
    }
    await this.agentMgr.stopAll()
    this.store.close()
  }

  waitForCompletion(timeoutMs = 3_600_000): Promise<"completed" | "failed" | "timeout"> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { off(); resolve("timeout") }, timeoutMs)
      const off = () => {
        const idx = this.eventListeners.indexOf(handler)
        if (idx !== -1) this.eventListeners.splice(idx, 1)
        clearTimeout(timer)
      }
      const handler = (e: ConductorEvent) => {
        if (e.kind === "run.completed") { off(); resolve("completed") }
        if (e.kind === "run.failed")    { off(); resolve("failed")    }
      }
      this.eventListeners.push(handler)
    })
  }

  status() {
    const all = this.dag.allTasks()
    return {
      runId: this.runId,
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
