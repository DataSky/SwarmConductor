import { createInterface } from "readline"
import type { Conductor } from "../conductor"
import type { TaskNode } from "../dag/types"
import { createTaskNode } from "../dag/engine"
import type { LiveView } from "./live-view"

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", gray: "\x1b[90m",
}

export class InteractiveRunner {
  private conductor: Conductor
  private noInteract: boolean
  private liveView: LiveView | null
  private pendingPrompt = false  // tracks whether a prompt is active

  constructor(conductor: Conductor, noInteract: boolean, liveView: LiveView | null = null) {
    this.conductor = conductor
    this.noInteract = noInteract
    this.liveView = liveView
  }

  attach(): void {
    if (this.noInteract) return

    this.conductor.onEvent(async e => {
      if (e.kind !== "task.status_changed") return
      if (e.payload["next"] !== "done") return

      const taskId = e.payload["taskId"] as string
      const task = this.conductor.taskDag.getTask(taskId)
      if (!task?.output) return

      this.conductor.stopScheduler()
      this.pendingPrompt = true

      try {
        // If LiveView is active, use its prompt (keeps layout intact)
        // Otherwise fall back to plain stdout
        let input = ""
        if (this.liveView) {
          input = await this.liveView.promptFollowup(task)
        } else {
          this.showTaskResult(task)
          input = await this.promptStdout()
        }

        if (input.trim()) {
          const injected = createTaskNode({
            type: inferType(input),
            title: input.slice(0, 80),
            prompt: [
              `Follow-up after "${task.title}":`,
              ``,
              input,
              `\n---\nYour output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`,
            ].join("\n"),
            scope: task.scope,
            priority: task.priority + 1,
            dependsOn: [task.id],
          })
          this.conductor.taskDag.addTask(injected)
        }
      } finally {
        this.pendingPrompt = false
        this.conductor.startScheduler()
      }
    })
  }

  // Plain stdout fallback (used when no LiveView)
  private showTaskResult(task: TaskNode): void {
    const out = task.output!
    console.log()
    console.log(`${C.bold}${"─".repeat(62)}${C.reset}`)
    console.log(`${C.green}✓${C.reset} ${C.bold}${task.title}${C.reset}  ${C.dim}[${task.type}]${C.reset}`)
    if (out.summary) {
      for (const line of out.summary.split("\n").slice(0, 5)) {
        if (line.trim()) console.log(`  ${line.trim()}`)
      }
    }
    for (const r of out.risks.slice(0, 2)) {
      if (r.trim()) console.log(`  ${C.yellow}⚠${C.reset} ${r.trim()}`)
    }
    for (const b of out.blockers.slice(0, 2)) {
      if (b.trim()) console.log(`  ${C.red}✗${C.reset} ${b.trim()}`)
    }
    const all = this.conductor.taskDag.allTasks()
    console.log(`\n  ${C.dim}Progress: ${all.filter(t => t.status === "done").length}/${all.length}${C.reset}`)
  }

  private promptStdout(): Promise<string> {
    return new Promise(resolve => {
      if (!process.stdin.isTTY) { resolve(""); return }
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      process.stdout.write(`\n  ${C.cyan}追加任务？${C.reset}${C.dim}(回车跳过)${C.reset}\n  > `)
      rl.once("line", (line: string) => {
        rl.close()
        if (line.trim()) console.log(`  ${C.green}→${C.reset} 已插入: "${line.trim()}"`)
        resolve(line)
      })
    })
  }
}

function inferType(input: string): "explore" | "implement" | "review" | "verify" | "plan" {
  const lower = input.toLowerCase()
  if (/分析|探索|查看|检查|找出|explore|analyze|scan/.test(lower)) return "explore"
  if (/测试|验证|test|verify|通过/.test(lower)) return "verify"
  if (/审查|review|评审/.test(lower)) return "review"
  if (/计划|规划|plan|设计/.test(lower)) return "plan"
  return "implement"
}
