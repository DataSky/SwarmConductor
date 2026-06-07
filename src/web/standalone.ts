import { GoalStore } from "./goal-store"
import { UI_HTML } from "./assets"
import { WarmPool } from "../runtime/warm-pool"
import { PortPool } from "./handlers/port-pool"
import { handleStartRun, forwardToSlot, TabDashboard } from "./handlers/start-run"
import type { RunSlot } from "./handlers/start-run"
import { handleReplay } from "./handlers/replay"
import { handleDataflowRun } from "./handlers/dataflow-run"
import { mkdirSync } from "fs"
import { join } from "path"

// ─── StandaloneServer ─────────────────────────────────────────────────────────
// Serves the single-page React app and coordinates all WebSocket traffic.
// Business logic lives in handlers/: start-run, replay, port-pool.

export class StandaloneServer {
  private wss       = new Set<import("bun").ServerWebSocket<unknown>>()
  private slots     = new Map<string, RunSlot>()
  private goalStore: GoalStore
  private server:   ReturnType<typeof Bun.serve> | null = null
  private warmPool: WarmPool
  private portPool: PortPool
  /** Bearer token gating /api/dataflow/run. Taken from SWARM_API_TOKEN if set,
   *  otherwise auto-generated at startup (zero-config) and printed once. */
  private readonly apiToken: string = process.env.SWARM_API_TOKEN
    || `swarm-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`

  private static readonly WARM_POOL_SIZE = 3

  constructor(
    private projectPath: string,
    private port: number,
    baseAgentPort = 8800,
  ) {
    const conductorDir = join(projectPath, ".conductor")
    mkdirSync(conductorDir, { recursive: true })
    this.goalStore = new GoalStore(conductorDir)

    const warmBasePort = baseAgentPort - StandaloneServer.WARM_POOL_SIZE * 2
    this.warmPool = new WarmPool({
      projectPath,
      codewhalebin: "codewhale",
      poolSize: StandaloneServer.WARM_POOL_SIZE,
      basePort: warmBasePort,
    })
    this.portPool = new PortPool(baseAgentPort)
  }

  start(): void {
    const stale = this.goalStore.reconcileStaleRuns()
    if (stale > 0) console.log(`  [goals.db] marked ${stale} stale run(s) as interrupted`)

    this.warmPool.start()
    console.log(`  [warm-pool] pre-warming ${StandaloneServer.WARM_POOL_SIZE} agents in background`)

    const self = this
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",   // localhost only — the dataflow endpoint runs SQL / spends tokens
      fetch(req, server) {
        const url = new URL(req.url)
        if (url.pathname === "/ws") {
          const ok = server.upgrade(req, { data: {} })
          return ok ? undefined : new Response("WS upgrade failed", { status: 500 })
        }
        if (url.pathname === "/api/dataflow/run") {
          return self.handleDataflowHTTP(req)
        }
        return self.handleHTTP(url)
      },
      websocket: {
        open:    (ws) => self.onOpen(ws),
        message: (ws, msg) => self.onMessage(ws, msg),
        close:   (ws) => { self.wss.delete(ws) },
      },
    })
    console.log(`  Swarm Web UI → http://localhost:${this.port}`)
    const src = process.env.SWARM_API_TOKEN ? "from SWARM_API_TOKEN" : "auto-generated"
    console.log(`  Data-flow API token (${src}): ${this.apiToken}`)
    console.log(`    → curl -H "Authorization: Bearer ${this.apiToken}" -X POST http://127.0.0.1:${this.port}/api/dataflow/run`)
  }

  stop(): void {
    for (const slot of this.slots.values()) slot.cleanup()
    this.warmPool.stop()
    this.goalStore.close()
    this.server?.stop()
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private handleHTTP(url: URL): Response {
    const json = (data: unknown) =>
      new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } })

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(UI_HTML as unknown as string, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
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
    const replayMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/replay$/)
    if (replayMatch) {
      return handleReplay(replayMatch[1]!, this.goalStore, json)
    }
    return new Response("Not found", { status: 404 })
  }

  // ── Data-flow analysis endpoint (auth-gated) ───────────────────────────────

  private async handleDataflowHTTP(req: Request): Promise<Response> {
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })

    if (req.method !== "POST") return json({ error: "method not allowed" }, 405)

    // Auth: the endpoint always has a token (from SWARM_API_TOKEN or auto-
    // generated at startup and printed). The caller must present it — we never
    // expose an unauthenticated SQL/LLM execution endpoint.
    const auth = req.headers.get("authorization") ?? ""
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : ""
    if (presented !== this.apiToken) return json({ error: "unauthorized" }, 401)

    let body: import("./handlers/dataflow-run").DataflowRequest
    try { body = await req.json() as import("./handlers/dataflow-run").DataflowRequest }
    catch { return json({ error: "invalid JSON body" }, 400) }

    try {
      const result = await handleDataflowRun(body)
      return json(result)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400)
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private onOpen(ws: import("bun").ServerWebSocket<unknown>): void {
    this.wss.add(ws)
    for (const slot of this.slots.values()) {
      (slot.dashboard as TabDashboard).attachWss(this.wss)
    }
    ws.send(JSON.stringify({ type: "server.state", ...this.serveState() }))
    for (const slot of this.slots.values()) {
      const snap = slot.dashboard.buildSnapshotPublic()
      if (snap) ws.send(JSON.stringify({ type: "snapshot", tabId: slot.tabId, ...snap }))
    }
  }

  private onMessage(ws: import("bun").ServerWebSocket<unknown>, msg: string | Buffer): void {
    let cmd: Record<string, unknown>
    try { cmd = JSON.parse(String(msg)) } catch { return }

    switch (cmd["type"]) {
      case "start.run":
        handleStartRun({
          cmd, originWs: ws, wss: this.wss, slots: this.slots,
          goalStore: this.goalStore, warmPool: this.warmPool, portPool: this.portPool,
          projectPath: this.projectPath,
          broadcast:           (m) => this.broadcast(m),
          broadcastServerState: () => this.broadcastServerState(),
          nextTabId:            () => this.nextTabId(),
        }).catch((err) => {
          const errMsg = String((err as Error).message ?? err)
          console.error(`[standalone] start.run error: ${errMsg}`)
          try { ws.send(JSON.stringify({ type: "run.error", error: errMsg })) } catch { /* disconnected */ }
        })
        break

      case "select.tab": {
        const tabId = String(cmd["tabId"] ?? "")
        const slot  = this.slots.get(tabId)
        if (!slot) { ws.send(JSON.stringify({ type: "run.error", error: "Tab not found" })); return }
        ws.send(JSON.stringify({ type: "snapshot", tabId, ...slot.dashboard.buildSnapshotPublic() }))
        break
      }

      case "abort.run": {
        const tabId = String(cmd["tabId"] ?? "")
        const slot  = this.slots.get(tabId)
        if (slot) {
          slot.conductor.shutdown().catch(() => {})
          slot.cleanup()
          this.portPool.release(slot.basePort)
          this.slots.delete(tabId)
          this.broadcastServerState()
        }
        break
      }

      case "pause": case "resume": case "inject": case "interrupt": case "approve": {
        const tabId = String(cmd["tabId"] ?? "")
        const slot  = this.slots.get(tabId)
        if (slot) forwardToSlot(slot, cmd)
        break
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private serveState(): object {
    return {
      project: this.projectPath,
      tabs: [...this.slots.values()].map((s) => ({
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
    for (const ws of this.wss) try { ws.send(s) } catch { /* disconnected */ }
  }

  private broadcastServerState(): void {
    this.broadcast({ type: "server.state", ...this.serveState() })
  }

  private nextTabId(): string {
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  }
}
