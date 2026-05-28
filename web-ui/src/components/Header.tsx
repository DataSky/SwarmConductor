import { useState } from "react"
import { useRunStore } from "../store/run"
import { useServeStore } from "../store/serve"
import { wsClient } from "../ws/client"
import { fmtElapsed, fmtEta, fmtNum } from "../utils"
import styles from "./Header.module.css"

export function Header() {
  const status     = useRunStore((s) => s.status)
  const tokenStats = useRunStore((s) => s.tokenStats)
  const tasks      = useRunStore((s) => s.tasks)
  const phaseHist  = useRunStore((s) => s.phaseHistory)
  const runStartMs = useRunStore((s) => s.runStartMs)
  const riskCount  = useRunStore((s) => s.riskCount)
  const lastRisk   = useRunStore((s) => s.lastRisk)
  const goal       = useRunStore((s) => s.goal)
  const wsStatus   = useServeStore((s) => s.wsStatus)
  const project    = useServeStore((s) => s.project)

  const [paused, setPaused] = useState(false)

  const s  = status
  const tk = tokenStats

  const done  = s?.tasks?.done  ?? 0
  const total = s?.tasks?.total ?? 0
  const pct   = total > 0 ? Math.round(done / total * 100) : 0
  const ag    = s?.agents ?? { idle: 0, busy: 0, crashed: 0, total: 0 }
  const tk2   = s?.tasks  ?? { running: 0, ready: 0, blocked: 0, failed: 0 }

  const wallMs  = Date.now() - runStartMs
  const tokRate = tk && wallMs > 5000 ? Math.round(tk.totalTokens / wallMs * 60_000) : 0
  const cost    = tk ? (tk.inputTokens * 15 + tk.outputTokens * 75) / 1_000_000 : 0

  const doneTasks = tasks.filter((t) => t.status === "done" && t.startedAt && t.completedAt)
  let etaMs = 0
  if (doneTasks.length > 0) {
    const avgMs   = doneTasks.reduce((a, t) => a + (t.completedAt! - t.startedAt!), 0) / doneTasks.length
    const remain  = total - done - (s?.tasks?.failed ?? 0)
    const parallel = Math.max(1, ag.busy)
    etaMs = remain > 0 ? (remain / parallel) * avgMs : 0
  }

  const phases = phaseHist.length > 0
    ? phaseHist
    : [{ phase: 0, startMs: runStartMs, endMs: null as number | null }]

  function togglePause() {
    if (paused) { wsClient.send({ type: "resume", tabId: "" }); setPaused(false) }
    else        { wsClient.send({ type: "pause",  tabId: "" }); setPaused(true) }
  }

  return (
    <div className={styles.header}>
      <div className={styles.row1}>
        <span className={styles.brand}>SWARM</span>
        <span className={styles.runId} id="run-id">—</span>

        {project && (
          <span className={styles.projectBadge} title={project}>
            📁 {project.split("/").at(-1)}
          </span>
        )}

        <span className={`badge badge-phase`}>Phase {s?.phase ?? 0}</span>

        <div className={styles.progressBar}>
          <div className={styles.progBar}>
            <div className={styles.progFill} style={{ width: `${pct}%` }} />
          </div>
          <span className={styles.progText}>{done}/{total} ({pct}%)</span>
        </div>

        {riskCount > 0 && (
          <span className="badge badge-risk" title={lastRisk}>⚠ {riskCount} risk</span>
        )}
        {etaMs > 0 && <span className="badge badge-eta">ETA {fmtEta(etaMs)}</span>}
        {cost > 0 && (
          <span className="badge badge-cost">
            {cost >= 0.01 ? `$${cost.toFixed(2)}` : "<$0.01"}
          </span>
        )}

        <button
          className={`btn ${paused ? "btn-resume" : "btn-pause"}`}
          onClick={togglePause}
        >
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>

        <div className={styles.connStatus}>
          <div className={`dot ${wsStatus === "live" ? "dot-live" : "dot-reconnect"}`} />
          <span>{wsStatus === "live" ? "LIVE" : "RECONNECTING…"}</span>
        </div>
      </div>

      <div className={styles.row2}>
        <div className={styles.statsRow}>
          <span className={styles.stat}>agents <span>{ag.idle} idle · {ag.busy} busy</span></span>
          <span className={styles.stat}>tasks <span>run:{tk2.running ?? 0} rdy:{tk2.ready ?? 0} blk:{tk2.blocked ?? 0} fail:{tk2.failed ?? 0}</span></span>
          {tk && tk.totalTokens > 0 && (
            <>
              <span className={styles.stat}>tok <span>{fmtNum(tk.totalTokens)}</span></span>
              {tokRate > 0 && <span className={styles.stat}>tok/min <span>{fmtNum(tokRate)}</span></span>}
              <span className={styles.stat}>cache <span>{tk.cacheHitRate}%</span></span>
            </>
          )}
        </div>

        <div className={styles.phaseTimeline}>
          {phases.map((p) => (
            <span
              key={p.phase}
              className={`${styles.phaseChip} ${p.endMs === null ? styles.active : ""}`}
            >
              {p.endMs === null ? "►" : ""}P{p.phase} {fmtElapsed(p.endMs !== null ? p.endMs - p.startMs : Date.now() - p.startMs)}
            </span>
          ))}
        </div>
      </div>

      {goal && (
        <div className={styles.row3}>
          <span className={styles.goalLabel}>GOAL</span>
          <span className={styles.goalText}>{goal}</span>
        </div>
      )}
    </div>
  )
}
