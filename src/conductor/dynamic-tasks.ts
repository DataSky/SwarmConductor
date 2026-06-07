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

/** Chinese-language stub phrases that non-English agents sometimes produce
 *  instead of "none" in the output contract sections. */
const CHINESE_STUB_RE = /^五[个]?[节段](落|章)?[。.]?$/

/** Maximum dynamic tasks (blockers + risks combined) generated per parent task.
 *  Prevents a single verbose agent output from flooding the DAG. */
const MAX_DYNAMIC_PER_TASK = 2

/** Maximum dynamic-generation depth. A task generated from an original task has
 *  depth 1; one generated from THAT has depth 2; etc. Beyond this cap no further
 *  follow-ups are generated, which stops runaway recursion such as the observed
 *  verify→verify→verify chain (each level had a distinct title, so title-based
 *  dedup alone could not stop it). */
const MAX_DYNAMIC_DEPTH = 2

/** Minimum blocker text length — short strings are almost always noise. */
const MIN_BLOCKER_LEN = 15

/** A meaningful blocker must contain a verb or colon indicating actionable work. */
const MEANINGFUL_BLOCKER_RE = /[:：]|\b(need|needs|must|require|requires|missing|broken|fail|failed|cannot|unable|implement|fix|add|update|create|remove)\b/i

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
  let dynamicCount = 0  // shared cap: blockers + risks combined

  // Depth guard: stop generating once we're at/over the cap, so dynamically
  // generated tasks can't spawn an unbounded chain of further follow-ups.
  const parentDepth = completedTask.dynamicDepth ?? 0
  if (parentDepth >= MAX_DYNAMIC_DEPTH) return { inserted, skipped }
  const childDepth = parentDepth + 1

  // ── Blockers → implement tasks ───────────────────────────────────────────
  for (const blocker of output.blockers) {
    if (dynamicCount >= MAX_DYNAMIC_PER_TASK) break

    const trimmed = blocker.replace(/^[-*\s]+/, "").trim()
    if (!trimmed || /^none$/i.test(trimmed) || CHINESE_STUB_RE.test(trimmed)) continue
    if (trimmed.length <= MIN_BLOCKER_LEN) continue
    if (!MEANINGFUL_BLOCKER_RE.test(trimmed)) continue

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
      dynamicDepth: childDepth,
    }))
    dynamicCount++
  }

  // ── High-severity risks → review tasks ──────────────────────────────────
  for (const risk of output.risks) {
    if (dynamicCount >= MAX_DYNAMIC_PER_TASK) break
    if (!RISK_HIGH_RE.test(risk)) continue

    const trimmed = risk.replace(/^[-*\s]+/, "").trim()
    if (!trimmed || /^none$/i.test(trimmed) || CHINESE_STUB_RE.test(trimmed)) continue

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
      dynamicDepth: childDepth,
    }))
    dynamicCount++
  }

  // ── Changes touching test files → verify task ────────────────────────────
  // Only spawn from a task that actually edits code (implement). A verify task
  // re-running tests must NOT spawn another verify — that was the source of the
  // observed verify→verify→verify recursion (distinct titles defeated dedup).
  const touchesTests = completedTask.type === "implement" && (
    completedTask.scope.some(p =>
      /\b(test|spec|__tests__)\b/i.test(p) || p.endsWith(".test.ts") || p.endsWith(".spec.ts")
    ) || output.changes.some(c => /\b(test|spec)\b/i.test(c.file))
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
        dynamicDepth: childDepth,
      }))
    }
  }

  return { inserted, skipped }
}
