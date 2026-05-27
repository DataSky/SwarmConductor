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
  it("inserts implement task for each valid blocker", () => {
    const parent = createTaskNode({ type: "implement", title: "Feature A", prompt: "p", scope: ["src/a.ts"] })
    const output = { ...baseOutput(), blockers: ["- Missing auth middleware", "- DB migration: needs to be applied first"] }

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

// ─── dynamic-tasks 误报过滤 ───────────────────────────────────────────────────

describe("generateFollowupTasks — noise filtering", () => {
  const base = (): TaskOutput => ({
    summary: "done", changes: [], evidence: [], risks: [], blockers: [], rawText: "",
  })
  const parent = createTaskNode({ type: "implement", title: "Feature", prompt: "p", scope: ["/proj/src"] })

  it("blocker ≤15 chars is filtered out (too short to be actionable)", () => {
    const out = { ...base(), blockers: ["TODO: fix"] }  // length=9
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    expect(inserted.length).toBe(0)
  })

  it("blocker with no verb and no colon is filtered out", () => {
    const out = { ...base(), blockers: ["Something problematic here"] }
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    expect(inserted.length).toBe(0)
  })

  it("blocker with 'missing' keyword passes filter", () => {
    const out = { ...base(), blockers: ["Missing auth middleware for API routes"] }
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    expect(inserted.length).toBe(1)
    expect(inserted[0]!.type).toBe("implement")
  })

  it("blocker with colon passes filter", () => {
    const out = { ...base(), blockers: ["DB migration: run npm run migrate first"] }
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    expect(inserted.length).toBe(1)
  })

  it("blocker with 'needs' passes filter", () => {
    const out = { ...base(), blockers: ["Auth module needs rate-limiting before deploy"] }
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    expect(inserted.length).toBe(1)
  })

  it("max MAX_DYNAMIC_PER_TASK (2) dynamic tasks per parent", () => {
    const out = {
      ...base(),
      blockers: [
        "Missing auth middleware for routes one",
        "Needs database migration script applied here",
        "Cannot proceed without SSL certificate configured",
        "Requires Redis connection pool implementation",
        "Must add rate limiting to prevent abuse scenarios",
      ],
    }
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    expect(inserted.length).toBe(2)
  })

  it("cap applies across blockers AND risks combined", () => {
    const out = {
      ...base(),
      blockers: ["Missing auth middleware for route handling"],  // 1 valid blocker
      risks:    ["CRITICAL: exposes all user data to public internet"],  // 1 high risk
    }
    const { inserted } = generateFollowupTasks(parent, out, new Set())
    // Combined cap = 2, so both should fit
    expect(inserted.length).toBe(2)

    // Now add a second risk — should be capped at 2 total
    const out2 = {
      ...base(),
      blockers: ["Missing auth middleware for route handling"],
      risks:    [
        "CRITICAL: exposes all user data to public internet",
        "HIGH: SQL injection vulnerability in user input",
      ],
    }
    const { inserted: ins2 } = generateFollowupTasks(parent, out2, new Set())
    expect(ins2.length).toBe(2)
  })

  it("title dedup still works with new filtering", () => {
    const out = { ...base(), blockers: ["Missing authentication middleware for routes"] }
    const { inserted: first } = generateFollowupTasks(parent, out, new Set())
    expect(first.length).toBe(1)

    const { inserted: second, skipped } = generateFollowupTasks(parent, out, new Set([first[0]!.title]))
    expect(second.length).toBe(0)
    expect(skipped).toBe(1)
  })
})
