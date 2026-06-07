import type { TaskNode, AgentRole, Artifact } from "../dag/types"

// ─── Executor abstraction ─────────────────────────────────────────────────────
// Decouples the scheduler from *how* a task is executed. The conductor's
// scheduling loop only knows about Executors and ExecutionHandles — it does not
// know whether a task runs on an LLM agent (spawned codewhale process) or, in
// the future, a cheap deterministic worker (SQL runner, validator, comparator).
//
// Design intent: the default executor is the LLM agent (LLMExecutor), so today
// every task behaves exactly as before. A deterministic backend (the
// WorkerExecutor class, or any sql/validate/compare executor) sets
// `actsDirectly = true` and the conductor routes it down the worker path with
// no change to the scheduling core.

export type ExecutionStatus = "completed" | "failed" | "interrupted"

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
}

export interface ExecutionResult {
  status: ExecutionStatus
  /** The full text produced by the worker (LLM output, tool result, etc.). */
  rawText: string
  usage: TokenUsage
  /** Model that actually ran the task (null for non-LLM executors). */
  model: string | null
  /** Count of malformed stream lines observed, for observability. */
  malformedLines: number
}

export interface ExecutionOptions {
  /** Preferred model for this task; executor may ignore if not applicable. */
  model?: string
  /** Whether the executor may auto-approve internal tool/permission prompts. */
  autoApprove: boolean
  /** Inherit prior context (LLM fork_context); ignored by stateless executors. */
  forkContext: boolean
  /** Hard timeout for the whole execution. */
  timeoutMs: number
  /** Resolved upstream input artifacts (from inputFromDeps / inputArtifactIds).
   *  The LLM executor ignores these (it inlines them into the prompt instead);
   *  worker runners (validate/compare) consume them directly as their data. */
  inputArtifacts?: Artifact[]
}

/** Streamed incremental output. `model` is the resolved model (null if N/A). */
export type DeltaCallback = (delta: string, model: string | null) => void

/**
 * A reserved execution slot bound to a single task. Created synchronously by
 * Executor.reserve() so the scheduler can claim capacity without racing, then
 * consumed asynchronously by execute(). Always release() — on success, failure,
 * or if you decide not to execute after all (e.g. a file lock could not be
 * acquired) — to return the slot to the pool.
 */
export interface ExecutionHandle {
  /** Opaque id of the worker doing the work (an agent instance id for LLM). */
  readonly workerId: string
  execute(prompt: string, opts: ExecutionOptions, onDelta?: DeltaCallback): Promise<ExecutionResult>
  /** Return the slot to the pool. Idempotent. */
  release(): void
}

export interface Executor {
  /** Discriminator: "llm", "worker", "sql", "validate", … (free-form label). */
  readonly kind: string
  /**
   * Whether this executor acts on the task DIRECTLY (deterministic work whose
   * result IS the output) rather than driving an LLM. Governs how the conductor
   * treats the task:
   *   - false / undefined (default): LLM path — build the structured agent
   *     prompt, parse five-section markdown, rate-limit the start.
   *   - true: worker path — pass task.prompt through untouched, store the raw
   *     result verbatim as the artifact, skip LLM rate-limiting.
   * Defaulting to false keeps every existing/LLM-emulating executor on the safe
   * path; only genuinely deterministic backends opt in.
   */
  readonly actsDirectly?: boolean
  /** How many tasks can be dispatched right now (free slots in the pool). */
  availableSlots(): number
  /**
   * Reserve a slot for the given task, marking capacity busy synchronously.
   * Returns null if no slot is free. The returned handle MUST be released.
   */
  reserve(task: TaskNode): ExecutionHandle | null
}

/** Roles an executor can be asked to fulfil (mirrors AgentRole today). */
export type ExecutorRole = AgentRole
