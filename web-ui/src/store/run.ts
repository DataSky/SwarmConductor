import { create } from "zustand"
import type {
  TaskNode, AgentSlot, TokenStats, ApprovalRequest,
} from "../ws/types"

interface RunState {
  runId: string
  goal: string
  tasks: TaskNode[]
  agents: AgentSlot[]
  log: string[]
  tokenStats: TokenStats | null
  pendingApprovals: ApprovalRequest[]
  runFinished: boolean
  planningElapsedMs: number | null  // null = not planning

  applySnapshot: (snap: Partial<RunState>) => void
  pushLog: (line: string) => void
  setTask: (id: string, patch: Partial<TaskNode>) => void
  setPlanningElapsed: (ms: number | null) => void
  setFinished: () => void
  reset: () => void
}

const EMPTY_TOKEN_STATS: TokenStats = {
  inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
  cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0,
}

export const useRunStore = create<RunState>((set) => ({
  runId: "",
  goal: "",
  tasks: [],
  agents: [],
  log: [],
  tokenStats: null,
  pendingApprovals: [],
  runFinished: false,
  planningElapsedMs: null,

  applySnapshot: (snap) => set((s) => ({ ...s, ...snap })),

  pushLog: (line) =>
    set((s) => ({ log: [...s.log.slice(-499), line] })),

  setTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  setPlanningElapsed: (planningElapsedMs) => set({ planningElapsedMs }),

  setFinished: () => set({ runFinished: true }),

  reset: () =>
    set({
      runId: "", goal: "", tasks: [], agents: [], log: [],
      tokenStats: EMPTY_TOKEN_STATS, pendingApprovals: [],
      runFinished: false, planningElapsedMs: null,
    }),
}))
