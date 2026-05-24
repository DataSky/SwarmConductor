/**
 * Integration tests: require a live codewhale serve instance.
 * Run with: bun test tests/integration.test.ts
 * These tests make real API calls and LLM requests.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { CodeWhaleClient } from "../src/runtime/client"
import { spawn, type Subprocess } from "bun"

const TEST_PORT = 18001

let serverProc: Subprocess | null = null
let client: CodeWhaleClient

beforeAll(async () => {
  serverProc = spawn({
    cmd: ["codewhale", "serve", "--http", "--port", String(TEST_PORT), "--insecure"],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  })

  client = new CodeWhaleClient(TEST_PORT)
  await client.waitUntilReady(30_000)
})

afterAll(async () => {
  serverProc?.kill()
  await serverProc?.exited
})

describe("CodeWhaleClient", () => {
  it("health check passes", async () => {
    const ok = await client.health()
    expect(ok).toBe(true)
  })

  it("creates a thread", async () => {
    const thread = await client.createThread()
    expect(thread.id).toMatch(/^thr_/)
  })

  it("posts a turn and receives agent_message via SSE", async () => {
    const thread = await client.createThread()
    const turn = await client.postTurn(thread.id, {
      prompt: 'Reply with exactly the word "PING" and nothing else.',
      auto_approve: true,
    })
    expect(turn.id).toMatch(/^turn_/)
    expect(turn.status).toBe("in_progress")

    const deltas: string[] = []
    const result = await client.waitForTurn(
      thread.id,
      turn.id,
      d => deltas.push(d),
      60_000
    )

    expect(result.status).toBe("completed")
    expect(result.fullText.trim()).toContain("PING")
    expect(deltas.length).toBeGreaterThan(0)
  }, 90_000)

  it("two turns on the same thread accumulate context", async () => {
    const thread = await client.createThread()

    const t1 = await client.postTurn(thread.id, {
      prompt: 'Remember the secret code: "ZETA-7". Just acknowledge.',
      auto_approve: true,
    })
    await client.waitForTurn(thread.id, t1.id, undefined, 60_000)

    const t2 = await client.postTurn(thread.id, {
      prompt: 'What was the secret code I told you? Reply with just the code.',
      auto_approve: true,
    })
    const r2 = await client.waitForTurn(thread.id, t2.id, undefined, 60_000)

    expect(r2.fullText).toContain("ZETA-7")
  }, 120_000)
})
