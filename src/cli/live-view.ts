import { createInterface } from "readline"
import type { Conductor } from "../conductor"
import type { TaskNode } from "../dag/types"
import { createTaskNode } from "../dag/engine"

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",  bold:  "\x1b[1m",  dim:   "\x1b[2m",
  green:   "\x1b[32m", yellow:"\x1b[33m", red:   "\x1b[31m",
  cyan:    "\x1b[36m", blue:  "\x1b[34m", magenta:"\x1b[35m",
  gray:    "\x1b[90m", bgDark:"\x1b[48;5;235m", bgMid:"\x1b[48;5;237m",
  white:   "\x1b[97m",
}

const STATUS_ICON: Record<string, string> = {
  done:        `${C.green}✓${C.reset}`,
  running:     `${C.cyan}⟳${C.reset}`,
  ready:       `${C.blue}○${C.reset}`,
  blocked:     `${C.dim}·${C.reset}`,
  failed:      `${C.red}✗${C.reset}`,
  interrupted: `${C.yellow}!${C.reset}`,
  pending:     `${C.dim}·${C.reset}`,
}

const TYPE_SHORT: Record<string, string> = {
  explore: "exp", plan: "pln", implement: "imp",
  review: "rev", verify: "vfy", merge: "mrg",
}

const MODEL_SHORT: Record<string, string> = {
  "deepseek-v4-pro":               "dv4p",
  "deepseek-v4-flash":             "dv4f",
  "deepseek-v3":                   "dv3",
  "deepseek-reasoner":             "r1",
  "claude-opus-4-7":               "opus",
  "claude-sonnet-4-6":             "son",
  "claude-haiku-4-5-20251001":     "hku",
  "gpt-4.1":                       "g41",
  "gpt-4.1-mini":                  "g4m",
  "gpt-4o":                        "4o",
  "gemini-2.5-pro":                "g25p",
}

function modelShort(model: string | null | undefined): string {
  if (!model) return ""
  return MODEL_SHORT[model] ?? model.split(/[-/]/).slice(-1)[0]!.slice(0, 5)
}

export type VerboseLevel = "quiet" | "summary" | "stream"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function bar(done: number, total: number, width = 18): string {
  if (total === 0) return `${C.dim}${"░".repeat(width)}${C.reset}`
  const filled = Math.round((done / total) * width)
  return `${C.green}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(width - filled)}${C.reset}`
}

function elapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function etaStr(ms: number): string {
  if (ms <= 0) return "–"
  if (ms < 60_000) return `~${Math.round(ms / 1000)}s`
  return `~${Math.ceil(ms / 60_000)}m`
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[^m]*m/g, "")
}

function pad(s: string, w: number): string {
  const len = stripAnsi(s).length
  return len < w ? s + " ".repeat(w - len) : s
}

function trunc(s: string, w: number): string {
  if (stripAnsi(s).length <= w) return s
  // trim visible chars preserving ANSI escape codes
  let vis = 0, idx = 0
  while (idx < s.length && vis < w - 1) {
    if (s[idx] === "\x1b") { while (idx < s.length && s[idx] !== "m") idx++; idx++ }
    else { vis++; idx++ }
  }
  return s.slice(0, idx) + C.reset + "…"
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const HEADER_ROWS  = 3   // 3-row header (progress / agents / phase timeline)
const FOOTER_ROWS  = 2
const MIN_LOG_H    = 4

// ─── AgentSlot ────────────────────────────────────────────────────────────────

interface AgentSlot {
  taskId:     string
  title:      string
  type:       string
  scope:      string[]
  startedAt:  number
  lastLine:   string
  model:      string | null
  tokenUsage: { input: number; output: number } | null
}

// ─── PhaseRecord ──────────────────────────────────────────────────────────────

interface PhaseRecord {
  phase:   number
  startMs: number
  endMs:   number | null
}

// ─── LiveView ─────────────────────────────────────────────────────────────────

export class LiveView {
  private conductor:  Conductor
  private verbose:    VerboseLevel
  private slots       = new Map<string, AgentSlot>()      // agentId → slot
  private log:        string[] = []
  private maxLog      = 500
  private tokBuf      = new Map<string, string>()          // agentId → partial line buffer

  // Terminal geometry (recalculated on resize)
  private tw = process.stdout.columns || 120
  private th = process.stdout.rows    || 30

  // Column widths (three-pane layout)
  private lw  = 0   // left  (tasks)
  private mw  = 0   // mid   (agents)
  // rw = tw - lw - mw - 4 divider chars

  // Stability guards
  private isTUI     = false
  private rendering = false
  private leftDirty = false
  private logDirty  = false
  private tick: ReturnType<typeof setInterval> | null = null
  private rl:   ReturnType<typeof createInterface> | null = null
  private exitHandlers: Array<() => void> = []

  // Pause / intervention state
  private paused     = false
  private pauseInput = false  // true while readline prompt is active

  // Run-level state
  private runStartMs   = 0
  private riskCount    = 0
  private lastRisk     = ""
  private phaseHistory: PhaseRecord[] = []

  constructor(conductor: Conductor, verbose: VerboseLevel = "summary") {
    this.conductor = conductor
    this.verbose   = verbose
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    this.runStartMs = Date.now()
    this.recalcGeometry()
    this.isTUI = !!process.stdout.isTTY && this.tw >= 60

    const cleanup   = () => { this.stop() }
    const onUncaught = (err: unknown) => { this.stop(); console.error("\n[swarm] uncaught:", err); process.exit(1) }
    process.on("SIGINT",  cleanup)
    process.on("SIGTERM", cleanup)
    process.on("uncaughtException", onUncaught)
    this.exitHandlers = [
      () => process.off("SIGINT",  cleanup),
      () => process.off("SIGTERM", cleanup),
      () => process.off("uncaughtException", onUncaught),
    ]

    process.stdout.on("resize", () => {
      this.recalcGeometry()
      this.isTUI = !!process.stdout.isTTY && this.tw >= 60
      this.fullRedraw()
    })

    this.conductor.onStream((agentId, task, delta, model) => this.handleDelta(agentId, task, delta, model))
    this.conductor.onEvent(e => this.handleEvent(e.kind, e.payload))

    // Raw keypress for pause key — only in TUI mode with a real TTY
    if (this.isTUI && process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding("utf8")
      process.stdin.on("data", this.onKeypress)
    }

    this.fullRedraw()
    this.tick = setInterval(() => {
      if (this.leftDirty || this.logDirty) this.flushDirty()
      else if (this.isTUI) {
        // Always refresh left+mid pane (elapsed timers)
        this.leftDirty = true
        this.flushDirty()
      }
    }, 500)
  }

  stop(): void {
    if (this.tick) { clearInterval(this.tick); this.tick = null }
    this.rl?.close()
    for (const off of this.exitHandlers) off()
    this.exitHandlers = []
    if (process.stdin.isTTY) {
      process.stdin.off("data", this.onKeypress)
      try { process.stdin.setRawMode(false) } catch { /* ok */ }
    }
    if (this.isTUI) process.stdout.write(`\x1b[?25h\x1b[${this.th};0H\n`)
  }

  // Arrow function so `this` is bound when used as event listener
  private onKeypress = (key: string): void => {
    // Ctrl+C → always clean up
    if (key === "") { this.stop(); process.exit(0) }
    // p → toggle pause (ignore if a readline prompt is already active)
    if ((key === "p" || key === "P") && !this.pauseInput) {
      this.togglePause()
    }
  }

  private togglePause(): void {
    if (!this.paused) {
      this.paused = true
      this.conductor.stopScheduler()
      this.pushLog(`${C.yellow}⏸  PAUSED — scheduler stopped${C.reset}`)
      this.renderFooter()
      this.promptIntervention()
    }
    // resume is handled at the end of promptIntervention
  }

  private promptIntervention(): void {
    if (!process.stdin.isTTY) { this.resume(); return }
    this.pauseInput = true

    // Temporarily exit raw mode so readline can work normally
    try { process.stdin.setRawMode(false) } catch { /* ok */ }

    const col = this.tw >= 140 ? (this.lw + this.mw + 6) : (this.lw + 2)
    const promptRow = this.logBottom()
    if (this.isTUI) process.stdout.write(`\x1b[${promptRow};${col}H${C.yellow}⏸ 干预指令 (回车跳过): ${C.reset}`)

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
    this.rl = rl
    rl.once("line", (input: string) => {
      rl.close()
      this.rl = null
      this.pauseInput = false

      const trimmed = input.trim()
      if (trimmed) {
        const injected = createTaskNode({
          type: "implement",
          title: trimmed.slice(0, 80),
          prompt: [
            `[Human intervention injected during run]`,
            ``,
            trimmed,
            `\n---\nYour output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`,
          ].join("\n"),
          scope: [],
          priority: 999,
        })
        this.conductor.taskDag.addTask(injected)
        this.pushLog(`${C.cyan}⊕ 干预任务已插入: "${trimmed.slice(0, 60)}"${C.reset}`)
      }

      this.resume()
    })
  }

  private resume(): void {
    this.paused = false
    // Re-engage raw mode
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true) } catch { /* ok */ }
    }
    this.conductor.startScheduler()
    this.pushLog(`${C.green}▶  Resumed${C.reset}`)
    this.leftDirty = true
    this.flushDirty()
  }

  promptFollowup(_task: TaskNode): Promise<string> {
    return new Promise(resolve => {
      this.pushLog(`${C.cyan}追加任务？${C.reset}${C.dim} 回车跳过${C.reset}`)
      if (!process.stdin.isTTY) { resolve(""); return }
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      this.rl = rl
      if (this.isTUI) {
        const col = this.lw + this.mw + 6
        const row = this.logBottom()
        process.stdout.write(`\x1b[${row};${col}H${C.cyan}> ${C.reset}`)
      } else {
        process.stdout.write(`${C.cyan}> ${C.reset}`)
      }
      rl.once("line", (input: string) => {
        rl.close(); this.rl = null
        if (input.trim()) this.pushLog(`${C.cyan}→ "${input.trim()}"${C.reset}`)
        resolve(input.trim())
      })
    })
  }

  // ── Geometry ──────────────────────────────────────────────────────────────

  private recalcGeometry(): void {
    this.tw = process.stdout.columns || 120
    this.th = process.stdout.rows    || 30
    if (this.tw >= 140) {
      // Three-pane
      this.lw = Math.min(36, Math.max(26, Math.floor(this.tw * 0.26)))
      this.mw = Math.min(52, Math.max(38, Math.floor(this.tw * 0.40)))
    } else if (this.tw >= 80) {
      // Two-pane: left=tasks, right=agents+log merged
      this.lw = Math.min(32, Math.floor(this.tw * 0.32))
      this.mw = 0
    } else {
      // Narrow two-pane
      this.lw = Math.min(28, Math.floor(this.tw * 0.30))
      this.mw = 0
    }
  }

  private get rw(): number {
    if (this.tw >= 140) return this.tw - this.lw - this.mw - 4
    return this.tw - this.lw - 2
  }

  private logHeight(): number {
    return Math.max(MIN_LOG_H, this.th - HEADER_ROWS - FOOTER_ROWS - 1)
  }

  private logBottom(): number {
    return HEADER_ROWS + this.logHeight()
  }

  // ── Event handling ────────────────────────────────────────────────────────

  private handleEvent(kind: string, payload: Record<string, unknown>): void {
    if (kind === "phase.started") {
      const phase = payload["phase"] as number
      // Close previous phase
      const prev = this.phaseHistory[this.phaseHistory.length - 1]
      if (prev && prev.endMs === null) prev.endMs = Date.now()
      this.phaseHistory.push({ phase, startMs: Date.now(), endMs: null })
      return
    }

    if (kind === "task.status_changed") {
      const taskId = payload["taskId"] as string
      const next   = payload["next"]   as string
      const task   = this.conductor.taskDag.getTask(taskId)
      if (!task) return

      if (next === "running") {
        const agentId = task.assignedTo ?? taskId
        this.slots.set(agentId, {
          taskId, title: task.title, type: task.type,
          scope: task.scope,
          startedAt: Date.now(), lastLine: "",
          model: null,
          tokenUsage: null,
        })
        if (this.verbose === "stream") {
          this.pushLog(`${C.cyan}▶${C.reset} ${C.dim}[${TYPE_SHORT[task.type] ?? task.type}]${C.reset} ${task.title}`)
        }
      } else if (next === "done" || next === "failed" || next === "interrupted") {
        const entry   = [...this.slots.entries()].find(([, s]) => s.taskId === taskId)
        const agentId = entry?.[0]
        const slot    = entry?.[1]

        if (slot) {
          const dur    = elapsed(Date.now() - slot.startedAt)
          const tok    = task.tokenUsage
          const tokStr = tok ? `${C.dim} · ${(tok.inputTokens + tok.outputTokens).toLocaleString()} tok${C.reset}` : ""
          const icon   = next === "done" ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
          const tag    = `${C.dim}[${TYPE_SHORT[slot.type] ?? slot.type}]${C.reset}`
          this.pushLog(`${icon} ${tag} ${task.title}  ${C.dim}${dur}${C.reset}${tokStr}`)
          if ((this.verbose === "summary" || this.verbose === "stream") && next === "done") {
            this.pushSummary(task)
          }
          if (agentId) this.slots.delete(agentId)
        }
        if (agentId) this.tokBuf.delete(agentId)

        // Accumulate risk signals
        if (next === "done" && task.output) {
          const highs = task.output.risks.filter(r =>
            /\b(critical|high|severe|security|data loss|breaking)\b/i.test(r))
          if (highs.length > 0) {
            this.riskCount += highs.length
            this.lastRisk = highs[0]!.slice(0, 60)
          }
        }
      }
      this.leftDirty = true
      return
    }

    if (kind === "task.dynamic_inserted") {
      this.pushLog(`${C.magenta}⊕${C.reset} ${C.dim}inserted:${C.reset} ${payload["title"]}`)
      this.leftDirty = true
      return
    }

    if (kind === "approval.required") {
      this.pushLog(`${C.yellow}${C.bold}⏸  Approval required — paused${C.reset}`)
      return
    }
  }

  // ── Token stream ──────────────────────────────────────────────────────────

  private handleDelta(agentId: string, task: TaskNode, delta: string, model: string | null): void {
    const slot = this.slots.get(agentId)
    // Update model on first delta (thread is now confirmed open)
    if (slot && model && !slot.model) slot.model = model
    const buf  = (this.tokBuf.get(agentId) ?? "") + delta
    this.tokBuf.set(agentId, buf)

    const lines = buf.split("\n")
    const lastComplete = lines.slice(0, -1).map(l => l.trim()).filter(Boolean).at(-1)
    if (lastComplete && slot) slot.lastLine = lastComplete.slice(0, this.mw - 6)

    if (this.verbose === "stream" && lines.length > 1) {
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim()
        if (line) this.pushLog(`${C.dim}  ${(TYPE_SHORT[task.type] ?? task.type).slice(0, 3)}${C.reset} ${line}`)
      }
      this.tokBuf.set(agentId, lines[lines.length - 1]!)
    } else {
      if (buf.length > 4096) this.tokBuf.set(agentId, buf.slice(-2048))
    }

    this.leftDirty = true
  }

  // ── Summary box ───────────────────────────────────────────────────────────

  private pushSummary(task: TaskNode): void {
    if (!task.output) return
    const w = this.rw - 6
    const summaryLines = task.output.summary
      .split("\n").map(l => l.trim()).filter(Boolean).slice(0, 3)
    const highRisks = task.output.risks
      .filter(r => /\b(critical|high|severe|security)\b/i.test(r)).slice(0, 2)
    const blockers = task.output.blockers.map(b => b.trim()).filter(Boolean).slice(0, 1)
    if (!summaryLines.length && !highRisks.length && !blockers.length) return
    this.pushLog(`${C.dim}  ╭${"─".repeat(Math.min(w, 50))}${C.reset}`)
    for (const line of summaryLines) this.pushLog(`${C.dim}  │${C.reset} ${line.slice(0, w)}`)
    for (const r of highRisks) this.pushLog(`${C.dim}  │${C.reset} ${C.yellow}▲${C.reset} ${r.trim().slice(0, w - 2)}`)
    for (const b of blockers)  this.pushLog(`${C.dim}  │${C.reset} ${C.red}✗${C.reset} ${b.slice(0, w - 2)}`)
    this.pushLog(`${C.dim}  ╰${"─".repeat(Math.min(w, 50))}${C.reset}`)
  }

  // ── Log buffer ────────────────────────────────────────────────────────────

  private pushLog(line: string): void {
    this.log.push(line)
    if (this.log.length > this.maxLog) this.log.shift()
    if (!this.isTUI) { console.log(stripAnsi(line)); return }
    this.logDirty = true
    if (!this.rendering) this.flushDirty()
  }

  // ── Dirty flush ───────────────────────────────────────────────────────────

  private flushDirty(): void {
    if (this.rendering) return
    this.rendering = true
    try {
      if (this.leftDirty || this.logDirty) {
        this.renderHeader()
        this.renderDividers()
        if (this.leftDirty) {
          this.renderLeft()
          if (this.tw >= 140) this.renderMid()
          this.leftDirty = false
        }
        if (this.logDirty) { this.renderLog(); this.logDirty = false }
        this.renderFooter()
      }
    } finally {
      this.rendering = false
    }
  }

  // ── Full redraw ───────────────────────────────────────────────────────────

  private fullRedraw(): void {
    if (!this.isTUI) return
    if (this.rendering) { this.leftDirty = true; this.logDirty = true; return }
    this.rendering = true
    try {
      process.stdout.write("\x1b[?25l\x1b[2J\x1b[H")
      this.renderHeader()
      this.renderDividers()
      this.renderLeft()
      if (this.tw >= 140) this.renderMid()
      this.renderLog()
      this.renderFooter()
      this.leftDirty = false
      this.logDirty  = false
    } finally {
      this.rendering = false
      process.stdout.write("\x1b[?25h")
    }
  }

  // ── Header (3 rows) ───────────────────────────────────────────────────────

  private renderHeader(): void {
    if (!this.isTUI) return
    const s   = this.conductor.status()
    const now = new Date().toLocaleTimeString("en-GB", { hour12: false })
    const done = s.tasks.done
    const tot  = s.tasks.total
    const pct  = tot === 0 ? 0 : Math.round((done / tot) * 100)

    // ── Token / cost / rate ────────────────────────────────────────────────
    let totalTok = 0, inputTok = 0, outputTok = 0, cacheHit = 0
    try {
      const tk = this.conductor.store.tokenStats()
      totalTok  = tk.totalTokens
      inputTok  = tk.inputTokens
      outputTok = tk.outputTokens
      cacheHit  = tk.cacheHitRate
    } catch { /* db closed */ }

    const wallMs = Date.now() - this.runStartMs
    const tokRate  = wallMs > 5000 ? Math.round(totalTok / wallMs * 60_000) : 0
    const costUSD  = (inputTok * 15 + outputTok * 75) / 1_000_000
    const costStr  = costUSD >= 0.01
      ? `$${costUSD.toFixed(2)}`
      : costUSD > 0 ? `<$0.01` : ""

    // ── ETA ────────────────────────────────────────────────────────────────
    const doneTasks = this.conductor.taskDag.allTasks().filter(t =>
      t.status === "done" && t.startedAt && t.completedAt)
    const avgMs = doneTasks.length > 0
      ? doneTasks.reduce((a, t) => a + (t.completedAt! - t.startedAt!), 0) / doneTasks.length
      : 0
    const remaining = s.tasks.total - s.tasks.done - s.tasks.failed
    const parallelism = Math.max(1, s.agents.busy)
    const etaMs = avgMs > 0 && remaining > 0
      ? (remaining / parallelism) * avgMs
      : 0

    // ── Row 1 ──────────────────────────────────────────────────────────────
    let row1 = `  ${C.bold}${C.bgDark}SWARM${C.reset}${C.bgDark}`
    row1 += `  Phase ${s.phase}  ${bar(done, tot)}  ${done}/${tot} (${pct}%)`
    if (totalTok > 0) row1 += `  ${C.yellow}${totalTok.toLocaleString()} tok${C.reset}${C.bgDark}`
    if (tokRate > 0)  row1 += `  ${C.dim}${tokRate}/min${C.reset}${C.bgDark}`
    if (costStr)      row1 += `  ${C.dim}${costStr}${C.reset}${C.bgDark}`
    if (cacheHit > 0) row1 += `  ${C.green}${cacheHit}% cache${C.reset}${C.bgDark}`
    if (etaMs > 0)    row1 += `  ${C.cyan}ETA ${etaStr(etaMs)}${C.reset}${C.bgDark}`
    if (this.riskCount > 0) row1 += `  ${C.red}${C.bold}⚠ ${this.riskCount} risk${C.reset}${C.bgDark}`
    const timeField = `${now}  `
    const row1bare  = stripAnsi(row1)
    const pad1      = Math.max(0, this.tw - row1bare.length - timeField.length)
    process.stdout.write(`\x1b[1;0H${row1}${" ".repeat(pad1)}${C.dim}${timeField}${C.reset}\n`)

    // ── Row 2: agent/task stats ────────────────────────────────────────────
    const row2 = `  ${C.dim}agents  idle ${s.agents.idle}  busy ${s.agents.busy}  locked ${s.locks}` +
      `    tasks  run ${s.tasks.running}  rdy ${s.tasks.ready}  blk ${s.tasks.blocked}  fail ${s.tasks.failed}${C.reset}`
    process.stdout.write(`\x1b[2;0H${row2}${" ".repeat(Math.max(0, this.tw - stripAnsi(row2).length))}\n`)

    // ── Row 3: Phase timeline + last risk ─────────────────────────────────
    let row3 = "  "
    const phases = this.phaseHistory.length > 0 ? this.phaseHistory : [{ phase: 0, startMs: this.runStartMs, endMs: null }]
    row3 += `${C.dim}phases  `
    for (const p of phases) {
      const dur = p.endMs ? elapsed(p.endMs - p.startMs) : elapsed(Date.now() - p.startMs)
      const isCur = p.endMs === null
      const bracket = isCur
        ? `${C.reset}${C.cyan}[►P${p.phase} ${dur}]${C.reset}${C.dim}`
        : `[P${p.phase} ${dur}]`
      row3 += bracket + "  "
    }
    row3 += C.reset
    if (this.lastRisk) {
      const riskLabel = `  ${C.red}${C.bold}⬤ HIGH: ${C.reset}${C.red}${this.lastRisk}${C.reset}`
      const bare3 = stripAnsi(row3)
      const gapNeeded = this.tw - bare3.length - stripAnsi(riskLabel).length
      if (gapNeeded > 2) row3 += " ".repeat(gapNeeded) + riskLabel
    }
    const bare3 = stripAnsi(row3)
    process.stdout.write(`\x1b[3;0H${row3}${" ".repeat(Math.max(0, this.tw - bare3.length))}`)
  }

  // ── Dividers ──────────────────────────────────────────────────────────────

  private renderDividers(): void {
    const h = this.logHeight()
    for (let r = 1; r <= h + 1; r++) {
      process.stdout.write(`\x1b[${HEADER_ROWS + r};${this.lw + 1}H${C.dim}│${C.reset}`)
    }
    if (this.tw >= 140) {
      const col2 = this.lw + 1 + this.mw + 2
      for (let r = 1; r <= h + 1; r++) {
        process.stdout.write(`\x1b[${HEADER_ROWS + r};${col2}H${C.dim}│${C.reset}`)
      }
    }
  }

  // ── Left pane: Orchestrator task DAG ──────────────────────────────────────

  private renderLeft(): void {
    const tasks    = this.conductor.taskDag.allTasks()
    const h        = this.logHeight()
    const startRow = HEADER_ROWS + 1

    // Header row
    const hdr = ` ${C.bold}${C.dim}TASKS${C.reset}`
    process.stdout.write(`\x1b[${startRow};1H${hdr}${" ".repeat(Math.max(0, this.lw - stripAnsi(hdr).length))}`)

    // Sort: topological order approximation (by creation time, which reflects insertion order)
    const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt)

    let row = startRow + 1
    const maxRow = HEADER_ROWS + h

    for (const t of sorted) {
      if (row > maxRow) break
      process.stdout.write(`\x1b[${row};1H`)

      const icon  = STATUS_ICON[t.status] ?? "·"
      const tag   = `${C.dim}[${(TYPE_SHORT[t.type] ?? t.type).slice(0, 3)}]${C.reset}`
      const isDynamic = t.id.startsWith("dyn-") || (t as TaskNode & { dynamic?: boolean }).dynamic
      const dynMark = isDynamic ? `${C.magenta}⊕${C.reset}` : " "

      let line: string
      if (t.status === "running") {
        const dur = t.startedAt ? ` ${C.dim}${elapsed(Date.now() - t.startedAt)}${C.reset}` : ""
        line = `${dynMark}${icon}${tag}${C.cyan}${t.title}${C.reset}${dur}`
      } else if (t.status === "done") {
        line = `${dynMark}${icon}${tag}${C.dim}${t.title}${C.reset}`
      } else if (t.status === "failed") {
        line = `${dynMark}${icon}${tag}${C.red}${t.title}${C.reset}`
      } else {
        line = `${dynMark}${icon}${tag}${t.title}`
      }

      const truncated = trunc(line, this.lw - 1)
      process.stdout.write(pad(truncated, this.lw))
      row++
    }

    // Clear unused rows
    for (let r = row; r <= maxRow; r++) {
      process.stdout.write(`\x1b[${r};1H${" ".repeat(this.lw)}`)
    }
  }

  // ── Mid pane: Active agents ────────────────────────────────────────────────

  private renderMid(): void {
    if (this.tw < 140) return

    const h        = this.logHeight()
    const startRow = HEADER_ROWS + 1
    const startCol = this.lw + 2
    const maxRow   = HEADER_ROWS + h

    // Header
    const hdr = ` ${C.bold}${C.dim}AGENTS${C.reset}`
    process.stdout.write(`\x1b[${startRow};${startCol}H${hdr}${" ".repeat(Math.max(0, this.mw - stripAnsi(hdr).length))}`)

    const allInstances = this.conductor.status().agents
    const detailed = (allInstances.total <= 4)
    const CARD_H   = detailed ? 5 : 3    // lines per busy agent card
    const IDLE_H   = 1

    let row = startRow + 1
    const busySlots = Array.from(this.slots.values())

    for (const slot of busySlots) {
      if (row + CARD_H > maxRow) break

      const dur    = elapsed(Date.now() - slot.startedAt)
      const tag    = `${C.dim}[${(TYPE_SHORT[slot.type] ?? slot.type).slice(0, 3)}]${C.reset}`
      const task   = this.conductor.taskDag.getTask(slot.taskId)
      const tokU   = task?.tokenUsage
      const mShort = modelShort(slot.model)
      const mLabel = mShort ? ` ${C.dim}${C.yellow}${mShort}${C.reset}` : ""

      // Line 1: task title + model tag (right-aligned within card width)
      const titleStr = `${C.bold}${C.cyan}● ${C.reset}${tag} ${slot.title}`
      const titleBare = stripAnsi(titleStr)
      const mLabelBare = mShort ? ` ${mShort}` : ""
      const titlePad = Math.max(0, this.mw - 1 - titleBare.length - mLabelBare.length)
      process.stdout.write(`\x1b[${row};${startCol}H${titleStr}${" ".repeat(titlePad)}${mLabel} ${C.reset}`)
      row++

      // Line 2: elapsed + scope file
      const scopeFile = slot.scope.length > 0
        ? slot.scope[0]!.split("/").slice(-2).join("/")
        : ""
      const line2 = `  ${C.dim}${dur}  ${scopeFile}${C.reset}`
      process.stdout.write(`\x1b[${row};${startCol}H${pad(trunc(line2, this.mw - 1), this.mw - 1)}`)
      row++

      // Line 3: last token hint
      const hint = slot.lastLine
        ? `  ${C.dim}╰ ${slot.lastLine}${C.reset}`
        : `  ${C.dim}╰ waiting...${C.reset}`
      process.stdout.write(`\x1b[${row};${startCol}H${pad(trunc(hint, this.mw - 1), this.mw - 1)}`)
      row++

      if (detailed) {
        // Line 4: token usage
        if (tokU) {
          const tokLine = `  ${C.dim}in ${tokU.inputTokens.toLocaleString()}  out ${tokU.outputTokens.toLocaleString()}  cache ${tokU.cacheHitTokens.toLocaleString()}${C.reset}`
          process.stdout.write(`\x1b[${row};${startCol}H${pad(trunc(tokLine, this.mw - 1), this.mw - 1)}`)
        } else {
          process.stdout.write(`\x1b[${row};${startCol}H${" ".repeat(this.mw - 1)}`)
        }
        row++

        // Line 5: blank separator
        process.stdout.write(`\x1b[${row};${startCol}H${" ".repeat(this.mw - 1)}`)
        row++
      }
    }

    // Show idle agents count in a compact line
    const idleCount = this.conductor.status().agents.idle
    if (idleCount > 0 && row + IDLE_H <= maxRow) {
      const idleLine = `  ${C.dim}◌ ${idleCount} agent${idleCount > 1 ? "s" : ""} idle${C.reset}`
      process.stdout.write(`\x1b[${row};${startCol}H${pad(idleLine, this.mw - 1)}`)
      row++
    }

    // Clear unused rows
    for (let r = row; r <= maxRow; r++) {
      process.stdout.write(`\x1b[${r};${startCol}H${" ".repeat(this.mw - 1)}`)
    }
  }

  // ── Right pane: Event log ─────────────────────────────────────────────────

  private renderLog(): void {
    const h        = this.logHeight()
    const startRow = HEADER_ROWS + 1
    const startCol = this.tw >= 140 ? (this.lw + this.mw + 4) : (this.lw + 2)
    const visible  = this.log.slice(-h)

    // Header
    const hdr = ` ${C.bold}${C.dim}LOG${C.reset}`
    process.stdout.write(`\x1b[${startRow};${startCol}H${hdr}${" ".repeat(Math.max(0, this.rw - stripAnsi(hdr).length))}`)

    for (let i = 0; i < h - 1; i++) {
      const line = visible[i] ?? ""
      process.stdout.write(`\x1b[${startRow + 1 + i};${startCol}H`)
      this.writeLineAt(line, this.rw)
    }
  }

  private writeLineAt(line: string, maxW: number): void {
    const stripped = stripAnsi(line)
    if (stripped.length <= maxW) {
      process.stdout.write(line + " ".repeat(Math.max(0, maxW - stripped.length)) + C.reset)
      return
    }
    // Trim preserving ANSI
    let vis = 0, idx = 0
    while (idx < line.length && vis < maxW - 1) {
      if (line[idx] === "\x1b") { while (idx < line.length && line[idx] !== "m") idx++; idx++ }
      else { vis++; idx++ }
    }
    process.stdout.write(line.slice(0, idx) + C.reset + " ")
  }

  // ── Footer ────────────────────────────────────────────────────────────────

  private renderFooter(): void {
    if (!this.isTUI) return
    const row = this.logBottom() + 1
    const s   = this.conductor.status()
    process.stdout.write(`\x1b[${row};0H${C.dim}${"─".repeat(this.tw)}${C.reset}\n`)

    if (this.paused) {
      process.stdout.write(` ${C.yellow}${C.bold}⏸  PAUSED${C.reset}${C.yellow} — 输入干预指令后回车，空回车继续运行${C.reset}`)
    } else if (s.pendingApprovals > 0) {
      process.stdout.write(` ${C.yellow}${C.bold}⏸  Approval required — type y/n${C.reset}`)
    } else {
      const mode  = this.verbose
      const runId = this.conductor.runId.slice(0, 18)
      process.stdout.write(` ${C.dim}Ctrl+C stop  ·  p pause  ·  mode: ${mode}  ·  run: ${runId}${C.reset}`)
    }
  }
}
