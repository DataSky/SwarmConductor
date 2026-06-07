import type { ConductorStore } from "../memory/store"
import type { TaskDAG } from "../dag/engine"

// ─── Self-check (M4) ──────────────────────────────────────────────────────────
// Deterministic, zero-LLM invariant checks that run after a conductor run
// completes. The checks are purely structural — they query the DB and the
// in-memory DAG to verify the system's own postconditions.
//
// Why here and not in tests? Tests verify code paths before a run. Self-check
// verifies ACTUAL RUN STATE after the fact, against data that only exists once
// the run has executed. It is the foundation for "trace-based self-validation".

export type Severity = "error" | "warning"

export interface Violation {
  rule: string
  severity: Severity
  detail: string
  relatedTaskIds: string[]
}

export interface SelfCheckReport {
  runId: string
  passed: boolean
  checkedAt: number
  violations: Violation[]
}

// ─── Individual check functions ───────────────────────────────────────────────

/** Every task that reached "done" must have at least one artifact in the DB. */
function checkDoneTasksHaveArtifacts(store: ConductorStore, dag: TaskDAG): Violation[] {
  const violations: Violation[] = []
  for (const task of dag.allTasks()) {
    if (task.status !== "done") continue
    const arts = store.getArtifactsByTask(task.id)
    if (arts.length === 0) {
      violations.push({
        rule: "done_task_has_artifact",
        severity: "error",
        detail: `Task "${task.title}" (${task.id}) is done but has no artifact`,
        relatedTaskIds: [task.id],
      })
    }
  }
  return violations
}

/** A done task's completedAt must be > startedAt (no negative durations). */
function checkTimestampOrdering(dag: TaskDAG): Violation[] {
  const violations: Violation[] = []
  for (const task of dag.allTasks()) {
    if (task.status !== "done") continue
    if (task.startedAt !== null && task.completedAt !== null) {
      if (task.completedAt <= task.startedAt) {
        violations.push({
          rule: "timestamp_ordering",
          severity: "warning",
          detail: `Task "${task.title}" (${task.id}) completedAt(${task.completedAt}) ≤ startedAt(${task.startedAt})`,
          relatedTaskIds: [task.id],
        })
      }
    }
  }
  return violations
}

/** At run completion, no task should still be in "running" state. */
function checkNoTasksStuckRunning(dag: TaskDAG): Violation[] {
  const running = dag.runningTasks()
  if (running.length === 0) return []
  return [{
    rule: "no_running_at_completion",
    severity: "error",
    detail: `${running.length} task(s) still in "running" state after run completed`,
    relatedTaskIds: running.map(t => t.id),
  }]
}

/** Every task with inputFromDeps or inputArtifactIds must have non-empty
 *  sourceArtifactIds on its artifact (lineage must be recorded). */
function checkDataFlowLineage(store: ConductorStore, dag: TaskDAG): Violation[] {
  const violations: Violation[] = []
  for (const task of dag.allTasks()) {
    if (task.status !== "done") continue
    if (!task.inputFromDeps && !task.inputArtifactIds?.length) continue
    const arts = store.getArtifactsByTask(task.id)
    for (const art of arts) {
      if (!art.sourceArtifactIds || art.sourceArtifactIds.length === 0) {
        violations.push({
          rule: "dataflow_lineage_recorded",
          severity: "warning",
          detail: `Task "${task.title}" (${task.id}) has data-flow input but artifact ${art.id} has no sourceArtifactIds`,
          relatedTaskIds: [task.id],
        })
        break  // one violation per task is enough
      }
    }
  }
  return violations
}

/** All sourceArtifactIds referenced by any artifact must actually exist. */
function checkNoHangingArtifactRefs(store: ConductorStore, dag: TaskDAG): Violation[] {
  const violations: Violation[] = []
  for (const task of dag.allTasks()) {
    const arts = store.getArtifactsByTask(task.id)
    for (const art of arts) {
      for (const srcId of art.sourceArtifactIds ?? []) {
        const src = store.getArtifact(srcId)
        if (!src) {
          violations.push({
            rule: "no_dangling_artifact_ref",
            severity: "error",
            detail: `Artifact ${art.id} (task "${task.title}") references non-existent source artifact ${srcId}`,
            relatedTaskIds: [task.id],
          })
        }
      }
    }
  }
  return violations
}

/** Worker tasks (executorKind set, non-llm) should have consumed 0 tokens. */
function checkWorkerZeroTokens(dag: TaskDAG): Violation[] {
  const violations: Violation[] = []
  for (const task of dag.allTasks()) {
    if (task.status !== "done") continue
    if (!task.executorKind) continue  // LLM path
    const u = task.tokenUsage
    if (u && (u.inputTokens > 0 || u.outputTokens > 0)) {
      violations.push({
        rule: "worker_zero_tokens",
        severity: "warning",
        detail: `Worker task "${task.title}" (${task.id}) logged tokens: input=${u.inputTokens} output=${u.outputTokens}`,
        relatedTaskIds: [task.id],
      })
    }
  }
  return violations
}

// ─── Runner ────────────────────────────────────────────────────────────────────

/** Run all deterministic self-checks, persist the result to event_log, and
 *  return the report. Call after `conductor.waitForCompletion()` and before
 *  `conductor.shutdown()`. */
export function runSelfCheck(runId: string, store: ConductorStore, dag: TaskDAG): SelfCheckReport {
  const violations: Violation[] = [
    ...checkDoneTasksHaveArtifacts(store, dag),
    ...checkTimestampOrdering(dag),
    ...checkNoTasksStuckRunning(dag),
    ...checkDataFlowLineage(store, dag),
    ...checkNoHangingArtifactRefs(store, dag),
    ...checkWorkerZeroTokens(dag),
  ]

  const report: SelfCheckReport = {
    runId,
    passed: violations.filter(v => v.severity === "error").length === 0,
    checkedAt: Date.now(),
    violations,
  }

  // Persist into event_log so the self-check is itself part of the trace
  store.logConductorEvent(
    {
      kind: "selfcheck.completed" as import("../dag/types").ConductorEventKind,
      payload: {
        passed: report.passed,
        errorCount: violations.filter(v => v.severity === "error").length,
        warningCount: violations.filter(v => v.severity === "warning").length,
      },
      timestamp: report.checkedAt,
    },
    "_selfcheck",
    "_",
  )

  return report
}
