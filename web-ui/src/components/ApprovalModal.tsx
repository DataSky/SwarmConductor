import { useRunStore } from "../store/run"
import { wsClient } from "../ws/client"
import styles from "./ApprovalModal.module.css"

export function ApprovalModal() {
  const approvals    = useRunStore((s) => s.pendingApprovals)
  const applySnapshot = useRunStore((s) => s.applySnapshot)

  const req = approvals[0]
  if (!req) return null

  function resolve(decision: "approved" | "rejected") {
    wsClient.send({ type: "approve", tabId: "", requestId: req!.id, decision })
    const remaining = approvals.slice(1)
    applySnapshot({ pendingApprovals: remaining })
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.box}>
        <h3>⏸ Approval Required</h3>
        <pre className={styles.msg}>{req.message ?? JSON.stringify(req, null, 2)}</pre>
        <div className={styles.btns}>
          <button className="btn btn-resume" onClick={() => resolve("approved")}>✓ Approve</button>
          <button className="btn btn-danger" onClick={() => resolve("rejected")}>✗ Reject</button>
        </div>
      </div>
    </div>
  )
}
