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
  maxConcurrentAgents: number     // default 10
  basePort: number                // default 7878
  fileLockTtlMs: number           // default 300_000 (5min)
  deadlockTimeoutMs: number       // default 300_000
  schedulerTickMs: number         // default 500
  autoApprove: boolean            // pass auto_approve to CodeWhale
  codewhalebin: string            // path to codewhale binary
}

// ─── Events emitted by conductor ─────────────────────────────────────────────

export type ConductorEventKind =
  | "task.status_changed"
  | "agent.status_changed"
  | "lock.acquired"
  | "lock.released"
  | "deadlock.detected"
  | "phase.started"
  | "phase.completed"
  | "approval.required"

export interface ConductorEvent {
  kind: ConductorEventKind
  payload: Record<string, unknown>
  timestamp: number
}
