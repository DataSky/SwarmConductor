import type { Conductor } from "../conductor"
import type { ConductorEvent, TaskNode } from "../dag/types"
import { createTaskNode } from "../dag/engine"
// Embed ui.html at compile time so the binary is fully self-contained
import UI_HTML from "./ui.html" with { type: "text" }

// ─── Types ────────────────────────────────────────────────────────────────────

interface AgentSlotInfo {
  agentId:   string
  taskId:    string
  title:     string
  type:      string
  scope:     string[]
  startedAt: number
  lastLine:  string
  model:     string | null
  tokenBuf:  string   // not sent to client; used for lastLine update
}

interface PhaseRecord {
  phase:   number
  startMs: number
  endMs:   number | null
}

// ─── ANSI stripper (same logic as live-view) ──────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[^m]*m/g, "")
}

// ─── WebDashboard ─────────────────────────────────────────────────────────────

export class WebDashboard {
  private wss     = new Set<import("bun").ServerWebSocket<unknown>>()
  private logRing: string[] = []
  private agentSlots  = new Map<string, AgentSlotInfo>()
  private phaseHistory: PhaseRecord[] = []
  private deltaBuf    = new Map<string, string>()   // agentId → accumulated delta for current frame
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private tickTimer:  ReturnType<typeof setInterval> | null = null
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(
    private conductor: Conductor,
    private port: number,
    private goal: string = "",
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start(): void {
    this.startEventSubscriptions()

    const self = this
    this.server = Bun.serve({
      port: this.port,
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === "/ws") {
          const ok = server.upgrade(req, { data: {} })
          return ok ? undefined : new Response("WS upgrade failed", { status: 500 })
        }
        return self.handleHTTP(req, url)
      },
      websocket: {
        open:    (ws: import("bun").ServerWebSocket<unknown>) => self.onWsOpen(ws),
        message: (ws: import("bun").ServerWebSocket<unknown>, msg: string | Buffer) => self.onWsMessage(ws, msg),
        close:   (ws: import("bun").ServerWebSocket<unknown>) => { self.wss.delete(ws) },
      },
    })
  }

  stop(): void {
    this.stopTimers()
    this.server?.stop()
  }

  protected startEventSubscriptions(): void {
    this.conductor.onEvent(e => this.handleConductorEvent(e))
    this.conductor.onStream((agentId, task, delta, model) =>
      this.handleDelta(agentId, task, delta, model))
    // 16 ms flush: batch token deltas into one WS frame per agent per frame
    this.flushTimer = setInterval(() => this.flushDeltas(), 16)
    // 2 s tick: push status + task snapshot
    this.tickTimer = setInterval(() => this.pushTick(), 2000)
  }

  protected stopTimers(): void {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    if (this.tickTimer)  { clearInterval(this.tickTimer);  this.tickTimer  = null }
  }

  // ── HTTP handler ─────────────────────────────────────────────────────────────

  private handleHTTP(_req: Request, url: URL): Response {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(UI_HTML as unknown as string, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }

    if (url.pathname === "/api/state") {
      return this.jsonResponse(this.buildSnapshot())
    }

    if (url.pathname === "/api/runs") {
      try {
        const runs = this.conductor.store.listRuns(
          (this.conductor as unknown as { config: { projectPath: string } }).config.projectPath
        )
        return this.jsonResponse(runs)
      } catch {
        return this.jsonResponse([])
      }
    }

    if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/tasks")) {
      // Historical run tasks — read from DB (same conductor store, different runId via ad-hoc query)
      // For simplicity, return current run tasks only; a full implementation would open a second DB connection
      return this.jsonResponse(this.conductor.taskDag.allTasks())
    }

    if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/events")) {
      try {
        return this.jsonResponse(this.conductor.store.getRecentEvents(200))
      } catch {
        return this.jsonResponse([])
      }
    }

    return new Response("Not found", { status: 404 })
  }

  private jsonResponse(data: unknown): Response {
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    })
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  private onWsOpen(ws: import("bun").ServerWebSocket<unknown>): void {
    this.wss.add(ws)
    // Send full snapshot immediately so client can render without waiting for tick
    ws.send(JSON.stringify({ type: "snapshot", ...this.buildSnapshot() }))
  }

  private onWsMessage(_ws: import("bun").ServerWebSocket<unknown>, msg: string | Buffer): void {
    let cmd: Record<string, unknown>
    try { cmd = JSON.parse(String(msg)) } catch { return }

    switch (cmd["type"]) {
      case "pause":
        this.conductor.stopScheduler()
        this.pushLog("⏸ Paused by web client")
        break

      case "resume":
        this.conductor.startScheduler()
        this.pushLog("▶ Resumed by web client")
        break

      case "inject": {
        const prompt = String(cmd["prompt"] ?? "").trim()
        if (!prompt) break
        const priority = typeof cmd["priority"] === "number" ? cmd["priority"] : 999
        const node = createTaskNode({
          type: "implement",
          title: prompt.slice(0, 80),
          prompt: `[Web intervention]\n\n${prompt}\n\n---\nOutput MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`,
          scope: [],
          priority,
        })
        this.conductor.taskDag.addTask(node)
        this.pushLog(`⊕ Task injected: "${prompt.slice(0, 60)}"`)
        break
      }

      case "interrupt": {
        const agentId = String(cmd["agentId"] ?? "")
        const slot = this.agentSlots.get(agentId)
        if (slot) {
          // Get client for this agent via conductor internals
          try {
            const agentMgr = (this.conductor as unknown as { agentMgr: { getClient: (id: string) => { interruptThread: (tid: string) => Promise<void> }, getInstance: (id: string) => { threadId: string | null } | undefined } }).agentMgr
            const inst = agentMgr.getInstance(agentId)
            if (inst?.threadId) {
              agentMgr.getClient(agentId).interruptThread(inst.threadId).catch(() => {})
              this.pushLog(`✗ Agent ${agentId.slice(-8)} interrupted by web client`)
            }
          } catch { /* ignore */ }
        }
        break
      }

      case "approve": {
        const reqId   = String(cmd["requestId"] ?? "")
        const decision = cmd["decision"] === "approved" ? "approved" : "rejected"
        const pending  = this.conductor.approvalGate.pendingRequests()
        const req = pending.find(r => r.id === reqId)
        if (req) {
          this.conductor.approvalGate.resolve(reqId, decision)
          this.pushLog(`${decision === "approved" ? "✓" : "✗"} Approval ${decision} by web client`)
          if (decision === "approved") this.conductor.startScheduler()
        }
        break
      }
    }
  }

  // ── Conductor event handlers ─────────────────────────────────────────────────

  private handleConductorEvent(e: ConductorEvent): void {
    // Maintain local state mirrors
    if (e.kind === "phase.started") {
      const phase = e.payload["phase"] as number
      const prev  = this.phaseHistory[this.phaseHistory.length - 1]
      if (prev && prev.endMs === null) prev.endMs = e.timestamp
      this.phaseHistory.push({ phase, startMs: e.timestamp, endMs: null })
    }

    if (e.kind === "task.status_changed") {
      const taskId = e.payload["taskId"] as string
      const next   = e.payload["next"]   as string
      const task   = this.conductor.taskDag.getTask(taskId)

      if (next === "running" && task) {
        const agentId = task.assignedTo ?? taskId
        // Try to pick up the model already stored in the agent instance
        const agentMgr = (this.conductor as unknown as { agentMgr: { getInstance: (id: string) => { model: string | null } | undefined } }).agentMgr
        const knownModel = agentMgr.getInstance(agentId)?.model ?? null
        this.agentSlots.set(agentId, {
          agentId, taskId, title: task.title, type: task.type,
          scope: task.scope, startedAt: Date.now(),
          lastLine: "", model: knownModel, tokenBuf: "",
        })
        this.pushLog(`⟳ [${task.type.slice(0, 3)}] ${task.title}`)
      }

      if ((next === "done" || next === "failed" || next === "interrupted") && task) {
        const agentId = [...this.agentSlots.entries()]
          .find(([, s]) => s.taskId === taskId)?.[0]
        if (agentId) this.agentSlots.delete(agentId)

        const icon = next === "done" ? "✓" : "✗"
        const tok  = task.tokenUsage
        const tokStr = tok ? ` · ${(tok.inputTokens + tok.outputTokens).toLocaleString()} tok` : ""
        this.pushLog(`${icon} [${task.type.slice(0, 3)}] ${task.title}${tokStr}`)
        if (next === "done" && task.output?.summary) {
          this.pushLog(`  ${task.output.summary.split("\n")[0]?.slice(0, 100) ?? ""}`)
        }
      }
    }

    if (e.kind === "task.dynamic_inserted") {
      this.pushLog(`⊕ inserted: ${e.payload["title"]}`)
    }

    if (e.kind === "approval.required") {
      this.pushLog(`⏸ Approval required`)
      // Push the real pending requests so client has actual ids
      this.broadcast({
        type: "approval.required",
        requests: this.conductor.approvalGate.pendingRequests(),
      })
    } else if (e.kind === "run.completed" || e.kind === "run.failed") {
      // Close the last open phase
      const last = this.phaseHistory[this.phaseHistory.length - 1]
      if (last && last.endMs === null) last.endMs = e.timestamp

      // Build and broadcast final report
      const allTasks = this.conductor.taskDag.allTasks()
      const done   = allTasks.filter(t => t.status === "done")
      const failed = allTasks.filter(t => t.status === "failed")
      let tokenStats = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0 }
      try { tokenStats = this.conductor.store.tokenStats() } catch { /* ok */ }
      this.broadcast({
        type: "run.finished",
        result: e.kind === "run.completed" ? "completed" : "failed",
        runId: this.conductor.runId,
        tasks: { total: allTasks.length, done: done.length, failed: failed.length },
        tokenStats,
        phaseHistory: this.phaseHistory,
        summaries: done.map(t => ({
          id: t.id, title: t.title, type: t.type,
          summary: t.output?.summary ?? "",
          risks: t.output?.risks ?? [],
          blockers: t.output?.blockers ?? [],
          changes: t.output?.changes ?? [],
          tokenUsage: t.tokenUsage ?? null,
          durationMs: (t.startedAt && t.completedAt) ? t.completedAt - t.startedAt : null,
        })),
        errors: failed.map(t => ({ id: t.id, title: t.title, error: t.error })),
      })
    }

    // Broadcast event to all connected clients
    this.broadcast({ type: "event", kind: e.kind, payload: e.payload, timestamp: e.timestamp })
  }

  private handleDelta(agentId: string, _task: TaskNode, delta: string, model: string | null): void {
    const slot = this.agentSlots.get(agentId)
    if (slot) {
      if (model && !slot.model) slot.model = model
      slot.tokenBuf += delta
      const lines = slot.tokenBuf.split("\n")
      const last  = lines.slice(0, -1).map(l => l.trim()).filter(Boolean).at(-1)
      if (last) slot.lastLine = last.slice(0, 120)
      if (slot.tokenBuf.length > 8192) slot.tokenBuf = slot.tokenBuf.slice(-4096)
    }
    // Accumulate in deltaBuf for batched flush
    this.deltaBuf.set(agentId, (this.deltaBuf.get(agentId) ?? "") + delta)
  }

  // ── Flush & tick ──────────────────────────────────────────────────────────────

  private flushDeltas(): void {
    if (this.deltaBuf.size === 0) return
    for (const [agentId, text] of this.deltaBuf) {
      const slot = this.agentSlots.get(agentId)
      this.broadcast({
        type: "delta",
        agentId,
        taskId: slot?.taskId ?? "",
        model:  slot?.model  ?? null,
        text,
      })
    }
    this.deltaBuf.clear()
  }

  private pushTick(): void {
    let tokenStats = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0 }
    try { tokenStats = this.conductor.store.tokenStats() } catch { /* db may be closed */ }
    this.broadcast({
      type: "tick",
      status:     this.conductor.status(),
      tokenStats,
      tasks:      this.conductor.taskDag.allTasks(),
      agents:     this.agentSlotsArray(),
      phaseHistory: this.phaseHistory,
    })
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private pushLog(line: string): void {
    const clean = stripAnsi(line)
    this.logRing.push(clean)
    if (this.logRing.length > 200) this.logRing.shift()
    this.broadcast({ type: "log", line: clean })
  }

  protected broadcast(msg: object): void {
    if (this.wss.size === 0) return
    const s = JSON.stringify(msg)
    for (const ws of this.wss) {
      try { ws.send(s) } catch { /* client disconnected */ }
    }
  }

  buildSnapshotPublic(): object { return this.buildSnapshot() }

  private buildSnapshot(): object {
    let tokenStats = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0 }
    try { tokenStats = this.conductor.store.tokenStats() } catch { /* ok */ }
    return {
      runId:        this.conductor.runId,
      goal:         this.goal,
      phase:        this.conductor.taskDag.phase,
      status:       this.conductor.status(),
      tasks:        this.conductor.taskDag.allTasks(),
      tokenStats,
      phaseHistory: this.phaseHistory,
      agents:       this.agentSlotsArray(),
      log:          [...this.logRing],
      pendingApprovals: this.conductor.approvalGate.pendingRequests(),
    }
  }

  private agentSlotsArray() {
    return [...this.agentSlots.values()].map(s => ({
      agentId:   s.agentId,
      taskId:    s.taskId,
      title:     s.title,
      type:      s.type,
      scope:     s.scope,
      startedAt: s.startedAt,
      lastLine:  s.lastLine,
      model:     s.model,
    }))
  }
}
