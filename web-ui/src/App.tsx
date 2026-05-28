import { useState } from "react"
import "./globals.css"
import { useWebSocket } from "./hooks/useWebSocket"
import { useServeStore } from "./store/serve"
import { useRunStore } from "./store/run"
import { TabBar }        from "./components/TabBar"
import { Header }        from "./components/Header"
import { LaunchOverlay } from "./components/LaunchOverlay"
import { TaskDag, TaskDetail } from "./components/TaskDag"
import { AgentSlots }    from "./components/AgentSlots"
import { LogStream }     from "./components/LogStream"
import { ApprovalModal } from "./components/ApprovalModal"
import { InjectModal }   from "./components/InjectModal"
import { HistoryDrawer } from "./components/HistoryDrawer"
import { DebugPanel }    from "./components/DebugPanel"

// ── Run-finished banner ────────────────────────────────────────────────────────

function RunBanner() {
  const [dismissed, setDismissed] = useState(false)
  const runFinished  = useRunStore((s) => s.runFinished)
  const finalReport  = useRunStore((s) => s.finalReport) as Record<string, unknown> | null

  if (!runFinished || dismissed || !finalReport) return null
  const done = finalReport["result"] === "completed"
  const tk   = finalReport["tokenStats"] as Record<string, number> | null
  const tasks = finalReport["tasks"] as Record<string, number> | null
  const cost = tk ? (( tk["inputTokens"] ?? 0) * 15 + (tk["outputTokens"] ?? 0) * 75) / 1_000_000 : 0

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 200,
      background: "var(--bg2)", borderBottom: "2px solid var(--border)",
      padding: "10px 20px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
    }}>
      <span style={{ fontSize: 18 }}>{done ? "✓" : "✗"}</span>
      <span style={{ fontWeight: "bold", fontSize: 14, color: done ? "var(--green)" : "var(--red)" }}>
        {done ? "Run completed" : "Run finished with failures"}
      </span>
      <span style={{ color: "var(--dim)", fontSize: 12 }}>
        {tasks?.["done"] ?? 0}/{tasks?.["total"] ?? 0} tasks done
        {(tk?.["totalTokens"] ?? 0) > 0 ? `  ·  ${(tk!["totalTokens"]!).toLocaleString()} tok` : ""}
        {cost > 0.001 ? `  ·  $${cost.toFixed(2)}` : ""}
      </span>
      <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setDismissed(true)}>✕</button>
    </div>
  )
}

// ── Replay banner ──────────────────────────────────────────────────────────────

function ReplayBanner({ onClose }: { onClose: () => void }) {
  const activeId = useServeStore((s) => s.activeTabId)
  const isReplay = activeId?.startsWith("replay-") ?? false
  if (!isReplay) return null
  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, zIndex: 190,
      background: "rgba(88,166,255,0.12)", borderBottom: "1px solid rgba(88,166,255,0.3)",
      padding: "6px 16px", display: "flex", alignItems: "center", gap: 10,
      fontSize: 12, color: "var(--cyan)",
    }}>
      🔁 <strong>REPLAY MODE</strong> — Read-only view of a completed run
      <button className="btn" style={{ marginLeft: "auto", fontSize: 11, padding: "2px 10px" }}
        onClick={onClose}>✕ Close Replay</button>
    </div>
  )
}

// ── Root ───────────────────────────────────────────────────────────────────────

export default function App() {
  useWebSocket()

  const tabs        = useServeStore((s) => s.tabs)
  const activeTabId = useServeStore((s) => s.activeTabId)
  const { removeTab, setActiveTab } = useServeStore()
  const applySnapshot = useRunStore((s) => s.applySnapshot)
  const tasks = useRunStore((s) => s.tasks)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

  const showTUI = !!activeTabId

  async function openReplay(runId: string, goalText: string) {
    setHistoryOpen(false)
    const tabId = "replay-" + runId.slice(-8)

    useServeStore.getState().upsertTab({
      tabId, runId, goalId: "", goalText: `🔁 ${goalText.slice(0, 24)}`,
      agents: 0, status: "completed",
    })
    setActiveTab(tabId)
    applySnapshot({ tasks: [], agents: [], log: [], goal: goalText, runFinished: true })

    try {
      const data = await fetch(`/api/runs/${runId}/replay`).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json() as Promise<Record<string, unknown>>
      })
      applySnapshot({
        tasks:       (data["tasks"] as Parameters<typeof applySnapshot>[0]["tasks"]) ?? [],
        log:         (data["log"] as string[]) ?? [],
        tokenStats:  (data["tokenStats"] as Parameters<typeof applySnapshot>[0]["tokenStats"]) ?? null,
        goal:        (data["goalText"] as string) ?? goalText,
        finalReport: data as Record<string, unknown>,
        runFinished: true,
      })
    } catch (err) {
      applySnapshot({ log: [`Error loading replay: ${err}`] })
    }
  }

  function closeReplay() {
    if (!activeTabId) return
    removeTab(activeTabId)
    const next = tabs.find((t) => !t.tabId.startsWith("replay-") && t.tabId !== activeTabId)
    setActiveTab(next?.tabId ?? null)
    applySnapshot({ runFinished: false })
  }

  function handleSelectGoal(text: string) {
    setActiveTab(null)  // show launch overlay
    // The LaunchOverlay will have the goal pre-filled via URL or state
    // For now we dispatch a custom event that LaunchOverlay listens to
    document.dispatchEvent(new CustomEvent("swarm:prefill-goal", { detail: text }))
  }

  return (
    <>
      <TabBar />

      {showTUI ? (
        <>
          <ReplayBanner onClose={closeReplay} />
          <RunBanner />
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 8px", background: "var(--bg2)", borderBottom: "1px solid var(--border)" }}>
            <button
              style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", fontSize: 14, padding: "2px 6px" }}
              title="History"
              onClick={() => setHistoryOpen(true)}
            >☰</button>
          </div>
          <Header />
          <div id="main">
            <TaskDag
              selectedId={selectedTaskId}
              onSelect={(id) => setSelectedTaskId((prev) => (prev === id ? null : id))}
            />
            <AgentSlots />
            <LogStream />
          </div>
          {selectedTaskId && (
            <TaskDetail
              taskId={selectedTaskId}
              tasks={tasks}
              onClose={() => setSelectedTaskId(null)}
            />
          )}
        </>
      ) : (
        <LaunchOverlay />
      )}

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSelectGoal={handleSelectGoal}
        onReplay={openReplay}
      />
      <ApprovalModal />
      <InjectModal />
      <DebugPanel />
    </>
  )
}
