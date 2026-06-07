import type { TaskNode, TaskOutput, ConductorConfig, AgentRole, ConductorEvent, ConductorEventKind } from "../dag/types"
import { TaskDAG, createTaskNode } from "../dag/engine"
import { AgentProcessManager } from "../runtime/agent-manager"
import { FileLockRegistry } from "../workspace/file-lock"
import { ConductorStore } from "../memory/store"

import { CrashRecovery } from "./crash-recovery"
import { ApprovalGate } from "./approval-gate"
import { generateFollowupTasks } from "./dynamic-tasks"
import { buildFanOutTasks, parseSpawnDirective } from "./fan-out"
import { StartRateLimiter } from "./rate-limiter"
import { LLMExecutor } from "../executor/llm-executor"
import type { Executor, ExecutionHandle } from "../executor/types"
import { join } from "path"
import { mkdirSync, existsSync, readFileSync } from "fs"

// ─── Structured agent instruction protocol ────────────────────────────────────
// Each sub-agent receives a prompt with clearly delimited sections so the model
// knows exactly: what its role is, what context it inherits, what it must produce.

const MAX_CONTEXT_ENTRIES = 5    // take the most recent N entries
const MAX_ENTRY_CHARS     = 1_600 // cap each entry individually, not the whole block
const MAX_OUTPUT_CHARS    = 80_000  // truncate runaway output before parsing

interface PromptParts {
  task: import("../dag/types").TaskNode
  agentInstructions: string
  projectMapBlock: string
  contextBlock: string
}

function buildAgentPrompt(p: PromptParts): string {
  const { task, agentInstructions, projectMapBlock, contextBlock } = p

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
    contextBlock
      ? [`<inherited_context>`, contextBlock.trim(), `</inherited_context>`, ``].join("\n")
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

export function parseTaskOutput(rawText: string): TaskOutput {
  /** Escape regex specials in section name so future additions are safe. */
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

  const extract = (section: string): string => {
    // Match a ## SECTION header and capture everything until the next ## header
    // (preceded by optional \r?\n) or end-of-string. Using \r?\n handles Windows
    // line endings and prevents runaway matches when header separators are missing.
    const re = new RegExp(`##\\s*${esc(section)}\\b[\\s\\S]*?(?=\\r?\\n##|$)`, "i")
    const m = rawText.match(re)
    return m ? m[0].replace(/^##\s*\S+\s*/i, "").trim() : ""
  }

  /** Split by newlines and drop empty / stub lines. Also drops the literal "none"
   *  placeholder that the output contract asks agents to use for empty sections,
   *  as well as Chinese-language stub phrases (五段, 五个节。, etc.) that non-English
   *  agents sometimes produce instead of "none". */
  const CHINESE_STUB_RE = /^五[个]?[节段](落|章)?[。.]?$/
  const lines = (section: string): string[] =>
    extract(section)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l =>
        l.length > 0 &&
        l.toLowerCase() !== "none" &&
        !CHINESE_STUB_RE.test(l)
      )

  const changesText = extract("CHANGES")
  const changes = changesText
    .split(/\r?\n/)
    .filter(l => l.match(/^[-*]\s/))
    .map(l => {
      const [file, ...desc] = l.replace(/^[-*]\s/, "").split(":")
      return { file: (file ?? "").trim(), description: desc.join(":").trim() }
    })

  const summaryRaw = extract("SUMMARY")
  return {
    summary: summaryRaw.toLowerCase() === "none" ? "" : summaryRaw,
    changes,
    evidence: lines("EVIDENCE"),
    risks: lines("RISKS"),
    blockers: lines("BLOCKERS"),
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
  private executor: Executor                       // default backend (llm)
  private executorsByKind: Map<string, Executor>   // routing table by task.executorKind
  private startLimiter: StartRateLimiter
  private lockRegistry: FileLockRegistry
  readonly store: ConductorStore
  private crashRecovery: CrashRecovery
  readonly approvalGate: ApprovalGate
  private config: ConductorConfig
  private conductorDir: string
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private ticking = false   // reentrancy guard for tick()
  private eventListeners: Array<(e: ConductorEvent) => void> = []
  private streamListeners: Array<(agentId: string, task: TaskNode, delta: string, model: string | null) => void> = []
  private agentInstructions: string
  readonly runId: string

  constructor(config: ConductorConfig, runId?: string, executor?: Executor, extraExecutors?: Executor[]) {
    this.config = config
    this.conductorDir = join(config.projectPath, ".conductor")
    mkdirSync(this.conductorDir, { recursive: true })
    this.runId = runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

    this.dag = new TaskDAG(config.projectPath)
    this.agentMgr = new AgentProcessManager(config)
    // Default backend is the LLM agent pool. A custom executor can be injected
    // (a fake for deterministic tests today; a cheap WorkerExecutor tomorrow)
    // without the scheduler knowing the difference.
    this.executor = executor ?? new LLMExecutor(this.agentMgr)
    // Routing table: a task whose executorKind matches a registered executor is
    // dispatched there; everything else falls back to the default executor.
    this.executorsByKind = new Map()
    this.executorsByKind.set(this.executor.kind, this.executor)
    for (const ex of extraExecutors ?? []) this.executorsByKind.set(ex.kind, ex)
    this.startLimiter = new StartRateLimiter({
      minIntervalMs: config.minStartIntervalMs,
      maxPerMinute: config.maxStartsPerMinute,
    })
    this.lockRegistry = new FileLockRegistry(config.fileLockTtlMs)
    this.store = new ConductorStore(this.conductorDir, this.runId)
    this.approvalGate = new ApprovalGate()
    this.agentInstructions = loadAgentInstructions(config.projectPath)

    this.crashRecovery = new CrashRecovery(config, this.agentMgr, this.dag, this.lockRegistry, this.store)
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
    const { started, failures } = await this.agentMgr.spawnPool(roles)
    if (failures.length > 0) {
      // Degraded run: some agents failed but at least one started. Surface it
      // rather than aborting — the scheduler simply has a smaller pool to work
      // with and dispatches tasks more slowly.
      console.warn(`[conductor] ${failures.length}/${roles.length} agent(s) failed to spawn; continuing with ${started.length}`)
      this.emit("agent.spawn_degraded", {
        requested: roles.length,
        started: started.length,
        failed: failures.length,
        errors: failures.map(e => e.message),
      })
    }
    this.emit("phase.started", { phase: this.dag.phase, agentCount: started.length })
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  startScheduler(): void {
    if (this.tickInterval) return
    // Safety-net timer: catches any missed wakeups (e.g. after approval gate resolves).
    // Reduced from 500 ms to 5 s because dispatch() now calls triggerTick() on completion.
    this.tickInterval = setInterval(() => this.triggerTick(), 5_000)
    this.crashRecovery.start()
    // Kick off immediately so the first batch of ready tasks is dispatched without delay.
    this.triggerTick()
  }

  stopScheduler(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval)
      this.tickInterval = null
    }
    this.crashRecovery.stop()
  }

  // Enqueue a tick via queueMicrotask so callers never recurse directly into tick().
  private triggerTick(): void {
    queueMicrotask(() => this.tick())
  }

  private async tick(): Promise<void> {
    if (this.ticking) return   // prevent re-entrant ticks
    this.ticking = true
    try {
      if (this.approvalGate.hasPending()) return
      this.checkDeadlocks()

      if (this.dag.isComplete()) {
        this.stopScheduler()
        const finalStatus = this.dag.hasCriticalFailure() ? "failed" : "completed"
        this.store.updateRunStatus(finalStatus)
        this.emit(finalStatus === "completed" ? "run.completed" : "run.failed", { phase: this.dag.phase })
        return
      }

      // Total free capacity across all executors. If everything is busy, wait.
      if (this.totalAvailableSlots() === 0) return

      for (const task of this.dag.readyTasks()) {
        if (this.totalAvailableSlots() === 0) break
        if (this.dag.conflictingRunning(task.scope).length > 0) continue

        // Route to the executor for this task, then reserve a slot there. If
        // that executor is full, skip to the next ready task — another task may
        // target a different (free) executor, so we `continue`, not `break`.
        const executor = this.selectExecutor(task)
        const handle = executor.reserve(task)
        if (!handle) continue

        if (task.scope.length > 0) {
          if (!this.lockRegistry.tryAcquire(task.scope, handle.workerId, task.id)) {
            handle.release()   // give the slot back; another task may use it
            continue
          }
          this.emit("lock.acquired", { agentId: handle.workerId, taskId: task.id, scope: task.scope })
        }

        this.dispatch(executor, handle, task).catch(err =>
          console.error(`[conductor] dispatch error task=${task.id}:`, err)
        )
      }
    } finally {
      this.ticking = false
    }
  }

  /** Pick the executor for a task: its declared executorKind if registered,
   *  otherwise the default (LLM) executor. */
  private selectExecutor(task: TaskNode): Executor {
    if (task.executorKind) {
      const ex = this.executorsByKind.get(task.executorKind)
      if (ex) return ex
    }
    return this.executor
  }

  /** Free slots summed across every registered executor. */
  private totalAvailableSlots(): number {
    let n = 0
    for (const ex of this.executorsByKind.values()) n += ex.availableSlots()
    return n
  }

  private async dispatch(executor: Executor, handle: ExecutionHandle, task: TaskNode): Promise<void> {
    const agentId = handle.workerId
    this.activeDispatches++
    try {
      // Does this executor act directly (worker) or drive an LLM? Decided by the
      // executor's declared capability, not a brittle kind-string match — so any
      // deterministic backend (sql/validate/compare) takes the worker path.
      const isWorker = executor.actsDirectly === true

      // Resolve data-flow inputs once: used to inline into the LLM prompt, to
      // record lineage, and (for workers) to hand the actual artifacts to the runner.
      const { block: artifactBlock, sourceIds, artifacts: inputArtifacts } = this.resolveInputArtifacts(task)

      // Worker tasks act on the task directly (no prompt assembly, no parsing).
      // Everything else (the LLM backend, and test fakes that emulate it) gets
      // the full structured agent prompt including inlined data-flow inputs.
      let fullPrompt: string
      if (isWorker) {
        fullPrompt = task.prompt
      } else {
        const contextEntries = this.store.getContext(task.scope)
          .slice(-MAX_CONTEXT_ENTRIES)
          .map(e => e.content.length > MAX_ENTRY_CHARS
            ? { ...e, content: e.content.slice(0, MAX_ENTRY_CHARS) + "\n[…entry truncated…]" }
            : e
          )
        const contextBlock = contextEntries.length > 0
          ? `\n\n## Shared Context from Previous Agents\n${contextEntries.map(e => e.content).join("\n\n")}`
          : ""
        const projectMap = this.store.getProjectMap()
        const projectMapBlock = projectMap ? `\n\n## Project Map\n${projectMap.content}` : ""
        fullPrompt = buildAgentPrompt({
          task,
          agentInstructions: this.agentInstructions,
          projectMapBlock,
          contextBlock: contextBlock + artifactBlock,
        })
      }

      // The slot was reserved (worker marked busy) in tick(); record the DAG
      // assignment, then hand the prompt to the executor.
      this.dag.assign(task.id, agentId)

      // Backpressure: wait until the rate limiter permits a new start, so a
      // tick that reserved many agents doesn't burst the LLM provider at once.
      // Workers don't hit the provider — they run at full speed, unthrottled.
      if (!isWorker) await this.startLimiter.acquire()

      const { rawText, status, usage, malformedLines } = await handle.execute(
        fullPrompt,
        {
          model: this.config.modelMap[task.role] ?? undefined,
          autoApprove: this.config.autoApprove,
          forkContext: task.forkContext,
          timeoutMs: this.config.fileLockTtlMs,
          inputArtifacts,
        },
        this.streamListeners.length > 0
          ? (delta, model) => { for (const cb of this.streamListeners) cb(agentId, task, delta, model) }
          : undefined,
      )

      if (malformedLines > 0) {
        try {
          this.store.logEvent(agentId, task.id, "sse.malformed", { title: task.title, malformedLines })
        } catch { /* db may be closed */ }
      }

      if (status === "failed" || status === "interrupted") {
        this.dag.fail(task.id, `Execution ended with status: ${status}`)
        return
      }

      // Guard against runaway output that would explode the parser / memory.
      const fullText = rawText.length > MAX_OUTPUT_CHARS
        ? rawText.slice(0, MAX_OUTPUT_CHARS) + "\n[output truncated by conductor]"
        : rawText

      // Worker output is the result itself; LLM output is five-section markdown.
      const output: TaskOutput = isWorker
        ? { summary: fullText, changes: [], evidence: [], risks: [], blockers: [], rawText: fullText }
        : parseTaskOutput(fullText)
      task.tokenUsage = usage

      this.persistCompletion(agentId, task, output, isWorker, sourceIds)
      this.dag.complete(task.id, output)

      if (this.config.dynamicTasks) await this.insertDynamicTasks(task, output)
      await this.handleHighRiskGate(task, output)

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
      handle.release()
      this.activeDispatches--
      // Immediately wake the scheduler so the next ready task starts
      // without waiting for the 5-s safety-net interval.
      if (this.tickInterval) this.triggerTick()
    }
  }

  // ── dispatch helpers (extracted for clarity; behaviour unchanged) ──────────

  /** Resolve the data-flow input artifacts for a task: explicitly-named ids
   *  plus (if inputFromDeps) every artifact produced by its dependencies.
   *  Returns both the inlined prompt block and the resolved source IDs (for
   *  lineage). Resolved at dispatch time — sibling IDs don't exist earlier. */
  private resolveInputArtifacts(task: TaskNode): { block: string; sourceIds: string[]; artifacts: import("../dag/types").Artifact[] } {
    const ids: string[] = [...(task.inputArtifactIds ?? [])]
    if (task.inputFromDeps) {
      for (const depId of task.dependsOn) {
        for (const a of this.store.getArtifactsByTask(depId)) ids.push(a.id)
      }
    }
    const seen = new Set<string>()
    const sourceIds: string[] = []
    const artifacts: import("../dag/types").Artifact[] = []
    const parts: string[] = []
    for (const aid of ids) {
      if (seen.has(aid)) continue
      seen.add(aid)
      const art = this.store.getArtifact(aid)
      if (art) {
        sourceIds.push(art.id)
        artifacts.push(art)
        const label = art.label ? ` (${art.label})` : ""
        parts.push(`### Artifact ${art.id}${label} [${art.kind}]\n${art.content}`)
      }
    }
    const block = parts.length > 0
      ? `\n\n## Input Data (complete, from upstream tasks)\n${parts.join("\n\n")}`
      : ""
    return { block, sourceIds, artifacts }
  }

  /** Persist a completed task's full output as an artifact (verbatim for
   *  workers, parsed sections for LLM) and record memory + event. Best-effort:
   *  swallows closed-DB errors during shutdown. */
  private persistCompletion(agentId: string, task: TaskNode, output: TaskOutput, isWorker: boolean, sourceArtifactIds: string[]): void {
    try {
      const ref = this.store.writeArtifact({
        taskId: task.id,
        kind: isWorker ? "json" : "task_output",
        label: task.title,
        sourceArtifactIds,
        content: isWorker
          ? output.rawText
          : JSON.stringify({
              summary: output.summary,
              changes: output.changes,
              evidence: output.evidence,
              risks: output.risks,
              blockers: output.blockers,
            }),
      })
      task.artifacts = [...(task.artifacts ?? []), ref]
    } catch (err) {
      // A closed DB during shutdown is expected; anything else is a real bug
      // (e.g. a schema/migration mismatch) that must not be silently swallowed.
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("closed database")) {
        console.error(`[conductor] writeArtifact failed for task ${task.id}: ${msg}`)
      }
    }

    this.store.writeMemory({
      layer: "context", agentId, taskId: task.id,
      content: `[Task: ${task.title}]\n${output.summary}\n\nChanges:\n${output.changes.map(c => `- ${c.file}: ${c.description}`).join("\n")}`,
      tags: task.scope,
    })
    this.store.logEvent(agentId, task.id, "task.completed", { title: task.title, risks: output.risks })
  }

  /** Open the high-severity-risk approval gate. In autoApprove (unattended)
   *  mode it auto-approves with an observability event instead of blocking, so
   *  a headless run can't deadlock on a gate nobody is there to resolve. */
  private async handleHighRiskGate(task: TaskNode, output: TaskOutput): Promise<void> {
    const highRisks = output.risks.filter(r => /\b(critical|high|severe|security|data loss|breaking)\b/i.test(r))
    if (highRisks.length === 0) return

    if (this.config.autoApprove) {
      this.emit("approval.required", { taskId: task.id, risks: highRisks, autoApproved: true })
      this.emit("approval.resolved", { decision: "approved", taskId: task.id, autoApproved: true })
      return
    }
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

  private async insertDynamicTasks(completedTask: TaskNode, output: TaskOutput): Promise<void> {
    // 1. Explicit, output-driven fan-out: an agent (typically a planner) may
    //    emit a `## SPAWN` directive declaring an arbitrary number of children.
    //    This is the data-flow path — no 2-task cap.
    const fanOut = parseSpawnDirective(output.rawText)
    if (fanOut.length > 0) {
      this.spawnTasks(completedTask.id, fanOut)
      return
    }

    // 2. Heuristic fallback (legacy code-edit behaviour): BLOCKERS → implement,
    //    high RISKS → review, test changes → verify. Capped at 2.
    //    Skipped for data-flow tasks: their successors are declared explicitly
    //    via SPAWN, so mining their structured output for follow-ups only yields
    //    noise (markdown rows, "none" lines) misread as blockers/risks.
    if (completedTask.dataflow) return
    const existingTitles = new Set(this.dag.allTasks().map(t => t.title))
    const { inserted } = generateFollowupTasks(completedTask, output, existingTitles)
    if (inserted.length === 0) return
    this.dag.addTasks(inserted)
    for (const t of inserted) {
      this.store.upsertTask(t)
      this.emit("task.dynamic_inserted", { taskId: t.id, title: t.title, type: t.type, parentTaskId: completedTask.id })
    }
  }

  /**
   * Declaratively fan out a batch of child tasks from a parent task. Children
   * may depend on the parent, on each other (via FanOutSpec.key), and may inline
   * upstream artifacts as full-fidelity input. Returns the spec.key → task id
   * map. This is the public, programmable dynamic-graph API.
   */
  spawnTasks(parentTaskId: string, specs: import("../dag/types").FanOutSpec[]): Record<string, string> {
    const parent = this.dag.getTask(parentTaskId)
    if (!parent) throw new Error(`spawnTasks: unknown parent task ${parentTaskId}`)
    if (specs.length === 0) return {}

    const { nodes, keyToId, warnings } = buildFanOutTasks({
      parent,
      parentArtifacts: parent.artifacts ?? [],
      specs,
    })
    for (const w of warnings) console.warn(`[conductor] fan-out: ${w}`)

    this.dag.addTasks(nodes)
    for (const t of nodes) {
      try { this.store.upsertTask(t) } catch { /* db may be closed */ }
      this.emit("task.dynamic_inserted", { taskId: t.id, title: t.title, type: t.type, parentTaskId })
    }
    return keyToId
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
  onStream(cb: (agentId: string, task: TaskNode, delta: string, model: string | null) => void): void {
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
