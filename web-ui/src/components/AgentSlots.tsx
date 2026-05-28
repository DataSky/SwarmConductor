import { useState, useRef, useEffect } from "react"
import { useRunStore } from "../store/run"
import { wsClient } from "../ws/client"
import { TYPE_SHORT, shortModel, fmtElapsed } from "../utils"
import styles from "./AgentSlots.module.css"

// Per-agent stream buffers — kept outside React state to avoid re-render on every token
const streamBufs: Record<string, string> = {}

export function AgentSlots() {
  const agents    = useRunStore((s) => s.agents)
  const status    = useRunStore((s) => s.status)
  const idleCount = status?.agents?.idle ?? 0
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [, forceUpdate] = useState(0)

  // Subscribe to delta messages to update stream buffers
  useEffect(() => {
    return wsClient.subscribe((msg) => {
      if (msg.type !== "delta") return
      if (!streamBufs[msg.agentId]) streamBufs[msg.agentId] = ""
      streamBufs[msg.agentId] = (streamBufs[msg.agentId] + msg.text).slice(-32768)
      // Only force update if this agent is expanded (avoid re-rendering all agents on each token)
      if (expandedId === msg.agentId) forceUpdate((n) => n + 1)
    })
  }, [expandedId])

  return (
    <div className="pane" id="agent-pane">
      <div className="pane-header">
        Agents
        <span style={{ color: "var(--dim)", fontWeight: "normal", fontSize: 11 }}>
          {agents.length} busy{idleCount > 0 ? ` · ${idleCount} idle` : ""}
        </span>
      </div>
      <div className="pane-body">
        {agents.map((slot) => {
          const expanded  = expandedId === slot.agentId
          const dur       = fmtElapsed(Date.now() - slot.startedAt)
          const mShort    = shortModel(slot.model)
          const scopeStr  = slot.scope.map((s) => s.split("/").slice(-2).join("/")).join(", ")
          const stream    = streamBufs[slot.agentId] ?? ""

          return (
            <AgentCard
              key={slot.agentId}
              agentId={slot.agentId}
              title={slot.title}
              type={slot.type}
              dur={dur}
              mShort={mShort}
              scopeStr={scopeStr}
              lastLine={slot.lastLine}
              stream={stream}
              expanded={expanded}
              onToggle={() => setExpandedId(expanded ? null : slot.agentId)}
              onInterrupt={() => wsClient.send({ type: "interrupt", tabId: "", agentId: slot.agentId })}
            />
          )
        })}
        {idleCount > 0 && (
          <div className={styles.idle}>◌ {idleCount} agent{idleCount > 1 ? "s" : ""} idle</div>
        )}
      </div>
    </div>
  )
}

interface AgentCardProps {
  agentId: string; title: string; type: string
  dur: string; mShort: string; scopeStr: string
  lastLine: string; stream: string
  expanded: boolean; onToggle: () => void; onInterrupt: () => void
}

function AgentCard({ agentId, title, type, dur, mShort, scopeStr, lastLine, stream, expanded, onToggle, onInterrupt }: AgentCardProps) {
  const streamRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!expanded || !streamRef.current) return
    const el = streamRef.current
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (atBottom) el.scrollTop = el.scrollHeight
  })

  return (
    <div
      className={`${styles.card} ${expanded ? styles.expanded : ""}`}
      data-agent-id={agentId}
      onClick={onToggle}
    >
      <div className={styles.header}>
        <span className={styles.dot}>●</span>
        <span className={styles.typeTag}>{TYPE_SHORT[type] ?? type.slice(0, 3)}</span>
        <span className={styles.title}>{title}</span>
        {mShort && <span className={styles.model}>{mShort}</span>}
        <span className={styles.elapsed}>{dur}</span>
      </div>
      {scopeStr && (
        <div className={styles.meta}><span className={styles.scope}>{scopeStr}</span></div>
      )}
      {lastLine && <div className={styles.lastLine}>{lastLine}</div>}
      {expanded && (
        <>
          <pre ref={streamRef} className={styles.stream}>
            {stream.slice(-4096)}
          </pre>
          <div className={styles.interruptWrap}>
            <button
              className="btn btn-danger"
              style={{ fontSize: 11, padding: "2px 8px" }}
              onClick={(e) => { e.stopPropagation(); onInterrupt() }}
            >
              ✗ Interrupt
            </button>
          </div>
        </>
      )}
    </div>
  )
}
