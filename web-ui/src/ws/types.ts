// WebSocket message types shared between the Bun backend and the React frontend.
// These mirror the messages emitted by StandaloneServer / WebDashboard.

// ─── Outbound (client → server) ───────────────────────────────────────────────

export interface StartRunCmd {
  type: "start.run"
  goalText: string
  agents: number
  modelWorker: string | null
  noAiPlan: boolean
}

export interface SelectTabCmd {
  type: "select.tab"
  tabId: string
}

export interface AbortRunCmd {
  type: "abort.run"
  tabId: string
}

export interface PauseCmd   { type: "pause";   tabId: string }
export interface ResumeCmd  { type: "resume";  tabId: string }
export interface InjectCmd  { type: "inject";  tabId: string; prompt: string }
export interface InterruptCmd { type: "interrupt"; tabId: string; agentId: string }
export interface ApproveCmd {
  type: "approve"
  tabId: string
  requestId: string
  decision: "approved" | "rejected"
}

export type ClientMessage =
  | StartRunCmd | SelectTabCmd | AbortRunCmd
  | PauseCmd | ResumeCmd | InjectCmd | InterruptCmd | ApproveCmd

// ─── Inbound (server → client) ────────────────────────────────────────────────

export interface TaskNode {
  id: string
  type: string
  title: string
  status: "pending" | "blocked" | "ready" | "running" | "done" | "failed" | "interrupted"
  priority: number
  role: string
  scope: string[]
  dependsOn: string[]
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  output: {
    summary: string
    changes: { file: string; description: string }[]
    evidence: string[]
    risks: string[]
    blockers: string[]
  } | null
  error: string | null
  tokenUsage: { inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number } | null
}

export interface AgentSlot {
  agentId: string
  taskId: string
  title: string
  type: string
  scope: string[]
  startedAt: number
  lastLine: string
  model: string | null
}

export interface TokenStats {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  totalTokens: number
  cacheHitRate: number
}

export interface ApprovalRequest {
  id: string
  kind: string
  message: string
  createdAt: number
}

export interface TabInfo {
  tabId: string
  runId: string
  goalId: string
  goalText: string
  agents: number
  status: "planning" | "running" | "completed" | "failed"
}

export interface GoalRecord {
  id: string
  text: string
  createdAt: number
}

// Server → client message union

export interface ServerStateMsg {
  type: "server.state"
  project: string
  tabs: TabInfo[]
  recentGoals: GoalRecord[]
}

export interface SnapshotMsg {
  type: "snapshot"
  tabId: string
  runId: string
  goal: string
  tasks: TaskNode[]
  agents: AgentSlot[]
  log: string[]
  tokenStats: TokenStats
  pendingApprovals: ApprovalRequest[]
  status: { agents: { total: number; idle: number; busy: number; crashed: number } } | null
}

export interface TickMsg {
  type: "tick"
  tabId?: string
  tasks?: TaskNode[]
  agents?: AgentSlot[]
  tokenStats?: TokenStats
  status?: SnapshotMsg["status"]
}

export interface DeltaMsg {
  type: "delta"
  tabId?: string
  agentId: string
  taskId: string
  model: string | null
  text: string
}

export interface LogMsg      { type: "log";               tabId?: string; line: string }
export interface RunPlanningMsg { type: "run.planning";   tabId: string; goalText: string }
export interface RunPlanningHeartbeatMsg { type: "run.planning.heartbeat"; tabId: string; elapsedMs: number }
export interface RunErrorMsg { type: "run.error";         tabId?: string; error: string }
export interface RunFinishedMsg { type: "run.finished";   tabId?: string; result: "completed" | "failed" }
export interface EventMsg    { type: "event";             tabId?: string; kind: string; payload: Record<string, unknown> }
export interface ApprovalRequiredMsg { type: "approval.required"; tabId?: string; requests: ApprovalRequest[] }

export type ServerMessage =
  | ServerStateMsg | SnapshotMsg | TickMsg | DeltaMsg
  | LogMsg | RunPlanningMsg | RunPlanningHeartbeatMsg | RunErrorMsg
  | RunFinishedMsg | EventMsg | ApprovalRequiredMsg
