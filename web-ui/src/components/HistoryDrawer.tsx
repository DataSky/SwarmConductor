import { useState } from "react"
import { fmtTimeAgo, fmtElapsed } from "../utils"
import styles from "./HistoryDrawer.module.css"

interface GoalRecord { id: string; text: string; createdAt: number }
interface RunRecord  { id: string; status: string; createdAt: number; finishedAt?: number; agents: number; tokenTotal?: number; costUsd?: number }

interface Props {
  open: boolean
  onClose: () => void
  onSelectGoal: (text: string) => void
  onReplay: (runId: string, goalText: string) => void
}

export function HistoryDrawer({ open, onClose, onSelectGoal, onReplay }: Props) {
  const [goals, setGoals]               = useState<GoalRecord[]>([])
  const [runsMap, setRunsMap]           = useState<Record<string, RunRecord[]>>({})
  const [expandedGoalId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState("")

  async function load() {
    setLoading(true)
    setError("")
    try {
      const g: GoalRecord[] = await fetch("/api/goals").then((r) => r.json())
      setGoals(g)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  async function loadRuns(goalId: string) {
    if (runsMap[goalId]) return
    try {
      const runs: RunRecord[] = await fetch(`/api/goals/${goalId}/runs`).then((r) => r.json())
      setRunsMap((m) => ({ ...m, [goalId]: runs }))
    } catch { /* ignore */ }
  }

  // Load on open
  const [loaded, setLoaded] = useState(false)
  if (open && !loaded) { setLoaded(true); load() }
  if (!open && loaded)  { setLoaded(false) }

  const dotColor = (status: string) =>
    status === "completed" ? "var(--green)" : status === "failed" ? "var(--red)" : status === "interrupted" ? "var(--yellow)" : "var(--cyan)"

  return (
    <>
      <div className={`${styles.backdrop} ${open ? styles.backdropVisible : ""}`} onClick={onClose} />
      <div className={`${styles.drawer} ${open ? styles.open : ""}`}>
        <div className={styles.drawerHeader}>
          Goals & Runs
          <button className="btn" style={{ fontSize: 10, padding: "2px 8px" }} onClick={onClose}>✕</button>
        </div>
        <div className={styles.drawerBody}>
          {loading && <div className={styles.hint}>Loading…</div>}
          {error   && <div className={styles.hint} style={{ color: "var(--red)" }}>Failed: {error}</div>}
          {!loading && !error && goals.length === 0 && (
            <div className={styles.hint}>No history yet.</div>
          )}
          {goals.map((g) => {
            const expanded = expandedGoalId === g.id
            const runs     = runsMap[g.id]
            return (
              <div
                key={g.id}
                className={`${styles.goalItem} ${expanded ? styles.goalExpanded : ""}`}
                onClick={async (e) => {
                  if ((e.target as HTMLElement).closest(`.${styles.runItem}`)) return
                  const next = expanded ? null : g.id
                  setExpandedId(next)
                  if (next) await loadRuns(g.id)
                }}
              >
                <div className={styles.goalText}>{g.text}</div>
                <div className={styles.goalMeta}>{fmtTimeAgo(g.createdAt)}</div>
                {expanded && (
                  <div className={styles.runList}>
                    {!runs && <div style={{ padding: "4px 8px", color: "var(--dim)", fontSize: 11 }}>Loading…</div>}
                    {runs && runs.length === 0 && <div style={{ padding: "4px 8px", color: "var(--dim)", fontSize: 11 }}>No runs</div>}
                    {runs?.map((r) => {
                      const tokStr  = (r.tokenTotal ?? 0) > 0 ? `${(r.tokenTotal ?? 0).toLocaleString()} tok` : ""
                      const durStr  = r.finishedAt ? fmtElapsed(r.finishedAt - r.createdAt) : ""
                      const costStr = (r.costUsd ?? 0) > 0.001 ? `$${(r.costUsd ?? 0).toFixed(3)}` : ""
                      return (
                        <div
                          key={r.id}
                          className={styles.runItem}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSelectGoal(g.text)
                            onClose()
                          }}
                        >
                          <span className={styles.runDot} style={{ background: dotColor(r.status) }} />
                          <span style={{ flex: 1 }}>{fmtTimeAgo(r.createdAt)} · {r.agents}a · {r.status}</span>
                          <span style={{ color: "var(--dim)", fontSize: 10 }}>
                            {[tokStr, durStr, costStr].filter(Boolean).join(" · ")}
                          </span>
                          <button
                            className="btn"
                            style={{ fontSize: 10, padding: "1px 7px", marginLeft: 6, flexShrink: 0 }}
                            onClick={(e) => { e.stopPropagation(); onReplay(r.id, g.text) }}
                          >🔁</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
