import type { ClientMessage, ServerMessage } from "./types"

export type MessageHandler = (msg: ServerMessage) => void

export class WsClient {
  private ws: WebSocket | null = null
  private handlers: Set<MessageHandler> = new Set()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private stopped = false

  constructor(private url: string) {}

  connect(): void {
    if (this.stopped) return
    this.ws = new WebSocket(this.url)

    this.ws.onopen = () => {
      this.reconnectDelay = 1000
      this.emit({ type: "ws.open" } as unknown as ServerMessage)
    }

    this.ws.onclose = () => {
      this.ws = null
      this.emit({ type: "ws.close" } as unknown as ServerMessage)
      if (!this.stopped) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000)
      }
    }

    this.ws.onerror = () => this.ws?.close()

    this.ws.onmessage = (e: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(e.data) as ServerMessage
        this.emit(msg)
      } catch { /* ignore malformed frames */ }
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  subscribe(handler: MessageHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  private emit(msg: ServerMessage): void {
    for (const h of this.handlers) h(msg)
  }
}

// Singleton for the app lifetime
const WS_URL = `ws://${location.host}/ws`
export const wsClient = new WsClient(WS_URL)
