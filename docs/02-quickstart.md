# 快速上手

## 1. 验证安装

```bash
swarm demo
```

输出：
```
Task DAG: 4 tasks  |  3 ready (parallel)  |  1 blocked
  [ready    ] [explore   ] Scan file structure      → ready
  [ready    ] [explore   ] Analyze test coverage    → ready
  [ready    ] [explore   ] Map API boundaries        → ready
  [blocked  ] [plan      ] Generate plan             → blocked by 3
Deadlock check: clean ✓
M3 features available:
  ✓ Dynamic task insertion
  ✓ Approval gate
  ✓ Crash recovery
  ✓ Real-time dashboard
```

---

## 2. 对真实项目运行

```bash
swarm run --project /path/to/your/project --agents 5 --auto-approve
```

Dashboard 示意：
```
╔══════════════════════════════════════════════════╗
║       SWARM CONDUCTOR  v0.1.0    08:32:14        ║
╚══════════════════════════════════════════════════╝

Phase 0  [████████████████░░░░░░░░░░░░]  4/5 (80%)
  running:1  ready:0  blocked:3  failed:0

Agents  idle:4  busy:1  crashed:0  locks:2

  STATUS      TYPE        TITLE
  ──────────────────────────────────────────────────────────
  done        explore     Explore: DAG engine & types
  done        explore     Explore: Runtime client
  done        explore     Explore: Conductor scheduler
  done        explore     Explore: SQLite store
  running     explore     Explore: Workspace isolation
  blocked     review      Review: Crash recovery
  blocked     review      Review: Test gaps
  blocked     review      Review: Performance

Recent events
  ──────────────────────────────────────────────────────────
  [08:30:11] task.status_changed task:a1b2c3d4
  [08:31:44] lock.acquired
  [08:32:01] task.status_changed task:e5f6g7h8
```

---

## 3. self-analysis benchmark

用 Swarm Conductor 分析自身代码（9 个 agent，3 个 phase）：

```bash
bun run bench
```

输出 JSON 报告到 `.conductor-bench/self-analysis-report.json`。

---

## 4. 编程式 API（最常用场景）

### 基础：两个串行任务

```typescript
import { Conductor } from "./src/conductor"
import { createTaskNode } from "./src/dag/engine"
import { defaultConfig } from "./src/dag/types"

const conductor = new Conductor(defaultConfig({
  projectPath: "/your/project",
  maxConcurrentAgents: 2,
  autoApprove: true,
}))

await conductor.initialize()

const explore = createTaskNode({
  type: "explore",
  title: "Scan project structure",
  prompt: "List all source files and identify the main modules.",
  scope: ["/your/project/src"],
  priority: 100,
})

const plan = createTaskNode({
  type: "plan",
  title: "Generate refactor plan",
  prompt: "Based on the project structure, propose a refactoring plan.",
  scope: [],
  priority: 80,
  dependsOn: [explore.id],  // runs after explore
})

conductor.taskDag.addTasks([explore, plan])

conductor.onEvent(e => {
  if (e.kind === "task.status_changed") {
    const { taskId, next } = e.payload
    console.log(`Task ${taskId}: → ${next}`)
  }
})

await conductor.spawnAgents(["general", "general"])
conductor.startScheduler()

const result = await conductor.waitForCompletion(300_000)
console.log("Result:", result)  // "completed" | "failed" | "timeout"

await conductor.shutdown()
```

### 并行探索 + 收集结果

```typescript
// 5 个 explore 任务并行跑，全部完成后读取它们的输出
const explores = ["src/auth", "src/api", "src/db", "src/ui", "src/tests"].map(dir =>
  createTaskNode({
    type: "explore",
    title: `Explore ${dir}`,
    prompt: `Analyze the ${dir} directory. List files, exports, and dependencies.`,
    scope: [`/project/${dir}`],
    priority: 100,
  })
)

conductor.taskDag.addTasks(explores)
await conductor.spawnAgents(["explore", "explore", "explore", "explore", "explore"])
conductor.startScheduler()

await conductor.waitForCompletion()

// 读取所有完成任务的输出摘要
const summaries = explores
  .map(t => conductor.taskDag.getTask(t.id))
  .filter(t => t?.status === "done")
  .map(t => t!.output!.summary)

console.log(summaries)
```

### 多 Phase 流程（explore → implement → verify）

```typescript
// Phase 0: 探索
const explores = [/* ... */]
conductor.taskDag.addTasks(explores)

await conductor.spawnAgents(Array(5).fill("general"))
conductor.startScheduler()
await conductor.waitForCompletion()

// Phase 边界审批（如需人工确认）
const decision = await conductor.requestPhaseBoundaryApproval(
  "Implement the changes identified in Phase 0"
)
if (decision === "rejected") {
  await conductor.shutdown()
  process.exit(0)
}

// Phase 1: 实施（依赖 Phase 0 输出）
const exploreIds = explores.map(t => t.id)
conductor.addPhase([
  {
    type: "implement",
    title: "Implement feature A",
    prompt: "Based on exploration, implement feature A in src/feature-a.ts",
    scope: ["src/feature-a.ts"],
    dependsOn: exploreIds,
  },
  {
    type: "implement",
    title: "Implement feature B",
    prompt: "Based on exploration, implement feature B in src/feature-b.ts",
    scope: ["src/feature-b.ts"],   // 不同文件，可并行
    dependsOn: exploreIds,
  },
])

await conductor.waitForCompletion()
await conductor.shutdown()
```

---

## 5. 审批门控制

### 程序化审批（测试或自动化流程）

```typescript
// 监听审批请求
conductor.onEvent(e => {
  if (e.kind === "approval.required") {
    const reqs = conductor.approvalGate.pendingRequests()
    for (const req of reqs) {
      // 自动批准 phase_boundary，拒绝 high_risk
      const decision = req.kind === "phase_boundary" ? "approved" : "rejected"
      conductor.approvalGate.resolve(req.id, decision)
    }
  }
})
```

### 终端交互审批

```typescript
conductor.onEvent(async e => {
  if (e.kind === "approval.required") {
    const reqs = conductor.approvalGate.pendingRequests()
    for (const req of reqs) {
      // 调出终端 y/n 提示
      const decision = await conductor.approvalGate.promptStdin(req)
      console.log(`Decision: ${decision}`)
    }
  }
})
```

---

## 6. 查看持久化数据

所有运行数据存储在目标项目的 `.conductor/conductor.db`：

```bash
# 查看所有 run
bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('.conductor/conductor.db')
console.log(db.prepare('SELECT id, status, phase FROM runs ORDER BY created_at DESC LIMIT 5').all())
db.close()
"

# 查看任务完成情况
bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('.conductor/conductor.db')
const tasks = db.prepare('SELECT title, status, completed_at - started_at as duration_ms FROM tasks').all()
for (const t of tasks) console.log(t)
db.close()
"
```
