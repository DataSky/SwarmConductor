import { create } from "zustand"
import type { TabInfo, GoalRecord } from "../ws/types"

interface ServeState {
  project: string
  tabs: TabInfo[]
  recentGoals: GoalRecord[]
  activeTabId: string | null
  wsStatus: "live" | "reconnect"

  setServerState: (project: string, tabs: TabInfo[], goals: GoalRecord[]) => void
  setWsStatus: (s: "live" | "reconnect") => void
  setActiveTab: (tabId: string | null) => void
  upsertTab: (tab: TabInfo) => void
  removeTab: (tabId: string) => void
}

export const useServeStore = create<ServeState>((set) => ({
  project: "",
  tabs: [],
  recentGoals: [],
  activeTabId: null,
  wsStatus: "reconnect",

  setServerState: (project, tabs, recentGoals) =>
    set((s) => ({
      project,
      tabs,
      recentGoals,
      // Auto-select first tab if nothing active
      activeTabId: s.activeTabId ?? tabs[0]?.tabId ?? null,
    })),

  setWsStatus: (wsStatus) => set({ wsStatus }),

  setActiveTab: (activeTabId) => set({ activeTabId }),

  upsertTab: (tab) =>
    set((s) => {
      const exists = s.tabs.find((t) => t.tabId === tab.tabId)
      return {
        tabs: exists
          ? s.tabs.map((t) => (t.tabId === tab.tabId ? tab : t))
          : [...s.tabs, tab],
        activeTabId: s.activeTabId ?? tab.tabId,
      }
    }),

  removeTab: (tabId) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.tabId !== tabId)
      return {
        tabs,
        activeTabId: s.activeTabId === tabId ? (tabs[0]?.tabId ?? null) : s.activeTabId,
      }
    }),
}))
