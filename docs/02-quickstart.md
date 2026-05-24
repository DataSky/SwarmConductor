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

### 方式一：自然语言描述目标（最简单）

```bash
swarm run --goal "重构 src/auth 模块，把 JWT 换成 session" --project /your/repo
```

Swarm 自动生成 explore → plan → implement → review → verify 五阶段任务图。

每个任务完成后会暂停，打印摘要，允许你追加新任务：

```
✓ Explore: understand codebase  [explore]
─────────────────────────────────────────────
  发现 JWT 过期处理有 bug，session 表缺少索引
  ⚠ HIGH: refresh token 无失效机制

追加任务？(回车跳过，输入描述直接加入队列)
> 顺便检查一下 refresh token 的失效逻辑
→ 已插入: "顺便检查一下 refresh token 的失效逻辑"
```

全自动不打断：

```bash
swarm run --goal "..." --no-interact --project /your/repo
```

### 方式二：YAML 任务文件（精确控制）

```bash
swarm run --tasks tasks.yaml
```

`tasks.yaml` 示例：

```yaml
goal: "重构 auth 模块，把 JWT 换成 session"
agents: 5

phases:
  - name: explore
    tasks:
      - title: "分析 auth 模块现状"
        type: explore
        scope: ["src/auth"]

      - title: "分析测试覆盖情况"
        type: explore
        scope: ["tests/auth"]

  - name: implement
    tasks:
      - title: "制定重构计划"
        type: plan
        depends_on_phase: explore    # 等 explore phase 全部完成

      - title: "替换 JWT 为 session"
        type: implement
        scope: ["src/auth/jwt.ts", "src/auth/session.ts"]
        depends_on: ["制定重构计划"] # 等特定任务完成

      - title: "补全单元测试"
        type: implement
        scope: ["tests/auth"]
        depends_on: ["替换 JWT 为 session"]
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
