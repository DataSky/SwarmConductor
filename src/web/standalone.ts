import { Conductor } from "../conductor"
import { defaultConfig } from "../dag/types"
import { createTaskNode } from "../dag/engine"
import { WebDashboard } from "./server"
import { GoalStore } from "./goal-store"
import { aiGoalToTaskGraph } from "../cli/ai-planner"
import { goalToTaskGraph } from "../cli/goal-planner"
// Embed ui.html at compile time so the binary is fully self-contained
import UI_HTML from "./ui.html" with { type: "text" }
import { mkdirSync } from "fs"
import { join } from "path"

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunSlot {
  tabId:      string
  runId:      string
  goalId:     string
  goalText:   string
  agents:     number
  status:     "planning" | "running" | "completed" | "failed"
  conductor:  Conductor
  dashboard:  TabDashboard   // per-tab WS broadcaster
  cleanup:    () => void     // stop timers
}

// ─── ANSI stripper (unused directly but kept for future log use) ──────────────
// function stripAnsi(s: string): string { return s.replace(/\x1b\[[^m]*m/g, "") }

// ─── Per-tab WebSocket broadcaster ────────────────────────────────────────────
// Each tab uses a separate WebDashboard but shares the same wss Set (all
// connected browsers). Messages include tabId so the frontend can route them.

class TabDashboard extends WebDashboard {
  constructor(conductor: Conductor, private tabId: string, goal: string) {
    super(conductor, 0, goal)
  }

  // Override start() — subscribe to conductor events only, never start HTTP server
  start(): void {
    this.startEventSubscriptions()
  }

  // Override stop() — only clear timers, no server to stop
  stop(): void {
    this.stopTimers()
  }

  // Override broadcast to inject tabId and use shared wss
  broadcast(msg: object): void {
    const wss: Set<import("bun").ServerWebSocket<unknown>> = (this as any)._standaloneWss
    if (!wss || wss.size === 0) return
    const s = JSON.stringify({ ...msg, tabId: this.tabId })
    for (const ws of wss) {
      try { ws.send(s) } catch { /* disconnected */ }
    }
  }

  attachWss(wss: Set<import("bun").ServerWebSocket<unknown>>): void {
    (this as any)._standaloneWss = wss
  }
}

// ─── StandaloneServer ─────────────────────────────────────────────────────────

export class StandaloneServer {
  private wss      = new Set<import("bun").ServerWebSocket<unknown>>()
  private slots    = new Map<string, RunSlot>()  // tabId → RunSlot
  private goalStore: GoalStore
  private server: ReturnType<typeof Bun.serve> | null = null

  constructor(
    private projectPath: string,
    private port: number,
    private baseAgentPort = 8800,
  ) {
    const conductorDir = join(projectPath, ".conductor")
    mkdirSync(conductorDir, { recursive: true })
    this.goalStore = new GoalStore(conductorDir)
  }

  start(): void {
    const self = this
    this.server = Bun.serve({
      port: this.port,
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === "/ws") {
          const ok = server.upgrade(req, { data: {} })
          return ok ? undefined : new Response("WS upgrade failed", { status: 500 })
        }
        return self.handleHTTP(url)
      },
      websocket: {
        open:    ws => self.onOpen(ws),
        message: (ws, msg) => self.onMessage(ws, msg),
        close:   ws => { self.wss.delete(ws) },
      },
    })
    console.log(`  Swarm Web UI → http://localhost:${this.port}`)
  }

  stop(): void {
    for (const slot of this.slots.values()) slot.cleanup()
    this.goalStore.close()
    this.server?.stop()
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private handleHTTP(url: URL): Response {
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(UI_HTML as unknown as string, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }
    if (url.pathname === "/api/goals") {
      return json(this.goalStore.listGoals(this.projectPath))
    }
    if (url.pathname === "/api/runs") {
      return json(this.goalStore.listRunMeta(this.projectPath))
    }
    if (url.pathname.startsWith("/api/goals/") && url.pathname.endsWith("/runs")) {
      const goalId = url.pathname.split("/")[3]!
      return json(this.goalStore.listRunMeta(undefined, goalId))
    }
    if (url.pathname === "/api/server/state") {
      return json(this.serveState())
    }
    return new Response("Not found", { status: 404 })
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private onOpen(ws: import("bun").ServerWebSocket<unknown>): void {
    this.wss.add(ws)
    // Inject this wss into all existing tab dashboards
    for (const slot of this.slots.values()) {
      (slot.dashboard as TabDashboard).attachWss(this.wss)
    }
    // Send server state so client can render existing tabs
    ws.send(JSON.stringify({ type: "server.state", ...this.serveState() }))
    // Also send latest snapshot for each active slot
    for (const slot of this.slots.values()) {
      const snap = (slot.dashboard as any).buildSnapshotPublic?.()
      if (snap) ws.send(JSON.stringify({ type: "snapshot", tabId: slot.tabId, ...snap }))
    }
  }

  private onMessage(ws: import("bun").ServerWebSocket<unknown>, msg: string | Buffer): void {
    let cmd: Record<string, unknown>
    try { cmd = JSON.parse(String(msg)) } catch { return }

    switch (cmd["type"]) {
      case "start.run":
        this.handleStartRun(cmd, ws).catch(err => {
          const errMsg = String((err as Error).message ?? err)
          console.error(`[standalone] start.run error: ${errMsg}`)
          try { ws.send(JSON.stringify({ type: "run.error", error: errMsg })) } catch { /* disconnected */ }
        })
        break

      case "select.tab": {
        const tabId = String(cmd["tabId"] ?? "")
        const slot  = this.slots.get(tabId)
        if (!slot) { ws.send(JSON.stringify({ type: "run.error", error: "Tab not found" })); return }
        const snap = slot.dashboard.buildSnapshotPublic()
        ws.send(JSON.stringify({ type: "snapshot", tabId, ...snap }))
        break
      }

      case "abort.run": {
        const tabId = String(cmd["tabId"] ?? "")
        const slot  = this.slots.get(tabId)
        if (slot) {
          slot.conductor.shutdown().catch(() => {})
          slot.cleanup()
          this.slots.delete(tabId)
          this.broadcastServerState()
        }
        break
      }

      // Forward tab-specific commands to the right conductor
      case "pause": case "resume": case "inject": case "interrupt": case "approve": {
        const tabId = String(cmd["tabId"] ?? "")
        const slot  = this.slots.get(tabId)
        if (!slot) break
        this.forwardToSlot(slot, cmd)
        break
      }
    }
  }

  private forwardToSlot(slot: RunSlot, cmd: Record<string, unknown>): void {
    const conductor = slot.conductor
    switch (cmd["type"]) {
      case "pause":
        conductor.stopScheduler()
        break
      case "resume":
        conductor.startScheduler()
        break
      case "inject": {
        const prompt = String(cmd["prompt"] ?? "").trim()
        if (!prompt) break
        const node = createTaskNode({
          type: "implement",
          title: prompt.slice(0, 80),
          prompt: `[Web intervention]\n\n${prompt}\n\n---\nOutput MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`,
          scope: [],
          priority: 999,
        })
        conductor.taskDag.addTask(node)
        break
      }
      case "interrupt": {
        const agentId = String(cmd["agentId"] ?? "")
        try {
          const mgr = (conductor as any).agentMgr
          const inst = mgr.getInstance(agentId)
          if (inst?.threadId) mgr.getClient(agentId).interruptThread(inst.threadId).catch(() => {})
        } catch { /* ignore */ }
        break
      }
      case "approve": {
        const reqId    = String(cmd["requestId"] ?? "")
        const decision = cmd["decision"] === "approved" ? "approved" : "rejected"
        conductor.approvalGate.resolve(reqId, decision)
        if (decision === "approved") conductor.startScheduler()
        break
      }
    }
  }

  // ── Start a new run ───────────────────────────────────────────────────────

  private async handleStartRun(cmd: Record<string, unknown>, originWs: import("bun").ServerWebSocket<unknown>): Promise<void> {
    const goalText    = String(cmd["goalText"] ?? "").trim()
    const goalId      = cmd["goalId"] ? String(cmd["goalId"]) : null
    const agents      = Math.max(1, Math.min(20, Number(cmd["agents"] ?? 3)))
    const noAiPlan    = cmd["noAiPlan"] === true
    const modelWorker = cmd["modelWorker"] ? String(cmd["modelWorker"]) : null

    const sendError = (msg: string, tabId?: string) => {
      const payload = JSON.stringify({ type: "run.error", error: msg, ...(tabId ? { tabId } : {}) })
      try { originWs.send(payload) } catch { /* disconnected */ }
      this.broadcast({ type: "run.error", error: msg, ...(tabId ? { tabId } : {}) })
    }

    if (!goalText && !goalId) { sendError("Goal cannot be empty"); return }

    // Resolve goal text
    const resolvedGoalText = goalText ||
      this.goalStore.listGoals(this.projectPath, 50).find(g => g.id === goalId)?.text || ""
    if (!resolvedGoalText) { sendError("Goal not found"); return }

    const finalGoalId = goalText
      ? this.goalStore.createGoal(goalText, this.projectPath)
      : (goalId ?? this.goalStore.createGoal(resolvedGoalText, this.projectPath))

    // Allocate tabId and base port
    const tabId = this.nextTabId()
    const nextBasePort = this.baseAgentPort + this.slots.size * 20

    // Build config
    const modelMap: Record<string, string> = {}
    if (modelWorker) {
      for (const role of ["explore","plan","implementer","review","verifier","general"])
        modelMap[role] = modelWorker
    }
    const config = defaultConfig({
      projectPath: this.projectPath,
      maxConcurrentAgents: agents,
      basePort: nextBasePort,
      autoApprove: true,
      dynamicTasks: true,
      modelMap,
    })

    // ── Planning phase ───────────────────────────────────────────────────────
    // Broadcast planning state to client BEFORE we block on AI planning
    this.broadcast({ type: "run.planning", tabId, goalText: resolvedGoalText })

    let taskNodes
    try {
      if (noAiPlan) {
        taskNodes = goalToTaskGraph(resolvedGoalText, this.projectPath).nodes
      } else {
        try {
          taskNodes = (await aiGoalToTaskGraph(resolvedGoalText, this.projectPath)).nodes
        } catch (aiErr) {
          // AI planner failed → fall back silently
          taskNodes = goalToTaskGraph(resolvedGoalText, this.projectPath).nodes
        }
      }
    } catch (err) {
      sendError(`Planning failed: ${(err as Error).message}`, tabId)
      return
    }

    // ── Conductor setup ──────────────────────────────────────────────────────
    const conductor = new Conductor(config)
    await conductor.initialize()
    conductor.taskDag.addTasks(taskNodes)
    this.goalStore.upsertRunMeta(conductor.runId, finalGoalId, this.projectPath, agents)

    const dashboard = new TabDashboard(conductor, tabId, resolvedGoalText)
    dashboard.attachWss(this.wss)
    dashboard.start()

    const slot: RunSlot = {
      tabId,
      runId: conductor.runId,
      goalId: finalGoalId,
      goalText: resolvedGoalText,
      agents,
      status: "running",
      conductor,
      dashboard,
      cleanup: () => { dashboard.stop() },
    }
    // Register slot BEFORE broadcasting server.state so the tab appears correctly
    this.slots.set(tabId, slot)
    this.broadcastServerState()

    // Send initial snapshot for this tab so client can switch to it
    try {
      const snap = dashboard.buildSnapshotPublic()
      this.broadcast({ type: "snapshot", tabId, ...snap })
    } catch { /* ok */ }

    // ── Spawn agents ─────────────────────────────────────────────────────────
    try {
      const roles = Array(Math.min(agents, taskNodes.length)).fill("general") as "general"[]
      await conductor.spawnAgents(roles)
    } catch (err) {
      sendError(`Agent spawn failed: ${(err as Error).message}`, tabId)
      slot.status = "failed"
      slot.cleanup()
      this.slots.delete(tabId)
      this.broadcastServerState()
      return
    }

    conductor.startScheduler()

    // Wait for completion (non-blocking)
    conductor.waitForCompletion(3_600_000).then(result => {
      slot.status = result === "completed" ? "completed" : "failed"
      let tokenTotal = 0, costUsd = 0
      try {
        const tk = conductor.store.tokenStats()
        tokenTotal = tk.totalTokens
        costUsd = (tk.inputTokens * 15 + tk.outputTokens * 75) / 1_000_000
      } catch { /* ok */ }
      this.goalStore.finishRunMeta(conductor.runId, slot.status, tokenTotal, costUsd)
      this.broadcastServerState()
      conductor.shutdown().catch(() => {})
    })
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private serveState(): object {
    return {
      project: this.projectPath,
      tabs: [...this.slots.values()].map(s => ({
        tabId:    s.tabId,
        runId:    s.runId,
        goalId:   s.goalId,
        goalText: s.goalText,
        agents:   s.agents,
        status:   s.status,
      })),
      recentGoals: this.goalStore.listGoals(this.projectPath, 5),
    }
  }

  private broadcast(msg: object): void {
    const s = JSON.stringify(msg)
    for (const ws of this.wss) {
      try { ws.send(s) } catch { /* disconnected */ }
    }
  }

  private broadcastServerState(): void {
    this.broadcast({ type: "server.state", ...this.serveState() })
  }

  private nextTabId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  }
}
