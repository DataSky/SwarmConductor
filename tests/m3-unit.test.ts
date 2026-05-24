import { describe, it, expect } from "bun:test"
import { generateFollowupTasks } from "../src/conductor/dynamic-tasks"
import { createTaskNode } from "../src/dag/engine"
import { ApprovalGate } from "../src/conductor/approval-gate"
import type { TaskOutput } from "../src/dag/types"

// ─── Dynamic task generation ──────────────────────────────────────────────────

const baseOutput = (): TaskOutput => ({
  summary: "Did some work",
  changes: [],
  evidence: [],
  risks: [],
  blockers: [],
  rawText: "",
})

describe("generateFollowupTasks", () => {
  it("inserts implement task for each non-empty blocker", () => {
    const parent = createTaskNode({ type: "implement", title: "Feature A", prompt: "p", scope: ["src/a.ts"] })
    const output = { ...baseOutput(), blockers: ["- Missing auth middleware", "- DB migration not applied"] }

    const { inserted } = generateFollowupTasks(parent, output, new Set())
    expect(inserted.length).toBe(2)
    expect(inserted.every(t => t.type === "implement")).toBe(true)
    expect(inserted.every(t => t.dependsOn.includes(parent.id))).toBe(true)
  })

  it("inserts review task for high-severity risks", () => {
    const parent = createTaskNode({ type: "implement", title: "Auth refactor", prompt: "p", scope: [] })
    const output = { ...baseOutput(), risks: ["Low: minor formatting", "CRITICAL: exposes user tokens to logs"] }

    const { inserted } = generateFollowupTasks(parent, output, new Set())
    expect(inserted.length).toBe(1)
    expect(inserted[0]!.type).toBe("review")
    expect(inserted[0]!.dependsOn).toContain(parent.id)
  })

  it("inserts verify task when scope includes test files", () => {
    const parent = createTaskNode({
      type: "implement",
      title: "Fix parser",
      prompt: "p",
      scope: ["src/parser.ts", "tests/parser.test.ts"],
    })
    const output = { ...baseOutput(), changes: [{ file: "src/parser.ts", description: "fixed edge case" }] }

    const { inserted } = generateFollowupTasks(parent, output, new Set())
    expect(inserted.some(t => t.type === "verify")).toBe(true)
  })

  it("deduplicates: skips tasks with already-existing titles", () => {
    const parent = createTaskNode({ type: "implement", title: "Feature B", prompt: "p", scope: [] })
    const output = { ...baseOutput(), blockers: ["- Need to add logging"] }

    const { inserted: first } = generateFollowupTasks(parent, output, new Set())
    const { inserted: second, skipped } = generateFollowupTasks(parent, output, new Set([first[0]!.title]))

    expect(first.length).toBe(1)
    expect(second.length).toBe(0)
    expect(skipped).toBe(1)
  })

  it("returns empty when output has no blockers, no high risks, no test scope", () => {
    const parent = createTaskNode({ type: "explore", title: "Scan", prompt: "p", scope: ["docs/"] })
    const output = { ...baseOutput(), risks: ["Low: docs could be more detailed"] }
    const { inserted } = generateFollowupTasks(parent, output, new Set())
    expect(inserted.length).toBe(0)
  })
})

// ─── ApprovalGate ─────────────────────────────────────────────────────────────

describe("ApprovalGate", () => {
  it("resolves pending approval programmatically (approved)", async () => {
    const gate = new ApprovalGate()
    const reqPromise = gate.request("phase_boundary", "Proceed to phase 2?")

    const [reqs] = [gate.pendingRequests()]
    expect(reqs.length).toBe(1)

    const id = reqs[0]!.id
    const ok = gate.resolve(id, "approved")
    expect(ok).toBe(true)

    const decision = await reqPromise
    expect(decision).toBe("approved")
    expect(gate.hasPending()).toBe(false)
  })

  it("resolves pending approval programmatically (rejected)", async () => {
    const gate = new ApprovalGate()
    const reqPromise = gate.request("high_risk", "Dangerous operation detected")
    const id = gate.pendingRequests()[0]!.id
    gate.resolve(id, "rejected")

    expect(await reqPromise).toBe("rejected")
  })

  it("returns false for unknown approval ID", () => {
    const gate = new ApprovalGate()
    expect(gate.resolve("nonexistent-id", "approved")).toBe(false)
  })

  it("fires onApprovalRequest callback", async () => {
    const gate = new ApprovalGate()
    const seen: string[] = []
    gate.onApprovalRequest(req => seen.push(req.id))

    const p = gate.request("merge_conflict", "Conflict in src/main.ts")
    gate.resolve(gate.pendingRequests()[0]!.id, "approved")
    await p

    expect(seen.length).toBe(1)
  })

  it("handles multiple concurrent approvals independently", async () => {
    const gate = new ApprovalGate()
    const p1 = gate.request("phase_boundary", "Phase 1 done")
    const p2 = gate.request("high_risk", "Risk detected")

    const [req1, req2] = gate.pendingRequests()
    gate.resolve(req1!.id, "approved")
    gate.resolve(req2!.id, "rejected")

    const [d1, d2] = await Promise.all([p1, p2])
    expect(d1).toBe("approved")
    expect(d2).toBe("rejected")
  })
})
