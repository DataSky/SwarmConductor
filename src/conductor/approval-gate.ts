import { createInterface } from "readline"
import type { ApprovalRequest, ApprovalKind } from "../dag/types"

// ─── Approval Gate ─────────────────────────────────────────────────────────
// Pauses the conductor at key decision points and waits for human input.
// Supports two response modes: interactive stdin and programmatic resolve().

export class ApprovalGate {
  private pending: Map<string, ApprovalRequest> = new Map()
  private resolvers: Map<string, (decision: "approved" | "rejected") => void> = new Map()
  private onRequest: (req: ApprovalRequest) => void = () => {}

  onApprovalRequest(cb: (req: ApprovalRequest) => void): void {
    this.onRequest = cb
  }

  /** Create a pending approval and wait for it to be resolved. */
  async request(
    kind: ApprovalKind,
    message: string,
    context: Record<string, unknown> = {},
  ): Promise<"approved" | "rejected"> {
    const id = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const req: ApprovalRequest = {
      id,
      kind,
      message,
      context,
      createdAt: Date.now(),
      resolvedAt: null,
      decision: null,
    }

    this.pending.set(id, req)
    this.onRequest(req)

    return new Promise<"approved" | "rejected">(resolve => {
      this.resolvers.set(id, resolve)
    })
  }

  /** Programmatically resolve a pending approval (used in tests or HTTP API). */
  resolve(approvalId: string, decision: "approved" | "rejected"): boolean {
    const req = this.pending.get(approvalId)
    const resolver = this.resolvers.get(approvalId)
    if (!req || !resolver) return false

    req.resolvedAt = Date.now()
    req.decision = decision
    this.pending.delete(approvalId)
    this.resolvers.delete(approvalId)
    resolver(decision)
    return true
  }

  pendingRequests(): ApprovalRequest[] {
    return Array.from(this.pending.values())
  }

  hasPending(): boolean {
    return this.pending.size > 0
  }

  /** Interactive stdin prompt — blocks until user types y/n. */
  async promptStdin(req: ApprovalRequest): Promise<"approved" | "rejected"> {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    return new Promise(resolve => {
      const kinds: Record<ApprovalKind, string> = {
        phase_boundary: "PHASE BOUNDARY",
        high_risk: "HIGH RISK",
        merge_conflict: "MERGE CONFLICT",
      }
      const label = kinds[req.kind] ?? req.kind

      console.log(`\n${"─".repeat(60)}`)
      console.log(`⏸  APPROVAL REQUIRED [${label}]`)
      console.log(`─${"─".repeat(59)}`)
      console.log(req.message)
      if (Object.keys(req.context).length > 0) {
        console.log("\nContext:")
        for (const [k, v] of Object.entries(req.context)) {
          console.log(`  ${k}: ${JSON.stringify(v)}`)
        }
      }
      console.log(`${"─".repeat(60)}`)

      rl.question("Approve? [y/N] ", answer => {
        rl.close()
        const decision = answer.trim().toLowerCase() === "y" ? "approved" : "rejected"
        this.resolve(req.id, decision)
        resolve(decision)
      })
    })
  }
}
