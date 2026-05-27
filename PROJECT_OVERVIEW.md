# Swarm Conductor — 项目汇总文档

> 基于 [CodeWhale](https://github.com/Hmbown/CodeWhale) 构建的多 Agent 并行编排层。
> 让 10+ 个 AI coding agent 同时处理一个大型项目，自动协调任务依赖、文件冲突和上下文共享。

---

## 1. 项目简介

Swarm Conductor 是一个 TypeScript 实现的**多 Agent 任务编排框架**。它作为 CodeWhale CLI 的上层调度器，将大型软件工程任务拆解为声明式的任务 DAG，并以最大 20 个并行的 CodeWhale agent 实例分阶段执行。框架自动处理任务依赖解析、文件写入冲突检测、agent 间上下文传递、崩溃恢复、人工审批闸门以及基于 Git 的工作空间隔离。

核心价值在于将"一个 agent 串行处理所有子任务"扩展为"多个 agent 同时工作，按依赖自动协调"，大幅缩短大型重构、代码审查、跨模块改造等场景的总耗时。

---

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript (ESNext, strict mode) |
| 运行时 | Bun ≥ 1.3（利用 `bun:sqlite` 内建数据库） |
| 包管理 | Bun (`bun.lock`) |
| 类型校验 | Zod ≥ 3.24 |
| SSE 客户端 | eventsource ≥ 2.0 |
| 数据库 | SQLite（WAL 模式，通过 `bun:sqlite`） |
| 进程管理 | `bun.spawn` 子进程 |
| 测试框架 | Bun test (`bun test`) |
| CLI 入口 | `#!/usr/bin/env bun` shebang |
| 下游依赖 | CodeWhale CLI（HTTP serve 模式） |

---

## 3. 目录结构说明

```
codewhale_debug/
├── src/
│   ├── cli/                   # CLI 入口和终端 UI
│   │   ├── index.ts           # 主入口：命令行解析、run/demo/serve/start 命令
│   │   ├── task-file.ts       # YAML 任务文件加载器
│   │   ├── goal-planner.ts    # 基于模板的任务图生成（自然语言 → DAG）
│   │   ├── ai-planner.ts      # 基于 AI 的任务图生成（调用 CodeWhale 做规划）
│   │   ├── live-view.ts       # 终端实时 Dashboard（进度条、agent 面板、事件流）
│   │   └── interactive.ts     # 交互式终端输入（人工审批提示等）
│   ├── conductor/             # 核心编排引擎
│   │   ├── index.ts           # Conductor 主类：调度循环、任务分发、输出解析
│   │   ├── approval-gate.ts   # 审批闸门：人工确认、编程式 resolve
│   │   ├── crash-recovery.ts  # 崩溃恢复：心跳检测、自动重启、任务重排队
│   │   └── dynamic-tasks.ts   # 动态任务生成：输出中的 BLOCKERS/RISKS 触发新任务
│   ├── dag/                   # 任务 DAG 数据结构和引擎
│   │   ├── types.ts           # 类型定义：TaskNode、ConductorConfig、事件、文件锁等
│   │   ├── engine.ts          # DAG 引擎：状态机、依赖解析、死锁检测
│   │   └── index.ts           # 模块导出
│   ├── runtime/               # CodeWhale agent 运行时管理
│   │   ├── agent-manager.ts   # Agent 进程池：spawn、健康检查、重启
│   │   ├── client.ts          # CodeWhale HTTP API 客户端：SSE 事件流
│   │   └── index.ts           # 模块导出
│   ├── memory/                # 共享记忆总线
│   │   ├── bus.ts             # 基于文件系统的三层记忆总线（旧方案）
│   │   ├── store.ts           # SQLite 持久化存储（ConductorStore）
│   │   └── index.ts           # 模块导出
│   ├── workspace/             # 工作空间管理
│   │   ├── file-lock.ts       # 文件锁注册表（TTL 过期机制）
│   │   ├── git-manager.ts     # Git 分支隔离与合并管理
│   │   └── index.ts           # 模块导出
│   ├── web/                   # Web 仪表板
│   │   ├── server.ts          # WebSocket 实时推送服务器
│   │   ├── standalone.ts      # 独立 HTTP 服务 + 前端
│   │   ├── goal-store.ts      # 目标状态存储
│   │   └── ui.html            # 前端页面
│   └── bench/                 # 基准测试工具
│       └── run-benchmark.ts   # 自分析 benchmark（9 agent 三阶段）
├── tests/                     # 测试套件（10 个测试文件）
├── scripts/                   # 构建与发布脚本
├── Formula/                   # Homebrew formula
├── docs/                      # 文档
├── diagrams/                  # 架构图（SVG）
├── package.json               # 项目配置
├── tsconfig.json              # TypeScript 配置
├── example-tasks.yaml         # 示例任务文件
└── README.md                  # 项目说明
```

---

## 4. 核心功能模块

### 4.1 任务 DAG 引擎 (`src/dag/`)

- **类型系统**：定义 6 种任务类型（explore/plan/implement/review/verify/merge）和 7 种状态（pending/blocked/ready/running/done/failed/interrupted）
- **状态机**：`addTask → recomputeStatus (pending/ready/blocked) → assign (running) → complete/fail/interrupt`
- **依赖解析**：自动维护 `dependsOn`（前驱）和 `blocks`（后继）双向边；任务完成后自动 `unblockDownstream`
- **死锁检测**：检测 running 任务之间是否存在循环依赖
- **冲突检测**：`conflictingRunning` 检查 scope 交集，防止两个 agent 同时写入同一文件

### 4.2 Conductor 编排器 (`src/conductor/`)

- **调度循环**：每 500ms 一次 tick，从 ready 任务队列按优先级选取任务，匹配空闲 agent
- **Agent 分配策略**：优先按角色匹配（task.role → agent.role），fallback 到 general 角色
- **结构化 Prompt 构建**：组装 `<agent_role>` + `<task_instruction>` + `<scope>` + `<inherited_context>` + `<project_map>` + `<project_instructions>` + `<output_contract>` 七段式 prompt
- **输出解析**：从 agent 响应中正则提取 SUMMARY / CHANGES / EVIDENCE / RISKS / BLOCKERS 五段
- **上下文上限保护**：继承上下文截断至 8KB，输出截断至 80KB
- **AGENTS.md 自动注入**：检测项目根目录的 `AGENTS.md` / `CLAUDE.md` / `.conductor/AGENTS.md`，注入每个 agent 的 system prompt

### 4.3 Agent 进程管理 (`src/runtime/`)

- 通过 `codewhale serve --http --port N` 启动 CodeWhale 实例
- 支持并发启动（`Promise.all` 并行 spawn）
- 90 秒启动超时等待 HTTP 就绪
- 健康检查：每 15 秒心跳，45 秒超时判定崩溃
- 安全环境变量传递：仅转发 `DEEPSEEK_/OPENAI_/ANTHROPIC_/HOME/PATH/USER/SHELL/TERM/LANG/LC_/XDG_` 前缀的变量
- `CodeWhaleClient` 封装完整 HTTP API：createThread、postTurn、SSE 事件流订阅、interruptThread

### 4.4 文件锁注册表 (`src/workspace/file-lock.ts`)

- 内存 Map 实现，路径归一化后去重
- 原子获取：`tryAcquire` 全路径或全拒绝
- TTL 过期自动释放（默认 5 分钟），防止崩溃 agent 永久持锁
- 按 task 或 agent 维度释放锁

### 4.5 共享记忆总线 (`src/memory/`)

- **三层架构**：`project_map`（项目地图）→ `context`（agent 间上下文传递）→ `event_log`（审计事件）
- **双实现**：文件系统版（`SharedMemoryBus`，旧方案）和 SQLite 版（`ConductorStore`，当前主力）
- SQLite 实现支持：WAL 模式、索引化的 tag 查询（`memory_tags` 表 + O(1) 索引）、按 run 隔离、token 用量统计

### 4.6 Git 工作空间隔离 (`src/workspace/git-manager.ts`)

- 每个 agent 在独立分支工作（`agent/<id>/<task_id>`）
- 支持 Phase 边界合并（`merge/phase-N` 分支）
- 冲突检测：`tryMerge` 失败时收集冲突文件列表并 abort，上报人工处理
- 自动提交（`-c user.name=agent-xxx`）

### 4.7 崩溃恢复 (`src/conductor/crash-recovery.ts`)

- 心跳监控 + HTTP 健康二次确认
- 检测 stuck agent（运行时间 > 2× 文件锁 TTL 时主动 interrupt）
- 自动重启（最多 3 次），超限放弃
- 崩溃时：任务重新排队（retry 计数）、释放文件锁

### 4.8 动态任务生成 (`src/conductor/dynamic-tasks.ts`)

- **BLOCKERS → implement 任务**：每个非空 blocker 生成一个修复任务（优先级 +5）
- **HIGH RISKS → review 任务**：匹配 `critical/high/severe/security/data loss/breaking` 关键词（优先级 +10）
- **Changes 含 test 文件 → verify 任务**：自动触发测试验证（优先级 -5）
- 去重逻辑：按 title 去重，支持中英文 stub 占位符过滤

### 4.9 审批闸门 (`src/conductor/approval-gate.ts`)

- 三种审批类型：`phase_boundary`（阶段边界）、`high_risk`（高风险输出）、`merge_conflict`（Git 冲突）
- 双模式响应：终端交互式（stdin y/N）和编程式 `resolve()`
- 高风险任务完成后自动暂停调度器，等待人工确认

### 4.10 CLI 和终端 UI (`src/cli/`)

- 命令：`demo`（架构验证）| `run`（执行任务）| `serve`（Web 服务）| `start`（交互式启动）
- `LiveView`：全屏实时 Dashboard，含进度条、agent 面板、事件日志流、token 用量、ETA 估算
- 三种详细级别：`quiet`（仅进度）| `summary`（进度+表格）| `stream`（实时输出流）
- 自然语言输入：通过 AI planner（`ai-planner.ts`）或模板 planner（`goal-planner.ts`）将目标转为任务图
- 支持 `--web` 启动并行 Web 仪表板（WebSocket 实时推送）

### 4.11 Web 仪表板 (`src/web/`)

- `WebDashboard`：WebSocket 服务器，实时推送 conductor 事件
- `StandaloneServer`：完整 HTTP 服务（含静态 UI），提供 REST API + WebSocket
- 前端页面 (`ui.html`)：可视化任务 DAG 和实时状态

---

## 5. 关键业务流程

### 5.1 完整 Run 生命周期

```
1. CLI 解析参数 → 构建 ConductorConfig
2. 加载任务：YAML 文件 / AI 规划 / 模板规划 → TaskNode[]
3. Conductor.initialize() → SQLite 初始化、Git 检测
4. taskDag.addTasks() → 插入 DAG，自动计算初始状态
5. spawnAgents() → 并行启动 codewhale serve 进程池
6. startScheduler() → 每 500ms tick 调度循环
7. crashRecovery.start() → 心跳监控启动
8. 调度循环：
   a. 检查死锁、检查完成状态
   b. 取 ready 任务（按 priority 降序）
   c. 跳过 scope 冲突任务
   d. 匹配空闲 agent（优先角色匹配）
   e. tryAcquire 文件锁
   f. dispatch → 构建 prompt → createThread → postTurn → waitForTurn(SSE)
   g. parseTaskOutput → complete/fail
   h. writeMemory → 写入共享上下文
   i. insertDynamicTasks → 根据输出生成新任务
   j. 高风险检测 → 暂停调度器等待审批
9. waitForCompletion → 轮询直到 isComplete()
10. 打印最终报告 → JSON 输出 → shutdown
```

### 5.2 任务状态流转

```
pending ──(deps met)──→ ready ──(assign)──→ running ──(output ok)──→ done
   │                       │                    │
   │                       │                    ├──(error, retries>0)──→ ready (retry)
   │                       │                    ├──(error, retries=0)──→ failed
   │                       │                    └──(crash/stuck)──→ interrupted
   └──(deps not met)──→ blocked
```

### 5.3 Agent 间上下文传递

```
Task A 完成 → output.summary + changes → writeMemory(layer="context")
                                              │
Task B 派发时 ← getContext(scope) ← 读取共享上下文 ←┘
```

---

## 6. 模块依赖关系

```
                        ┌─────────────────┐
                        │   CLI (index.ts) │
                        └────────┬────────┘
                                 │ 导入
                        ┌────────▼────────┐
                        │    Conductor     │
                        │  (conductor/)    │
                        └───┬──┬──┬──┬────┘
          ┌─────────────────┘  │  │  └──────────────┐
          ▼                    ▼  ▼                  ▼
   ┌──────────┐   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │  TaskDAG │   │AgentManager  │  │ ConductorStore│  │GitWorkspace  │
   │  (dag/)  │   │  (runtime/)  │  │  (memory/)   │  │ (workspace/) │
   └────┬─────┘   └──────┬───────┘  └──────────────┘  └──────────────┘
        │                │
        │ types          │ HTTP
        ▼                ▼
   ┌──────────┐   ┌──────────────┐
   │ dag/types│   │CodeWhaleClient│
   │  (共享)   │   │  (runtime/)  │
   └──────────┘   └──────────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
        crash-recovery  approval-gate  dynamic-tasks
        (conductor/)    (conductor/)   (conductor/)
```

核心依赖流向：
- **dag/types.ts** 是被所有模块共享的基础类型定义层
- **Conductor** 聚合 DAG、AgentManager、FileLockRegistry、ConductorStore、GitWorkspaceManager、CrashRecovery、ApprovalGate
- **CLI** 仅依赖 Conductor + Web 仪表板，不直接接触底层模块

---

## 7. 配置与构建说明

### 7.1 安装方式

```bash
# Homebrew（推荐，无需 Bun）
brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
brew install swarm-conductor

# 源码构建
git clone https://github.com/DataSky/SwarmConductor.git
cd SwarmConductor
bun install
bun run dev demo
# 或编译为可执行文件
bun build --compile src/cli/index.ts --outfile swarm-conductor
```

### 7.2 运行命令

```bash
swarm demo                              # 架构验证
swarm run --goal "描述你的目标"           # 自然语言输入
swarm run --tasks example-tasks.yaml     # YAML 任务文件
swarm run --goal "..." --auto-approve   # 自动批准
swarm run --goal "..." --agents 8        # 指定 agent 数
swarm run --goal "..." --model-worker deepseek-v4-pro  # 指定模型
swarm start                              # 交互式启动
swarm serve --project .                  # 启动 Web 服务
```

### 7.3 关键配置项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxConcurrentAgents` | 10 | 最大并发 agent（上限 20） |
| `basePort` | 7878 | Agent HTTP 端口起始值 |
| `fileLockTtlMs` | 300000 | 文件锁 TTL（5 分钟） |
| `deadlockTimeoutMs` | 300000 | 死锁检测超时 |
| `schedulerTickMs` | 500 | 调度周期（毫秒） |
| `heartbeatIntervalMs` | 15000 | 心跳间隔 |
| `heartbeatTimeoutMs` | 45000 | 心跳超时 |
| `maxAgentRestarts` | 3 | 崩溃最大重启次数 |
| `autoApprove` | false | 自动批准所有 tool call |
| `dynamicTasks` | true | 是否启用动态任务生成 |
| `modelMap` | {} | 按角色指定模型 |

### 7.4 构建与测试

```bash
bun run typecheck    # TypeScript 类型检查
bun test             # 运行所有测试
bun run bench        # 自分析 benchmark
bun run build        # 编译到 dist/
```

---

## 8. 潜在问题或注意事项

1. **CodeWhale 启动延迟**：每个 agent 实例通过 `codewhale serve` 启动，冷启动约需 20 秒。大规模 agent 池（10+）的总启动时间可能达到 30-90 秒，需要在流程中预留等待时间。

2. **文件锁内存实现**：`FileLockRegistry` 基于内存 Map，conductor 重启后锁状态丢失。虽然有 TTL 机制兜底，但在 conductor 短暂崩溃恢复后，可能存在锁状态与实际情况不一致的窗口期。

3. **上下文膨胀**：agent 之间通过 `context` 层传递上下文，随着任务链增长可能积累大量文本。虽然有 8KB 截断保护，但在长链任务场景下，后续 agent 可能丢失关键的历史上下文。

4. **Git 分支爆炸**：每个 agent 都创建独立分支，长时间运行后会产生大量 `agent/xxx/yyy` 分支。当前代码未包含自动清理过期分支的逻辑，建议在 CI/CD 场景中定期清理。

5. **并发上限硬约束**：最大 20 个并发 agent，受限于端口范围和系统资源（每个 agent 是一个独立 CodeWhale 进程）。在高负载场景下需要监控系统资源使用。

6. **动态任务去重局限**：`generateFollowupTasks` 仅通过 title 去重，若同一 blocker 被两个 agent 以不同措辞报告，仍可能生成重复任务。

7. **死锁检测覆盖有限**：当前 `detectDeadlock` 仅检测 running 任务间的直接循环依赖，不涵盖更复杂的死锁场景（如 A→B→C→A 且 A、C running、B pending）。调度器依赖超时 + stuck 检测作为补充兜底。

8. **YAML 任务文件的 Phase 边界**：YAML 格式中通过 `depends_on_phase` 声明跨 phase 依赖，但 CLI 中的 phase 边界审批需要手动确认。在 `--auto-approve` 模式下会跳过这些审批，可能导致非预期的阶段切换。

9. **安全环境变量过滤**：`safeEnv()` 通过前缀白名单过滤环境变量。若 CodeWhale 未来需要新的环境变量前缀（如新的 provider），需要更新白名单，否则 agent 将无法使用相关配置。

10. **单点故障**：Conductor 进程本身是单点，崩溃后所有 agent 失去调度协调。虽然有 SQLite 持久化支持重启恢复，但没有 conductor 级别的高可用或主备机制。
