import { createTaskNode } from "../dag/engine"
import type { TaskNode } from "../dag/types"

// ─── Goal → TaskGraph ─────────────────────────────────────────────────────────
// Converts a natural-language goal into a sensible default task graph:
//   Phase 0: explore (understand the codebase)
//   Phase 1: plan    (design the solution, gated on explore)
//   Phase 2: implement + review (parallel execution, gated on plan)
//   Phase 3: verify  (gated on all implements)

export interface GoalPlan {
  nodes: TaskNode[]
  description: string
}

export function goalToTaskGraph(goal: string, projectPath: string): GoalPlan {
  const outputSuffix = "\n\n---\nYour output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS"

  // ── Phase 0: Explore ────────────────────────────────────────────────────────
  const explore = createTaskNode({
    type: "explore",
    title: "Explore: understand codebase",
    prompt: [
      `You are starting work on the following goal:`,
      `"${goal}"`,
      ``,
      `First, explore the project at ${projectPath}.`,
      `Map the relevant files, modules, and dependencies.`,
      `Identify what needs to change and what risks exist.`,
      outputSuffix,
    ].join("\n"),
    scope: [],  // read-only: no file lock needed
    priority: 100,
  })

  // ── Phase 1: Plan ───────────────────────────────────────────────────────────
  const plan = createTaskNode({
    type: "plan",
    title: "Plan: design the solution",
    prompt: [
      `Based on your exploration of the project, create a detailed implementation plan for:`,
      `"${goal}"`,
      ``,
      `Produce:`,
      `1. A list of files to create/modify`,
      `2. The order of changes (dependencies between steps)`,
      `3. Potential risks and how to mitigate them`,
      `4. Estimated complexity per change`,
      outputSuffix,
    ].join("\n"),
    scope: [],
    priority: 90,
    dependsOn: [explore.id],
  })

  // ── Phase 2: Implement ──────────────────────────────────────────────────────
  const implement = createTaskNode({
    type: "implement",
    title: "Implement: execute the plan",
    prompt: [
      `Execute the implementation plan for:`,
      `"${goal}"`,
      ``,
      `Follow the plan from the previous phase.`,
      `Make minimal, correct changes. Do not refactor unrelated code.`,
      outputSuffix,
    ].join("\n"),
    scope: [projectPath],
    priority: 80,
    dependsOn: [plan.id],
  })

  const review = createTaskNode({
    type: "review",
    title: "Review: check the implementation",
    prompt: [
      `Review the implementation for:`,
      `"${goal}"`,
      ``,
      `Check for:`,
      `- Correctness and edge cases`,
      `- Type safety and style consistency`,
      `- Missing tests`,
      `Score each finding 1-10 by severity.`,
      outputSuffix,
    ].join("\n"),
    scope: [],  // read-only: no file lock needed
    priority: 75,
    dependsOn: [implement.id],
  })

  // ── Phase 3: Verify ─────────────────────────────────────────────────────────
  const verify = createTaskNode({
    type: "verify",
    title: "Verify: run tests and confirm",
    prompt: [
      `Verify the changes made for:`,
      `"${goal}"`,
      ``,
      `Run the test suite and confirm:`,
      `- All existing tests still pass`,
      `- New behavior works as expected`,
      `- No regressions introduced`,
      outputSuffix,
    ].join("\n"),
    scope: [],  // read-only: no file lock needed
    priority: 70,
    dependsOn: [implement.id, review.id],
  })

  return {
    nodes: [explore, plan, implement, review, verify],
    description: [
      `Phase 0: Explore codebase (1 agent)`,
      `Phase 1: Design solution plan (1 agent, after explore)`,
      `Phase 2: Implement + Review in parallel (2 agents, after plan)`,
      `Phase 3: Verify (1 agent, after implement + review)`,
    ].join("\n"),
  }
}
