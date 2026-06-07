import type { TaskNode } from "../dag/types"
import type { AgentProcessManager } from "../runtime/agent-manager"
import type {
  Executor, ExecutionHandle, ExecutionOptions, ExecutionResult, ExecutionStatus, DeltaCallback,
} from "./types"

// ─── LLM Executor ─────────────────────────────────────────────────────────────
// The default executor: runs each task on a spawned codewhale agent over HTTP.
// This is a thin adapter over AgentProcessManager + CodeWhaleClient — it holds
// exactly the per-task execution logic that used to be inlined in
// Conductor.dispatch(), now behind the Executor interface so the scheduler is
// agnostic to the backend.

/** Map CodeWhale's wider turn-status union onto the executor's terminal set. */
function toExecutionStatus(s: string): ExecutionStatus {
  if (s === "completed") return "completed"
  if (s === "interrupted" || s === "canceled") return "interrupted"
  return "failed"   // queued / in_progress should never be terminal; treat as failed
}

class LLMExecutionHandle implements ExecutionHandle {
  private released = false
  constructor(
    readonly workerId: string,
    private readonly mgr: AgentProcessManager,
    private readonly taskId: string,
  ) {}

  async execute(prompt: string, opts: ExecutionOptions, onDelta?: DeltaCallback): Promise<ExecutionResult> {
    const client = this.mgr.getClient(this.workerId)

    // Open a thread (chooses the model), then record it on the instance so the
    // dashboard and token accounting see the real model id.
    const thread = await client.createThread(opts.model)
    this.mgr.markBusy(this.workerId, this.taskId, thread.id, thread.model)
    const model = this.mgr.getInstance(this.workerId)?.model ?? null

    const turn = await client.postTurn(thread.id, {
      prompt,
      auto_approve: opts.autoApprove,
      fork_context: opts.forkContext,
    })

    const { fullText, status, usage, malformedLines } = await client.waitForTurn(
      thread.id, turn.id,
      onDelta ? (delta) => onDelta(delta, model) : undefined,
      opts.timeoutMs,
    )

    return { status: toExecutionStatus(status), rawText: fullText, usage, model, malformedLines }
  }

  release(): void {
    if (this.released) return
    this.released = true
    this.mgr.markIdle(this.workerId)
  }
}

export class LLMExecutor implements Executor {
  readonly kind = "llm"
  constructor(private readonly mgr: AgentProcessManager) {}

  availableSlots(): number {
    return this.mgr.idleInstances().length
  }

  reserve(task: TaskNode): ExecutionHandle | null {
    // Prefer an idle agent matching the task role, then a general agent, then
    // any idle agent — same precedence the scheduler used inline before.
    const agent =
      this.mgr.idleByRole(task.role)[0] ??
      this.mgr.idleByRole("general")[0] ??
      this.mgr.idleInstances()[0]
    if (!agent) return null

    // Claim the slot synchronously so a concurrent reserve() in the same tick
    // cannot pick the same agent. execute() later overwrites threadId/model.
    this.mgr.markBusy(agent.id, task.id, "pending")
    return new LLMExecutionHandle(agent.id, this.mgr, task.id)
  }
}
