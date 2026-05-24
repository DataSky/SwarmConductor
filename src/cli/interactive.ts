import { createInterface } from "readline"
import type { Conductor } from "../conductor"
import type { TaskNode } from "../dag/types"
import { createTaskNode } from "../dag/engine"

// ─── InteractiveRunner ────────────────────────────────────────────────────────
// After each task completes, prints the result and prompts the user to
// optionally inject a follow-up task before the scheduler continues.

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", gray: "\x1b[90m", magenta: "\x1b[35m",
}

export class InteractiveRunner {
  private conductor: Conductor
  private noInteract: boolean
  private pendingPrompt = false  // tracks whether a prompt is active

  constructor(conductor: Conductor, noInteract: boolean) {
    this.conductor = conductor
    this.noInteract = noInteract
  }

  attach(): void {
    if (this.noInteract) return

    this.conductor.onEvent(async e => {
      if (e.kind !== "task.status_changed") return
      if (e.payload["next"] !== "done") return

      const taskId = e.payload["taskId"] as string
      const task = this.conductor.taskDag.getTask(taskId)
      if (!task?.output) return

      // Pause scheduler while we interact
      this.conductor.stopScheduler()
      this.pendingPrompt = true

      try {
        await this.showTaskResult(task)
        const injected = await this.promptForFollowup(task)
        if (injected) {
          this.conductor.taskDag.addTask(injected)
          console.log(`  ${C.green}→${C.reset} Added: "${injected.title}"`)
          console.log()
        }
      } finally {
        this.pendingPrompt = false
        this.conductor.startScheduler()
      }
    })
  }

  private showTaskResult(task: TaskNode): Promise<void> {
    return new Promise(resolve => {
      const out = task.output!
      console.log()
      console.log(`${C.bold}${"─".repeat(62)}${C.reset}`)
      console.log(`${C.green}✓${C.reset} ${C.bold}${task.title}${C.reset}  ${C.dim}[${task.type}]${C.reset}`)
      console.log(`${"─".repeat(62)}`)

      // Summary (up to 6 lines)
      if (out.summary) {
        for (const line of out.summary.split("\n").slice(0, 6)) {
          if (line.trim()) console.log(`  ${line.trim()}`)
        }
      }

      // Risks
      if (out.risks.length > 0) {
        console.log()
        for (const r of out.risks.slice(0, 3)) {
          const isHigh = /\b(critical|high|severe)\b/i.test(r)
          const icon = isHigh ? `${C.red}⚠${C.reset}` : `${C.yellow}⚠${C.reset}`
          console.log(`  ${icon} ${r.trim()}`)
        }
      }

      // Blockers
      if (out.blockers.length > 0) {
        console.log()
        for (const b of out.blockers.slice(0, 3)) {
          if (b.trim()) console.log(`  ${C.red}✗${C.reset} ${b.trim()}`)
        }
      }

      // Remaining tasks status
      const all = this.conductor.taskDag.allTasks()
      const done = all.filter(t => t.status === "done").length
      const total = all.length
      console.log()
      console.log(`  ${C.dim}Progress: ${done}/${total} tasks done${C.reset}`)

      resolve()
    })
  }

  private promptForFollowup(completedTask: TaskNode): Promise<TaskNode | null> {
    return new Promise(resolve => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })

      process.stdout.write(
        `\n  ${C.cyan}追加任务？${C.reset}${C.dim}(回车跳过，输入描述直接加入队列)${C.reset}\n  > `
      )

      // Raw mode for single-line input with timeout feel
      rl.once("line", (input: string) => {
        rl.close()
        const trimmed = input.trim()
        if (!trimmed) {
          resolve(null)
          return
        }

        // Infer task type from keywords
        const type = inferType(trimmed)
        const node = createTaskNode({
          type,
          title: trimmed.slice(0, 80),
          prompt: [
            `Follow-up task after "${completedTask.title}":`,
            ``,
            trimmed,
            ``,
            `Context: this task was added interactively by the user during the run.`,
            `\n---\nYour output MUST contain: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS`,
          ].join("\n"),
          scope: completedTask.scope,
          priority: completedTask.priority + 1,
          dependsOn: [completedTask.id],
        })
        resolve(node)
      })

      // If stdin is not a TTY (piped), skip
      if (!process.stdin.isTTY) {
        rl.close()
        resolve(null)
      }
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
