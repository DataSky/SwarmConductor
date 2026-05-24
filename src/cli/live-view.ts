import { createInterface } from "readline"
import type { Conductor } from "../conductor"
import type { TaskNode } from "../dag/types"

// ─── ANSI ─────────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
  gray: "\x1b[90m", white: "\x1b[97m", bgDark: "\x1b[48;5;235m",
}

const statusIcon: Record<string, string> = {
  done:        `${C.green}✓${C.reset}`,
  running:     `${C.cyan}⟳${C.reset}`,
  ready:       `${C.blue}○${C.reset}`,
  blocked:     `${C.dim}…${C.reset}`,
  failed:      `${C.red}✗${C.reset}`,
  interrupted: `${C.yellow}!${C.reset}`,
  pending:     `${C.dim}·${C.reset}`,
}

function bar(done: number, total: number, width = 24): string {
  if (total === 0) return " ".repeat(width)
  const filled = Math.round((done / total) * width)
  return `${C.green}${"█".repeat(filled)}${C.reset}${C.dim}${"░".repeat(width - filled)}${C.reset}`
}

function elapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

// ─── Layout constants ─────────────────────────────────────────────────────────

const HEADER_ROWS   = 3   // header + blank
const FOOTER_ROWS   = 1
const LEFT_WIDTH    = 38  // task list column width
const MIN_SCROLL_H  = 8   // minimum scroll area height

// ─── AgentSlot ────────────────────────────────────────────────────────────────
// Tracks the running state for one agent in the right panel.

interface AgentSlot {
  agentId: string
  taskId: string
  title: string
  role: string
  startedAt: number
  buffer: string      // accumulated token stream (last N chars)
  lineCount: number   // how many lines this slot has printed
}

// ─── LiveView ─────────────────────────────────────────────────────────────────

export class LiveView {
  private conductor: Conductor
  private slots = new Map<string, AgentSlot>()
  private scrollLines: string[] = []
  private maxScrollLines = 400
  private termWidth  = process.stdout.columns || 120
  private termHeight = process.stdout.rows    || 30
  private leftWidth  = Math.min(LEFT_WIDTH, Math.floor((process.stdout.columns || 120) * 0.35))
  private rightWidth = (process.stdout.columns || 120) - Math.min(LEFT_WIDTH, Math.floor((process.stdout.columns || 120) * 0.35)) - 3
  private tickInterval: ReturnType<typeof setInterval> | null = null
  private rl: ReturnType<typeof createInterface> | null = null

  constructor(conductor: Conductor) {
    this.conductor = conductor
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  start(): void {
    // Resize handler
    process.stdout.on("resize", () => {
      this.termWidth  = process.stdout.columns || 120
      this.termHeight = process.stdout.rows    || 30
      this.leftWidth  = Math.min(LEFT_WIDTH, Math.floor(this.termWidth * 0.35))
      this.rightWidth = this.termWidth - this.leftWidth - 3
      this.fullRedraw()
    })

    // Subscribe to token stream
    this.conductor.onStream((agentId, task, delta) => {
      this.handleDelta(agentId, task, delta)
    })

    // Subscribe to conductor events for slot lifecycle
    this.conductor.onEvent(e => {
      if (e.kind === "task.status_changed") {
        const taskId = e.payload["taskId"] as string
        const next   = e.payload["next"]   as string
        const task   = this.conductor.taskDag.getTask(taskId)
        if (!task) return

        if (next === "running") {
          // Open a new slot for this task
          const agentId = task.assignedTo ?? taskId
          this.slots.set(agentId, {
            agentId, taskId,
            title: task.title,
            role: task.type,
            startedAt: Date.now(),
            buffer: "",
            lineCount: 0,
          })
          this.appendScroll(`${C.bold}${C.cyan}▶ [${task.type}] ${task.title}${C.reset}`)

        } else if (next === "done" || next === "failed" || next === "interrupted") {
          const agentId = [...this.slots.entries()]
            .find(([, s]) => s.taskId === taskId)?.[0]
          if (agentId) {
            const slot = this.slots.get(agentId)!
            const dur = elapsed(Date.now() - slot.startedAt)
            const tok = task.tokenUsage
            const tokStr = tok ? ` · ${C.yellow}${tok.inputTokens.toLocaleString()} tok${C.reset}` : ""
            const icon = next === "done" ? `${C.green}✓` : `${C.red}✗`
            this.appendScroll(`${icon} [${task.type}] ${task.title}${C.reset}  ${C.dim}${dur}${tokStr}${C.reset}`)

            if (next === "done" && task.output?.summary) {
              this.appendTaskSummary(task)
            }
            this.slots.delete(agentId)
          }

        } else if (next === "blocked") {
          // no visual noise for normal blocked transitions
        }
      }

      if (e.kind === "phase.completed") {
        const sep = "─".repeat(Math.min(this.rightWidth, 50))
        this.appendScroll(`${C.dim}${sep}${C.reset}`)
        this.appendScroll(`${C.bold}Phase ${e.payload["phase"]} complete${C.reset}`)
        this.appendScroll(`${C.dim}${sep}${C.reset}`)
      }

      if (e.kind === "task.dynamic_inserted") {
        this.appendScroll(`${C.magenta}⊕ dynamic: ${e.payload["title"]}${C.reset}`)
      }

      if (e.kind === "approval.required") {
        this.appendScroll(`${C.yellow}${C.bold}⏸  Approval required — scheduler paused${C.reset}`)
      }
    })

    // Initial clear + draw
    this.fullRedraw()

    // Redraw left panel (task list) periodically
    this.tickInterval = setInterval(() => this.refreshLeft(), 500)
  }

  stop(): void {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null }
    this.rl?.close()
    // Move cursor to safe position below everything
    process.stdout.write(`\x1b[${this.termHeight};0H\n`)
  }

  // Prompt the user for a follow-up task injection (called from interactive runner)
  promptFollowup(_completedTask: TaskNode): Promise<string> {
    return new Promise(resolve => {
      this.appendScroll(`${C.cyan}追加任务？${C.reset}${C.dim}(回车跳过)${C.reset}`)
      this.renderBottom()

      if (!process.stdin.isTTY) { resolve(""); return }

      const rl = createInterface({ input: process.stdin, output: process.stdout })
      this.rl = rl

      const inputRow = this.scrollAreaBottom()
      process.stdout.write(`\x1b[${inputRow};${this.leftWidth + 4}H${C.cyan}> ${C.reset}`)

      rl.once("line", (input: string) => {
        rl.close()
        this.rl = null
        if (input.trim()) {
          this.appendScroll(`${C.cyan}→ 已插入: "${input.trim()}"${C.reset}`)
        }
        resolve(input.trim())
      })
    })
  }

  // ── Token stream handler ────────────────────────────────────────────────────

  private handleDelta(agentId: string, task: TaskNode, delta: string): void {
    let slot = this.slots.get(agentId)
    if (!slot) {
      // Slot may not have been created yet (race), create it now
      slot = {
        agentId, taskId: task.id,
        title: task.title, role: task.type,
        startedAt: Date.now(), buffer: "", lineCount: 0,
      }
      this.slots.set(agentId, slot)
    }
    slot.buffer += delta

    // Only show lines that end with newline (complete thoughts), or flush long buffers
    const lines = slot.buffer.split("\n")
    if (lines.length > 1) {
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim()
        if (line) {
          const agentLabel = `${C.dim}[${task.type.slice(0, 3)}]${C.reset}`
          this.appendScroll(`  ${agentLabel} ${line.slice(0, this.rightWidth - 8)}`)
          slot.lineCount++
        }
      }
      slot.buffer = lines[lines.length - 1]!
    } else if (slot.buffer.length > this.rightWidth - 8) {
      // Flush long unbuffered line
      const agentLabel = `${C.dim}[${task.type.slice(0, 3)}]${C.reset}`
      this.appendScroll(`  ${agentLabel} ${slot.buffer.trim().slice(0, this.rightWidth - 8)}`)
      slot.buffer = ""
      slot.lineCount++
    }
  }

  // ── Task summary ────────────────────────────────────────────────────────────

  private appendTaskSummary(task: TaskNode): void {
    if (!task.output) return
    const w = this.rightWidth - 4

    this.appendScroll(`${C.dim}  ┌${"─".repeat(Math.min(w, 54))}${C.reset}`)
    for (const line of task.output.summary.split("\n").slice(0, 5)) {
      const t = line.trim()
      if (t) this.appendScroll(`${C.dim}  │${C.reset} ${t.slice(0, w)}`)
    }
    for (const r of task.output.risks.slice(0, 2)) {
      if (r.trim()) this.appendScroll(`${C.dim}  │${C.reset} ${C.yellow}⚠${C.reset} ${r.trim().slice(0, w - 2)}`)
    }
    for (const b of task.output.blockers.slice(0, 1)) {
      if (b.trim()) this.appendScroll(`${C.dim}  │${C.reset} ${C.red}✗${C.reset} ${b.trim().slice(0, w - 2)}`)
    }
    this.appendScroll(`${C.dim}  └${"─".repeat(Math.min(w, 54))}${C.reset}`)
  }

  // ── Scroll buffer ────────────────────────────────────────────────────────────

  private appendScroll(line: string): void {
    this.scrollLines.push(line)
    if (this.scrollLines.length > this.maxScrollLines) {
      this.scrollLines.shift()
    }
    this.renderScrollLine(line)
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  private scrollAreaHeight(): number {
    return Math.max(MIN_SCROLL_H, this.termHeight - HEADER_ROWS - FOOTER_ROWS - 2)
  }

  private scrollAreaBottom(): number {
    return HEADER_ROWS + this.scrollAreaHeight() + 1
  }

  private fullRedraw(): void {
    process.stdout.write("\x1b[2J\x1b[H")   // clear screen, cursor to top
    this.renderHeader()
    this.renderDivider()
    this.renderLeft()
    // Render the last N lines of scroll buffer into right pane
    const h = this.scrollAreaHeight()
    const visible = this.scrollLines.slice(-h)
    for (let i = 0; i < visible.length; i++) {
      this.renderRightLine(HEADER_ROWS + 1 + i, visible[i]!)
    }
    this.renderBottom()
  }

  private renderHeader(): void {
    const s = this.conductor.status()
    const done = s.tasks.done, total = s.tasks.total
    const pct = total === 0 ? 0 : Math.round((done / total) * 100)
    const now = new Date().toLocaleTimeString("en-GB", { hour12: false })

    let tokStr = ""
    try {
      const tok = this.conductor.store.tokenStats()
      if (tok.totalTokens > 0) {
        tokStr = `  ${C.yellow}${tok.totalTokens.toLocaleString()}tok${C.reset} ${C.green}${tok.cacheHitRate}%cache${C.reset}`
      }
    } catch { /* ok */ }

    const title = `SWARM CONDUCTOR  Phase ${s.phase}  ${bar(done, total)}  ${done}/${total} (${pct}%)${tokStr}`
    process.stdout.write(`\x1b[1;0H`)  // row 1, col 1
    process.stdout.write(`${C.bold}${C.bgDark} ${title.padEnd(this.termWidth - 2)} ${C.reset}\n`)
    process.stdout.write(
      `${C.dim} idle:${s.agents.idle}  busy:${s.agents.busy}  locks:${s.locks}` +
      `  running:${s.tasks.running}  ready:${s.tasks.ready}  blocked:${s.tasks.blocked}  failed:${s.tasks.failed}` +
      `  ${now}${C.reset}`.padEnd(this.termWidth) + "\n"
    )
  }

  private renderDivider(): void {
    // Vertical divider between left and right — draw once on full redraw
    const h = this.scrollAreaHeight()
    for (let r = 0; r < h + 2; r++) {
      const row = HEADER_ROWS + r
      process.stdout.write(`\x1b[${row};${this.leftWidth + 1}H${C.dim}│${C.reset}`)
    }
  }

  private renderLeft(): void {
    const tasks = this.conductor.taskDag.allTasks()
    const h = this.scrollAreaHeight()
    const startRow = HEADER_ROWS + 1

    // Header
    process.stdout.write(`\x1b[${startRow};1H`)
    process.stdout.write(`${C.bold} ${"TASKS".padEnd(this.leftWidth - 2)}${C.reset}`)

    for (let i = 0; i < Math.min(h - 1, tasks.length); i++) {
      const t = tasks[i]!
      const row = startRow + 1 + i
      process.stdout.write(`\x1b[${row};1H`)

      const icon = statusIcon[t.status] ?? "·"
      let line: string
      const dur = (t.startedAt && t.status === "running")
        ? ` ${C.dim}${elapsed(Date.now() - t.startedAt)}${C.reset}` : ""
      const title = t.title.slice(0, this.leftWidth - 5)

      if (t.status === "running") {
        line = ` ${icon} ${C.cyan}${title}${C.reset}${dur}`
      } else if (t.status === "done") {
        line = ` ${icon} ${C.dim}${title}${C.reset}`
      } else {
        line = ` ${icon} ${title}${dur}`
      }

      // Pad to left width and clear rest of line in left column
      const stripped = line.replace(/\x1b\[[^m]*m/g, "")
      const pad = Math.max(0, this.leftWidth - stripped.length)
      process.stdout.write(line + " ".repeat(pad))
    }

    // Clear remaining rows in left pane
    for (let i = tasks.length; i < h - 1; i++) {
      process.stdout.write(`\x1b[${startRow + 1 + i};1H${" ".repeat(this.leftWidth)}`)
    }
  }

  private refreshLeft(): void {
    this.renderHeader()
    this.renderLeft()
    this.renderBottom()
  }

  private renderScrollLine(_line: string): void {
    const h = this.scrollAreaHeight()
    const startRow = HEADER_ROWS + 2  // +1 for tasks header

    // Scroll visible area up by 1, then write new line at bottom
    // Simple approach: re-render last N lines of scroll buffer
    const visible = this.scrollLines.slice(-h)
    for (let i = 0; i < visible.length; i++) {
      this.renderRightLine(startRow + i, visible[i]!)
    }
    // Clear any line below (in case count decreased)
    if (visible.length < h) {
      process.stdout.write(`\x1b[${startRow + visible.length};${this.leftWidth + 3}H${" ".repeat(this.rightWidth)}`)
    }
  }

  private renderRightLine(row: number, line: string): void {
    process.stdout.write(`\x1b[${row};${this.leftWidth + 3}H`)
    // Truncate to right panel width (accounting for ANSI codes)
    const stripped = line.replace(/\x1b\[[^m]*m/g, "")
    const maxLen = this.rightWidth
    let out = line
    if (stripped.length > maxLen) {
      // Trim visible characters while keeping ANSI codes intact
      let vis = 0, idx = 0
      while (idx < line.length && vis < maxLen - 1) {
        if (line[idx] === "\x1b") {
          while (idx < line.length && line[idx] !== "m") idx++
          idx++
        } else {
          vis++; idx++
        }
      }
      out = line.slice(0, idx) + C.reset
    }
    process.stdout.write(out + " ".repeat(Math.max(0, maxLen - stripped.length)) + C.reset)
  }

  private renderBottom(): void {
    const row = this.scrollAreaBottom() + 1
    process.stdout.write(`\x1b[${row};0H`)
    const s = this.conductor.status()
    const aStr = s.pendingApprovals > 0
      ? `${C.yellow}${C.bold}⏸ APPROVAL PENDING${C.reset}`
      : `${C.dim}Press Ctrl+C to stop${C.reset}`
    process.stdout.write(`${C.dim}${"─".repeat(this.termWidth)}${C.reset}\n`)
    process.stdout.write(` ${aStr}`)
  }
}
