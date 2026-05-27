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

export interface ConductorEvent {
  kind: ConductorEventKind
  payload: Record<string, unknown>
  timestamp: number
}
