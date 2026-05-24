import { readFileSync, existsSync } from "fs"
import { resolve, dirname } from "path"
import { createTaskNode } from "../dag/engine"
import type { TaskNode, TaskType, AgentRole } from "../dag/types"

// ─── Task file types ──────────────────────────────────────────────────────────

interface RawTask {
  title: string
  type?: string
  prompt?: string
  scope?: string[]
  priority?: number
  depends_on?: string[]
  depends_on_phase?: string
  max_retries?: number
  role?: string
}

interface RawPhase {
  name?: string
  tasks: RawTask[]
}

interface TaskFile {
  goal?: string
  agents?: number
  auto_approve?: boolean
  phases: RawPhase[]
}

export interface ParseResult {
  nodes: TaskNode[]
  goal: string
  agents: number | null
  autoApprove: boolean | null
}

// ─── YAML parser (indentation-aware, handles task file subset) ────────────────

function parseTaskYAML(text: string): TaskFile {
  const lines = text
    .split("\n")
    .map((l, i) => ({ text: l, n: i }))
    .filter(l => l.text.trim() && !l.text.trim().startsWith("#"))

  const result: TaskFile = { phases: [] }
  let i = 0

  function indent(line: { text: string }): number {
    return line.text.length - line.text.trimStart().length
  }

  function scalar(s: string): string | number | boolean {
    const t = s.trim().replace(/^["']|["']$/g, "")
    if (t === "true") return true
    if (t === "false") return false
    if (/^\d+$/.test(t)) return parseInt(t)
    return t
  }

  function parseStringList(start: number, baseIndent: number): { items: string[]; end: number } {
    const items: string[] = []
    let j = start
    // inline array: [a, b, c]
    const line = lines[j]
    if (line && line.text.trim().startsWith("[")) {
      const raw = line.text.trim()
      const inner = raw.slice(raw.indexOf("[") + 1, raw.lastIndexOf("]"))
      items.push(...inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")))
      return { items, end: j + 1 }
    }
    // block list
    while (j < lines.length) {
      const l = lines[j]!
      if (indent(l) <= baseIndent) break
      const t = l.text.trimStart()
      if (t.startsWith("- ")) items.push(t.slice(2).trim().replace(/^["']|["']$/g, ""))
      j++
    }
    return { items, end: j }
  }

  function parseTask(start: number, taskIndent: number): { task: RawTask; end: number } {
    const task: RawTask = { title: "" }
    let j = start
    while (j < lines.length) {
      const l = lines[j]!
      const ind = indent(l)
      // Stop when we hit a line at shallower indent (parent or sibling phase)
      if (ind < taskIndent) break
      const t = l.text.trimStart()
      // Stop when we hit a sibling task item (same-level "- ")
      if (ind === taskIndent - 2 && t.startsWith("- ")) break

      const colonIdx = t.indexOf(": ")
      if (colonIdx === -1 && t.endsWith(":")) {
        const key = t.slice(0, -1).trim()
        if (key === "scope" || key === "depends_on") {
          const nextLine = lines[j + 1]
          if (nextLine && nextLine.text.trim().startsWith("[")) {
            const r = parseStringList(j + 1, ind)
            if (key === "scope") task.scope = r.items
            else task.depends_on = r.items
            j = r.end
          } else {
            const r = parseStringList(j + 1, ind)
            if (key === "scope") task.scope = r.items
            else task.depends_on = r.items
            j = r.end
          }
        } else {
          j++
        }
        continue
      }

      if (colonIdx !== -1) {
        const key = t.slice(0, colonIdx).trim()
        const val = t.slice(colonIdx + 2).trim()
        if (val.startsWith("[")) {
          const inner = val.slice(1, val.lastIndexOf("]"))
          const arr = inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, ""))
          if (key === "scope") task.scope = arr
          else if (key === "depends_on") task.depends_on = arr
        } else if (val === "") {
          if (key === "scope" || key === "depends_on") {
            const r = parseStringList(j + 1, ind)
            if (key === "scope") task.scope = r.items
            else task.depends_on = r.items
            j = r.end
            continue
          }
        } else {
          const sv = scalar(val)
          switch (key) {
            case "title":            task.title = String(sv); break
            case "type":             task.type = String(sv); break
            case "prompt":           task.prompt = String(sv); break
            case "priority":         task.priority = Number(sv); break
            case "max_retries":      task.max_retries = Number(sv); break
            case "role":             task.role = String(sv); break
            case "depends_on_phase": task.depends_on_phase = String(sv); break
          }
        }
      }
      j++
    }
    return { task, end: j }
  }

  // Top-level parsing
  while (i < lines.length) {
    const l = lines[i]!
    const t = l.text.trimStart()
    const colonIdx = t.indexOf(": ")

    if (colonIdx !== -1) {
      const key = t.slice(0, colonIdx).trim()
      const val = t.slice(colonIdx + 2).trim()
      switch (key) {
        case "goal":         result.goal = val.replace(/^["']|["']$/g, ""); break
        case "agents":       result.agents = parseInt(val); break
        case "auto_approve": result.auto_approve = val === "true"; break
      }
      i++
      continue
    }

    if (t === "phases:") {
      i++
      while (i < lines.length) {
        const pl = lines[i]!
        const pt = pl.text.trimStart()
        const pind = indent(pl)
        // Each phase starts with "- name: xxx" or "- tasks:" at indent 2
        if (pt.startsWith("- ")) {
          // Inline phase header: "- name: explore"
          const phaseHeaderLine = pt.slice(2).trim()  // "name: explore"
          const phase: RawPhase = { tasks: [] }
          if (phaseHeaderLine.startsWith("name: ")) {
            phase.name = phaseHeaderLine.slice(6).trim().replace(/^["']|["']$/g, "")
          }
          const phaseBodyIndent = pind + 2
          i++
          // Read phase body (name, tasks)
          while (i < lines.length) {
            const bl = lines[i]!
            const bind = indent(bl)
            if (bind < phaseBodyIndent) break
            const bt = bl.text.trimStart()
            if (bt.startsWith("name: ")) {
              phase.name = bt.slice(6).trim().replace(/^["']|["']$/g, "")
              i++
              continue
            }
            if (bt === "tasks:") {
              i++
              // Parse task list items
              while (i < lines.length) {
                const tl = lines[i]!
                const tind = indent(tl)
                if (tind < phaseBodyIndent) break
                if (!tl.text.trimStart().startsWith("- ")) { i++; continue }
                // Task item: "      - title: ..."
                const firstLine = tl.text.trimStart().slice(2).trim()
                const tmpTask: RawTask = { title: "" }
                if (firstLine.startsWith("title: ")) {
                  tmpTask.title = firstLine.slice(7).trim().replace(/^["']|["']$/g, "")
                }
                const taskBodyIndent = tind + 2
                const r = parseTask(i + 1, taskBodyIndent)
                const merged: RawTask = { ...tmpTask }
                if (r.task.title) merged.title = r.task.title
                if (r.task.type) merged.type = r.task.type
                if (r.task.prompt) merged.prompt = r.task.prompt
                if (r.task.scope) merged.scope = r.task.scope
                if (r.task.priority !== undefined) merged.priority = r.task.priority
                if (r.task.depends_on) merged.depends_on = r.task.depends_on
                if (r.task.depends_on_phase) merged.depends_on_phase = r.task.depends_on_phase
                if (r.task.max_retries !== undefined) merged.max_retries = r.task.max_retries
                if (r.task.role) merged.role = r.task.role
                phase.tasks.push(merged)
                i = r.end
              }
              continue
            }
            i++
          }
          result.phases.push(phase)
          continue
        }
        i++
      }
      continue
    }

    i++
  }

  return result
}

// ─── Public loader ────────────────────────────────────────────────────────────

export function loadTaskFile(filePath: string): ParseResult {
  const abs = resolve(filePath)
  if (!existsSync(abs)) throw new Error(`Task file not found: ${abs}`)

  const text = readFileSync(abs, "utf8")
  const raw = parseTaskYAML(text)

  if (!raw.phases?.length) throw new Error(`Task file has no phases: ${abs}`)

  const roleMap: Record<TaskType, AgentRole> = {
    explore: "explore", plan: "plan", implement: "implementer",
    review: "review", verify: "verifier", merge: "general",
  }

  const titleToId = new Map<string, string>()
  const phaseNameToIds = new Map<string, string[]>()
  const allNodes: TaskNode[] = []

  // First pass: create nodes, collect IDs
  for (const phase of raw.phases) {
    const phaseIds: string[] = []
    for (const rt of phase.tasks) {
      if (!rt.title) throw new Error("Every task must have a 'title'")
      const type = (rt.type ?? "implement") as TaskType
      const node = createTaskNode({
        type,
        title: rt.title,
        prompt: rt.prompt ?? buildDefaultPrompt(rt.title, type, rt.scope ?? []),
        scope: (rt.scope ?? []).map(s => resolve(dirname(abs), s)),
        priority: rt.priority ?? 50,
        maxRetries: rt.max_retries ?? 2,
        role: rt.role ? rt.role as AgentRole : roleMap[type],
      })
      titleToId.set(rt.title, node.id)
      phaseIds.push(node.id)
      allNodes.push(node)
    }
    if (phase.name) phaseNameToIds.set(phase.name, phaseIds)
  }

  // Second pass: wire dependencies
  let idx = 0
  for (const phase of raw.phases) {
    for (const rt of phase.tasks) {
      const node = allNodes[idx]!
      const depIds: string[] = []

      for (const depTitle of (rt.depends_on ?? [])) {
        const depId = titleToId.get(depTitle)
        if (!depId) throw new Error(`Task "${rt.title}" depends_on unknown title: "${depTitle}"`)
        depIds.push(depId)
      }

      if (rt.depends_on_phase) {
        const ids = phaseNameToIds.get(rt.depends_on_phase)
        if (!ids) throw new Error(`Unknown phase: "${rt.depends_on_phase}"`)
        depIds.push(...ids)
      }

      node.dependsOn = [...new Set(depIds)]
      idx++
    }
  }

  return {
    nodes: allNodes,
    goal: raw.goal ?? "",
    agents: raw.agents ?? null,
    autoApprove: raw.auto_approve ?? null,
  }
}

function buildDefaultPrompt(title: string, type: TaskType, scope: string[]): string {
  const scopeNote = scope.length > 0 ? `\nFocus on: ${scope.join(", ")}` : ""
  const templates: Record<TaskType, string> = {
    explore:   `Explore and analyze: ${title}${scopeNote}\n\nList files, identify patterns, surface issues.`,
    plan:      `Create an implementation plan for: ${title}${scopeNote}\n\nBreak down into concrete steps with risks.`,
    implement: `Implement: ${title}${scopeNote}\n\nMake minimal, correct changes.`,
    review:    `Review: ${title}${scopeNote}\n\nCheck correctness, style, and test coverage. Score severity 1-10.`,
    verify:    `Verify: ${title}${scopeNote}\n\nRun tests, check types, confirm expected behavior.`,
    merge:     `Merge and reconcile: ${title}${scopeNote}`,
  }
  return (templates[type] ?? title) +
    "\n\n---\nYour output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS"
}
