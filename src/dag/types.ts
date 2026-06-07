// ─── Task types ─────────────────────────────────────────────────────────────

export type TaskType =
  | "explore"
  | "plan"
  | "implement"
  | "review"
  | "verify"
  | "merge"

export type TaskStatus =
  | "pending"    // waiting for dependencies
  | "blocked"    // deps exist but not met
  | "ready"      // all deps met, waiting for agent
  | "running"    // assigned to an agent
  | "done"       // completed successfully
  | "failed"     // failed, see error field
  | "interrupted" // forcibly stopped (deadlock resolution etc.)

export type AgentRole =
  | "explore"
  | "plan"
  | "implementer"
  | "review"
  | "verifier"
  | "general"

// ─── Task Node ───────────────────────────────────────────────────────────────

export interface TaskNode {
  id: string
  type: TaskType
  status: TaskStatus
  priority: number          // higher = more urgent
  title: string
  prompt: string            // instruction sent to the agent
  dependsOn: string[]       // task IDs that must be done first
  blocks: string[]          // task IDs that depend on this task
  scope: string[]           // file paths / module globs this task touches
  assignedTo: string | null // agent instance ID
  role: AgentRole
  output: TaskOutput | null
  error: string | null
  createdAt: number         // Date.now()
  startedAt: number | null
  completedAt: number | null
  retryCount: number
  maxRetries: number
  forkContext: boolean       // inherit parent agent context
  tokenUsage: { inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number } | null
  /** Artifact IDs whose FULL content should be inlined into this task's prompt
   *  (data-flow input). Bypasses the truncated `context` layer. */
  inputArtifactIds?: string[]
  /** Inline the FULL artifacts of every task this one dependsOn (resolved at
   *  dispatch time). Closes the fan-out → cross-comparison data-flow loop. */
  inputFromDeps?: boolean
  /** Refs to artifacts this task produced (populated on completion). */
  artifacts?: ArtifactRef[]
  /** How many dynamic-generation hops produced this task (0 = original/plan).
   *  Used to cap runaway follow-up recursion (e.g. verify→verify→verify). */
  dynamicDepth?: number
  /** This task is part of an EXPLICIT data-flow graph (created via spawnTasks /
   *  a `## SPAWN` directive). Its successors are declared explicitly, so the
   *  legacy code-edit heuristics (blockers→implement etc.) must NOT fire on its
   *  output — otherwise structured result text gets mined into noise tasks. */
  dataflow?: boolean
  /** Which executor backend should run this task ("llm" by default). When set
   *  to a registered non-LLM kind (e.g. "worker"), the scheduler routes it to
   *  that executor — cheap deterministic work (SQL, validation, diff) avoids
   *  spending LLM tokens. Unknown kinds fall back to the default executor. */
  executorKind?: string
  /** How to handle failed dependencies at fan-in:
   *   - "tolerate" (default): run once all deps reach a terminal state, even if
   *     some failed — the task receives whatever upstream artifacts exist.
   *   - "all": any failed/interrupted dependency cascades — this task is marked
   *     failed without running (use when partial input is meaningless). */
  failurePolicy?: "tolerate" | "all"
}

// Required output contract (mirrors CodeWhale SUBAGENTS.md)
export interface TaskOutput {
  summary: string
  changes: ChangeRecord[]
  evidence: string[]
  risks: string[]
  blockers: string[]
  rawText: string
}

export interface ChangeRecord {
  file: string
  description: string
}

// ─── Artifacts ────────────────────────────────────────────────────────────────
// A typed, full-fidelity result produced by a task. Unlike the `context` memory
// layer (which is truncated to ~8KB for prompt economy), an artifact holds the
// COMPLETE structured output — a SQL result set, a validation report, a diff —
// so a downstream task can consume it without loss. This is the foundation of
// data-flow orchestration: tasks pass data, not lossy text summaries.

export type ArtifactKind =
  | "task_output"   // the structured TaskOutput of a completed task
  | "json"          // arbitrary structured data (e.g. a SQL result set)
  | "text"          // large free text that must not be truncated
  | "rows"          // tabular rows: { columns: string[]; rows: unknown[][] }

export interface Artifact {
  id: string
  taskId: string       // the task that produced it
  kind: ArtifactKind
  /** Optional human label, e.g. "query_42_result". */
  label: string | null
  /** Serialized content (JSON string for json/rows/task_output, raw for text). */
  content: string
  /** Byte length of content, for budgeting/observability. */
  byteSize: number
  /** Lineage: artifact IDs that were fed into the task that produced this one.
   *  Lets you trace a comparison/summary back to its source data. */
  sourceArtifactIds?: string[]
  createdAt: number
}

/** A lightweight pointer to an artifact, stored on the producing TaskNode. */
export interface ArtifactRef {
  id: string
  kind: ArtifactKind
  label: string | null
  byteSize: number
}

// ─── Dynamic fan-out ──────────────────────────────────────────────────────────
// A declarative spec for a task spawned at runtime (data-flow fan-out). Unlike
// the old heuristic generator (capped at 2 follow-ups), a single completed task
// can fan out into an arbitrary number of children — e.g. 100 SQL-validation
// tasks, then a cross-comparison task per qualifying pair. Specs in one batch
// can depend on each other via `key`/`dependsOnKeys`, which the conductor
// resolves to real task IDs when it materializes the batch.

export interface FanOutSpec {
  /** Optional batch-local handle so sibling specs can depend on this one. */
  key?: string
  type: TaskType
  title: string
  prompt: string
  scope?: string[]
  role?: AgentRole
  priority?: number
  /** Depend on the task that produced this fan-out. */
  dependsOnParent?: boolean
  /** Depend on sibling specs in the same batch, by their `key`. */
  dependsOnKeys?: string[]
  /** Inline these upstream artifacts' FULL content into the child's prompt. */
  inputArtifactIds?: string[]
  /** Inline the parent task's produced artifacts into the child's prompt. */
  inputFromParent?: boolean
  /** Inline the FULL artifacts of every task this one dependsOn. Resolves at
   *  dispatch time (sibling artifact IDs aren't known when the spec is written),
   *  which is what closes the fan-out → cross-comparison data-flow loop. */
  inputFromDeps?: boolean
  /** Route this child to a specific executor backend (e.g. "worker" for a
   *  deterministic SQL/validation step). Defaults to the LLM executor. */
  executorKind?: string
  /** Fan-in failure handling: "tolerate" (default) or "all" (cascade on any
   *  failed dependency). See TaskNode.failurePolicy. */
  failurePolicy?: "tolerate" | "all"
}

// ─── DAG state ───────────────────────────────────────────────────────────────

export interface TaskGraph {
  id: string                // execution run ID
  projectPath: string
  tasks: Map<string, TaskNode>
  phase: number
  createdAt: number
  updatedAt: number
}

// ─── Agent instance ──────────────────────────────────────────────────────────

export type AgentInstanceStatus =
  | "starting"
  | "idle"
  | "busy"
  | "crashed"
  | "stopped"

export interface AgentInstance {
  id: string
  port: number
  role: AgentRole
  status: AgentInstanceStatus
  pid: number | null
  currentTaskId: string | null
  threadId: string | null     // CodeWhale thread ID for current task
  model: string | null        // model used for the current/last thread
  startedAt: number
  lastHeartbeat: number
}

// ─── File lock ───────────────────────────────────────────────────────────────

export interface FileLock {
  path: string             // normalized absolute path
  heldBy: string           // agent instance ID
  taskId: string
  acquiredAt: number
  expiresAt: number        // auto-release on crash
}

// ─── Shared memory entry ─────────────────────────────────────────────────────

export type MemoryLayerKind = "project_map" | "context" | "event_log"

export interface MemoryEntry {
  id: string
  layer: MemoryLayerKind
  agentId: string
  taskId: string
  content: string
  tags: string[]           // module names, file paths, etc.
  timestamp: number
}

// ─── Conductor config ────────────────────────────────────────────────────────

export interface ConductorConfig {
  projectPath: string
  maxConcurrentAgents: number
  basePort: number
  fileLockTtlMs: number
  deadlockTimeoutMs: number
  schedulerTickMs: number
  autoApprove: boolean
  codewhalebin: string
  heartbeatIntervalMs: number
  heartbeatTimeoutMs: number
  maxAgentRestarts: number
  dynamicTasks: boolean
  /** Per-role model override. Omitted roles use codewhale's global config. */
  modelMap: Partial<Record<AgentRole, string>>
  /** Backpressure: minimum gap (ms) between two execution *starts*. Spaces out
   *  LLM provider calls so a tick that dispatches many agents at once doesn't
   *  burst the API into rate limits. 0 disables spacing. */
  minStartIntervalMs: number
  /** Backpressure: max executions allowed to *start* within any rolling 60s
   *  window (token bucket). 0 disables the window cap. */
  maxStartsPerMinute: number
  // ── Tuneable limits (formerly hard-coded constants) ──────────────────────
  /** Max recent context entries inlined into an agent prompt. Default 5. */
  maxContextEntries: number
  /** Max chars per context entry before truncation. Default 1600. */
  maxEntryChars: number
  /** Max chars of raw agent output before conductor truncates. Default 80 000. */
  maxOutputChars: number
  /** SQLite busy_timeout in ms. Default 5000. */
  sqliteBusyTimeoutMs: number
  /** Max events returned by the replay endpoint. Default 300. */
  replayEventLimit: number
  /** Max rows materialised per SQL worker result. Default 10 000. */
  sqlWorkerMaxRows: number
}

export function defaultConfig(overrides: Partial<ConductorConfig> & Pick<ConductorConfig, "projectPath">): ConductorConfig {
  return {
    maxConcurrentAgents: 10,
    basePort: 7878,
    fileLockTtlMs: 300_000,
    deadlockTimeoutMs: 300_000,
    schedulerTickMs: 500,
    autoApprove: false,
    codewhalebin: "codewhale",
    heartbeatIntervalMs: 15_000,
    heartbeatTimeoutMs: 45_000,
    maxAgentRestarts: 3,
    dynamicTasks: true,
    modelMap: {},
    minStartIntervalMs: 0,    // off by default — preserves current burst behaviour
    maxStartsPerMinute: 0,    // off by default
    maxContextEntries:  5,
    maxEntryChars:      1_600,
    maxOutputChars:     80_000,
    sqliteBusyTimeoutMs: 5_000,
    replayEventLimit:   300,
    sqlWorkerMaxRows:   10_000,
    ...overrides,
  }
}

// ─── Approval gate ────────────────────────────────────────────────────────────

export type ApprovalKind =
  | "phase_boundary"   // between phases
  | "high_risk"        // task output has RISKS that exceed threshold
  | "merge_conflict"   // git merge failed, needs human resolution

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  message: string
  context: Record<string, unknown>
  createdAt: number
  resolvedAt: number | null
  decision: "approved" | "rejected" | null
}

// ─── Events emitted by conductor ─────────────────────────────────────────────

export type ConductorEventKind =
  | "task.status_changed"
  | "agent.status_changed"
  | "agent.crashed"
  | "agent.restarted"
  | "agent.spawn_degraded"
  | "lock.acquired"
  | "lock.released"
  | "deadlock.detected"
  | "phase.started"
  | "phase.completed"
  | "approval.required"
  | "approval.resolved"
  | "task.dynamic_inserted"
  | "run.completed"
  | "run.failed"
  | "selfcheck.completed"

export interface ConductorEvent {
  kind: ConductorEventKind
  payload: Record<string, unknown>
  timestamp: number
}
