import { createTaskNode } from "../dag/engine"
import type { TaskNode, FanOutSpec, ArtifactRef, TaskType } from "../dag/types"

const VALID_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
  "explore", "plan", "implement", "review", "verify", "merge",
])

// ─── Declarative fan-out ──────────────────────────────────────────────────────
// Materializes a batch of FanOutSpecs into TaskNodes with dependencies wired:
//   • dependsOnParent → depend on the task that produced the fan-out
//   • dependsOnKeys   → depend on sibling specs in the same batch (by key)
//   • inputFromParent → inherit the parent's produced artifact IDs as inputs
//
// This is the data-flow primitive: one task can fan out into N children, and
// children can form their own sub-DAG (e.g. cross-comparison tasks that each
// depend on two upstream query tasks). Pure function — no I/O, easy to test.

export interface BuildFanOutInput {
  parent: TaskNode
  /** Artifact refs the parent produced (for inputFromParent wiring). */
  parentArtifacts: ArtifactRef[]
  specs: FanOutSpec[]
}

export interface BuildFanOutResult {
  nodes: TaskNode[]
  /** Map of spec.key → generated task id, for callers that need it. */
  keyToId: Record<string, string>
  /** Specs dropped because a referenced key was unknown, with the reason. */
  warnings: string[]
}

export function buildFanOutTasks(input: BuildFanOutInput): BuildFanOutResult {
  const { parent, parentArtifacts, specs } = input
  const warnings: string[] = []

  // Pass 1: create a node per spec and record its key → id.
  const keyToId: Record<string, string> = {}
  const nodes: TaskNode[] = []
  const specForNode = new Map<string, FanOutSpec>()

  for (const spec of specs) {
    const parentInputs = spec.inputFromParent ? parentArtifacts.map(a => a.id) : []
    const inputArtifactIds = [...(spec.inputArtifactIds ?? []), ...parentInputs]

    const node = createTaskNode({
      type: spec.type,
      title: spec.title,
      prompt: spec.prompt,
      scope: spec.scope ?? parent.scope,
      ...(spec.role ? { role: spec.role } : {}),
      priority: spec.priority ?? parent.priority,
      ...(inputArtifactIds.length > 0 ? { inputArtifactIds } : {}),
      ...(spec.inputFromDeps ? { inputFromDeps: true } : {}),
      ...(spec.executorKind ? { executorKind: spec.executorKind } : {}),
      ...(spec.failurePolicy ? { failurePolicy: spec.failurePolicy } : {}),
      dataflow: true,   // explicit data-flow node — heuristics must not fire on it
    })
    nodes.push(node)
    specForNode.set(node.id, spec)
    if (spec.key) keyToId[spec.key] = node.id
  }

  // Pass 2: wire dependencies now that every key has an id.
  for (const node of nodes) {
    const spec = specForNode.get(node.id)!
    const deps = new Set<string>()

    if (spec.dependsOnParent) deps.add(parent.id)

    for (const key of spec.dependsOnKeys ?? []) {
      const id = keyToId[key]
      if (id) deps.add(id)
      else warnings.push(`spec "${spec.title}" depends on unknown key "${key}" — skipped`)
    }

    node.dependsOn = Array.from(deps)
  }

  return { nodes, keyToId, warnings }
}

// ─── Output-driven fan-out directive ──────────────────────────────────────────
// An agent (typically a planner) can declare children by emitting a fenced JSON
// block in a `## SPAWN` section of its output:
//
//   ## SPAWN
//   ```json
//   [ { "type": "verify", "title": "validate query 1", "prompt": "...",
//       "inputFromParent": true, "dependsOnParent": true } ]
//   ```
//
// Agent output is untrusted: parse defensively, validate every field, and
// silently drop malformed specs rather than throwing. Returns [] if absent.

export function parseSpawnDirective(rawText: string): FanOutSpec[] {
  // Locate the SPAWN section (everything until the next "## " header or EOF).
  const sec = rawText.match(/##\s*SPAWN\b([\s\S]*?)(?=\r?\n##\s|\s*$)/i)
  if (!sec || !sec[1]) return []

  // Prefer a fenced code block; fall back to the first [...] array in the body.
  const fenced = sec[1].match(/```(?:json)?\s*([\s\S]*?)```/i)
  const jsonText = (fenced?.[1] ?? sec[1]).trim()
  const start = jsonText.indexOf("[")
  const end = jsonText.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) return []

  let parsed: unknown
  try { parsed = JSON.parse(jsonText.slice(start, end + 1)) }
  catch { return [] }
  if (!Array.isArray(parsed)) return []

  const specs: FanOutSpec[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== "object") continue
    const o = raw as Record<string, unknown>
    const type = o["type"]
    const title = o["title"]
    const prompt = o["prompt"]
    // Required, well-typed fields — drop the spec if any is invalid.
    if (typeof type !== "string" || !VALID_TYPES.has(type as TaskType)) continue
    if (typeof title !== "string" || title.trim() === "") continue
    if (typeof prompt !== "string" || prompt.trim() === "") continue

    const spec: FanOutSpec = { type: type as TaskType, title, prompt }
    if (typeof o["key"] === "string") spec.key = o["key"]
    if (Array.isArray(o["scope"])) spec.scope = (o["scope"] as unknown[]).filter(s => typeof s === "string") as string[]
    if (typeof o["priority"] === "number") spec.priority = o["priority"]
    if (o["dependsOnParent"] === true) spec.dependsOnParent = true
    if (o["inputFromParent"] === true) spec.inputFromParent = true
    if (o["inputFromDeps"] === true) spec.inputFromDeps = true
    if (typeof o["executorKind"] === "string") spec.executorKind = o["executorKind"]
    if (o["failurePolicy"] === "all" || o["failurePolicy"] === "tolerate") spec.failurePolicy = o["failurePolicy"]
    if (Array.isArray(o["dependsOnKeys"])) spec.dependsOnKeys = (o["dependsOnKeys"] as unknown[]).filter(k => typeof k === "string") as string[]
    if (Array.isArray(o["inputArtifactIds"])) spec.inputArtifactIds = (o["inputArtifactIds"] as unknown[]).filter(k => typeof k === "string") as string[]
    specs.push(spec)
  }
  return specs
}

