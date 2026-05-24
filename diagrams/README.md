# Swarm Conductor 详解：面向初学者的完整指南

## 目录
1. [它是什么？解决什么问题？](#1-它是什么解决什么问题)
2. [核心概念：Task DAG](#2-核心概念task-dag)
3. [系统架构：五个层次](#3-系统架构五个层次)
4. [核心执行链路](#4-核心执行链路)
5. [调度器的工作原理](#5-调度器的工作原理)
6. [Agent 是什么，怎么工作的](#6-agent-是什么怎么工作的)
7. [文件锁：防止 Agent 互相踩踏](#7-文件锁防止-agent-互相踩踏)
8. [Shared Memory：Agent 之间怎么传递信息](#8-shared-memoryagent-之间怎么传递信息)
9. [动态任务：Agent 发现问题时自动扩展](#9-动态任务agent-发现问题时自动扩展)
10. [Crash Recovery：Agent 崩了怎么办](#10-crash-recoveryagent-崩了怎么办)
11. [Human-in-the-loop：什么时候需要人工介入](#11-human-in-the-loop什么时候需要人工介入)
12. [SQLite 持久化：运行状态如何保存](#12-sqlite-持久化运行状态如何保存)
13. [从用户视角：三种使用方式](#13-从用户视角三种使用方式)
14. [Homebrew 安装与发布流程](#14-homebrew-安装与发布流程)

---

## 1. 它是什么？解决什么问题？

Swarm Conductor 是一个**多 Agent 编排系统**，架设在 [CodeWhale](https://github.com/Hmbown/CodeWhale) 之上。

### 背景：AI coding agent 的局限

当你面对一个大型代码库（比如 5000 行、20 个模块），让一个 AI agent 来处理：

- **上下文窗口不够**：它无法一次性读完所有代码
- **串行太慢**：探索 → 规划 → 实施 → 测试，一步一步排队很慢
- **无法并行**：明明可以同时分析不同模块，却只能按顺序来

Swarm Conductor 的解法是：**让多个 AI agent 像一个团队一样并行工作**。

```
传统方式：
  AI agent → 读文件 → 分析 → 写代码 → 测试  (串行，慢)

Swarm 方式：
  Agent 1 → 分析 auth 模块
  Agent 2 → 分析 API 模块      ← 同时进行
  Agent 3 → 分析数据库模块
  Agent 4 → 等前三个完成 → 生成实施计划
  Agent 5、6 → 并行实施修改  (快 3~5 倍)
```

---

## 2. 核心概念：Task DAG

**DAG** = Directed Acyclic Graph（有向无环图）。Swarm 用 DAG 来描述任务之间的依赖关系。

### 什么是任务（Task）？

每个 Task 就是给一个 AI agent 的一个工作指令，包含：

| 字段 | 含义 | 示例 |
|------|------|------|
| `title` | 任务名称 | "分析 auth 模块" |
| `type` | 任务类型 | explore / plan / implement / review / verify |
| `prompt` | 给 agent 的具体指令 | "分析 src/auth 目录的所有文件..." |
| `scope` | 涉及的文件路径 | `["src/auth/jwt.ts"]` |
| `dependsOn` | 必须先完成的任务 ID | `[exploreTask.id]` |
| `priority` | 优先级（越高越先调度） | `100` |

### Task 的状态机

每个 Task 在生命周期中经历以下状态：

```
pending  →  blocked  →  ready  →  running  →  done
                                     ↓
                                   failed  →  (retry)  →  ready
                                     ↓
                                interrupted  (deadlock 被强制终止)
```

- **pending**：刚创建，还在计算是否有依赖
- **blocked**：有依赖未完成，等待
- **ready**：所有依赖都完成了，等待 agent 领取
- **running**：已分配给某个 agent，正在执行
- **done**：成功完成，输出已保存
- **failed**：执行出错，会自动重试（最多 2 次），超过次数则永久失败
- **interrupted**：被调度器强制终止（通常是死锁时的牺牲品）

### DAG 的依赖关系

```
Explore A ──┐
             ├──→  Plan  ──→  Implement ──┐
Explore B ──┘                              ├──→  Verify
                             Review    ──┘
```

- **扇入（fan-in）**：Plan 要等 Explore A 和 Explore B 都完成才能开始
- **扇出（fan-out）**：Plan 完成后，Implement 和 Review 可以同时开始
- **并行**：没有依赖关系的任务自动并行执行

---

## 3. 系统架构：五个层次

Swarm Conductor 由五个层次组成：

### 层次 1：Conductor 调度核心

这是大脑，负责：
- 每 500ms 执行一次调度循环（`tick()`）
- 把 ready 的任务分配给 idle 的 agent
- 检测死锁，处理审批请求

主要模块：
- **Conductor**：主调度器，包含 `tick()` 和 `dispatch()` 方法
- **TaskDAG**：任务图引擎，管理所有任务的状态和依赖关系
- **FileLockRegistry**：文件锁注册表，防止两个 agent 同时修改同一个文件
- **ApprovalGate**：人工介入接口，在关键节点暂停等待确认
- **CrashRecovery**：崩溃恢复，心跳监控 + 自动重启

### 层次 2：Agent 运行时

这是手臂，负责实际运行 AI agent：
- **AgentProcessManager**：管理 CodeWhale 进程池，每个 agent 是一个独立进程，监听不同端口（7878、7879...）
- **CodeWhaleClient**：HTTP 客户端，通过 REST API + SSE 事件流与 CodeWhale 通信

### 层次 3：持久化层

这是记忆，把所有状态存入 SQLite 数据库（`.conductor/conductor.db`）：
- `runs` 表：每次 `swarm run` 的记录
- `tasks` 表：所有任务的状态，每次变更都会更新
- `memory` 表：Agent 之间共享的上下文信息
- `memory_tags` 表：标签索引，O(1) 查询
- `event_log` 表：追加写入的审计日志

### 层次 4：工作区隔离

这是沙箱，防止 agent 互相干扰：
- **FileLockRegistry**：逻辑锁，每个文件同时只有一个 agent 能修改
- **GitWorkspaceManager**：每个 agent 在独立 git 分支工作，完成后合并

### 层次 5：CodeWhale Agent Pool

最多 20 个 CodeWhale 进程并行运行，每个进程通过 `codewhale serve --http` 暴露 HTTP API，接受 Conductor 的调度。

---

## 4. 核心执行链路

从用户输入到任务完成，完整链路如下：

### 步骤 1：接收用户输入

```bash
# 方式一：自然语言
swarm run --goal "重构 src/auth 模块，把 JWT 换成 session"

# 方式二：YAML 任务文件
swarm run --tasks tasks.yaml
```

### 步骤 2：构建 TaskDAG

- `--goal` 模式：`goalToTaskGraph()` 自动生成 5 个任务（explore → plan → implement → review → verify）
- `--tasks` 模式：`loadTaskFile()` 解析 YAML，按照 `depends_on` 和 `depends_on_phase` 连接依赖

### 步骤 3：启动 Agent 进程池

```bash
# 内部执行（对每个 agent）
codewhale serve --http --port 7878 --insecure
codewhale serve --http --port 7879 --insecure
# ...
```

等待每个进程的 `/health` 端点响应，确认启动成功。

### 步骤 4：调度循环开始

每 500ms 执行一次 `tick()`，持续直到所有任务完成。

### 步骤 5：dispatch() — 核心分发逻辑

当一个任务被选中并分配给 agent 时：

```typescript
// ① 同步标记（防止双重调度）
agentMgr.markBusy(agentId, task.id, "pending")
dag.assign(task.id, agentId)

// ② 创建对话线程
const thread = await client.createThread()
// POST /v1/threads

// ③ 发送任务 prompt
const turn = await client.postTurn(thread.id, { prompt: fullPrompt })
// POST /v1/threads/{id}/turns

// ④ 监听 SSE 事件流，收集输出
const { fullText } = await client.waitForTurn(thread.id, turn.id)
// GET /v1/threads/{id}/events?since_seq=0

// ⑤ 解析输出的 5 个 section
const output = parseTaskOutput(fullText)
// ## SUMMARY / ## CHANGES / ## EVIDENCE / ## RISKS / ## BLOCKERS

// ⑥ 完成，写共享记忆，释放锁
dag.complete(task.id, output)
store.writeMemory({ layer: "context", content: output.summary, ... })
lockRegistry.releaseByTask(task.id)
agentMgr.markIdle(agentId)
```

### 步骤 6：输出

运行完成后：
- 终端打印每个任务的摘要、风险、Blockers
- JSON 报告自动保存到 `.conductor/report-<runId>.json`

---

## 5. 调度器的工作原理

`tick()` 方法是整个系统的心脏，每 500ms 运行一次：

```
tick() {
  if (approvalGate.hasPending()) return  // 有待审批，暂停

  checkDeadlocks()  // 检测并解除死锁

  if (dag.isComplete()) {
    stopScheduler()
    emit("run.completed")
    return
  }

  for (task of dag.readyTasks()) {        // 按优先级遍历 ready 任务
    if (dag.conflictingRunning(task.scope)) continue  // scope 冲突，跳过
    agent = findIdleAgent(task.role)      // 找到合适的 idle agent
    if (!lockRegistry.tryAcquire(scope))  continue  // 获取文件锁失败，跳过
    dispatch(agent.id, task)              // 异步分发（不阻塞 tick）
  }
}
```

**关键设计**：`dispatch()` 是异步的（不等待），所以多个任务可以真正并行执行。`tick()` 只负责"分配"，不负责"等待"。

### 死锁检测

如果多个 running 任务互相等待对方完成（成环），调度器会：
1. 找到环中优先级最低的任务
2. 强制将其状态改为 `interrupted`
3. 释放它持有的所有文件锁
4. 该 agent 回到 idle 状态，等待下次调度

---

## 6. Agent 是什么，怎么工作的

每个 Agent 就是一个在后台运行的 **CodeWhale 进程**：

```
[Conductor] ──HTTP──→ [codewhale serve --http --port 7878]
                                ↕ DeepSeek API
                         LLM 推理 + 工具调用
```

### CodeWhale HTTP API 交互

Conductor 通过以下 API 控制每个 agent：

| 操作 | API | 说明 |
|------|-----|------|
| 创建对话 | `POST /v1/threads` | 开启一个新的对话上下文 |
| 发送任务 | `POST /v1/threads/{id}/turns` | 把 prompt 发给 LLM |
| 接收输出 | `GET /v1/threads/{id}/events` | SSE 流，实时接收 token |

### SSE 事件流解析

```
event: item.delta
data: {"delta": "HELL", "kind": "agent_message"}

event: item.delta
data: {"delta": "O", "kind": "agent_message"}

event: turn.completed
data: {"turn": {"status": "completed"}}
```

只收集 `kind: "agent_message"` 的 delta（过滤掉 `agent_reasoning` 思维链）。

### Agent 输出格式

每个 agent 必须按照以下格式输出，否则 Conductor 无法解析：

```markdown
## SUMMARY
对本次任务的简洁总结（1-4 行）

## CHANGES
- src/auth/jwt.ts: 替换了 verifyToken 函数的实现
- src/auth/session.ts: 新增了 createSession 函数

## EVIDENCE
- 所有现有测试仍通过
- 新增了 3 个测试用例

## RISKS
- HIGH: 旧的 JWT token 在迁移期间无法验证，需要双写期

## BLOCKERS
- session 表还没有 expires_at 索引，查询性能会降低
```

Conductor 解析 `BLOCKERS` 可以自动创建新的 implement 任务，解析 `RISKS` 中包含 critical/high 关键词可以暂停调度要求人工审批。

---

## 7. 文件锁：防止 Agent 互相踩踏

**问题**：如果 Agent A 和 Agent B 同时修改 `src/auth.ts`，会产生冲突。

**解决方案**：FileLockRegistry（逻辑锁，不是 OS 锁）

```typescript
// 调度时尝试获取锁
const acquired = lockRegistry.tryAcquire(
  ["src/auth.ts", "src/auth/jwt.ts"],  // 声明的 scope
  "agent-01",   // 持有者
  "task-abc"    // 关联任务
)

if (!acquired) {
  // 有其他任务正在使用这些文件，跳过本次调度
  continue
}

// 任务完成后释放
lockRegistry.releaseByTask("task-abc")
```

**TTL 自动释放**：每个锁都有过期时间（默认 5 分钟）。如果 agent 崩溃没有正常释放锁，TTL 到期后自动释放，防止死锁。

---

## 8. Shared Memory：Agent 之间怎么传递信息

**问题**：Agent 1 做完探索，Agent 2 怎么知道 Agent 1 发现了什么？

**解决方案**：SQLite 三层共享记忆

| Layer | 用途 | 写入时机 |
|-------|------|---------|
| `project_map` | 项目结构全局地图 | explore 阶段结束时 |
| `context` | 各任务的发现和摘要 | 每个任务完成时 |
| `event_log` | 所有事件的追加日志 | 实时追加 |

每次 dispatch 时，Conductor 会读取相关 context 注入到 prompt：

```typescript
const contextEntries = store.getContext(task.scope)  // 按文件 tag 过滤
const contextBlock = `## Shared Context from Previous Agents\n${...}`

const fullPrompt = task.prompt + agentInstructions + projectMapBlock + contextBlock
```

这样 Agent 2（实施）就能看到 Agent 1（探索）发现的问题，做出更准确的修改。

---

## 9. 动态任务：Agent 发现问题时自动扩展

**场景**：Agent 在实施过程中发现了一个额外问题，需要追加新任务。

**自动触发规则**（`generateFollowupTasks()`）：

| 触发条件 | 插入任务类型 |
|---------|------------|
| `BLOCKERS` 有非空条目 | `implement`（修复 blocker） |
| `RISKS` 含 critical/high/severe/security | `review`（审查风险） |
| `scope` 含测试文件且有 `CHANGES` | `verify`（运行测试验证） |

动态任务的 `dependsOn` 自动指向触发它的任务，保证执行顺序正确。

**去重**：相同 title 的任务不会重复插入。

---

## 10. Crash Recovery：Agent 崩了怎么办

**心跳监控**（`CrashRecovery`）：

每隔 15 秒对所有 busy 状态的 agent 做一次 HTTP 健康检查：

```
检查 GET /health
  ↓
响应正常 → 更新 lastHeartbeat，继续
  ↓
无响应 且 超过 45 秒 → 判定 crashed
  ↓
1. 把该 agent 正在运行的任务重新标记为 failed（触发重试）
2. 释放该 agent 持有的所有文件锁
3. 尝试重启进程（最多 3 次）
4. 重启成功 → agent 回到 idle 状态
```

**互斥保护**：心跳检查有 `checking` 标志，防止 setInterval 堆积并发调用（10+ agents 时尤其重要）。

**崩溃恢复**：如果 Conductor 本身也崩溃，重启后调用 `restoreFromStore()` 从 SQLite 恢复任务图，把所有 `running` 状态的任务重置为 `ready`，继续调度。

---

## 11. Human-in-the-loop：什么时候需要人工介入

ApprovalGate 在三种情况下暂停调度器：

| 情况 | 描述 |
|------|------|
| `phase_boundary` | Phase 切换时，让人确认是否继续 |
| `high_risk` | 任务输出包含 HIGH/CRITICAL 风险 |
| `merge_conflict` | Git 分支合并冲突，需人工处理 |

暂停期间调度器停止分配新任务（正在运行的任务继续到完成）。

**两种响应方式**：

```typescript
// 方式 1：终端交互（人工敲 y/n）
await conductor.approvalGate.promptStdin(req)

// 方式 2：编程式（自动化流程）
conductor.approvalGate.resolve(req.id, "approved")
```

---

## 12. SQLite 持久化：运行状态如何保存

所有状态存入 `.conductor/conductor.db`（WAL 模式，支持并发读写）：

```sql
-- 每次运行记录
CREATE TABLE runs (id, project, phase, status, created_at, updated_at);

-- 任务状态（每次变更都 upsert）
CREATE TABLE tasks (id, run_id, type, title, status, output, ...);

-- 共享记忆
CREATE TABLE memory (id, run_id, layer, content, tags, timestamp);
CREATE TABLE memory_tags (memory_id, run_id, layer, tag);  -- O(1) 索引

-- 事件追加日志
CREATE TABLE event_log (id, run_id, kind, payload, timestamp);
```

**写入性能**：1,000 次 upsert = 37ms（0.04ms 每次）。

---

## 13. 从用户视角：三种使用方式

### 方式 1：自然语言目标（最简单）

```bash
swarm run --goal "帮我找出项目中所有的性能瓶颈并提出优化建议" \
          --project /path/to/your/repo \
          --agents 5
```

每个任务完成后暂停，展示摘要，可以追加新任务：

```
✓ Explore: understand codebase [explore] (42s)
  发现 3 个 N+1 查询问题，1 个缺失索引

追加任务？(回车跳过)
> 顺便检查一下缓存策略
→ 已插入: "顺便检查一下缓存策略"
```

### 方式 2：YAML 任务文件（精确控制）

```yaml
# tasks.yaml
goal: "优化数据库查询性能"
agents: 6

phases:
  - name: analyze
    tasks:
      - title: "分析慢查询"
        type: explore
        scope: ["src/db"]

      - title: "分析缓存命中率"
        type: explore
        scope: ["src/cache"]

  - name: fix
    tasks:
      - title: "添加缺失索引"
        type: implement
        scope: ["migrations/"]
        depends_on_phase: analyze

      - title: "优化 N+1 查询"
        type: implement
        scope: ["src/db/queries.ts"]
        depends_on_phase: analyze
```

```bash
swarm run --tasks tasks.yaml
```

### 方式 3：全自动批处理（夜间运行）

```bash
swarm run --goal "全面代码审查" \
          --no-interact \
          --auto-approve \
          --output nightly-report.json \
          --agents 10
```

---

## 14. Homebrew 安装与发布流程

### 安装

```bash
brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
brew install swarm-conductor

swarm demo   # 验证安装
```

### 发布新版本

```bash
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions 自动：
1. 编译 `darwin-arm64` 和 `darwin-x64` 二进制
2. 打包为 `.tar.gz`，计算 sha256
3. 更新 `Formula/swarm-conductor.rb` 中的 sha256
4. 创建 GitHub Release，上传文件

用户升级：
```bash
brew upgrade swarm-conductor
```

---

*文档生成时间：2026-05-24 · Swarm Conductor v0.1.2*
