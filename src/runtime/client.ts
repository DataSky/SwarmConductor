import type { AgentRole } from "../dag/types"

// ─── CodeWhale HTTP Runtime API 客户端 ──────────────────────────────────────
// 对应 codewhale serve --http（默认 localhost:7878）

export interface CWThread {
  id: string
  created_at: string
  title: string | null
}

export interface CWTurn {
  id: string
  thread_id: string
  status: "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled"
  created_at: string
  completed_at: string | null
}

export interface CWSSEEvent {
  seq: number
  thread_id: string
  event: string
  payload: Record<string, unknown>
}

export interface TurnOptions {
  prompt: string
  auto_approve?: boolean
  role?: AgentRole
  fork_context?: boolean
}

export class CodeWhaleClient {
  private base: string
  private token: string | undefined

  constructor(port: number, token?: string) {
    this.base = `http://127.0.0.1:${port}`
    this.token = token
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" }
    if (this.token) h["Authorization"] = `Bearer ${this.token}`
    return h
  }

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/health`, { headers: this.headers() })
      return r.ok
    } catch {
      return false
    }
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await this.health()) return
      await sleep(500)
    }
    throw new Error(`CodeWhale on ${this.base} did not become ready within ${timeoutMs}ms`)
  }

  async createThread(): Promise<CWThread> {
    const r = await fetch(`${this.base}/v1/threads`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({}),
    })
    if (!r.ok) throw new Error(`createThread failed: ${r.status} ${await r.text()}`)
    return r.json() as Promise<CWThread>
  }

  async postTurn(threadId: string, opts: TurnOptions): Promise<CWTurn> {
    const body: Record<string, unknown> = {
      message: opts.prompt,
      auto_approve: opts.auto_approve ?? false,
    }
    if (opts.role) body["role"] = opts.role
    if (opts.fork_context !== undefined) body["fork_context"] = opts.fork_context

    const r = await fetch(`${this.base}/v1/threads/${threadId}/turns`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`postTurn failed: ${r.status} ${await r.text()}`)
    return r.json() as Promise<CWTurn>
  }

  async getTurn(threadId: string, turnId: string): Promise<CWTurn> {
    const r = await fetch(`${this.base}/v1/threads/${threadId}/turns/${turnId}`, {
      headers: this.headers(),
    })
    if (!r.ok) throw new Error(`getTurn failed: ${r.status}`)
    return r.json() as Promise<CWTurn>
  }

  /** Poll turn until terminal status, collecting full text output. */
  async waitForTurn(
    threadId: string,
    turnId: string,
    onDelta?: (text: string) => void,
    timeoutMs = 1_800_000
  ): Promise<{ turn: CWTurn; fullText: string }> {
    const deadline = Date.now() + timeoutMs
    let lastSeq = 0
    let fullText = ""

    while (Date.now() < deadline) {
      const events = await this.pollEvents(threadId, lastSeq)

      for (const ev of events) {
        lastSeq = Math.max(lastSeq, ev.seq)

        if (ev.event === "item.delta") {
          const delta = (ev.payload["delta"] as string) ?? ""
          fullText += delta
          onDelta?.(delta)
        }

        if (ev.event === "turn.completed" || ev.event === "turn.failed" || ev.event === "turn.interrupted") {
          const turn = await this.getTurn(threadId, turnId)
          return { turn, fullText }
        }
      }

      await sleep(200)
    }

    throw new Error(`Turn ${turnId} timed out after ${timeoutMs}ms`)
  }

  async pollEvents(threadId: string, sinceSeq: number): Promise<CWSSEEvent[]> {
    const url = `${this.base}/v1/threads/${threadId}/events?since_seq=${sinceSeq}`
    const r = await fetch(url, { headers: this.headers() })
    if (!r.ok) throw new Error(`pollEvents failed: ${r.status}`)
    const data = await r.json() as { events?: CWSSEEvent[] }
    return data.events ?? []
  }

  /** Interrupt the current in-progress turn. */
  async interruptThread(threadId: string): Promise<void> {
    await fetch(`${this.base}/v1/threads/${threadId}/turns`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ action: "interrupt" }),
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
