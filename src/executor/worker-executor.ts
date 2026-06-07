import type { TaskNode, Artifact } from "../dag/types"
import type {
  Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, DeltaCallback,
} from "./types"

// ─── Worker Executor ──────────────────────────────────────────────────────────
// A cheap, deterministic backend that runs a plain async function per task —
// NO LLM, NO tokens, NO spawned process. This is where SQL execution, rule
// validation, numeric comparison, or any code-defined step belongs. The
// scheduler treats it exactly like the LLM executor (reserve/execute/release);
// it just doesn't build prompts or parse five-section markdown.
//
// The runner receives the task plus its resolved upstream artifacts (so
// validate/compare workers can act on prior results) and returns the full
// result as a string (JSON rows, a report, a diff). The conductor stores that
// verbatim as an artifact — same data-flow plumbing as the LLM path, no cost.

export type WorkerRunner = (task: TaskNode, inputs: Artifact[]) => Promise<string> | string

class WorkerExecutionHandle implements ExecutionHandle {
  private released = false
  constructor(
    readonly workerId: string,
    private readonly task: TaskNode,
    private readonly runner: WorkerRunner,
    private readonly onDone: () => void,
  ) {}

  async execute(_prompt: string, opts: ExecutionOptions, onDelta?: DeltaCallback): Promise<ExecutionResult> {
    // The prompt is ignored — a worker acts on the task + its upstream inputs,
    // not an LLM instruction. A timeout still applies so a hung runner can't
    // wedge a slot.
    const run = Promise.resolve(this.runner(this.task, opts.inputArtifacts ?? []))
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`worker timed out after ${opts.timeoutMs}ms`)), opts.timeoutMs))
    try {
      const rawText = await Promise.race([run, timeout])
      onDelta?.(rawText, null)   // emit once so streaming UIs see the result
      return {
        status: "completed",
        rawText,
        usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        model: null,
        malformedLines: 0,
      }
    } catch (err) {
      return {
        status: "failed",
        rawText: err instanceof Error ? err.message : String(err),
        usage: { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
        model: null,
        malformedLines: 0,
      }
    }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.onDone()
  }
}

export class WorkerExecutor implements Executor {
  readonly kind = "worker"
  readonly actsDirectly = true   // runs the task itself; no prompt build / parse
  private busy = 0
  constructor(private readonly runner: WorkerRunner, private readonly slots: number) {}

  availableSlots(): number {
    return Math.max(0, this.slots - this.busy)
  }

  reserve(task: TaskNode): ExecutionHandle | null {
    if (this.availableSlots() <= 0) return null
    this.busy++
    return new WorkerExecutionHandle(`worker-${task.id}`, task, this.runner, () => { this.busy-- })
  }
}
