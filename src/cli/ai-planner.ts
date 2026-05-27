import { createTaskNode } from "../dag/engine"
import type { TaskNode, TaskType, AgentRole } from "../dag/types"
import { scanProjectContext } from "./project-scanner"

// ─── AI Orchestrator — DMXAPI with DeepSeek fallback ─────────────────────────
// Primary:  claude-opus-4-7 via DMXAPI
// Fallback: deepseek-v3 via DMXAPI (same base URL, different model ID)
// The fallback triggers on any non-2xx response or network error from primary.

export interface GoalPlan {
  nodes: TaskNode[]
  description: string
}

interface AITaskSpec {
  title: string
  type: TaskType
  role?: AgentRole
  prompt: string
  scope: string[]
  priority: number
  dependsOn?: string[]   // titles of tasks this depends on (resolved to IDs below)
  forkContext?: boolean
}

interface PlannerResponse {
  description: string
  tasks: AITaskSpec[]
}

const DMXAPI_URL      = "https://www.dmxapi.cn/v1/chat/completions"
const DMXAPI_KEY      = "sk-yL623kg9yYnzwONfcztfgjIPRdCdeuWPvSXtg9qtw2wJ4rRQ"
export const PRIMARY_PLANNER_MODEL  = "claude-opus-4-7"
const FALLBACK_MODEL  = "deepseek-v3"   // used when primary fails

const SYSTEM_PROMPT = `You are an expert software engineering orchestrator.
Given a natural-language goal and a project path, produce a minimal, precise task graph.

Respond ONLY with a JSON object matching this schema (no markdown fences):
{
  "description": "one-line summary of the plan",
  "tasks": [
    {
      "title": "short descriptive title",
      "type": "explore" | "plan" | "implement" | "review" | "verify" | "merge",
      "role": "explore" | "plan" | "implementer" | "review" | "verifier" | "general",
      "prompt": "precise, unambiguous instruction for this task — include output format requirements",
      "scope": ["relative/path/or/glob"],
      "priority": 100,
      "dependsOn": ["title of another task"],
      "forkContext": false
    }
  ]
}

Rules:
- Keep task count ≤ 12. Parallel tasks (same phase) should have no dependsOn relationship.
- Prompts must be self-contained. Never say "as discussed" or "see plan".
- Every prompt MUST end with the sentence: "Output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS"
- scope paths must be relative to the project root.
- Use forkContext=true only for review/verify tasks that need the implementer's context.
- Assign role matching the task type: explore→explore, plan→plan, implement→implementer, review→review, verify→verifier.
`

export async function aiGoalToTaskGraph(goal: string, projectPath: string): Promise<GoalPlan> {
  const projectCtx = scanProjectContext(projectPath)
  const userMsg = `Goal: ${goal}\nProject path: ${projectPath}\n\n${projectCtx}`

  let raw: string
  try {
    raw = await callPlanner(PRIMARY_PLANNER_MODEL, userMsg)
  } catch (primaryErr) {
    console.warn(`[planner] ${PRIMARY_PLANNER_MODEL} failed (${(primaryErr as Error).message}), falling back to ${FALLBACK_MODEL}`)
    try {
      raw = await callPlanner(FALLBACK_MODEL, userMsg)
    } catch (fallbackErr) {
      throw new Error(
        `AI planner failed on both models.\n` +
        `  Primary  (${PRIMARY_PLANNER_MODEL}): ${(primaryErr as Error).message}\n` +
        `  Fallback (${FALLBACK_MODEL}): ${(fallbackErr as Error).message}`
      )
    }
  }

  let plan: PlannerResponse
  try {
    const cleaned = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim()
    plan = JSON.parse(cleaned) as PlannerResponse
  } catch {
    throw new Error(`AI planner returned invalid JSON:\n${raw.slice(0, 500)}`)
  }

  return buildGraph(plan, projectPath)
}

async function callPlanner(model: string, userMsg: string): Promise<string> {
  const resp = await fetch(DMXAPI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${DMXAPI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userMsg },
      ],
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json() as {
    choices: Array<{ message: { content: string } }>
  }
  const content = data.choices[0]?.message?.content ?? ""
  if (!content) throw new Error("empty response from model")
  return content
}

function buildGraph(plan: PlannerResponse, projectPath: string): GoalPlan {
  const titleToNode    = new Map<string, TaskNode>()
  const titleToNodeNorm = new Map<string, TaskNode>()  // lowercase+trim for fuzzy match
  const rawSpecs       = plan.tasks

  for (const spec of rawSpecs) {
    const node = createTaskNode({
      type:        spec.type       ?? "implement",
      role:        spec.role       ?? "general",
      title:       spec.title,
      prompt:      spec.prompt,
      scope:       spec.scope.map(s => s.startsWith("/") ? s : `${projectPath}/${s}`),
      priority:    spec.priority   ?? 50,
      forkContext: spec.forkContext ?? false,
    })
    titleToNode.set(spec.title, node)
    titleToNodeNorm.set(spec.title.toLowerCase().trim(), node)
  }

  // Wire dependsOn by title → ID, with normalized fallback
  for (const spec of rawSpecs) {
    if (!spec.dependsOn?.length) continue
    const node = titleToNode.get(spec.title)!
    for (const depTitle of spec.dependsOn) {
      let dep = titleToNode.get(depTitle)
      if (!dep) {
        dep = titleToNodeNorm.get(depTitle.toLowerCase().trim())
        if (dep) {
          console.warn(`[planner] dependsOn normalized: "${depTitle}" → "${dep.title}"`)
        }
      }
      if (dep) {
        node.dependsOn.push(dep.id)
        dep.blocks.push(node.id)
      } else {
        console.warn(`[planner] dependsOn not found: "${depTitle}" in task "${spec.title}" — dependency skipped`)
      }
    }
  }

  return {
    nodes: Array.from(titleToNode.values()),
    description: plan.description,
  }
}
