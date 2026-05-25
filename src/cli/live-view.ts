import { createInterface } from "readline"
import type { Conductor } from "../conductor"
import type { TaskNode } from "../dag/types"

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
  gray: "\x1b[90m", bgDark: "\x1b[48;5;235m",
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

export type VerboseLevel = "quiet" | "summary" | "stream"

function bar(done: number, total: number, width = 20): string {
  if (total === 0) return `${C.dim}${"░".repeat(width)}${C.reset}`
  const filled = Math.round((done / total) * width)
  return `${C.green}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(width - filled)}${C.reset}`
}

function elapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[^m]*m/g, "")
}

// ─── Layout ───────────────────────────────────────────────────────────────────

const HEADER_ROWS = 2
const FOOTER_ROWS = 2
const LEFT_W      = 36
const MIN_LOG_H   = 6

// ─── AgentSlot ────────────────────────────────────────────────────────────────

interface AgentSlot {
  taskId:    string
  title:     string
  type:      string
  startedAt: number
  lastLine:  string    // last token line seen (shown in left panel while running)
}

// ─── LiveView ─────────────────────────────────────────────────────────────────

export class LiveView {
  private conductor: Conductor
  private verbose: VerboseLevel
  private slots   = new Map<string, AgentSlot>()
  private log:    string[] = []
  private maxLog  = 500
  private tokBuf  = new Map<string, string>()
  private tw = process.stdout.columns || 120
  private th = process.stdout.rows    || 30
  private lw = Math.min(LEFT_W, Math.floor((process.stdout.columns || 120) * 0.32))
  private get rw() { return this.tw - this.lw - 2 }
  private tick: ReturnType<typeof setInterval> | null = null
  private rl:   ReturnType<typeof createInterface> | null = null

  // ── Stability guards ───────────────────────────────────────────────────────
  private isTUI    = false  // false = plain-text fallback (narrow/non-TTY terminal)
  private rendering = false  // mutex: prevents concurrent ANSI writes
  private leftDirty = false  // coalesces rapid left-panel refreshes
  private logDirty  = false  // coalesces rapid log refreshes
  private exitHandlers: Array<() => void> = []

  constructor(conductor: Conductor, verbose: VerboseLevel = "summary") {
    this.conductor = conductor
    this.verbose   = verbose
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    // Detect whether we can render a TUI (needs TTY + minimum width)
    this.isTUI = !!process.stdout.isTTY && this.tw >= 60

    // Register exit/signal handlers to restore terminal state
    const cleanup = () => { this.stop(); }
    const onUncaught = (err: unknown) => {
      this.stop()
      console.error("\n[swarm] uncaught error:", err)
      process.exit(1)
    }
    process.on("SIGINT",  cleanup)
    process.on("SIGTERM", cleanup)
    process.on("uncaughtException", onUncaught)
    this.exitHandlers = [
      () => process.off("SIGINT",  cleanup),
      () => process.off("SIGTERM", cleanup),
      () => process.off("uncaughtException", onUncaught),
    ]

    // Resize: re-detect TUI eligibility + full redraw
    process.stdout.on("resize", () => {
      this.tw = process.stdout.columns || 120
      this.th = process.stdout.rows    || 30
      this.lw = Math.min(LEFT_W, Math.floor(this.tw * 0.32))
      this.isTUI = !!process.stdout.isTTY && this.tw >= 60
      this.fullRedraw()
    })

    this.conductor.onStream((agentId, task, delta) => {
      this.handleDelta(agentId, task, delta)
    })

    this.conductor.onEvent(e => this.handleEvent(e.kind, e.payload))

    this.fullRedraw()
    // Coalesced refresh: flush dirty flags at most once per tick
    this.tick = setInterval(() => {
      if (this.leftDirty || this.logDirty) this.flushDirty()
    }, 500)
  }

  stop(): void {
    if (this.tick) { clearInterval(this.tick); this.tick = null }
    this.rl?.close()
    // Deregister signal handlers
    for (const off of this.exitHandlers) off()
    this.exitHandlers = []
    if (this.isTUI) {
      // Restore cursor to bottom, show it
      process.stdout.write(`\x1b[?25h\x1b[${this.th};0H\n`)
    }
  }

  promptFollowup(_task: TaskNode): Promise<string> {
    return new Promise(resolve => {
      this.pushLog(`${C.cyan}追加任务？${C.reset}${C.dim} 回车跳过${C.reset}`)
      if (!process.stdin.isTTY) { resolve(""); return }

      const rl = createInterface({ input: process.stdin, output: process.stdout })
      this.rl = rl

      if (this.isTUI) {
        // Position cursor in the right panel at the log bottom
        const col = this.lw + 3
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

  // ── Event handling ────────────────────────────────────────────────────────

  private handleEvent(kind: string, payload: Record<string, unknown>): void {
    if (kind === "task.status_changed") {
      const taskId = payload["taskId"] as string
      const next   = payload["next"]   as string
      const task   = this.conductor.taskDag.getTask(taskId)
      if (!task) return

      if (next === "running") {
        const agentId = task.assignedTo ?? taskId
        this.slots.set(agentId, {
          taskId, title: task.title, type: task.type,
          startedAt: Date.now(), lastLine: "",
        })
        // Only show start event in stream mode
        if (this.verbose === "stream") {
          this.pushLog(`${C.cyan}▶${C.reset} ${C.dim}[${task.type}]${C.reset} ${task.title}`)
        }

      } else if (next === "done" || next === "failed" || next === "interrupted") {
        const entry = [...this.slots.entries()].find(([, s]) => s.taskId === taskId)
        const agentId = entry?.[0]
        const slot    = entry?.[1]

        if (slot) {
          const dur = elapsed(Date.now() - slot.startedAt)
          const tok = task.tokenUsage
          const tokStr = tok ? `${C.dim} · ${tok.inputTokens.toLocaleString()} tok${C.reset}` : ""
          const icon   = next === "done" ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`
          const typeTag = `${C.dim}[${slot.type}]${C.reset}`

          // Always log task completion — this is the one line per task
          this.pushLog(`${icon} ${typeTag} ${task.title}  ${C.dim}${dur}${C.reset}${tokStr}`)

          // Summary only in summary / stream modes
          if ((this.verbose === "summary" || this.verbose === "stream") && next === "done") {
            this.pushSummary(task)
          }

          if (agentId) this.slots.delete(agentId)
        }
        if (agentId) this.tokBuf.delete(agentId)
      }
      return
    }

    if (kind === "phase.completed") {
      const sep = `${C.dim}${"─".repeat(Math.min(this.rw - 2, 48))}${C.reset}`
      this.pushLog(sep)
      this.pushLog(`${C.bold}  Phase ${payload["phase"]} complete${C.reset}`)
      this.pushLog(sep)
      return
    }

    if (kind === "task.dynamic_inserted") {
      this.pushLog(`${C.magenta}⊕${C.reset} ${C.dim}inserted:${C.reset} ${payload["title"]}`)
      return
    }

    if (kind === "approval.required") {
      this.pushLog(`${C.yellow}${C.bold}⏸  Approval required — paused${C.reset}`)
      return
    }
  }

  // ── Token stream ─────────────────────────────────────────────────────────

  private handleDelta(agentId: string, task: TaskNode, delta: string): void {
    // Always update the slot's lastLine so it shows in the left panel
    const slot = this.slots.get(agentId)
    const buf  = (this.tokBuf.get(agentId) ?? "") + delta
    this.tokBuf.set(agentId, buf)

    // Extract the most recent complete thought for the left panel hint
    const lines = buf.split("\n")
    const lastComplete = lines.slice(0, -1).map(l => l.trim()).filter(Boolean).at(-1)
    if (lastComplete && slot) {
      slot.lastLine = lastComplete.slice(0, this.lw - 4)
    }

    // In stream mode: flush complete lines to the right panel
    if (this.verbose === "stream" && lines.length > 1) {
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim()
        if (line) {
          const label = `${C.dim}  ${task.type.slice(0, 3)}${C.reset}`
          this.pushLog(`${label} ${line}`)
        }
      }
      this.tokBuf.set(agentId, lines[lines.length - 1]!)
    } else {
      // Trim buffer to avoid unbounded growth
      if (buf.length > 4096) this.tokBuf.set(agentId, buf.slice(-2048))
    }
  }

  // ── Summary box ───────────────────────────────────────────────────────────

  private pushSummary(task: TaskNode): void {
    if (!task.output) return
    const w = this.rw - 6

    // Summary: up to 3 lines
    const summaryLines = task.output.summary
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 3)

    // Risks: HIGH/CRITICAL only (keep noise down)
    const highRisks = task.output.risks
      .filter(r => /\b(critical|high|severe|security)\b/i.test(r))
      .slice(0, 2)

    const blockers = task.output.blockers
      .map(b => b.trim()).filter(Boolean).slice(0, 1)

    if (!summaryLines.length && !highRisks.length && !blockers.length) return

    this.pushLog(`${C.dim}  ╭${"─".repeat(Math.min(w, 50))}${C.reset}`)
    for (const line of summaryLines) {
      this.pushLog(`${C.dim}  │${C.reset} ${line.slice(0, w)}`)
    }
    for (const r of highRisks) {
      this.pushLog(`${C.dim}  │${C.reset} ${C.yellow}▲${C.reset} ${r.trim().slice(0, w - 2)}`)
    }
    for (const b of blockers) {
      this.pushLog(`${C.dim}  │${C.reset} ${C.red}✗${C.reset} ${b.slice(0, w - 2)}`)
    }
    this.pushLog(`${C.dim}  ╰${"─".repeat(Math.min(w, 50))}${C.reset}`)
  }

  // ── Log buffer ────────────────────────────────────────────────────────────

  private pushLog(line: string): void {
    this.log.push(line)
    if (this.log.length > this.maxLog) this.log.shift()
    if (!this.isTUI) {
      // Plain-text mode: just print to stdout directly
      console.log(stripAnsi(line))
      return
    }
    this.logDirty = true
    // Immediate render only if not currently rendering (avoids cursor conflict)
    if (!this.rendering) this.flushDirty()
  }

  // ── Dirty flush (called by interval + immediate path) ────────────────────

  private flushDirty(): void {
    if (this.rendering) return
    this.rendering = true
    try {
      if (this.leftDirty || this.logDirty) {
        if (this.leftDirty) { this.renderHeader(); this.renderLeft(); this.leftDirty = false }
        if (this.logDirty)  { this.renderLog();    this.logDirty  = false }
        this.renderFooter()
      }
    } finally {
      this.rendering = false
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private logHeight(): number {
    return Math.max(MIN_LOG_H, this.th - HEADER_ROWS - FOOTER_ROWS - 1)
  }

  private logBottom(): number {
    return HEADER_ROWS + this.logHeight()
  }

  private fullRedraw(): void {
    if (!this.isTUI) return
    if (this.rendering) { this.leftDirty = true; this.logDirty = true; return }
    this.rendering = true
    try {
      process.stdout.write("\x1b[?25l")  // hide cursor during redraw
      process.stdout.write("\x1b[2J\x1b[H")
      this.renderHeader()
      this.renderDivider()
      this.renderLeft()
      this.renderLog()
      this.renderFooter()
      this.leftDirty = false
      this.logDirty  = false
    } finally {
      this.rendering = false
      process.stdout.write("\x1b[?25h")  // restore cursor
    }
  }

  private renderHeader(): void {
    if (!this.isTUI) return
    const s    = this.conductor.status()
    const done = s.tasks.done
    const tot  = s.tasks.total
    const pct  = tot === 0 ? 0 : Math.round((done / tot) * 100)
    const now  = new Date().toLocaleTimeString("en-GB", { hour12: false })

    let tokLine = ""
    try {
      const tok = this.conductor.store.tokenStats()
      if (tok.totalTokens > 0) {
        tokLine = `  ${C.yellow}${tok.totalTokens.toLocaleString()} tok${C.reset}  ${C.green}${tok.cacheHitRate}% cache${C.reset}`
      }
    } catch { /* ok */ }

    // Row 1: title + progress
    const title = `  SWARM  Phase ${s.phase}  ${bar(done, tot)}  ${done}/${tot} (${pct}%)${tokLine}`
    const timeStr = `${now}  `
    const padLen  = Math.max(0, this.tw - stripAnsi(title).length - timeStr.length)
    process.stdout.write(
      `\x1b[1;0H${C.bold}${C.bgDark}${title}${" ".repeat(padLen)}${C.dim}${timeStr}${C.reset}\n`
    )

    // Row 2: agent status (compact)
    const agents = `  ${C.dim}agents  idle ${s.agents.idle}  busy ${s.agents.busy}  locks ${s.locks}` +
      `    tasks  run ${s.tasks.running}  rdy ${s.tasks.ready}  blk ${s.tasks.blocked}  fail ${s.tasks.failed}${C.reset}`
    process.stdout.write(`${agents}\n`)
  }

  private renderDivider(): void {
    const h = this.logHeight()
    for (let r = 0; r <= h + 1; r++) {
      process.stdout.write(`\x1b[${HEADER_ROWS + r};${this.lw + 1}H${C.dim}│${C.reset}`)
    }
  }

  private renderLeft(): void {
    const tasks    = this.conductor.taskDag.allTasks()
    const h        = this.logHeight()
    const startRow = HEADER_ROWS + 1

    // Left panel header
    process.stdout.write(`\x1b[${startRow};1H${C.bold}${C.dim} TASKS${C.reset}${" ".repeat(this.lw - 6)}`)

    for (let i = 0; i < Math.min(h - 1, tasks.length); i++) {
      const t   = tasks[i]!
      const row = startRow + 1 + i
      process.stdout.write(`\x1b[${row};1H`)

      const icon  = STATUS_ICON[t.status] ?? "·"
      const title = t.title.slice(0, this.lw - 5)

      let line: string
      if (t.status === "running") {
        // Show elapsed time
        const dur = t.startedAt ? ` ${C.dim}${elapsed(Date.now() - t.startedAt)}${C.reset}` : ""
        line = ` ${icon} ${C.cyan}${title}${C.reset}${dur}`

        // In summary mode: show last token hint below title in dim
        if (this.verbose !== "quiet") {
          const slot = [...this.slots.values()].find(s => s.taskId === t.id)
          if (slot?.lastLine) {
            const hint = slot.lastLine.slice(0, this.lw - 4)
            const stripped = stripAnsi(line)
            const pad = Math.max(0, this.lw - stripped.length)
            process.stdout.write(line + " ".repeat(pad))
            // Write hint on next row if space allows
            if (i + 1 < h - 1 && (i + 1 >= tasks.length || tasks[i + 1]!.status !== "running")) {
              process.stdout.write(`\x1b[${row + 1};1H ${C.dim}  ╰ ${hint}${C.reset}${" ".repeat(Math.max(0, this.lw - hint.length - 5))}`)
            }
            continue
          }
        }
      } else if (t.status === "done") {
        line = ` ${icon} ${C.dim}${title}${C.reset}`
      } else if (t.status === "failed") {
        line = ` ${icon} ${C.red}${title}${C.reset}`
      } else {
        line = ` ${icon} ${title}`
      }

      const stripped = stripAnsi(line)
      const pad      = Math.max(0, this.lw - stripped.length)
      process.stdout.write(line + " ".repeat(pad))
    }

    // Clear unused rows
    for (let i = tasks.length; i < h - 1; i++) {
      process.stdout.write(`\x1b[${startRow + 1 + i};1H${" ".repeat(this.lw)}`)
    }
  }

  private renderLog(): void {
    const h        = this.logHeight()
    const startRow = HEADER_ROWS + 1
    const visible  = this.log.slice(-h)
    const col      = this.lw + 3

    for (let i = 0; i < h; i++) {
      const line = visible[i] ?? ""
      process.stdout.write(`\x1b[${startRow + i};${col}H`)
      this.writeRightLine(line)
    }
  }

  private writeRightLine(line: string): void {
    const max     = this.rw - 1
    const stripped = stripAnsi(line)
    if (stripped.length <= max) {
      process.stdout.write(line + " ".repeat(Math.max(0, max - stripped.length)) + C.reset)
      return
    }
    // Trim preserving ANSI codes
    let vis = 0, idx = 0
    while (idx < line.length && vis < max - 1) {
      if (line[idx] === "\x1b") {
        while (idx < line.length && line[idx] !== "m") idx++
        idx++
      } else { vis++; idx++ }
    }
    process.stdout.write(line.slice(0, idx) + C.reset + " ")
  }

  private renderFooter(): void {
    const row = this.logBottom() + 1
    const s   = this.conductor.status()
    process.stdout.write(`\x1b[${row};0H${C.dim}${"─".repeat(this.tw)}${C.reset}\n`)

    if (s.pendingApprovals > 0) {
      process.stdout.write(` ${C.yellow}${C.bold}⏸  Approval required — type y/n${C.reset}`)
    } else {
      const mode = this.verbose === "quiet" ? "quiet" : this.verbose === "stream" ? "stream" : "summary"
      process.stdout.write(` ${C.dim}Ctrl+C to stop  ·  mode: ${mode}${C.reset}`)
    }
  }
}
