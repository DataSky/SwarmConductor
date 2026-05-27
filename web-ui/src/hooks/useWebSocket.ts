import { useEffect } from "react"
import { wsClient } from "../ws/client"
import type { ServerMessage } from "../ws/types"
import { useServeStore } from "../store/serve"
import { useRunStore } from "../store/run"

/**
 * Mounts once at app level. Connects the WS client and routes every
 * incoming message to the appropriate Zustand store.
 */
export function useWebSocket(): void {
  const { setServerState, setWsStatus, upsertTab, removeTab, setActiveTab } = useServeStore()
  const { applySnapshot, pushLog, setTask, setPlanningElapsed, setFinished, reset } = useRunStore()

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: ServerMessage) => {
      // Internal connection-lifecycle messages injected by WsClient
      if ((msg as { type: string }).type === "ws.open") {
        setWsStatus("live")
        return
      }
      if ((msg as { type: string }).type === "ws.close") {
        setWsStatus("reconnect")
        return
      }

      switch (msg.type) {
        case "server.state":
          setServerState(msg.project, msg.tabs, msg.recentGoals)
          break

        case "snapshot": {
          const { tabId, ...snap } = msg
          applySnapshot(snap)
          if (tabId) setActiveTab(tabId)
          break
        }

        case "tick":
          applySnapshot({
            ...(msg.tasks ? { tasks: msg.tasks } : {}),
            ...(msg.agents ? { agents: msg.agents } : {}),
            ...(msg.tokenStats ? { tokenStats: msg.tokenStats } : {}),
          })
          break

        case "delta":
          // Token streaming — update last line of the matching agent slot
          // (fine-grained update handled inside AgentSlots component)
          break

        case "log":
          pushLog(msg.line)
          break

        case "run.planning":
          setPlanningElapsed(0)
          if (msg.tabId) {
            upsertTab({
              tabId: msg.tabId, runId: "", goalId: "",
              goalText: msg.goalText, agents: 0, status: "planning",
            })
            setActiveTab(msg.tabId)
          }
          break

        case "run.planning.heartbeat":
          setPlanningElapsed(msg.elapsedMs)
          break

        case "run.error":
          setPlanningElapsed(null)
          if (msg.tabId) removeTab(msg.tabId)
          break

        case "run.finished":
          setFinished()
          setPlanningElapsed(null)
          break

        case "event":
          if (msg.kind === "task.status_changed") {
            const { taskId, next } = msg.payload as { taskId: string; next: string }
            setTask(taskId, { status: next as TaskNode["status"] })
          }
          break

        case "approval.required":
          applySnapshot({ pendingApprovals: msg.requests })
          break
      }
    })

    wsClient.connect()
    return () => {
      unsub()
      wsClient.stop()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

// Re-export type so useWebSocket callers don't need to import from store
import type { TaskNode } from "../ws/types"
