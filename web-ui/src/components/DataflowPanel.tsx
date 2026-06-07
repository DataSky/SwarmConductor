import { useState, useEffect } from "react"
import styles from "./DataflowPanel.module.css"

// ─── Types ────────────────────────────────────────────────────────────────────

interface TaskSpec {
  key: string
  kind: "sql" | "validate" | "compare" | "llm"
  title: string
  sql: string
  rules: string      // JSON string for validate
  keyColumn: string  // for compare
  prompt: string     // for llm
  dependsOn: string  // comma-separated keys
}

interface TaskResult {
  key: string
  title: string
  kind: string
  status: string
}

interface RunResult {
  runId: string
  status: string
  tasks: TaskResult[]
  artifacts: Record<string, string>
  tokens: { inputTokens: number; outputTokens: number }
  error?: string
}

// ─── Templates ───────────────────────────────────────────────────────────────

const TEMPLATES = {
  sql: (): TaskSpec[] => [
    { key: "query", kind: "sql", title: "SQL 查询", sql: "SELECT * FROM my_table LIMIT 10", rules: "", keyColumn: "", prompt: "", dependsOn: "" },
  ],
  sqlValidate: (): TaskSpec[] => [
    { key: "data", kind: "sql", title: "数据查询", sql: "SELECT region, COUNT(*) n FROM orders GROUP BY region", rules: "", keyColumn: "", prompt: "", dependsOn: "" },
    { key: "check", kind: "validate", title: "数据校验", sql: "", rules: '[{"type":"rowCount","min":1},{"type":"noNulls","column":"region"}]', keyColumn: "", prompt: "", dependsOn: "data" },
  ],
  compare: (): TaskSpec[] => [
    { key: "setA", kind: "sql", title: "数据集 A", sql: "SELECT DISTINCT region FROM orders", rules: "", keyColumn: "", prompt: "", dependsOn: "" },
    { key: "setB", kind: "sql", title: "数据集 B", sql: "SELECT DISTINCT region FROM orders WHERE amount > 500", rules: "", keyColumn: "", prompt: "", dependsOn: "" },
    { key: "diff", kind: "compare", title: "差异对比", sql: "", rules: "", keyColumn: "region", prompt: "", dependsOn: "setA,setB" },
  ],
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function newTask(key = ""): TaskSpec {
  return { key, kind: "sql", title: "", sql: "", rules: '[{"type":"rowCount","min":1}]', keyColumn: "", prompt: "", dependsOn: "" }
}

function taskPrompt(t: TaskSpec): string {
  if (t.kind === "sql")      return t.sql
  if (t.kind === "validate") return t.rules
  if (t.kind === "compare")  return JSON.stringify({ keyColumn: t.keyColumn })
  return t.prompt
}

// ─── Result renderers ─────────────────────────────────────────────────────────

function SqlResult({ content }: { content: string }) {
  const data = (() => { try { return JSON.parse(content) } catch { return null } })()
  if (!data) return <pre className={styles.rawPre}>{content}</pre>
  if (data.error) return <div className={styles.errorMsg}>⚠ {data.error}</div>

  const rows: Record<string, unknown>[] = data.rows ?? []
  if (rows.length === 0) return <div className={styles.emptyMsg}>0 rows returned</div>

  const cols = Object.keys(rows[0] ?? {})
  const truncated: boolean = data.truncated ?? false
  return (
    <div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 50).map((r, i) => (
              <tr key={i}>{cols.map(c => <td key={c}>{String(r[c] ?? "")}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={styles.tableFooter}>
        {data.rowCount} 行{truncated ? "（结果已截断）" : ""}
        {rows.length > 50 ? `，仅显示前 50 行` : ""}
      </div>
    </div>
  )
}

function ValidateResult({ content }: { content: string }) {
  const data = (() => { try { return JSON.parse(content) } catch { return null } })()
  if (!data) return <pre className={styles.rawPre}>{content}</pre>
  const passed: boolean = data.passed ?? false
  const checks: { rule: string; passed: boolean; message?: string }[] = data.checks ?? []
  return (
    <div>
      <div className={passed ? styles.passedBadge : styles.failedBadge}>
        {passed ? "✅ 校验通过" : "❌ 校验失败"}
      </div>
      {checks.map((c, i) => (
        <div key={i} className={`${styles.checkRow} ${c.passed ? styles.checkOk : styles.checkFail}`}>
          {c.passed ? "✓" : "✗"} {c.rule}
          {c.message ? <span className={styles.checkMsg}> — {c.message}</span> : null}
        </div>
      ))}
    </div>
  )
}

function CompareResult({ content }: { content: string }) {
  const data = (() => { try { return JSON.parse(content) } catch { return null } })()
  if (!data) return <pre className={styles.rawPre}>{content}</pre>
  const identical: boolean = data.identical ?? false
  return (
    <div>
      <div className={identical ? styles.passedBadge : styles.warnBadge}>
        {identical ? "✅ 两集合相同" : "⚠ 集合存在差异"}
      </div>
      {(data.onlyInA ?? []).length > 0 && (
        <div className={styles.diffRow}>
          <span className={styles.diffLabel}>仅在 A</span>
          {(data.onlyInA as string[]).map(v => <span key={v} className={styles.diffTag}>{v}</span>)}
        </div>
      )}
      {(data.onlyInB ?? []).length > 0 && (
        <div className={styles.diffRow}>
          <span className={styles.diffLabel}>仅在 B</span>
          {(data.onlyInB as string[]).map(v => <span key={v} className={styles.diffTag}>{v}</span>)}
        </div>
      )}
      {identical && <div className={styles.emptyMsg}>所有 key 均匹配</div>}
    </div>
  )
}

function ArtifactResult({ kind, content }: { kind: string; content: string }) {
  if (kind === "validate") return <ValidateResult content={content} />
  if (kind === "compare")  return <CompareResult content={content} />
  return <SqlResult content={content} />
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function DataflowPanel() {
  const [token, setToken]     = useState(() => localStorage.getItem("swarm_api_token") ?? "")
  const [dbPath, setDbPath]   = useState("")
  const [tasks, setTasks]     = useState<TaskSpec[]>(TEMPLATES.sqlValidate())
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState<RunResult | null>(null)
  const [error, setError]     = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (token) localStorage.setItem("swarm_api_token", token)
  }, [token])

  function updateTask(idx: number, patch: Partial<TaskSpec>) {
    setTasks(ts => ts.map((t, i) => i === idx ? { ...t, ...patch } : t))
  }

  function removeTask(idx: number) {
    setTasks(ts => ts.filter((_, i) => i !== idx))
  }

  function addTask() {
    setTasks(ts => [...ts, newTask(`task${ts.length + 1}`)])
  }

  function applyTemplate(tpl: keyof typeof TEMPLATES) {
    setTasks(TEMPLATES[tpl]())
    setResult(null)
    setError("")
  }

  function toggleExpanded(key: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  async function run() {
    setError("")
    setResult(null)
    if (!token.trim()) { setError("请先输入 API Token（从终端启动日志中复制）"); return }
    if (tasks.length === 0) { setError("请至少添加一个任务"); return }
    for (const t of tasks) {
      if (!t.key.trim()) { setError("每个任务都需要填写 key"); return }
    }

    setLoading(true)
    try {
      const body = {
        db: dbPath.trim() || undefined,
        tasks: tasks.map(t => ({
          key: t.key.trim(),
          kind: t.kind,
          title: t.title || t.key,
          ...(t.kind === "sql"      ? { sql: t.sql }       : {}),
          ...(t.kind === "validate" ? { rules: (() => { try { return JSON.parse(t.rules) } catch { return [] } })() } : {}),
          ...(t.kind === "compare"  ? { keyColumn: t.keyColumn } : {}),
          ...(t.kind === "llm"      ? { prompt: t.prompt }  : {}),
          dependsOn: t.dependsOn.split(",").map(s => s.trim()).filter(Boolean),
        })),
      }
      const resp = await fetch("/api/dataflow/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify(body),
      })
      if (resp.status === 401) {
        setError("Token 错误（401）— 请检查终端启动日志中显示的 token")
        return
      }
      const data = await resp.json() as RunResult & Record<string, unknown>
      if (!resp.ok) {
        setError(data["error"] as string ?? `请求失败 ${resp.status}`)
        return
      }
      setResult(data)
      // auto-expand all results
      setExpanded(new Set(data.tasks.map(t => t.key)))
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const allDone = result?.tasks.every(t => t.status === "done") ?? false
  const anyFailed = result?.tasks.some(t => t.status === "failed") ?? false

  return (
    <div className={styles.panel}>
      {/* ── Config row ────────────────────────────────────────────────── */}
      <div className={styles.configRow}>
        <label className={styles.configItem}>
          <span className={styles.configLabel}>DuckDB 路径</span>
          <input
            className={styles.input}
            placeholder="留空 = 内存数据库（无法运行 sql 任务）"
            value={dbPath}
            onChange={e => setDbPath(e.target.value)}
          />
        </label>
        <label className={styles.configItem} style={{ flex: "0 0 auto", minWidth: 220 }}>
          <span className={styles.configLabel}>API Token</span>
          <input
            className={styles.input}
            type="password"
            placeholder="从终端日志复制 swarm-xxx..."
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </label>
      </div>

      {/* ── Templates ─────────────────────────────────────────────────── */}
      <div className={styles.templateRow}>
        <span className={styles.configLabel}>快速模板：</span>
        <button className={styles.tplBtn} onClick={() => applyTemplate("sql")}>SQL 查询</button>
        <button className={styles.tplBtn} onClick={() => applyTemplate("sqlValidate")}>SQL + 校验</button>
        <button className={styles.tplBtn} onClick={() => applyTemplate("compare")}>两路对比</button>
      </div>

      {/* ── Task list ─────────────────────────────────────────────────── */}
      <div className={styles.taskList}>
        {tasks.map((t, idx) => (
          <div key={idx} className={styles.taskCard}>
            <div className={styles.taskCardHeader}>
              <input
                className={`${styles.input} ${styles.keyInput}`}
                placeholder="key"
                value={t.key}
                onChange={e => updateTask(idx, { key: e.target.value })}
              />
              <select
                className={styles.kindSelect}
                value={t.kind}
                onChange={e => updateTask(idx, { kind: e.target.value as TaskSpec["kind"] })}
              >
                <option value="sql">sql</option>
                <option value="validate">validate</option>
                <option value="compare">compare</option>
                <option value="llm">llm</option>
              </select>
              <input
                className={`${styles.input} ${styles.titleInput}`}
                placeholder="标题（可选）"
                value={t.title}
                onChange={e => updateTask(idx, { title: e.target.value })}
              />
              <input
                className={`${styles.input} ${styles.depsInput}`}
                placeholder="dependsOn（逗号分隔 key）"
                value={t.dependsOn}
                onChange={e => updateTask(idx, { dependsOn: e.target.value })}
              />
              <button className={styles.removeBtn} onClick={() => removeTask(idx)} title="删除">✕</button>
            </div>

            {t.kind === "sql" && (
              <textarea
                className={styles.codeArea}
                placeholder="SELECT ..."
                value={t.sql}
                rows={3}
                onChange={e => updateTask(idx, { sql: e.target.value })}
              />
            )}
            {t.kind === "validate" && (
              <textarea
                className={styles.codeArea}
                placeholder={'[{"type":"rowCount","min":1},{"type":"noNulls","column":"col"}]'}
                value={t.rules}
                rows={3}
                onChange={e => updateTask(idx, { rules: e.target.value })}
              />
            )}
            {t.kind === "compare" && (
              <input
                className={styles.input}
                placeholder="keyColumn（用于对比的主键列名）"
                value={t.keyColumn}
                onChange={e => updateTask(idx, { keyColumn: e.target.value })}
                style={{ marginTop: 6 }}
              />
            )}
            {t.kind === "llm" && (
              <textarea
                className={styles.codeArea}
                placeholder="给 LLM 的指令..."
                value={t.prompt}
                rows={3}
                onChange={e => updateTask(idx, { prompt: e.target.value })}
              />
            )}
          </div>
        ))}
      </div>

      {/* ── Actions ───────────────────────────────────────────────────── */}
      <div className={styles.actions}>
        <button className={styles.addBtn} onClick={addTask}>+ 添加任务</button>
        <button className={styles.runBtn} disabled={loading} onClick={run}>
          {loading ? "⏳ 运行中…" : "▶ 运行 Dataflow"}
        </button>
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}

      {/* ── Results ───────────────────────────────────────────────────── */}
      {result && (
        <div className={styles.results}>
          <div className={styles.resultHeader}>
            <span className={allDone && !anyFailed ? styles.statusOk : styles.statusFail}>
              {allDone && !anyFailed ? "✅ 全部完成" : anyFailed ? "❌ 部分任务失败" : "⚠ 未完成"}
            </span>
            <span className={styles.resultMeta}>
              run: {result.runId.slice(-8)}
              {result.tokens.inputTokens > 0 ? `  ·  ${result.tokens.inputTokens} tok` : "  ·  0 token（纯 worker）"}
            </span>
          </div>

          {result.tasks.map(t => {
            const art = result.artifacts[t.key]
            const isExpanded = expanded.has(t.key)
            const statusIcon = t.status === "done" ? "✅" : t.status === "failed" ? "❌" : "⏸"
            return (
              <div key={t.key} className={styles.resultCard}>
                <div
                  className={styles.resultCardHeader}
                  onClick={() => art && toggleExpanded(t.key)}
                  style={{ cursor: art ? "pointer" : "default" }}
                >
                  <span>{statusIcon}</span>
                  <span className={styles.resultKey}>{t.key}</span>
                  <span className={styles.resultKindBadge}>{t.kind}</span>
                  <span className={styles.resultTitle}>{t.title !== t.key ? t.title : ""}</span>
                  {art && <span className={styles.expandHint}>{isExpanded ? "▲ 收起" : "▼ 展开"}</span>}
                </div>
                {isExpanded && art && (
                  <div className={styles.resultBody}>
                    <ArtifactResult kind={t.kind} content={art} />
                  </div>
                )}
                {t.status === "failed" && !art && (
                  <div className={styles.errorMsg}>任务执行失败</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
