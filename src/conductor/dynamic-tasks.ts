import { createTaskNode } from "../dag/engine"
import type { TaskNode, TaskOutput } from "../dag/types"

// ─── Dynamic Task Generator ───────────────────────────────────────────────────
// Inspects completed task output and inserts follow-up tasks into the DAG.
//
// Rules:
//   BLOCKERS → insert a new "implement" task per non-empty blocker line
//   RISKS (severity HIGH) → insert a "review" task for that risk
//   Changes with test-related paths → insert a "verify" task

const RISK_HIGH_RE = /\b(critical|high|severe|security|data loss|breaking)\b/i

export interface DynamicInsertionResult {
  inserted: TaskNode[]
  skipped: number
}

export function generateFollowupTasks(
  completedTask: TaskNode,
  output: TaskOutput,
  existingTitles: Set<string>
): DynamicInsertionResult {
  const inserted: TaskNode[] = []
  let skipped = 0

  // ── Blockers → implement tasks ───────────────────────────────────────────
  for (const blocker of output.blockers) {
    const trimmed = blocker.replace(/^[-*\s]+/, "").trim()
    if (!trimmed) continue

    const title = `Fix: ${trimmed.slice(0, 80)}`
    if (existingTitles.has(title)) { skipped++; continue }

    inserted.push(createTaskNode({
      type: "implement",
      title,
      prompt: [
        `A blocker was reported by a previous agent while working on "${completedTask.title}".`,
        ``,
        `Blocker: ${trimmed}`,
        ``,
        `Resolve this blocker. Scope your changes to the minimum needed.`,
      ].join("\n"),
      scope: completedTask.scope,
      priority: completedTask.priority + 5, // slightly higher than parent
      dependsOn: [completedTask.id],
    }))
  }

  // ── High-severity risks → review tasks ──────────────────────────────────
  for (const risk of output.risks) {
    if (!RISK_HIGH_RE.test(risk)) continue
    const trimmed = risk.replace(/^[-*\s]+/, "").trim()
    if (!trimmed) continue

    const title = `Review risk: ${trimmed.slice(0, 60)}`
    if (existingTitles.has(title)) { skipped++; continue }

    inserted.push(createTaskNode({
      type: "review",
      title,
      prompt: [
        `A high-severity risk was flagged during "${completedTask.title}".`,
        ``,
        `Risk: ${trimmed}`,
        ``,
        `Review the relevant code and verify the risk is mitigated or document why it is acceptable.`,
        `Output a severity score (1-10) and recommended action.`,
      ].join("\n"),
      scope: completedTask.scope,
      priority: completedTask.priority + 10,
      dependsOn: [completedTask.id],
    }))
  }

  // ── Changes touching test files → verify task ────────────────────────────
  const touchesTests = completedTask.scope.some(p =>
    /\b(test|spec|__tests__)\b/i.test(p) || p.endsWith(".test.ts") || p.endsWith(".spec.ts")
  ) || output.changes.some(c =>
    /\b(test|spec)\b/i.test(c.file)
  )

  if (touchesTests && output.changes.length > 0) {
    const title = `Verify: ${completedTask.title}`
    if (!existingTitles.has(title)) {
      inserted.push(createTaskNode({
        type: "verify",
        title,
        prompt: [
          `Task "${completedTask.title}" made changes that affect test files.`,
          ``,
          `Run the test suite and report:`,
          `- Which tests pass / fail`,
          `- Any new test failures introduced`,
          `- Coverage delta if available`,
        ].join("\n"),
        scope: completedTask.scope,
        priority: completedTask.priority - 5,
        dependsOn: [completedTask.id],
      }))
    }
  }

  return { inserted, skipped }
}
