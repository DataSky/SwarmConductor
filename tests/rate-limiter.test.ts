import { describe, it, expect } from "bun:test"
import { StartRateLimiter } from "../src/conductor/rate-limiter"

// ─── Deterministic time harness ───────────────────────────────────────────────
// Virtual clock: sleep() advances time instantly so tests never wait in real
// time. acquire() resolves against the virtual clock.

function harness() {
  let now = 0
  const limiterFor = (minIntervalMs: number, maxPerMinute: number) =>
    new StartRateLimiter({
      minIntervalMs, maxPerMinute,
      now: () => now,
      sleep: async (ms) => { now += ms },   // advance virtual clock instead of waiting
    })
  return { advance: (ms: number) => { now += ms }, at: () => now, limiterFor }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("StartRateLimiter — disabled", () => {
  it("is a no-op when both constraints are zero", async () => {
    const lim = new StartRateLimiter({ minIntervalMs: 0, maxPerMinute: 0 })
    expect(lim.disabled).toBe(true)
    // Many acquires resolve immediately without touching the clock.
    await Promise.all(Array.from({ length: 50 }, () => lim.acquire()))
  })
})

describe("StartRateLimiter — min interval spacing", () => {
  it("spaces consecutive starts by at least minIntervalMs", async () => {
    const h = harness()
    const lim = h.limiterFor(1000, 0)

    await lim.acquire()            // first start: immediate, at t=0
    expect(h.at()).toBe(0)
    await lim.acquire()            // must wait 1000ms
    expect(h.at()).toBe(1000)
    await lim.acquire()            // another 1000ms
    expect(h.at()).toBe(2000)
  })

  it("does not delay if enough time already elapsed", async () => {
    const h = harness()
    const lim = h.limiterFor(1000, 0)
    await lim.acquire()            // t=0
    h.advance(5000)               // plenty of time passes externally
    await lim.acquire()            // no extra wait needed
    expect(h.at()).toBe(5000)
  })
})

describe("StartRateLimiter — rolling window cap", () => {
  it("allows up to maxPerMinute starts then waits for the window to slide", async () => {
    const h = harness()
    const lim = h.limiterFor(0, 3)   // 3 starts per 60s

    await lim.acquire()  // t=0
    await lim.acquire()  // t=0
    await lim.acquire()  // t=0  (3 used)
    expect(h.at()).toBe(0)

    // 4th must wait until the oldest (t=0) ages out at t=60000.
    await lim.acquire()
    expect(h.at()).toBe(60_000)
  })

  it("evicts old starts so the cap is per-rolling-window, not cumulative", async () => {
    const h = harness()
    const lim = h.limiterFor(0, 2)
    await lim.acquire()  // t=0
    await lim.acquire()  // t=0 (2 used)
    h.advance(60_001)    // both age out
    await lim.acquire()  // window empty again — immediate
    expect(h.at()).toBe(60_001)
  })
})

describe("StartRateLimiter — combined constraints", () => {
  it("honors the stricter of spacing and window", async () => {
    const h = harness()
    const lim = h.limiterFor(500, 100)   // spacing dominates here
    await lim.acquire()  // t=0
    await lim.acquire()  // spacing forces t=500
    expect(h.at()).toBe(500)
  })

  it("serializes concurrent acquires so spacing still holds", async () => {
    const h = harness()
    const lim = h.limiterFor(1000, 0)
    // Fire three acquires "at once" — they must resolve at 0, 1000, 2000.
    await Promise.all([lim.acquire(), lim.acquire(), lim.acquire()])
    expect(h.at()).toBe(2000)
  })
})
