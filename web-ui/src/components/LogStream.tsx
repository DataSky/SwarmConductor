import { useRef, useEffect, useState } from "react"
import { useRunStore } from "../store/run"
import styles from "./LogStream.module.css"

function lineClass(line: string): string {
  if (line.startsWith("✓"))  return styles.done ?? ""
  if (line.startsWith("✗"))  return styles.fail ?? ""
  if (line.startsWith("⟳"))  return styles.running ?? ""
  if (line.startsWith("⊕"))  return styles.dynamic ?? ""
  if (line.startsWith("⏸"))  return styles.paused ?? ""
  return ""
}

export function LogStream() {
  const log         = useRunStore((s) => s.log)
  const finalReport = useRunStore((s) => s.finalReport)
  const tasks       = useRunStore((s) => s.tasks)
  const [tab, setTab] = useState<"log" | "results">("log")
  const bodyRef     = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)

  // Auto-scroll log to bottom when new lines arrive
  useEffect(() => {
    const el = bodyRef.current
    if (!el || tab !== "log") return
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [log.length, tab])

  return (
    <div className="pane" id="log-pane">
      <div className="pane-header" style={{ padding: 0 }}>
        <button className={`tab-btn ${tab === "log" ? "active" : ""}`} onClick={() => setTab("log")}>Log</button>
        <button className={`tab-btn ${tab === "results" ? "active" : ""}`} onClick={() => setTab("results")}>Results</button>
        <button className="btn" style={{ fontSize: 10, padding: "1px 6px" }}
          onClick={() => useRunStore.setState({ log: [] })}>Clear</button>
      </div>

      {/* Log tab */}
      <div
        className="pane-body"
        ref={bodyRef}
        style={{ display: tab === "log" ? "" : "none" }}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottomRef.current = el.scrollTop + el.clientHeight > el.scrollHeight - 40
        }}
      >
        <div className={styles.logBody}>
          {log.map((line, i) => (
            <div key={i} className={`${styles.logLine} ${lineClass(line)}`}>{line}</div>
          ))}
        </div>
      </div>

      {/* Results tab */}
      <div className="pane-body" style={{ display: tab === "results" ? "" : "none" }}>
        <ResultsPanel finalReport={finalReport} tasks={tasks} />
      </div>
    </div>
  )
}

function ResultsPanel({
  finalReport,
  tasks,
}: {
  finalReport: ReturnType<typeof useRunStore.getState>["finalReport"]
  tasks: ReturnType<typeof useRunStore.getState>["tasks"]
}) {
  const report   = finalReport as Record<string, unknown> | null
  const summaries: Array<Record<string, unknown>> = report
    ? (report["summaries"] as Array<Record<string, unknown>>) ?? []
    : tasks.filter((t) => t.status === "done" && t.output).map((t) => ({
        id: t.id, title: t.title, type: t.type,
        summary: t.output?.summary ?? "",
        risks: t.output?.risks ?? [],
        blockers: t.output?.blockers ?? [],
        durationMs: t.startedAt && t.completedAt ? t.completedAt - t.startedAt : null,
        tokenUsage: t.tokenUsage,
      }))

  if (!summaries.length) {
    return <div style={{ padding: 16, color: "var(--dim)", fontSize: 12 }}>No completed tasks yet.</div>
  }

  const tk = report?.["tokenStats"] as Record<string, number> | null
  const errors = report?.["errors"] as Array<{ title: string; error: string }> | null

  return (
    <div>
      {report && (
        <div className={styles.summaryBar}>
          <span style={{ color: "var(--green)" }}>✓ {(report["tasks"] as Record<string,number>)?.["done"] ?? 0} done</span>
          {((report["tasks"] as Record<string,number>)?.["failed"] ?? 0) > 0 && (
            <span style={{ color: "var(--red)" }}>✗ {String((report["tasks"] as Record<string,number>)?.["failed"] ?? 0)} failed</span>
          )}
          <span style={{ color: "var(--dim)" }}>/ {String((report["tasks"] as Record<string,number> | undefined)?.["total"] ?? 0)} total</span>
          {tk && (tk["totalTokens"] ?? 0) > 0 && <span style={{ color: "var(--yellow)" }}>{Number(tk["totalTokens"] ?? 0).toLocaleString()} tok</span>}
          {tk && (tk["cacheHitRate"] ?? 0) > 0 && <span style={{ color: "var(--green)" }}>{String(tk["cacheHitRate"])}% cache</span>}
        </div>
      )}
      {errors?.map((e, i) => (
        <div key={i} className={styles.resultError}>✗ <strong>{e.title}</strong>: {e.error ?? "unknown error"}</div>
      ))}
      {summaries.map((t, i) => {
        const summary  = (t["summary"] as string) ?? ""
        const risks    = (t["risks"]   as string[]) ?? []
        const blockers = (t["blockers"] as string[]) ?? []
        const tokU     = t["tokenUsage"] as Record<string, number> | null
        return (
          <div key={i} className={styles.resultCard}>
            <div className={styles.cardHeader}>
              <span className="task-type-tag" style={{ fontSize: 10, color: "var(--dim)", background: "var(--bg3)", padding: "1px 5px", borderRadius: 3 }}>
                {String(t["type"] ?? "").slice(0, 3) || "?"}
              </span>
              <span className={styles.cardTitle}>{String(t["title"] ?? "")}</span>
              {t["durationMs"] != null && <span className={styles.cardDur}>{fmtElapsed(Number(t["durationMs"]))}</span>}
              {tokU && <span className={styles.cardTok}>{((tokU["inputTokens"] ?? 0) + (tokU["outputTokens"] ?? 0)).toLocaleString()} tok</span>}
            </div>
            {summary && <div className={styles.cardSummary}>{(summary.split("\n")[0] ?? "").slice(0, 150)}</div>}
            {risks.filter((r) => /\b(critical|high|severe|security)\b/i.test(r)).slice(0, 2).map((r, ri) => (
              <div key={ri} className={styles.riskItem}>▲ {r.trim().slice(0, 100)}</div>
            ))}
            {blockers.slice(0, 1).map((b, bi) => (
              <div key={bi} className={styles.blocker}>✗ {b.trim().slice(0, 100)}</div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

function fmtElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}
