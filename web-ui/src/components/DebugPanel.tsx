import { useState, useEffect } from "react"
import styles from "./DebugPanel.module.css"

interface LogEntry { ts: string; line: string; cls: string }

const debugLines: LogEntry[] = []

// Global hook for other modules to push debug entries
export function pushDebug(line: string, cls = "") {
  const ts = new Date().toLocaleTimeString("en-GB", { hour12: false })
  debugLines.push({ ts, line, cls })
  if (debugLines.length > 200) debugLines.shift()
  window.dispatchEvent(new CustomEvent("swarm:debug"))
}

export function DebugPanel() {
  const [visible, setVisible] = useState(false)
  const [lines, setLines]     = useState<LogEntry[]>([])

  useEffect(() => {
    const handler = () => setLines([...debugLines])
    window.addEventListener("swarm:debug", handler)
    return () => window.removeEventListener("swarm:debug", handler)
  }, [])

  return (
    <>
      <button id="debug-toggle" className={styles.toggle} onClick={() => setVisible((v) => !v)}>
        {visible ? "✕ Debug" : "🔍 Debug"}
      </button>
      {visible && (
        <div className={styles.panel}>
          <div className={styles.header}>
            <strong>Debug</strong>
            <button onClick={() => { debugLines.length = 0; setLines([]) }}
              style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", fontSize: 10 }}>
              Clear
            </button>
            <button onClick={() => setVisible(false)}
              style={{ background: "none", border: "none", color: "var(--dim)", cursor: "pointer", fontSize: 11 }}>
              ✕
            </button>
          </div>
          <div className={styles.log}>
            {lines.map((e, i) => (
              <div key={i} className={`${styles.line} ${e.cls === "ok" ? styles.ok : e.cls === "err" ? styles.err : e.cls === "info" ? styles.info : ""}`}>
                {e.ts} {e.line}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
