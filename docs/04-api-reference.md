# API 参考

## `defaultConfig(overrides)`

创建完整的 `ConductorConfig`，所有字段均有默认值：

```typescript
import { defaultConfig } from "./src/dag/types"

const config = defaultConfig({
  projectPath: "/your/project",  // 必填，其余均可选
})
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `projectPath` | `string` | — | 目标项目路径（必填） |
| `maxConcurrentAgents` | `number` | `10` | 最大并发 agent 数，硬上限 20 |
| `basePort` | `number` | `7878` | 第一个 agent 的 HTTP 端口，后续 +1 |
| `fileLockTtlMs` | `number` | `300000` | 文件锁 TTL（5 分钟） |
| `deadlockTimeoutMs` | `number` | `300000` | 死锁检测超时 |
| `schedulerTickMs` | `number` | `500` | 调度器轮询间隔 |
| `autoApprove` | `boolean` | `false` | 自动批准所有 tool call |
| `codewhalebin` | `string` | `"codewhale"` | CodeWhale 二进制路径 |
| `heartbeatIntervalMs` | `number` | `15000` | 心跳检查间隔 |
| `heartbeatTimeoutMs` | `number` | `45000` | 无心跳超过此值视为 crashed |
| `maxAgentRestarts` | `number` | `3` | 单 agent 最大重启次数 |
| `dynamicTasks` | `boolean` | `true` | 解析输出自动插入新任务 |

---

## `createTaskNode(partial)`

创建一个 `TaskNode`，未指定字段使用合理默认值：

```typescript
import { createTaskNode } from "./src/dag/engine"

const task = createTaskNode({
  // 必填
  type: "implement",         // explore | plan | implement | review | verify | merge
  title: "Fix auth bug",
  prompt: "...",
  scope: ["src/auth.ts"],    // 空数组 = 不涉及具体文件

  // 可选
  priority: 80,              // 默认 50，越高越先调度
  dependsOn: [otherId],      // 前置任务 ID 列表
  maxRetries: 2,             // 默认 2
  forkContext: false,        // 是否继承父 thread 上下文
  role: "implementer",       // 覆盖 type 推断的默认 role
})
```

`type` 与 `role` 默认映射：

| type | role |
|------|------|
| `explore` | `explore` |
| `plan` | `plan` |
| `implement` | `implementer` |
| `review` | `review` |
| `verify` | `verifier` |
| `merge` | `general` |

---

## `Conductor`

```typescript
import { Conductor } from "./src/conductor"

const conductor = new Conductor(config)
```

### 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `taskDag` | `TaskDAG` | 只读，访问任务图 |
| `store` | `ConductorStore` | 只读，访问 SQLite 持久化 |
| `approvalGate` | `ApprovalGate` | 只读，管理审批请求 |
| `runId` | `string` | 本次运行 ID |

### 方法

#### `initialize()`
```typescript
await conductor.initialize()
```
初始化：创建 `.conductor/` 目录，检测 Git 仓库，初始化 SQLite run 记录。在任何其他操作前必须调用。

#### `spawnAgents(roles)`
```typescript
await conductor.spawnAgents(["explore", "general", "general"])
```
启动指定 role 的 agent 进程池。实际会启动对应数量的 `codewhale serve --http` 进程。

#### `taskDag.addTask(node)` / `taskDag.addTasks(nodes)`
```typescript
conductor.taskDag.addTask(task)
conductor.taskDag.addTasks([task1, task2, task3])
```
向 DAG 添加任务。`addTasks` 批量添加并自动计算初始状态。  
⚠️ `dependsOn` 中的 task ID 必须已存在于 DAG 中，否则抛出错误。

#### `addPhase(taskPartials)`
```typescript
conductor.addPhase([
  { type: "implement", title: "...", prompt: "...", scope: [] },
])
```
推进 phase 计数器，批量添加新任务。

#### `startScheduler()` / `stopScheduler()`
```typescript
conductor.startScheduler()  // 开始 tick 循环 + 心跳监控
conductor.stopScheduler()   // 停止（审批等待时自动调用）
```

#### `waitForCompletion(timeoutMs?)`
```typescript
const result = await conductor.waitForCompletion(600_000)
// result: "completed" | "failed" | "timeout"
```
等待所有任务进入终止状态（done/failed/interrupted）。

#### `requestPhaseBoundaryApproval(description)`
```typescript
const decision = await conductor.requestPhaseBoundaryApproval("Run Phase 1: implement")
// decision: "approved" | "rejected"
```
暂停调度器，发出 `approval.required` 事件，等待人工或程序化批准。

#### `onEvent(callback)`
```typescript
conductor.onEvent(e => {
  console.log(e.kind, e.payload, e.timestamp)
})
```
订阅 conductor 事件流。

#### `status()`
```typescript
const s = conductor.status()
// {
//   runId, phase,
//   tasks: { total, ready, running, done, failed, blocked, interrupted },
//   agents: { total, idle, busy, crashed },
//   locks: number,
//   pendingApprovals: number
// }
```

#### `shutdown()`
```typescript
await conductor.shutdown()
```
停止调度器，关闭所有 agent 进程，关闭 SQLite 连接。

---

## `TaskDAG`

通过 `conductor.taskDag` 访问。

| 方法 | 说明 |
|------|------|
| `getTask(id)` | 获取单个任务，不存在返回 `undefined` |
| `allTasks()` | 返回所有任务数组 |
| `readyTasks()` | 返回 status=ready 的任务，按 priority 降序 |
| `runningTasks()` | 返回 status=running 的任务 |
| `isComplete()` | 所有任务是否都到终止状态 |
| `hasCriticalFailure()` | 是否有 status=failed 的非 review 任务 |
| `detectDeadlock()` | 返回形成死锁环路的 task ID 列表 |
| `conflictingRunning(scope)` | 返回与给定 scope 有文件重叠的 running 任务 |

---

## `ApprovalGate`

通过 `conductor.approvalGate` 访问。

```typescript
// 监听并自动处理
conductor.onEvent(e => {
  if (e.kind === "approval.required") {
    const reqs = conductor.approvalGate.pendingRequests()
    conductor.approvalGate.resolve(reqs[0].id, "approved")
  }
})

// 手动交互
const req = conductor.approvalGate.pendingRequests()[0]
const decision = await conductor.approvalGate.promptStdin(req)  // 终端 y/n 提示
```

| 方法 | 说明 |
|------|------|
| `pendingRequests()` | 返回所有待处理的审批请求 |
| `hasPending()` | 是否有待处理审批 |
| `resolve(id, decision)` | 程序化解决审批，`decision: "approved" \| "rejected"` |
| `promptStdin(req)` | 交互式终端提示，返回 Promise |

---

## `ConductorStore`

通过 `conductor.store` 访问。

```typescript
// 读取所有已完成任务
const tasks = conductor.store.loadTasks().filter(t => t.status === "done")

// 读取上下文（按文件 tag 过滤）
const ctx = conductor.store.getContext(["src/auth.ts"])

// 读取最近事件
const events = conductor.store.getRecentEvents(50)

// 读取统计
const stats = conductor.store.taskStats()
// { total, done, failed, interrupted, avgDurationMs }

// 列出历史 run
const runs = conductor.store.listRuns("/your/project")
```

---

## Conductor 事件类型

| 事件 | payload 字段 | 说明 |
|------|-------------|------|
| `task.status_changed` | `taskId, prev, next` | 任务状态变更 |
| `agent.crashed` | `agentId` | agent 进程崩溃 |
| `agent.restarted` | `agentId` | agent 进程重启成功 |
| `lock.acquired` | `agentId, taskId, scope` | 文件锁获取 |
| `lock.released` | `taskId` | 文件锁释放 |
| `deadlock.detected` | `cycle: string[]` | 检测到死锁 |
| `phase.started` | `phase, agentCount` | 新 phase 开始 |
| `phase.completed` | `phase` | 当前 phase 所有任务完成 |
| `approval.required` | `kind, taskId?` | 需要人工审批 |
| `approval.resolved` | `decision, kind` | 审批完成 |
| `task.dynamic_inserted` | `taskId, title, type, parentTaskId` | 动态任务插入 |
| `run.completed` | `phase` | 所有任务完成 |
| `run.failed` | `phase` | 有 critical failure |
