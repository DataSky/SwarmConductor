import { create } from "zustand"
import type {
  TaskNode, AgentSlot, TokenStats, ApprovalRequest,
} from "../ws/types"

interface PhaseRecord {
  phase: number
  startMs: number
  endMs: number | null
}

interface RunStatusSummary {
  phase: number
  tasks:  { total: number; done: number; failed: number; running: number; ready: number; blocked: number; interrupted: number }
  agents: { total: number; idle: number; busy: number; crashed: number }
}

interface RunState {
  runId: string
  goal: string
  tasks: TaskNode[]
  agents: AgentSlot[]
  log: string[]
  tokenStats: TokenStats | null
  pendingApprovals: ApprovalRequest[]
  runFinished: boolean
  planningElapsedMs: number | null
  // Extra fields for Header rendering
  status: RunStatusSummary | null
  phaseHistory: PhaseRecord[]
  runStartMs: number
  riskCount: number
  lastRisk: string
  finalReport: Record<string, unknown> | null

  applySnapshot: (snap: Partial<RunState>) => void
  pushLog: (line: string) => void
  setTask: (id: string, patch: Partial<TaskNode>) => void
  setPlanningElapsed: (ms: number | null) => void
  setFinished: (report?: Record<string, unknown>) => void
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
  status: null,
  phaseHistory: [],
  runStartMs: Date.now(),
  riskCount: 0,
  lastRisk: "",
  finalReport: null,

  applySnapshot: (snap) => set((s) => ({ ...s, ...snap })),

  pushLog: (line) =>
    set((s) => {
      // Track risk count from log lines containing risk keywords
      let { riskCount, lastRisk } = s
      if (/\b(critical|high|severe|security)\b/i.test(line)) {
        riskCount++
        lastRisk = line
      }
      return { log: [...s.log.slice(-499), line], riskCount, lastRisk }
    }),

  setTask: (id, patch) =>
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  setPlanningElapsed: (planningElapsedMs) => set({ planningElapsedMs }),

  setFinished: (report) => set({ runFinished: true, finalReport: report ?? null }),

  reset: () =>
    set({
      runId: "", goal: "", tasks: [], agents: [], log: [],
      tokenStats: EMPTY_TOKEN_STATS, pendingApprovals: [],
      runFinished: false, planningElapsedMs: null,
      status: null, phaseHistory: [], runStartMs: Date.now(),
      riskCount: 0, lastRisk: "", finalReport: null,
    }),
}))
