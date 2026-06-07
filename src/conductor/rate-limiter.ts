// ─── Start rate limiter (backpressure) ────────────────────────────────────────
// Gates *when* an execution may start, to protect the downstream LLM provider
// from bursts. Two independent constraints, both optional:
//
//   • minIntervalMs   — minimum gap between consecutive starts (spacing)
//   • maxPerMinute    — max starts in any rolling 60s window (token bucket)
//
// acquire() resolves once both constraints permit a start, recording the start
// time. It serializes waiters so spacing is honored even under concurrent calls.
// Time is injected (`now`) so tests are deterministic without real clocks.

export interface RateLimiterOpts {
  minIntervalMs: number
  maxPerMinute: number
  /** Injectable clock (defaults to Date.now). */
  now?: () => number
  /** Injectable sleep (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>
}

const WINDOW_MS = 60_000

export class StartRateLimiter {
  private readonly minIntervalMs: number
  private readonly maxPerMinute: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  private lastStart = -Infinity
  private starts: number[] = []        // timestamps within the rolling window
  private chain: Promise<void> = Promise.resolve()  // serializes waiters

  constructor(opts: RateLimiterOpts) {
    this.minIntervalMs = Math.max(0, opts.minIntervalMs)
    this.maxPerMinute = Math.max(0, opts.maxPerMinute)
    this.now = opts.now ?? (() => Date.now())
    this.sleep = opts.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)))
  }

  /** True if no constraints are active (fast path — skip the queue entirely). */
  get disabled(): boolean {
    return this.minIntervalMs === 0 && this.maxPerMinute === 0
  }

  /** Resolve once a start is permitted, recording it. Serialized across callers. */
  async acquire(): Promise<void> {
    if (this.disabled) return
    // Append to the serialization chain so spacing holds under concurrency.
    const mine = this.chain.then(() => this.waitForSlot())
    // Keep the chain alive even if a waiter throws (it shouldn't).
    this.chain = mine.catch(() => {})
    return mine
  }

  private async waitForSlot(): Promise<void> {
    // Loop: each sleep may expose a new constraint, so re-check after waking.
    for (;;) {
      const t = this.now()
      this.evict(t)

      const spacingWait = this.minIntervalMs > 0
        ? Math.max(0, this.lastStart + this.minIntervalMs - t)
        : 0

      let windowWait = 0
      if (this.maxPerMinute > 0 && this.starts.length >= this.maxPerMinute) {
        // Wait until the oldest start ages out of the window.
        const oldest = this.starts[0]!
        windowWait = Math.max(0, oldest + WINDOW_MS - t)
      }

      const wait = Math.max(spacingWait, windowWait)
      if (wait <= 0) break
      await this.sleep(wait)
    }

    const t = this.now()
    this.lastStart = t
    if (this.maxPerMinute > 0) this.starts.push(t)
  }

  private evict(t: number): void {
    if (this.maxPerMinute === 0) return
    const cutoff = t - WINDOW_MS
    while (this.starts.length > 0 && this.starts[0]! <= cutoff) this.starts.shift()
  }
}
