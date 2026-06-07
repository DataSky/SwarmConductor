import { DuckDBInstance } from "@duckdb/node-api"
import { Conductor } from "../../conductor"
import { defaultConfig } from "../../dag/types"
import { createTaskNode } from "../../dag/engine"
import { WorkerExecutor } from "../../executor/worker-executor"
import { makeSqlWorker } from "../../worker/sql-worker"
import { makeValidateWorker, makeCompareWorker } from "../../worker/validate-compare"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// ─── POST /api/dataflow/run ───────────────────────────────────────────────────
// Self-service entry point for data-flow analysis. The caller submits a DuckDB
// path + a declarative task list (sql / validate / compare / llm); the server
// builds a Conductor wired with the deterministic workers, runs the DAG, and
// returns structured results + artifacts. Runs synchronously (await completion)
// — fine for localhost, curl-driven use.
//
// SECURITY: this executes caller-supplied SQL and can spend LLM tokens, so it
// is gated by a bearer token (SWARM_API_TOKEN) and the server binds localhost.

interface DataflowTaskSpec {
  key: string
  kind: "sql" | "validate" | "compare" | "llm"
  title?: string
  /** sql: the query. validate/compare: JSON config. llm: the instruction. */
  sql?: string
  rules?: unknown
  keyColumn?: string
  prompt?: string
  dependsOn?: string[]   // other task keys
}

export interface DataflowRequest {
  db?: string                 // DuckDB file path; omitted → in-memory (empty)
  agents?: number             // LLM agents to spawn for any llm tasks
  tasks: DataflowTaskSpec[]
}

export interface DataflowResult {
  runId: string
  status: string
  tasks: { key: string; title: string; kind: string; status: string }[]
  artifacts: Record<string, string>   // key → artifact content (the result)
  tokens: { inputTokens: number; outputTokens: number }
}

/** Build the per-task prompt the worker/LLM expects from the spec. */
function promptFor(spec: DataflowTaskSpec): string {
  if (spec.kind === "sql") return spec.sql ?? ""
  if (spec.kind === "validate") return JSON.stringify({ rules: spec.rules ?? [] })
  if (spec.kind === "compare") return JSON.stringify({ keyColumn: spec.keyColumn })
  return spec.prompt ?? ""   // llm
}

export async function handleDataflowRun(body: DataflowRequest): Promise<DataflowResult> {
  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    throw new Error("request must include a non-empty tasks[] array")
  }

  // DuckDB opened READ_ONLY for analytical safety (caller SQL can't mutate).
  // A path is required for sql tasks to have data; in-memory is allowed but empty.
  const hasSql = body.tasks.some(t => t.kind === "sql")
  const instance = body.db
    ? await DuckDBInstance.create(body.db, { access_mode: "READ_ONLY" })
    : await DuckDBInstance.create(":memory:")
  if (hasSql && !body.db) {
    instance.closeSync?.()
    throw new Error("sql tasks require a 'db' path (in-memory has no data)")
  }

  // Each worker kind is its own executor instance (distinct kind, actsDirectly).
  const mk = (runner: ReturnType<typeof makeSqlWorker>, kind: string) => {
    const ex = new WorkerExecutor(runner, 4)
    ;(ex as unknown as { kind: string }).kind = kind
    return ex
  }
  const sqlExec = mk(makeSqlWorker(instance), "sql")
  const validateExec = mk(makeValidateWorker(), "validate")
  const compareExec = mk(makeCompareWorker(), "compare")

  const projectDir = mkdtempSync(join(tmpdir(), "dataflow-"))
  const config = defaultConfig({ projectPath: projectDir, maxConcurrentAgents: body.agents ?? 1, autoApprove: true, dynamicTasks: false })
  const conductor = new Conductor(config, undefined, undefined, [sqlExec, validateExec, compareExec])
  await conductor.initialize()

  // Map specs → TaskNodes, wiring dependsOn by key and routing by kind.
  const keyToId: Record<string, string> = {}
  const specByKey: Record<string, DataflowTaskSpec> = {}
  for (const s of body.tasks) specByKey[s.key] = s
  const nodes = body.tasks.map(s => {
    const node = createTaskNode({
      type: s.kind === "llm" ? "review" : "verify",
      title: s.title ?? s.key,
      prompt: promptFor(s),
      scope: [],
      ...(s.kind !== "llm" ? { executorKind: s.kind } : {}),
    })
    keyToId[s.key] = node.id
    return node
  })
  // Second pass: wire dependencies + inputFromDeps for consumers.
  for (const node of nodes) {
    const spec = body.tasks.find(s => keyToId[s.key] === node.id)!
    const deps = (spec.dependsOn ?? []).map(k => keyToId[k]).filter(Boolean) as string[]
    if (deps.length > 0) {
      node.dependsOn = deps
      node.inputFromDeps = true   // hand upstream results to validate/compare/llm
    }
  }

  conductor.taskDag.addTasks(nodes)
  // Spawn LLM agents only if there are llm tasks.
  if (body.tasks.some(t => t.kind === "llm")) {
    await conductor.spawnAgents(Array(body.agents ?? 1).fill("general"))
  }

  conductor.startScheduler()
  const status = await conductor.waitForCompletion(600_000)

  // Collect results before shutdown closes the DB.
  const artifacts: Record<string, string> = {}
  const tasks = body.tasks.map(s => {
    const id = keyToId[s.key]!
    const arts = conductor.store.getArtifactsByTask(id)
    if (arts[0]) artifacts[s.key] = arts[0].content
    return { key: s.key, title: s.title ?? s.key, kind: s.kind, status: conductor.taskDag.getTask(id)?.status ?? "unknown" }
  })
  const tokenStats = conductor.store.tokenStats()
  const runId = conductor.runId

  await conductor.shutdown()
  instance.closeSync?.()

  return { runId, status, tasks, artifacts, tokens: { inputTokens: tokenStats.inputTokens, outputTokens: tokenStats.outputTokens } }
}
