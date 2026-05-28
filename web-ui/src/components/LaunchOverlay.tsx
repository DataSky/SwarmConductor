import { useState, useRef, useEffect } from "react"
import { useServeStore } from "../store/serve"
import { useRunStore } from "../store/run"
import { wsClient } from "../ws/client"
import type { StartRunCmd } from "../ws/types"
import styles from "./LaunchOverlay.module.css"
import { fmtTimeAgo } from "../utils"

export function LaunchOverlay() {
  const { tabs, recentGoals, project, activeTabId, setActiveTab } = useServeStore()
  const planningElapsed = useRunStore((s) => s.planningElapsedMs)
  const wsStatus = useServeStore((s) => s.wsStatus)

  const [goal, setGoal]       = useState("")
  const [agents, setAgents]   = useState("3")
  const [model, setModel]     = useState("")
  const [aiPlan, setAiPlan]   = useState("true")
  const [error, setError]     = useState("")
  const [loading, setLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isModal = tabs.length > 0
  const visible = !activeTabId || planningElapsed !== null

  // Re-enable button on disconnect
  useEffect(() => {
    if (wsStatus === "reconnect") setLoading(false)
  }, [wsStatus])

  function submit() {
    const g = goal.trim()
    if (!g) { setError("Goal cannot be empty"); return }
    if (!wsClient.isOpen()) {
      setError("Not connected to server — please wait and retry")
      return
    }
    setError("")
    setLoading(true)
    wsClient.send({
      type: "start.run",
      goalText: g,
      agents: parseInt(agents),
      modelWorker: model || null,
      noAiPlan: aiPlan === "false",
    } satisfies StartRunCmd)
  }

  function cancel() {
    if (tabs[0]) setActiveTab(tabs[0].tabId)
  }

  if (!visible && activeTabId) return null

  return (
    <div
      className={`${styles.overlay} ${isModal ? styles.modal : ""}`}
      onClick={(e) => { if (isModal && e.target === e.currentTarget) cancel() }}
    >
      <div className={styles.box}>
        {isModal && (
          <button className={`btn ${styles.closeBtn}`} onClick={cancel}>✕ Cancel</button>
        )}

        {!isModal && (
          <>
            <div className={styles.brand}>SWARM</div>
            <div className={styles.subtitle}>Multi-agent coding swarm</div>
            {project && <div className={styles.projectPath}>{project}</div>}
          </>
        )}

        <div className={styles.label}>Goal</div>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder="Describe what you want the agents to do…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit() }}
          rows={4}
        />

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.row}>
          <label className={styles.selectGroup}>
            <span className={styles.selectLabel}>Agents</span>
            <select className={styles.select} value={agents} onChange={(e) => setAgents(e.target.value)}>
              {["1","2","3","5","8","10"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>

          <label className={styles.selectGroup}>
            <span className={styles.selectLabel}>Model</span>
            <select className={styles.select} value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Default</option>
              <option value="deepseek-v4-flash">dv4-flash (fast)</option>
              <option value="deepseek-v4-pro">dv4-pro</option>
              <option value="deepseek-v3">dv3</option>
            </select>
          </label>

          <label className={styles.selectGroup}>
            <span className={styles.selectLabel}>AI Plan</span>
            <select className={styles.select} value={aiPlan} onChange={(e) => setAiPlan(e.target.value)}>
              <option value="true">AI Planner</option>
              <option value="false">Static Template</option>
            </select>
          </label>

          <button
            className={styles.startBtn}
            disabled={loading}
            onClick={submit}
          >
            {loading
              ? planningElapsed !== null
                ? `⏳ Planning… ${Math.floor(planningElapsed / 1000)}s`
                : "⏳ Planning…"
              : "▶ Start Run"}
          </button>
        </div>

        {recentGoals.length > 0 && (
          <div className={styles.recent}>
            <div className={styles.recentTitle}>Recent Goals</div>
            {recentGoals.slice(0, 5).map((g) => (
              <div
                key={g.id}
                className={styles.recentItem}
                onClick={() => { setGoal(g.text); textareaRef.current?.focus() }}
              >
                <span className={styles.recentText}>{g.text}</span>
                <span className={styles.recentTime}>{fmtTimeAgo(g.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
