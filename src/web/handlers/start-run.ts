import { Conductor } from "../../conductor"
import { defaultConfig } from "../../dag/types"
import { aiGoalToTaskGraph } from "../../cli/ai-planner"
import { goalToTaskGraph } from "../../cli/goal-planner"
import { AgentProcessManager } from "../../runtime/agent-manager"
import { WebDashboard } from "../server"
import type { GoalStore } from "../goal-store"
import type { WarmPool } from "../../runtime/warm-pool"
import type { PortPool } from "./port-pool"
import { createTaskNode } from "../../dag/engine"
import { join } from "path"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunSlot {
  tabId:     string
  runId:     string
  goalId:    string
  goalText:  string
  agents:    number
  basePort:  number
  status:    "planning" | "running" | "completed" | "failed"
  conductor: Conductor
  dashboard: TabDashboard
  cleanup:   () => void
}

// ─── Per-tab WebSocket broadcaster ───────────────────────────────────────────

export class TabDashboard extends WebDashboard {
  constructor(conductor: Conductor, private tabId: string, goal: string) {
    super(conductor, 0, goal)
  }
  start(): void { this.startEventSubscriptions() }
  stop():  void { this.stopTimers() }

  broadcast(msg: object): void {
    const wss: Set<import("bun").ServerWebSocket<unknown>> = (this as unknown as { _wss: Set<import("bun").ServerWebSocket<unknown>> })._wss
    if (!wss || wss.size === 0) return
    const s = JSON.stringify({ ...msg, tabId: this.tabId })
    for (const ws of wss) {
      try { ws.send(s) } catch { /* disconnected */ }
    }
  }

  attachWss(wss: Set<import("bun").ServerWebSocket<unknown>>): void {
    (this as unknown as { _wss: Set<import("bun").ServerWebSocket<unknown>> })._wss = wss
  }
}

// ─── handleStartRun ───────────────────────────────────────────────────────────

export async function handleStartRun(opts: {
  cmd: Record<string, unknown>
  originWs: import("bun").ServerWebSocket<unknown>
  wss: Set<import("bun").ServerWebSocket<unknown>>
  slots: Map<string, RunSlot>
  goalStore: GoalStore
  warmPool: WarmPool
  portPool: PortPool
  projectPath: string
  broadcast: (msg: object) => void
  broadcastServerState: () => void
  nextTabId: () => string
}): Promise<void> {
  const {
    cmd, originWs, wss, slots, goalStore, warmPool, portPool,
    projectPath, broadcast, broadcastServerState, nextTabId,
  } = opts

  const goalText    = String(cmd["goalText"] ?? "").trim()
  const goalId      = cmd["goalId"] ? String(cmd["goalId"]) : null
  const agents      = Math.max(1, Math.min(20, Number(cmd["agents"] ?? 3)))
  const noAiPlan    = cmd["noAiPlan"] === true
  const modelWorker = cmd["modelWorker"] ? String(cmd["modelWorker"]) : null

  const sendError = (msg: string, tabId?: string) => {
    const payload = JSON.stringify({ type: "run.error", error: msg, ...(tabId ? { tabId } : {}) })
    try { originWs.send(payload) } catch { /* disconnected */ }
    broadcast({ type: "run.error", error: msg, ...(tabId ? { tabId } : {}) })
  }

  if (!goalText && !goalId) { sendError("Goal cannot be empty"); return }

  const resolvedGoalText = goalText ||
    goalStore.listGoals(projectPath, 50).find((g) => g.id === goalId)?.text || ""
  if (!resolvedGoalText) { sendError("Goal not found"); return }

  const finalGoalId = goalText
    ? goalStore.createGoal(goalText, projectPath)
    : (goalId ?? goalStore.createGoal(resolvedGoalText, projectPath))

  const tabId       = nextTabId()
  const nextBasePort = portPool.allocate()

  const modelMap: Record<string, string> = {}
  if (modelWorker) {
    for (const role of ["explore", "plan", "implementer", "review", "verifier", "general"])
      modelMap[role] = modelWorker
  }
  const config = defaultConfig({
    projectPath,
    maxConcurrentAgents: agents,
    basePort: nextBasePort,
    autoApprove: true,
    dynamicTasks: true,
    modelMap,
  })

  // ── Broadcast planning start ──────────────────────────────────────────────
  broadcast({ type: "run.planning", tabId, goalText: resolvedGoalText })

  // Acquire warm agents synchronously (0ms), start heartbeat
  const warmSlots   = warmPool.acquire(agents)
  const warmAcquired = warmSlots.length
  if (warmAcquired > 0) console.log(`  [warm-pool] acquired ${warmAcquired} pre-warmed agent(s) for run ${tabId}`)

  const planStart    = Date.now()
  const planningTimer = setInterval(() => {
    broadcast({ type: "run.planning.heartbeat", tabId, elapsedMs: Date.now() - planStart })
  }, 5_000)

  // ── Planning ──────────────────────────────────────────────────────────────
  let taskNodes
  try {
    if (noAiPlan) {
      taskNodes = goalToTaskGraph(resolvedGoalText, projectPath).nodes
    } else {
      try {
        taskNodes = (await aiGoalToTaskGraph(resolvedGoalText, projectPath)).nodes
      } catch {
        taskNodes = goalToTaskGraph(resolvedGoalText, projectPath).nodes
      }
    }
  } catch (err) {
    clearInterval(planningTimer)
    for (const ws of warmSlots) try { ws.process.kill() } catch { /* ignore */ }
    sendError(`Planning failed: ${(err as Error).message}`, tabId)
    return
  }
  clearInterval(planningTimer)

  // ── Conductor setup ───────────────────────────────────────────────────────
  const conductor = new Conductor(config)
  await conductor.initialize()
  conductor.taskDag.addTasks(taskNodes)

  const conductorDir = join(projectPath, ".conductor")
  goalStore.upsertRunMeta(conductor.runId, finalGoalId, projectPath, agents, conductorDir)

  const dashboard = new TabDashboard(conductor, tabId, resolvedGoalText)
  dashboard.attachWss(wss)
  dashboard.start()

  const slot: RunSlot = {
    tabId,
    runId:    conductor.runId,
    goalId:   finalGoalId,
    goalText: resolvedGoalText,
    agents,
    basePort: nextBasePort,
    status:   "running",
    conductor,
    dashboard,
    cleanup: () => { dashboard.stop() },
  }
  slots.set(tabId, slot)
  broadcastServerState()

  try {
    const snap = dashboard.buildSnapshotPublic()
    broadcast({ type: "snapshot", tabId, ...snap })
  } catch { /* ok */ }

  // ── Inject warm agents, spawn remainder ───────────────────────────────────
  try {
    const agentMgr = (conductor as unknown as { agentMgr: AgentProcessManager }).agentMgr
    for (const ws of warmSlots) agentMgr.adopt(ws.instance, ws.process, ws.client)

    const totalNeeded = Math.min(agents, taskNodes.length)
    const stillNeeded = totalNeeded - warmAcquired
    if (stillNeeded > 0) {
      const roles = Array(stillNeeded).fill("general") as "general"[]
      await conductor.spawnAgents(roles)
    }
  } catch (err) {
    sendError(`Agent spawn failed: ${(err as Error).message}`, tabId)
    slot.status = "failed"
    slot.cleanup()
    portPool.release(nextBasePort)
    slots.delete(tabId)
    broadcastServerState()
    return
  }

  conductor.startScheduler()

  // Wait for completion (non-blocking)
  conductor.waitForCompletion(3_600_000).then((result) => {
    slot.status = result === "completed" ? "completed" : "failed"
    let tokenTotal = 0, costUsd = 0
    try {
      const tk = conductor.store.tokenStats()
      tokenTotal = tk.totalTokens
      costUsd    = (tk.inputTokens * 15 + tk.outputTokens * 75) / 1_000_000
    } catch { /* ok */ }
    goalStore.finishRunMeta(conductor.runId, slot.status, tokenTotal, costUsd)
    portPool.release(nextBasePort)
    broadcastServerState()
    conductor.shutdown().catch(() => {})
  })
}

// ─── forwardToSlot ────────────────────────────────────────────────────────────

export function forwardToSlot(slot: RunSlot, cmd: Record<string, unknown>): void {
  const conductor = slot.conductor
  switch (cmd["type"]) {
    case "pause":   conductor.stopScheduler();  break
    case "resume":  conductor.startScheduler(); break
    case "inject": {
      const prompt = String(cmd["prompt"] ?? "").trim()
      if (!prompt) break
      conductor.taskDag.addTask(createTaskNode({
        type: "implement", title: prompt.slice(0, 80),
        prompt: `[Web intervention]\n\n${prompt}\n\n---\nOutput MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`,
        scope: [], priority: 999,
      }))
      break
    }
    case "interrupt": {
      const agentId = String(cmd["agentId"] ?? "")
      try {
        const mgr = (conductor as unknown as { agentMgr: AgentProcessManager }).agentMgr
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
