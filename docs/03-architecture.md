# 架构详解

## 整体结构

```
┌─────────────────────────────────────────────────────────────┐
│                    SWARM CONDUCTOR                          │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Task DAG    │  │  Conductor   │  │  ConductorStore  │  │
│  │  Engine      │  │  Scheduler   │  │  (SQLite)        │  │
│  └──────────────┘  └──────────────┘  └──────────────────┘  │
│         │                │                    │             │
│  ┌──────▼────────────────▼────────────────────▼──────────┐  │
│  │              Agent Runtime Layer                      │  │
│  │                                                       │  │
│  │  [Agent 01] [Agent 02] [Agent 03] ... [Agent N]      │  │
│  │  port:7878  port:7879  port:7880       port:78xx      │  │
│  │  codewhale serve --http --insecure                    │  │
│  └───────────────────────────────────────────────────────┘  │
│         │                │                    │             │
│  ┌──────▼────────────────▼────────────────────▼──────────┐  │
│  │              Workspace Layer                          │  │
│  │  FileLockRegistry  GitWorkspaceManager                │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Swarm Conductor 是 CodeWhale 的**外部编排层**，不修改 CodeWhale 本身。每个 CodeWhale 实例通过 `codewhale serve --http` 暴露本地 REST + SSE API，Conductor 通过 HTTP 控制它们。

---

## 模块说明

### Task DAG（`src/dag/`）

任务图引擎，核心数据结构是 `TaskNode`：

```
TaskNode {
  id, type, title, prompt    // 基本信息
  status                     // pending → blocked → ready → running → done/failed
  priority                   // 调度优先级，越高越先分配
  dependsOn, blocks          // 双向依赖图
  scope                      // 任务涉及的文件路径列表（用于冲突检测）
  role                       // explore/plan/implementer/review/verifier/general
  output                     // TaskOutput（SUMMARY/CHANGES/EVIDENCE/RISKS/BLOCKERS）
}
```

状态流转规则：
- `pending` → `ready`：无依赖，或所有依赖已 `done`
- `pending/blocked` → `blocked`：依赖未满足
- `ready` → `running`：被 Conductor 分配给 agent
- `running` → `done`：agent 返回有效输出
- `running` → `failed`：agent 错误，触发重试（`retryCount < maxRetries`）
- `running` → `interrupted`：死锁强制中断

### Conductor 调度器（`src/conductor/index.ts`）

调度循环每 `schedulerTickMs`（默认 500ms）执行一次 `tick()`：

```
tick():
  1. 检查审批门 — 有待审批则跳过
  2. 死锁检测 — 发现环路则打断最低优先级任务
  3. 获取 ready 任务列表（按 priority 降序）
  4. 获取 idle agent 列表
  5. 对每个 ready 任务：
     a. 检查 scope 是否与 running 任务冲突 → 跳过
     b. 匹配 role 最合适的 idle agent
     c. 申请文件锁
     d. 调用 dispatch()（异步，不阻塞 tick）
```

**双重调度防护**：`markBusy` 和 `dag.assign` 在第一个 `await` 之前同步执行，确保同一个 agent 在同一个 tick 内不会被分配两次。

### CodeWhale HTTP 客户端（`src/runtime/client.ts`）

封装 CodeWhale Runtime API：

```typescript
// 实际 API 调用链
const thread = await client.createThread()
// POST /v1/threads → { id: "thr_xxx", ... }

const turn = await client.postTurn(thread.id, { prompt, auto_approve: true })
// POST /v1/threads/{id}/turns → { thread, turn: { id: "turn_xxx", status: "in_progress" } }

const { fullText, status } = await client.waitForTurn(thread.id, turn.id)
// GET /v1/threads/{id}/events?since_seq=0 (SSE 流)
// 收集 item.delta(kind=agent_message) 直到 turn.completed
```

SSE 解析关键点：
- `item.delta` 里 `kind: "agent_message"` 才是正文（`agent_reasoning` 是思维链，丢弃）
- 连接异常断开时 `finalStatus` 默认为 `"failed"`（不是 `"completed"`）

### SQLite 持久化（`src/memory/store.ts`）

数据库表结构：

| 表 | 内容 |
|---|------|
| `runs` | 每次 conductor 运行记录，含 status 和 phase |
| `tasks` | 所有 TaskNode，每次状态变更都会 upsert |
| `memory` | 三层共享记忆（project\_map / context / event\_log）|
| `memory_tags` | 标签联结表，O(1) 按标签查询 context |
| `event_log` | 所有系统事件的追加日志 |

WAL 模式 + `busy_timeout=5000` 确保多 agent 并发写入不冲突。

### 文件锁（`src/workspace/file-lock.ts`）

内存级逻辑锁，不依赖 OS 文件锁：

```
tryAcquire(paths, agentId, taskId) → boolean
  - paths 内任何一个被其他任务持有 → 返回 false
  - 全部空闲 → 原子性全部锁定，返回 true
  - TTL 过期的锁自动释放（防 crash 后永久锁定）
```

### 动态任务生成（`src/conductor/dynamic-tasks.ts`）

agent 完成任务后，解析输出自动插入后续任务：

| 触发条件 | 插入任务类型 |
|---------|------------|
| `BLOCKERS` 有非空条目 | `implement`（修复 blocker） |
| `RISKS` 含 critical/high/severe/security 关键词 | `review`（审查风险） |
| `scope` 含测试文件且有 `CHANGES` | `verify`（跑测试验证） |

去重逻辑：相同 title 的任务不会重复插入。

---

## Agent 输出格式

每个 agent 必须返回包含以下 5 个 section 的文本：

```markdown
## SUMMARY
[简洁描述本次任务做了什么]

## CHANGES
- path/to/file.ts: 描述修改内容
- path/to/other.ts: 描述修改内容

## EVIDENCE
- 测试通过截图/输出
- 相关代码行引用

## RISKS
- LOW: 潜在影响描述
- HIGH: 重要风险（触发 review 任务）
- CRITICAL: 严重问题（暂停调度，触发人工审批）

## BLOCKERS
- 阻塞当前任务的问题（触发新的 implement 任务）
```

Conductor 解析这个格式，写入 `ConductorStore.writeMemory()`，下游 agent 领取任务时自动读取相关 context。

---

## 并发模型

```
tick interval: 500ms
  │
  ├── 检测 ready 任务 → 分配给 idle agent
  │   └── dispatch() — Promise，不等待结果
  │       └── 等待 SSE 流（阻塞 dispatch goroutine，不影响 tick）
  │
  └── 多个 dispatch() 同时运行，互不阻塞
      每个 dispatch 完成后：
        1. dag.complete()/fail()  → 更新内存状态
        2. store.upsertTask()     → 持久化
        3. lockRegistry.release() → 释放文件锁
        4. agentMgr.markIdle()    → agent 回到 idle 池
```

JavaScript 单线程保证：所有内存状态变更（DAG 状态、文件锁）是原子的，不需要 mutex（除了 CrashRecovery 的 heartbeat 需要防止 setInterval 堆积）。

---

## 数据流

```
用户定义任务 → conductor.taskDag.addTasks()
                    ↓
              TaskDAG 计算 ready/blocked
                    ↓
              Conductor.tick() 分配任务
                    ↓
              CodeWhaleClient 创建 thread + turn
                    ↓
              SSE 流收集 agent 输出
                    ↓
              parseTaskOutput() 解析 5 section
                    ↓
         ┌──────────┴──────────────────────┐
         ↓                                 ↓
  store.writeMemory()              generateFollowupTasks()
  (共享 context 给下游 agent)       (BLOCKERS/RISKS → 新任务)
         ↓
  解锁 + agent 回 idle
         ↓
  下游任务 ready，下一个 tick 分配
```
