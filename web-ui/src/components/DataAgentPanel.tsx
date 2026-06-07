import { useState, useEffect, useRef } from "react"
import type React from "react"
import styles from "./DataAgentPanel.module.css"

// ─── Types from backend ───────────────────────────────────────────────────────

type WikiPage = { path: string; title: string; stability: string; score: number }

type SseEvent =
  | { type: "thinking";   text: string }
  | { type: "tool_call";  name: string; input: Record<string, unknown>; callId: string }
  | { type: "tool_result"; callId: string; name: string; result: unknown }
  | { type: "wiki_result"; callId: string; pages: WikiPage[]; warnings: string[]; checklist: string }
  | { type: "chart";      callId: string; echartsOption: Record<string, unknown>; title: string }
  | { type: "python_img"; callId: string; images: string[]; output: string }
  | { type: "answer";     markdown: string }
  | { type: "error";      message: string }
  | { type: "done" }

// ─── Step display model ────────────────────────────────────────────────────────

interface Step {
  id: string
  kind: "thinking" | "tool_call" | "wiki" | "chart" | "python" | "answer" | "error"
  label: string
  detail?: string
  result?: unknown
  wikiPages?: WikiPage[]
  wikiWarnings?: string[]
  wikiChecklist?: string
  chart?: Record<string, unknown>
  images?: string[]
  pyOutput?: string
  status: "running" | "done" | "error"
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toolLabel(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case "explore_schema":
      return input.table ? `查看表结构: ${input.table}` : "列出所有表"
    case "search_wiki":
      return `知识库检索: ${(input.queries as string[]).join(" | ")}`
    case "run_sql":
      return `执行SQL: ${input.label ?? ""}`
    case "make_chart":
      return `生成图表: ${input.title ?? ""}`
    case "run_python":
      return `Python分析: ${input.label ?? ""}`
    default:
      return name
  }
}

function renderMarkdown(md: string): string {
  // Very simple markdown → HTML (for the final report)
  return md
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>")
}

function SqlTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (!rows.length) return <div className={styles.emptyMsg}>无数据</div>
  const cols = Object.keys(rows[0]!)
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.slice(0, 20).map((r, i) => (
            <tr key={i}>{cols.map(c => <td key={c}>{String(r[c] ?? "")}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 && <div className={styles.tableFooter}>显示前20行，共{rows.length}行</div>}
    </div>
  )
}

// ─── ECharts renderer ──────────────────────────────────────────────────────────

function EChart({ option }: { option: Record<string, unknown> }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ref.current) return
    let chart: { setOption: (o: unknown) => void; dispose: () => void } | null = null

    // Load ECharts from CDN lazily
    const loadECharts = async () => {
      // @ts-ignore
      if (window.__echarts) {
        // @ts-ignore
        chart = window.__echarts.init(ref.current, "dark")
        chart!.setOption({ ...option, backgroundColor: "transparent" })
        return
      }
      // Try to load from script tag
      const existing = document.querySelector('script[data-echarts]')
      if (!existing) {
        const s = document.createElement("script")
        s.src = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"
        s.setAttribute("data-echarts", "1")
        s.onload = () => {
          // @ts-ignore
          window.__echarts = (window as Record<string, unknown>).echarts as typeof window.__echarts
          if (ref.current) {
            // @ts-ignore
            chart = window.__echarts.init(ref.current, "dark")
            chart!.setOption({ ...option, backgroundColor: "transparent" })
          }
        }
        document.head.appendChild(s)
      } else {
        // Script already loading, poll
        const poll = setInterval(() => {
          // @ts-ignore
          if ((window as Record<string, unknown>).echarts) {
            clearInterval(poll)
            // @ts-ignore
            window.__echarts = (window as Record<string, unknown>).echarts as typeof window.__echarts
            if (ref.current) {
              // @ts-ignore
              chart = window.__echarts.init(ref.current, "dark")
              chart!.setOption({ ...option, backgroundColor: "transparent" })
            }
          }
        }, 100)
      }
    }
    loadECharts()

    return () => { chart?.dispose() }
  }, [option])

  return <div ref={ref} style={{ width: "100%", height: 280 }} />
}

// ─── Step card ─────────────────────────────────────────────────────────────────

function StepCard({ step }: { step: Step }) {
  const [expanded, setExpanded] = useState(step.kind === "answer" || step.kind === "chart")

  const headerIcon = {
    thinking: "💭",
    tool_call: "⚙️",
    wiki: "📚",
    chart: "📊",
    python: "🐍",
    answer: "📝",
    error: "❌",
  }[step.kind]

  const statusDot = step.status === "running"
    ? <span className={styles.spinnerDot} />
    : step.status === "error"
    ? <span className={styles.errorDot} />
    : null

  return (
    <div className={`${styles.stepCard} ${step.kind === "answer" ? styles.stepAnswer : ""} ${step.kind === "error" ? styles.stepError : ""}`}>
      <div
        className={styles.stepHeader}
        onClick={() => setExpanded(e => !e)}
        style={{ cursor: step.kind !== "thinking" ? "pointer" : "default" }}
      >
        <span className={styles.stepIcon}>{headerIcon}</span>
        <span className={styles.stepLabel}>{step.label}</span>
        {statusDot}
        {step.kind !== "thinking" && step.kind !== "answer" && step.kind !== "error" && (
          <span className={styles.expandHint}>{expanded ? "▲" : "▼"}</span>
        )}
      </div>

      {/* Always-visible body for answer/error/thinking */}
      {step.kind === "thinking" && step.detail && (
        <div className={styles.thinkingText}>{step.detail}</div>
      )}

      {step.kind === "error" && step.detail && (
        <div className={styles.errorText}>{step.detail}</div>
      )}

      {step.kind === "answer" && step.detail && (
        <div
          className={styles.answerBody}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(step.detail) }}
        />
      )}

      {/* Collapsible body for wiki/chart/python/tool */}
      {expanded && step.kind === "wiki" && step.wikiPages && (
        <div className={styles.stepBody}>
          {step.wikiWarnings && step.wikiWarnings.length > 0 && (
            <div className={styles.wikiWarning}>
              {step.wikiWarnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
            </div>
          )}
          <div className={styles.wikiPageList}>
            {step.wikiPages.map((p, i) => (
              <div key={i} className={styles.wikiPageRow}>
                <span className={styles.wikiStability}>{p.stability || "—"}</span>
                <span className={styles.wikiPath}>{p.path.replace("wiki/", "")}</span>
                <span className={styles.wikiTitle}>{p.title}</span>
                <span className={styles.wikiScore}>{p.score.toFixed(1)}</span>
              </div>
            ))}
          </div>
          {step.wikiChecklist && (
            <details className={styles.wikiChecklist}>
              <summary>Checklist</summary>
              <pre>{step.wikiChecklist}</pre>
            </details>
          )}
        </div>
      )}

      {expanded && step.kind === "chart" && step.chart && (
        <div className={styles.stepBody}>
          <EChart option={step.chart as Record<string, unknown>} />
        </div>
      )}

      {expanded && step.kind === "python" && (
        <div className={styles.stepBody}>
          {step.images?.map((img, i) => (
            <img key={i} src={img} alt="chart" className={styles.pyImage} />
          ))}
          {step.pyOutput && <pre className={styles.pyOutput}>{step.pyOutput}</pre>}
        </div>
      )}

      {expanded && step.kind === "tool_call" && step.result != null && renderToolResult(step.result, styles)}
    </div>
  )
}

function renderToolResult(result: unknown, styles: Record<string, string>): React.ReactNode {
  const r = result as Record<string, unknown>
  if (r.rows && Array.isArray(r.rows)) {
    return (
      <div className={styles.stepBody}>
        <SqlTable rows={r.rows as Record<string, unknown>[]} />
        <div className={styles.tableFooter}>
          共 {r.rowCount as number} 行{r.truncated ? "（已截断）" : ""}
        </div>
      </div>
    )
  }
  if (r.tables) {
    return (
      <div className={styles.stepBody}>
        <div className={styles.tableList}>
          {(r.tables as string[]).map(t => <span key={t} className={styles.tableTag}>{t}</span>)}
        </div>
      </div>
    )
  }
  if (r.columns) {
    return (
      <div className={styles.stepBody}>
        {(r.columns as { name: string; type: string }[]).map(c => (
          <div key={c.name} className={styles.colRow}>
            <span className={styles.colName}>{c.name}</span>
            <span className={styles.colType}>{c.type}</span>
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className={styles.stepBody}>
      <pre className={styles.rawPre}>{JSON.stringify(r, null, 2)}</pre>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function DataAgentPanel() {
  const [token, setToken]     = useState(() => localStorage.getItem("swarm_api_token") ?? "")
  const [dbPath, setDbPath]   = useState("")
  const [question, setQuestion] = useState("")
  const [steps, setSteps]     = useState<Step[]>([])
  const [running, setRunning] = useState(false)
  const [error, setError]     = useState("")
  const stepsRef              = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (token) localStorage.setItem("swarm_api_token", token)
  }, [token])

  const EXAMPLES = [
    "分析各地区的销售额分布，找出TOP 3地区并可视化",
    "统计每月订单数量趋势，判断是否有增长",
    "找出最畅销的产品类别，分析其利润率",
    "对比不同用户群体的消费行为差异",
  ]

  async function run() {
    if (!question.trim()) { setError("请输入分析问题"); return }
    if (!token.trim()) { setError("请先输入 API Token"); return }

    setError("")
    setSteps([])
    setRunning(true)

    const resp = await fetch("/api/dataagent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify({ question: question.trim(), dbPath: dbPath.trim() || undefined }),
    })

    if (resp.status === 401) {
      setError("Token 错误（401）")
      setRunning(false)
      return
    }
    if (!resp.ok || !resp.body) {
      setError(`请求失败 ${resp.status}`)
      setRunning(false)
      return
    }

    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const callIdToStepId = new Map<string, string>()

    const addStep = (s: Omit<Step, "id">): string => {
      const id = `step-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`
      setSteps(prev => [...prev, { ...s, id }])
      return id
    }

    const updateStep = (id: string, patch: Partial<Step>) => {
      setSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split("\n")
      buf = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        let event: SseEvent
        try { event = JSON.parse(line.slice(6)) as SseEvent } catch { continue }

        switch (event.type) {
          case "thinking": {
            addStep({ kind: "thinking", label: "分析中…", detail: event.text, status: "done" })
            break
          }
          case "tool_call": {
            const sid = addStep({
              kind: event.name === "search_wiki" ? "wiki" : "tool_call",
              label: toolLabel(event.name, event.input),
              status: "running",
            })
            callIdToStepId.set(event.callId, sid)
            break
          }
          case "tool_result": {
            const sid = callIdToStepId.get(event.callId)
            if (sid) updateStep(sid, { result: event.result, status: "done" })
            break
          }
          case "wiki_result": {
            const sid = callIdToStepId.get(event.callId)
            if (sid) {
              updateStep(sid, {
                kind: "wiki",
                wikiPages: event.pages,
                wikiWarnings: event.warnings,
                wikiChecklist: event.checklist,
                label: `知识库: 召回 ${event.pages.length} 页${event.warnings.length > 0 ? " ⚠️" : ""}`,
                status: "done",
              })
            }
            break
          }
          case "chart": {
            const sid = callIdToStepId.get(event.callId)
            if (sid) {
              updateStep(sid, { kind: "chart", label: `图表: ${event.title}`, chart: event.echartsOption, status: "done" })
            } else {
              addStep({ kind: "chart", label: `图表: ${event.title}`, chart: event.echartsOption, status: "done" })
            }
            break
          }
          case "python_img": {
            const sid = callIdToStepId.get(event.callId)
            if (sid) {
              updateStep(sid, { kind: "python", images: event.images, pyOutput: event.output, status: "done" })
            }
            break
          }
          case "answer": {
            addStep({ kind: "answer", label: "分析报告", detail: event.markdown, status: "done" })
            break
          }
          case "error": {
            addStep({ kind: "error", label: "出错", detail: event.message, status: "error" })
            break
          }
          case "done": {
            setRunning(false)
            break
          }
        }

        // Auto-scroll
        setTimeout(() => {
          stepsRef.current?.lastElementChild?.scrollIntoView({ behavior: "smooth" })
        }, 50)
      }
    }
    setRunning(false)
  }

  return (
    <div className={styles.panel}>
      {/* ── Config ──────────────────────────────────────────────────────── */}
      <div className={styles.configRow}>
        <label className={styles.configItem}>
          <span className={styles.configLabel}>DuckDB 数据库路径</span>
          <input
            className={styles.input}
            placeholder="/path/to/your.duckdb（留空则无数据）"
            value={dbPath}
            onChange={e => setDbPath(e.target.value)}
          />
        </label>
        <label className={styles.configItem} style={{ flex: "0 0 auto", minWidth: 220 }}>
          <span className={styles.configLabel}>API Token</span>
          <input
            className={styles.input}
            type="password"
            placeholder="swarm-xxx（启动时打印）"
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </label>
      </div>

      {/* ── Question input ───────────────────────────────────────────────── */}
      <div className={styles.questionRow}>
        <textarea
          className={styles.questionInput}
          placeholder="用自然语言描述你的数据分析需求…&#10;例如：分析各地区销售额，找出增长最快的区域并可视化"
          value={question}
          rows={3}
          onChange={e => setQuestion(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !running) run() }}
        />
        <button
          className={styles.runBtn}
          disabled={running}
          onClick={run}
        >
          {running ? <><span className={styles.spinner} />分析中</> : "▶ 开始分析"}
        </button>
      </div>

      {/* ── Example questions ────────────────────────────────────────────── */}
      {steps.length === 0 && !running && (
        <div className={styles.examples}>
          <span className={styles.configLabel}>示例问题：</span>
          <div className={styles.exampleList}>
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                className={styles.exampleBtn}
                onClick={() => setQuestion(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && <div className={styles.errorBanner}>{error}</div>}

      {/* ── Steps ────────────────────────────────────────────────────────── */}
      <div className={styles.steps} ref={stepsRef}>
        {steps.map(step => <StepCard key={step.id} step={step} />)}
        {running && steps.length === 0 && (
          <div className={styles.initialLoader}>
            <span className={styles.spinner} /> 正在连接 DataAgent…
          </div>
        )}
      </div>
    </div>
  )
}
