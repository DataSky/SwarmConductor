import { describe, it, expect } from "bun:test"
import { WarmPool } from "../src/runtime/warm-pool"
import type { Subprocess } from "bun"

// ─── Mock process factory ─────────────────────────────────────────────────────

function makeSpawnFn(opts: { fail?: boolean; delayMs?: number } = {}) {
  let killCount = 0
  const makeProcess = (): Subprocess => ({
    pid:    Math.floor(Math.random() * 90000) + 10000,
    kill:   () => { killCount++ },
    exited: Promise.resolve(0),
  } as unknown as Subprocess)

  return {
    killCount: () => killCount,
    fn: (_port: number) => {
      const process = makeProcess()
      const waitReady = opts.fail
        ? () => Promise.reject(new Error("mock spawn failure"))
        : opts.delayMs
          ? () => new Promise<void>(r => setTimeout(r, opts.delayMs))
          : () => Promise.resolve()
      return { process, waitReady }
    },
  }
}

function makePool(poolSize: number, spawnFnResult = makeSpawnFn()) {
  return new WarmPool({
    projectPath:  "/tmp/test-pool",
    codewhalebin: "codewhale",
    poolSize,
    basePort:     30000,
    _spawnFn:     spawnFnResult.fn,
  })
}

// Wait for pool to finish refilling (polls stats until refilling==0)
async function waitRefill(pool: WarmPool, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pool.stats().refilling === 0) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`WarmPool did not finish refilling within ${timeoutMs}ms`)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WarmPool.start()", () => {
  it("fills pool to poolSize after start", async () => {
    const pool = makePool(3)
    pool.start()
    await waitRefill(pool)
    expect(pool.stats().ready).toBe(3)
  })

  it("start() is non-blocking (does not throw)", () => {
    const pool = makePool(2)
    expect(() => pool.start()).not.toThrow()
  })

  it("stats().total equals poolSize while refilling", async () => {
    const slow = makeSpawnFn({ delayMs: 50 })
    const pool = makePool(2, slow)
    pool.start()
    // Immediately after start, agents are still refilling
    const s = pool.stats()
    expect(s.total).toBe(2)
    await waitRefill(pool)
  })
})

describe("WarmPool.acquire()", () => {
  it("returns up to n slots when pool is full", async () => {
    const pool = makePool(3)
    pool.start()
    await waitRefill(pool)

    const slots = pool.acquire(2)
    expect(slots).toHaveLength(2)
    expect(pool.stats().ready).toBe(1)
  })

  it("returns all available when requesting more than ready", async () => {
    const pool = makePool(2)
    pool.start()
    await waitRefill(pool)

    const slots = pool.acquire(5)
    expect(slots).toHaveLength(2)
  })

  it("returns empty array when pool is empty", () => {
    const pool = makePool(3)
    // Not started — ready is 0
    const slots = pool.acquire(2)
    expect(slots).toHaveLength(0)
  })

  it("each acquired slot has an idle instance and a client", async () => {
    const pool = makePool(2)
    pool.start()
    await waitRefill(pool)

    const slots = pool.acquire(2)
    for (const s of slots) {
      expect(s.instance.status).toBe("idle")
      expect(s.instance.port).toBeGreaterThan(0)
      expect(s.client).toBeTruthy()
      expect(s.process).toBeTruthy()
    }
  })

  it("triggers refill after acquire", async () => {
    const pool = makePool(3)
    pool.start()
    await waitRefill(pool)
    expect(pool.stats().ready).toBe(3)

    pool.acquire(2)
    // After acquire, pool should start refilling back to 3
    await waitRefill(pool)
    expect(pool.stats().ready).toBe(3)
  })
})

describe("WarmPool.stop()", () => {
  it("kills all ready processes", async () => {
    const mock = makeSpawnFn()
    const pool = makePool(3, mock)
    pool.start()
    await waitRefill(pool)
    expect(pool.stats().ready).toBe(3)

    pool.stop()
    expect(pool.stats().ready).toBe(0)
    expect(mock.killCount()).toBe(3)
  })

  it("acquire returns empty after stop", async () => {
    const pool = makePool(2)
    pool.start()
    await waitRefill(pool)

    pool.stop()
    expect(pool.acquire(2)).toHaveLength(0)
  })

  it("stop prevents further refill", async () => {
    const pool = makePool(2)
    pool.stop()  // stop before start
    pool.start()
    // Give it time to run (should be no-op)
    await new Promise(r => setTimeout(r, 50))
    expect(pool.stats().ready).toBe(0)
  })
})

describe("WarmPool error handling", () => {
  it("skips failed slots without throwing", async () => {
    const failing = makeSpawnFn({ fail: true })
    const pool = makePool(3, failing)
    pool.start()
    await waitRefill(pool)
    // All failed — pool is empty but no throw
    expect(pool.stats().ready).toBe(0)
  })

  it("partial failures: only successful slots are added", async () => {
    let callCount = 0
    const partialFail = {
      killCount: () => 0,
      fn: (port: number) => {
        callCount++
        const proc = { pid: port, kill: () => {}, exited: Promise.resolve(0) } as unknown as Subprocess
        // Fail every other slot
        const waitReady = callCount % 2 === 0
          ? () => Promise.reject(new Error("even slot fails"))
          : () => Promise.resolve()
        return { process: proc, waitReady }
      },
    }

    const pool = makePool(4, partialFail)
    pool.start()
    await waitRefill(pool)
    // 4 slots: slots 2,4 fail → 2 succeed
    expect(pool.stats().ready).toBe(2)
  })
})

describe("WarmPool.stats()", () => {
  it("reports correct counts before start", () => {
    const pool = makePool(3)
    expect(pool.stats()).toEqual({ ready: 0, refilling: 0, total: 0 })
  })

  it("reports ready=poolSize after fill", async () => {
    const pool = makePool(3)
    pool.start()
    await waitRefill(pool)
    expect(pool.stats()).toEqual({ ready: 3, refilling: 0, total: 3 })
  })

  it("total = ready + refilling during fill", async () => {
    const slow = makeSpawnFn({ delayMs: 80 })
    const pool = makePool(2, slow)
    pool.start()
    // Poll immediately — agents should be refilling
    await new Promise(r => setTimeout(r, 5))
    const s = pool.stats()
    expect(s.total).toBe(s.ready + s.refilling)
    await waitRefill(pool)
  })
})

describe("WarmPool port allocation", () => {
  it("each slot gets a unique port starting from basePort", async () => {
    const pool = makePool(3)
    pool.start()
    await waitRefill(pool)
    const slots = pool.acquire(3)
    const ports = slots.map(s => s.instance.port)
    expect(new Set(ports).size).toBe(3)
    expect(Math.min(...ports)).toBe(30000)
    expect(Math.max(...ports)).toBe(30002)
  })
})
