// ─── CodeWhale HTTP Runtime API 客户端 ──────────────────────────────────────
// SSE events endpoint: GET /v1/threads/{id}/events?since_seq=N
// Returns Server-Sent Events stream: "event: xxx\ndata: {...}\n\n"

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export interface CWThread {
  id: string
  created_at: string
  workspace: string
  mode: string
  auto_approve: boolean
}

export interface CWTurn {
  id: string
  thread_id: string
  status: "queued" | "in_progress" | "completed" | "failed" | "interrupted" | "canceled"
  created_at: string
  started_at: string | null
  ended_at: string | null
  duration_ms: number | null
  input_summary: string
}

export interface CWSSEEvent {
  seq: number
  thread_id: string
  turn_id: string | null
  item_id: string | null
  event: string
  payload: Record<string, unknown>
}

export interface TurnOptions {
  prompt: string
  auto_approve?: boolean
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
      const r = await fetch(`${this.base}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      })
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

  /** Returns the turn object. CodeWhale response wraps it as { thread, turn }. */
  async postTurn(threadId: string, opts: TurnOptions): Promise<CWTurn> {
    const body: Record<string, unknown> = {
      prompt: opts.prompt,
      auto_approve: opts.auto_approve ?? false,
    }
    if (opts.fork_context !== undefined) body["fork_context"] = opts.fork_context

    const r = await fetch(`${this.base}/v1/threads/${threadId}/turns`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`postTurn failed: ${r.status} ${await r.text()}`)
    const data = await r.json() as { turn?: CWTurn } | CWTurn
    // API returns { thread, turn } wrapper
    return ("turn" in data && data.turn ? data.turn : data) as CWTurn
  }

  /**
   * Stream SSE events until turn reaches terminal state.
   * Collects only agent_message deltas (not agent_reasoning).
   * SSE format: "event: xxx\ndata: {...}\n\n"
   */
  async waitForTurn(
    threadId: string,
    _turnId: string,
    onDelta?: (text: string) => void,
    timeoutMs = 1_800_000
  ): Promise<{ status: CWTurn["status"]; fullText: string; usage: TokenUsage }> {
    const url = `${this.base}/v1/threads/${threadId}/events?since_seq=0`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let fullText = ""
    const terminalEvents = new Set(["turn.completed", "turn.failed", "turn.interrupted"])

    try {
      const r = await fetch(url, {
        headers: { ...this.headers(), Accept: "text/event-stream" },
        signal: controller.signal,
      })
      if (!r.ok) throw new Error(`SSE connect failed: ${r.status}`)
      if (!r.body) throw new Error("No response body")

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      // Default to "failed" so an unexpected stream close is never silently treated as success.
      let finalStatus: CWTurn["status"] = "failed"
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }

      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            // event name captured in data line's ev.event field
          } else if (line.startsWith("data: ")) {
            const raw = line.slice(6).trim()
            try {
              const ev = JSON.parse(raw) as CWSSEEvent

              if (ev.event === "item.delta") {
                const payload = ev.payload as { delta?: string; kind?: string }
                if (payload.kind === "agent_message" && payload.delta) {
                  fullText += payload.delta
                  onDelta?.(payload.delta)
                }
              }

              if (terminalEvents.has(ev.event)) {
                const turnPayload = ev.payload as { turn?: { status?: string; usage?: Record<string, number> } }
                finalStatus = (turnPayload.turn?.status as CWTurn["status"]) ?? "completed"
                const u = turnPayload.turn?.usage
                if (u) {
                  usage = {
                    inputTokens:    u["input_tokens"]             ?? 0,
                    outputTokens:   u["output_tokens"]            ?? 0,
                    cacheHitTokens: u["prompt_cache_hit_tokens"]  ?? 0,
                    cacheMissTokens:u["prompt_cache_miss_tokens"] ?? 0,
                  }
                }
                break outer
              }
            } catch {
              // skip malformed SSE data line
            }
          }
          // blank line = SSE event separator
          else if (line === "") {
            // reset handled implicitly
          }
        }
      }

      return { status: finalStatus, fullText, usage }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Interrupt the current in-progress turn. */
  async interruptThread(threadId: string): Promise<void> {
    await fetch(`${this.base}/v1/threads/${threadId}/turns`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ action: "interrupt" }),
    }).catch(() => {})
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
