import { describe, it, expect, afterEach } from "bun:test"
import { Conductor } from "../src/conductor"
import { defaultConfig } from "../src/dag/types"
import { createTaskNode } from "../src/dag/engine"
import type { Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback } from "../src/executor/types"
import { mkdirSync, rmSync } from "fs"
import { join } from "path"

// ─── Fake executor ────────────────────────────────────────────────────────────
// Implements the Executor interface with canned, deterministic outputs and a
// fixed slot pool. Crucially it CAPTURES the prompt each task receives, so we
// can prove — without any LLM — that the cross-comparison task was handed the
// FULL content of its upstream analyses (the inputFromDeps data-flow path).

interface CapturedPrompt { taskId: string; prompt: string }

class FakeExecutor implements Executor {
  readonly kind = "fake"
  private free: number
  readonly captured: CapturedPrompt[] = []
  /** taskId → canned raw output the agent "returns". */
  constructor(slots: number, private readonly responses: (taskId: string) => string) {
    this.free = slots
  }
  availableSlots(): number { return this.free }
  reserve(task: { id: string }): ExecutionHandle | null {
    if (this.free <= 0) return null
    this.free--
    const self = this
    let released = false
    return {
      workerId: `fake-${task.id}`,
      async execute(prompt: string, _opts: ExecutionOptions, _onDelta?: DeltaCallback): Promise<ExecutionResult> {
        self.captured.push({ taskId: task.id, prompt })
        return {
          status: "completed",
          rawText: self.responses(task.id),
          usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
          model: "fake-model",
          malformedLines: 0,
        }
      },
      release() { if (!released) { released = true; self.free++ } },
    }
  }
}

// ─── Harness ──────────────────────────────────────────────────────────────────

const DIR = join(process.cwd(), ".test-dataflow")
afterEach(() => rmSync(DIR, { recursive: true, force: true }))

function analysis(marker: string): string {
  return [
    `## SUMMARY`, `Analysis result: ${marker}`,
    `## CHANGES`, `none`,
    `## EVIDENCE`, `${marker}-evidence`,
    `## RISKS`, `none`,            // benign — must not trip the high-risk approval gate
    `## BLOCKERS`, `none`,
  ].join("\n")
}

// ─── Test ─────────────────────────────────────────────────────────────────────

describe("data-flow fan-out → cross-comparison (deterministic, no LLM)", () => {
  it("inlines all upstream analyses into the comparison task's prompt", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    // Distinct marker per analysis so we can prove each reached the comparator.
    const markers: Record<string, string> = {}
    const fake = new FakeExecutor(3, (taskId) => {
      if (taskId in markers) return analysis(markers[taskId]!)
      return analysis("compare-done")   // the comparison task's own output
    })

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 3, dynamicTasks: false })
    const conductor = new Conductor(config, "run-dataflow", fake)
    await conductor.initialize()

    // Three independent analyses (distinct scopes → run in parallel).
    const a = createTaskNode({ type: "review", title: "analyze A", prompt: "analyze module A", scope: ["src/module-a.ts"] })
    const b = createTaskNode({ type: "review", title: "analyze B", prompt: "analyze module B", scope: ["src/module-b.ts"] })
    const c = createTaskNode({ type: "review", title: "analyze C", prompt: "analyze module C", scope: ["src/module-c.ts"] })
    markers[a.id] = "MARKER_PERF_A"
    markers[b.id] = "MARKER_NULLSAFETY_B"
    markers[c.id] = "MARKER_CLEAN_C"

    // Comparison depends on all three and pulls their FULL artifacts in.
    const compare = createTaskNode({
      type: "review", title: "compare all", prompt: "rank the three analyses",
      scope: [], dependsOn: [a.id, b.id, c.id], inputFromDeps: true,
    })

    conductor.taskDag.addTasks([a, b, c, compare])
    // No spawnAgents() — the fake executor supplies its own slot pool, so the
    // scheduler never touches the real agent process manager.

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(10_000)
    // Capture lineage before shutdown closes the DB.
    const compareArtifacts = conductor.store.getArtifactsByTask(compare.id)
    const aArtifacts = conductor.store.getArtifactsByTask(a.id)
    const bArtifacts = conductor.store.getArtifactsByTask(b.id)
    const cArtifacts = conductor.store.getArtifactsByTask(c.id)
    await conductor.shutdown()

    expect(result).toBe("completed")

    // The comparison task's prompt must contain every upstream analysis marker —
    // proof that inputFromDeps inlined the full sibling artifacts at dispatch.
    const comparePrompt = fake.captured.find(c => c.taskId === compare.id)?.prompt ?? ""
    expect(comparePrompt).toContain("MARKER_PERF_A")
    expect(comparePrompt).toContain("MARKER_NULLSAFETY_B")
    expect(comparePrompt).toContain("MARKER_CLEAN_C")
    // And it must be under the "Input Data" data-flow block, not the truncated context.
    expect(comparePrompt).toContain("Input Data (complete, from upstream tasks)")

    // Lineage: the comparison artifact records the three analysis artifacts as sources.
    const sources = compareArtifacts[0]!.sourceArtifactIds ?? []
    expect(sources).toContain(aArtifacts[0]!.id)
    expect(sources).toContain(bArtifacts[0]!.id)
    expect(sources).toContain(cArtifacts[0]!.id)
  })

  it("does not deadlock on a high-risk output when autoApprove is set", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    // Output flagged with a high-severity risk that would normally open the
    // human approval gate. With autoApprove (unattended), the run must still
    // complete instead of blocking forever on a gate nobody can resolve.
    const riskyOutput = [
      `## SUMMARY`, `done`,
      `## CHANGES`, `none`,
      `## EVIDENCE`, `none`,
      `## RISKS`, `CRITICAL: this will break production`,
      `## BLOCKERS`, `none`,
    ].join("\n")
    const fake = new FakeExecutor(1, () => riskyOutput)

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 1, autoApprove: true, dynamicTasks: false })
    const conductor = new Conductor(config, "run-highrisk", fake)
    await conductor.initialize()
    conductor.taskDag.addTasks([
      createTaskNode({ type: "implement", title: "risky", prompt: "do it", scope: [] }),
    ])

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(8_000)
    await conductor.shutdown()

    expect(result).toBe("completed")   // would be "timeout" before the fix
  })

  it("a dataflow task's blocker/risk text does NOT spawn heuristic noise tasks", async () => {
    rmSync(DIR, { recursive: true, force: true })
    mkdirSync(DIR, { recursive: true })

    // Output whose BLOCKERS/RISKS contain actionable-looking text that the
    // legacy heuristic WOULD mine into follow-up tasks. Because the task is a
    // data-flow node, the heuristic must be skipped — no noise tasks created.
    const noisy = [
      `## SUMMARY`, `analysis complete`,
      `## CHANGES`, `none`,
      `## EVIDENCE`, `none`,
      `## RISKS`, `- HIGH: must fix the null deref before shipping to production`,
      `## BLOCKERS`, `- needs the validation layer implemented first`,
    ].join("\n")
    const fake = new FakeExecutor(1, () => noisy)

    const config = defaultConfig({ projectPath: DIR, maxConcurrentAgents: 1, autoApprove: true, dynamicTasks: true })
    const conductor = new Conductor(config, "run-dataflow-noise", fake)
    await conductor.initialize()

    const inserted: string[] = []
    conductor.onEvent(e => { if (e.kind === "task.dynamic_inserted") inserted.push(String(e.payload["title"])) })

    // A single data-flow task (as if created by SPAWN).
    const t = createTaskNode({ type: "review", title: "analyze", prompt: "p", scope: [] })
    t.dataflow = true
    conductor.taskDag.addTasks([t])

    conductor.startScheduler()
    const result = await conductor.waitForCompletion(8_000)
    await conductor.shutdown()

    expect(result).toBe("completed")
    expect(inserted).toHaveLength(0)   // heuristic skipped — no noise
    expect(conductor.taskDag.allTasks()).toHaveLength(1)
  })
})
