import { useEffect } from "react"
import { wsClient } from "../ws/client"
import type { ServerMessage, TaskNode } from "../ws/types"
import { useServeStore } from "../store/serve"
import { useRunStore } from "../store/run"

export function useWebSocket(): void {
  const { setServerState, setWsStatus, upsertTab, removeTab, setActiveTab } = useServeStore()
  const { applySnapshot, pushLog, setTask, setPlanningElapsed, setFinished, reset: _reset } = useRunStore()

  useEffect(() => {
    const unsub = wsClient.subscribe((msg: ServerMessage) => {
      const type = (msg as { type: string }).type

      if (type === "ws.open")  { setWsStatus("live");      return }
      if (type === "ws.close") { setWsStatus("reconnect"); return }

      switch (msg.type) {
        case "server.state":
          setServerState(msg.project, msg.tabs, msg.recentGoals)
          break

        case "snapshot": {
          const { tabId, ...snap } = msg
          applySnapshot({
            runId:            snap.runId,
            goal:             snap.goal,
            tasks:            snap.tasks,
            agents:           snap.agents,
            log:              snap.log,
            tokenStats:       snap.tokenStats,
            pendingApprovals: snap.pendingApprovals,
            status:           snap.status as Parameters<typeof applySnapshot>[0]["status"],
            runStartMs:       Date.now(),
            runFinished:      false,
          })
          if (tabId) setActiveTab(tabId)
          break
        }

        case "tick":
          applySnapshot({
            ...(msg.tasks       ? { tasks:      msg.tasks }       : {}),
            ...(msg.agents      ? { agents:     msg.agents }      : {}),
            ...(msg.tokenStats  ? { tokenStats: msg.tokenStats }  : {}),
            ...(msg.status      ? { status:     msg.status as Parameters<typeof applySnapshot>[0]["status"] } : {}),
          })
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
          setFinished(msg as unknown as Record<string, unknown>)
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
    return () => { unsub(); wsClient.stop() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
