import { useWebSocket } from "./hooks/useWebSocket"
import { useServeStore } from "./store/serve"
import { useRunStore } from "./store/run"

// ── Connection status badge ────────────────────────────────────────────────────

function ConnBadge() {
  const wsStatus = useServeStore((s) => s.wsStatus)
  const color = wsStatus === "live" ? "#4ec9b0" : "#f0a030"
  const label = wsStatus === "live" ? "LIVE" : "RECONNECTING…"
  return (
    <span style={{ fontSize: 11, color, fontFamily: "monospace" }}>
      ● {label}
    </span>
  )
}

// ── Placeholder while full component migration is in progress ─────────────────

function MigrationNotice() {
  const project = useServeStore((s) => s.project)
  const tabs     = useServeStore((s) => s.tabs)
  const tasks    = useRunStore((s) => s.tasks)
  const log      = useRunStore((s) => s.log)
  const planning = useRunStore((s) => s.planningElapsedMs)

  return (
    <div style={{
      fontFamily: "monospace", fontSize: 13,
      background: "#1e1e1e", color: "#d4d4d4",
      minHeight: "100vh", padding: "24px 32px",
    }}>
      <div style={{ marginBottom: 16, display: "flex", gap: 16, alignItems: "center" }}>
        <strong style={{ fontSize: 16, color: "#4ec9b0" }}>SWARM</strong>
        <ConnBadge />
        {project && (
          <span style={{ color: "#888", fontSize: 11 }}>
            📁 {project.split("/").slice(-1)[0]} ({project})
          </span>
        )}
      </div>

      {planning !== null && (
        <div style={{ color: "#f0a030", marginBottom: 12 }}>
          ⏳ AI规划中… {(planning / 1000).toFixed(0)}s
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <strong>Tabs ({tabs.length}):</strong>{" "}
        {tabs.map((t) => (
          <span key={t.tabId} style={{ marginRight: 8, color: t.status === "running" ? "#4ec9b0" : "#888" }}>
            [{t.status}] {t.goalText.slice(0, 40)}
          </span>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        <strong>Tasks ({tasks.length}):</strong>{" "}
        {tasks.map((t) => (
          <span key={t.id} style={{ marginRight: 8, color: t.status === "done" ? "#4ec9b0" : t.status === "running" ? "#f0a030" : "#888" }}>
            [{t.status}] {t.title.slice(0, 30)}
          </span>
        ))}
      </div>

      <div>
        <strong>Log (last 10):</strong>
        <pre style={{ margin: "4px 0 0", color: "#ccc", fontSize: 11 }}>
          {log.slice(-10).join("\n")}
        </pre>
      </div>

      <div style={{ marginTop: 24, color: "#555", fontSize: 11 }}>
        ⚙️ React frontend migration in progress — full UI coming in phase 2.
        <br />
        WebSocket connection and state management are live.
      </div>
    </div>
  )
}

// ── Root ───────────────────────────────────────────────────────────────────────

export default function App() {
  useWebSocket()   // Mount once: connects WS, routes messages to stores
  return <MigrationNotice />
}
