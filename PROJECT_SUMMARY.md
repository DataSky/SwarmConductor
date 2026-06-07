# Swarm Conductor — 项目汇总

> 基于 CodeWhale 的多 Agent 并行编排层 · 版本 0.1.0 · 汇总日期 2026-05-28

---

## 1. 项目概述

Swarm Conductor 是一个 TypeScript 实现的**多 Agent 任务编排框架**。它在 CodeWhale CLI 之上充当调度层，将大型软件工程任务拆解为声明式任务 DAG，由最多 20 个 CodeWhale agent 实例并行执行，自动处理任务依赖、文件冲突检测、agent 间上下文传递、崩溃恢复和人工审批。

| 指标 | 数值 |
|------|------|
| 语言/运行时 | TypeScript (strict) + Bun ≥ 1.3 |
| 最大并发 agent | 20（受限于端口范围和系统资源） |
| 任务类型 | explore / plan / implement / review / verify / merge |
| 持久化 | SQLite (WAL) — runs，tasks，memory，event_log |
| 前端 | React 18 + Vite + Zustand + WebSocket |
| 测试套件 | 15 个文件，涵盖单元/集成/E2E |
| 分发 | Homebrew (arm64/x64) + 源码构建 (Bun) |

---

## 2. 技术栈

| 层级 | 技术 | 文件/说明 |
|------|------|----------|
| 语言 | TypeScript ESNext，strict，noUncheckedIndexedAccess | `tsconfig.json` |
| 运行时 | Bun ≥ 1.3（`bun:sqlite`、`bun.spawn`） | `package.json` |
| 类型校验 | Zod ^3.24 | `package.json` |
| SSE 客户端 | eventsource ^2.0 | CodeWhale HTTP API 消费 |
| 后端持久化 | SQLite WAL 模式 | `src/memory/store.ts` (320 行) |
| 测试框架 | Bun test | `tests/` 目录，`bun test` |
| CLI | `#!/usr/bin/env bun` shebang | `src/cli/index.ts` (503 行) |
| 前端框架 | React 18 + ReactDOM 18 | `web-ui/package.json` |
| 状态管理 | Zustand ^5 | `web-ui/src/store/run.ts` |
| 构建工具 | Vite 6 + vite-plugin-singlefile | `web-ui/vite.config.ts` |
| WebSocket | Bun.serve + 原生 WebSocket | `src/web/standalone.ts`，`web-ui/src/ws/client.ts` |
| 下游依赖 | CodeWhale CLI（`codewhale serve --http`） | `src/runtime/agent-manager.ts` |

---

## 3. 架构总览

```
                        ┌─────────────────┐
                        │   CLI (index.ts) │  ← 命令解析，LiveView，交互终端
                        │  + Web UI (React)│  ← StandaloneServer + WebSocket
                        └────────┬────────┘
                                 │
                        ┌────────▼────────┐
                        │    Conductor     │  ← 调度循环 (500ms tick)
                        │  (conductor/)    │    任务分发、输出解析、审批闸门
                        └───┬──┬──┬──┬────┘
           ┌────────────────┘  │  │  └──────────────┐
           ▼                   ▼  ▼                  ▼
    ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐
    │   TaskDAG    │  │AgentManager  │  │  ConductorStore  │
    │ (dag/)       │  │ (runtime/)   │  │  (memory/)       │
    │ 状态机·死锁  │  │ spawn·健康检 │  │  SQLite 持久化   │
    └──────┬───────┘  └──────┬───────┘  └──────────────────┘
           │                 │ HTTP
           ▼                 ▼
    ┌─────────────┐  ┌──────────────┐
    │  dag/types  │  │CodeWhaleClient│
    │ (共享类型)  │  │ SSE 事件流    │
    └─────────────┘  └──────────────┘
           │                 │
           ▼                 ▼
    ┌──────────────────────────────────┐
    │   Workspace (file-lock + git)    │
    │   MemoryBus (三层共享记忆)       │
    └──────────────────────────────────┘
```

**核心数据流**：

1. CLI / Web UI 接收指令（Goal 文本 / YAML 文件）→ 生成 TaskNode[]
2. Conductor 将任务插入 TaskDAG，spawn agent 进程池
3. 调度循环：取 ready 任务 → 匹配空闲 agent → acquire 文件锁 → dispatch prompt → SSE 等待完成
4. 解析 agent 输出 → 写入共享记忆 → 生成动态任务 → 进入下一轮
5. Web UI 通过 WebSocket 实时接收事件（状态变更、delta 流、审批请求）

---

## 4. 核心模块详解

### 4.1 CLI (`src/cli/`)

命令行入口和终端 UI，是整个系统的前端之一。

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 503 | 主入口：解析 `demo`/`run`/`serve`/`start` 子命令，最终报告打印 |
| `task-file.ts` | ~80 | YAML 任务文件加载（phase 结构解析） |
| `goal-planner.ts` | 120 | 模板化任务图生成器：explore → plan → implement+review → verify |
| `ai-planner.ts` | 171 | AI 驱动的任务图生成器：调用 DMXAPI（Claude Opus 4，fallback DeepSeek V3），结合 `project-scanner` 上下文 |
| `project-scanner.ts` | 88 | 项目上下文扫描器：检测技术栈 + 生成 ≤200 行的目录树（~1200 tokens） |
| `live-view.ts` | ~200 | 终端实时 Dashboard：进度条、agent 面板、事件流、token 统计、ETA |
| `interactive.ts` | ~100 | 交互式终端输入：人工审批提示 |

### 4.2 Conductor (`src/conductor/`)

核心编排引擎，聚合所有子系统。

| 文件 | 行数 | 职责 |
|------|------|------|
| `index.ts` | 498 | Conductor 主类：调度循环、7 段式 prompt 构建（agent_role + task_instruction + scope + inherited_context + project_map + project_instructions + output_contract）、结构化输出解析（SUMMARY/CHANGES/EVIDENCE/RISKS/BLOCKERS）、AGENTS.md 自动注入、上下文截断（最近 K 条 × 每条 1.6K 字符） |
| `approval-gate.ts` | 96 | 审批闸门：`phase_boundary`/`high_risk`/`merge_conflict` 三种类型，支持终端交互式和编程式 `resolve()` |
| `crash-recovery.ts` | 123 | 崩溃恢复：心率监控 + HTTP 二次确认，stuck agent 检测（> 2× TTL），自动重启（最多 3 次） |
| `dynamic-tasks.ts` | 129 | 动态任务生成：BLOCKERS → implement（优先级 +5），HIGH RISKS → review（+10），含 test 变更 → verify（-5），title 去重 + 噪音过滤 |

### 4.3 DAG Engine (`src/dag/`)

任务依赖图和状态机。

| 文件 | 行数 | 职责 |
|------|------|------|
| `types.ts` | 201 | 全部共享类型：TaskNode（6 种类型 × 7 种状态）、ConductorConfig、AgentInstance、FileLock、MemoryEntry、ApprovalRequest、ConductorEvent 等 |
| `engine.ts` | 296 | TaskDAG 类：`addTask`/`addTasks`（自动 wiring 双向边）、状态机（pending→ready/blocked→running→done/failed/interrupted）、`scopesConflict` 前缀/祖先匹配、死锁检测、`conflictingRunning` 并发冲突检查 |

任务状态流转：
```
pending ──(deps met)──→ ready ──(assign)──→ running ──(output ok)──→ done
   │                      │                     │
   │                      │                     ├──(retry)──→ ready
   └──(deps unmet)──→ blocked                   ├──(exhausted)──→ failed
                                                └──(crash/stuck)──→ interrupted
```

### 4.4 Memory (`src/memory/`)

共享记忆和持久化存储。

| 文件 | 行数 | 职责 |
|------|------|------|
| `store.ts` | 320 | ConductorStore (SQLite)：Schema 含 `runs`/`tasks`/`memory`/`memory_tags`/`event_log` 5 表，WAL 模式，支持按 run 隔离、scope 前缀降级查询、token 用量统计 |
| `bus.ts` | 82 | SharedMemoryBus（文件系统版，旧方案）：三层目录 `project_map`/`context`/`event_log`，event_log 为 append-only JSONL |

**三层记忆架构**：
- **project_map**：项目结构地图（文件列表、依赖关系）
- **context**：agent 间上下文传递（前序 agent 的 summary + changes）
- **event_log**：审计事件日志（append-only）

### 4.5 Runtime (`src/runtime/`)

CodeWhale agent 实例生命周期管理。

| 文件 | 行数 | 职责 |
|------|------|------|
| `agent-manager.ts` | 206 | AgentProcessManager：spawn CodeWhale serve 进程（`--http --project --port`），90s 启动超时，`adopt()` 从 WarmPool 零成本接管预热的 agent，安全环境变量传递（仅 DEEPSEEK_/OPENAI_/ANTHROPIC_/HOME 等前缀） |
| `client.ts` | 214 | CodeWhaleClient：封装完整 HTTP API（createThread/postTurn/getTurn/interrupt），SSE 事件流订阅（`/v1/threads/{id}/events?since_seq=N`），TokenUsage 统计 |
| `warm-pool.ts` | 137 | WarmPool：serve 启动时后台预热 poolSize 个 agent 进程（消除 ~20s 冷启动），`acquire()` 按需取用，`_spawnFn` 注入接口支持 mock 测试 |

### 4.6 Workspace (`src/workspace/`)

文件锁和 Git 工作空间管理。

| 文件 | 行数 | 职责 |
|------|------|------|
| `file-lock.ts` | 73 | FileLockRegistry：内存 Map 实现，路径归一化，`tryAcquire` 全路径或全拒绝原子操作，TTL 过期自动释放（默认 5 分钟），按 task/agent 维度释放 |
| `git-manager.ts` | 109 | GitWorkspaceManager：每个 agent 在独立分支（`agent/<id>/<task_id>`）工作，Phase 边界自动 merge，冲突检测 + 上报人工处理 |

### 4.7 Web (`src/web/`)

Web 仪表板后端。

| 文件 | 行数 | 职责 |
|------|------|------|
| `standalone.ts` | 202 | StandaloneServer：完整 HTTP 服务，集成 WarmPool + GoalStore，多 tab 并发 run 管理 |
| `server.ts` | ~393 | WebDashboard：WebSocket 实时推送 conductor 事件 |
| `goal-store.ts` | ~100 | GoalStore：SQLite 目标持久化 + 自动 schema 迁移 |
| `handlers/start-run.ts` | — | handleStartRun：run 启动流程，规划期心跳（5s），断连自动恢复 |
| `handlers/replay.ts` | — | 历史 run 回放 |
| `handlers/port-pool.ts` | — | 端口池管理，防止多 run 端口冲突 |

---

## 5. Web UI 功能

基于 React 18 + Vite + Zustand 的单页应用，通过 WebSocket 与后端 StandaloneServer 实时通信。

### 组件清单

| 组件 | 说明 |
|------|------|
| `App.tsx` | 根组件：TabBar + Header + RunBanner + 条件渲染 LaunchOverlay / TaskDag / AgentSlots / LogStream / ApprovalModal / InjectModal / HistoryDrawer / DebugPanel |
| `LaunchOverlay` | 启动面板：输入 Goal、选择 agent 数量/模型，一键 Start Run |
| `TaskDag` | 任务 DAG 可视化：依赖深度计算，状态图标（✓/✗/⟳/⏳），选中展开详情 |
| `AgentSlots` | Agent 实时面板：每个 agent 的 idle/busy 状态、当前任务、delta 流缓冲（32KB 上限），折叠展开 |
| `LogStream` | 事件日志流 + 任务结果标签页：自动滚底，行前缀高亮（✓/✗/⟳/⊕/⏸） |
| `ApprovalModal` | 审批弹窗：展示 pending 审批请求，Approve/Reject 操作 |
| `InjectModal` | 任务注入弹窗：手动向正在运行的 agent 注入新 prompt |
| `Header` | 顶部状态栏：phase 进度、任务完成数、token 用量、cost 估算 |
| `HistoryDrawer` | 历史 run 抽屉列表：GoalStore 中所有历史 run |
| `DebugPanel` | 调试面板：WebSocket 消息计数、连接状态 |
| `TabBar` | 多 tab 切换栏：支持并发 run，每个 run 独立 tab |

### WebSocket 实时特性

| 消息方向 | 类型 | 说明 |
|------|------|------|
| Client → Server | `start.run` | 启动新 run |
| | `abort.run` / `pause` / `resume` | 运行控制 |
| | `approve` / `reject` | 审批响应 |
| | `inject` / `interrupt` | 任务注入/中断 agent |
| Server → Client | `run.started` / `run.planning` | run 生命周期事件 |
| | `tasks.sync` / `task.update` | 任务状态全量/增量同步 |
| | `agents.sync` / `agent.update` | agent 状态同步 |
| | `log` / `delta` | 日志行 + 实时 token 流 |
| | `approval.required` | 触发审批弹窗 |
| | `token.stats` | token 用量更新 |
| | `run.completed` / `run.failed` | run 完成通知 + 最终报告 |

---

## 6. 测试覆盖

| 测试文件 | 类型 | 验证内容 |
|------|------|------|
| `dag.test.ts` | 单元 | TaskDAG 状态机：依赖解析、状态转换、逆向边 wiring、死锁检测、scope 冲突检测、addTasks 批量操作 |
| `scope-concurrency.test.ts` | 单元 | scope=[] 任务的并发行为：无锁冲突、可完全并行、与有 scope 任务不冲突 |
| `parse-output.test.ts` | 单元 | Conductor 输出解析器：5 段正则提取、边界情况、中英文 stub 过滤、截断处理 |
| `m3-unit.test.ts` | 单元 | 动态任务生成（BLOCKERS→implement、RISKS→review）、ApprovalGate 请求/解析、动态任务去重和噪音过滤 |
| `store.test.ts` | 单元 | ConductorStore SQLite CRUD：runs 表、tasks 表、memory 三层、token 统计、scope 前缀降级查询 |
| `bugfix-regression.test.ts` | 回归 | 已验证 bug 修复：addTask 逆向边 wiring、store init 幂等、warm-pool adopt、stuck agent interrupt |
| `warm-pool.test.ts` | 单元 | WarmPool：mock 进程 spawn、acquire/refill/stop 生命周期、`_spawnFn` 依赖注入 |
| `agent-manager-adopt.test.ts` | 单元 | AgentProcessManager.adopt()：实例接管、客户端可用性、端口管理 |
| `project-scanner.test.ts` | 单元 | scanProjectContext：技术栈检测、目录树生成、排除规则、输出长度限制 |
| `ai-planner-graph.test.ts` | 单元 | aiGoalToTaskGraph：buildGraph wiring 验证、dependsOn 解析、task 去重 |
| `interaction.test.ts` | 单元 | YAML 任务文件加载 + goalToTaskGraph 模板规划：phase 解析、depends_on_phase 解析 |
| `git-workspace.test.ts` | 集成 | GitWorkspaceManager：agent 独立分支创建、commit、merge 策略、冲突检测 |
| `integration.test.ts` | 集成 | CodeWhaleClient 真实 API 调用：createThread、postTurn、SSE 事件流 |
| `parallel.test.ts` | 集成 | 多 agent 并行调度：3 个真实 CodeWhale 实例并发任务分派、文件锁协调 |
| `conductor-e2e.test.ts` | E2E | 端到端 Conductor：完整调度周期、动态任务插入、审批闸门、端口池管理 |

---

## 7. 构建与发布

### 构建命令

```bash
bun run typecheck    # TypeScript 类型检查（前后端分别）
bun test             # 运行全部测试
bun run build        # 编译到 dist/（先 build UI，再编译 CLI）
bun run build:bin    # 编译为单文件可执行文件 (dist/swarm-conductor)
```

### 发布脚本

| 脚本 | 说明 |
|------|------|
| `scripts/build-release.sh` | 正式发布构建：多平台编译 + 生成 checksum |
| `scripts/test-local.sh` | 本地完整测试流程 |
| `scripts/update-formula.sh` | 自动更新 Homebrew formula 版本号和 SHA256 |
| `Formula/swarm-conductor.rb` | Homebrew formula 模板：支持 arm64/x64 macOS |
| `.github/workflows/release.yml` | GitHub Actions 发布流水线 |

---

## 8. 文档现状与建议

### 已有文档覆盖

| 文档 | 内容 |
|------|------|
| `README.md` | 项目介绍、核心能力表、安装指南、快速开始、CLI 参考 |
| `PROJECT_OVERVIEW.md` | 全面的技术文档：技术栈、目录结构、10 个子模块详解、业务流程、依赖关系、配置表、潜在问题 |
| `PROJECT_ANALYSIS.md` | 近期改动清单 + 结构化分析：文件行数、依赖树、架构图 |
| `TEST_PROMPTS.md` | 测试 prompt 示例 |
| `docs/01-installation.md` | 系统要求、安装步骤、配置字段、AGENTS.md 注入说明 |
| `docs/02-quickstart.md` | demo/run/bench 命令示例、编程式 API、多 phase 流程 |
| `docs/03-architecture.md` | 模块详解、并发模型、数据流图、SSE 解析细节 |
| `docs/04-api-reference.md` | 公开 API 完整参考 |
| `docs/05-troubleshooting.md` | 常见问题排错指南 |
| `diagrams/` | 3 个 SVG 架构图 + HTML 查看器 |
| `PROJECT_SUMMARY.md` | 本文档（新增） |

### 文档缺口与建议

| 缺口 | 建议 |
|------|------|
| **前端开发指南** | 无 Web UI 组件开发文档。建议新增 `docs/06-web-ui-dev.md`，覆盖：组件树、WebSocket 协议、Zustand store 设计、Vite 构建 |
| **测试策略文档** | 15 个测试文件但缺乏统一说明。建议记录：测试分类（单元/集成/E2E）、运行环境要求、mock 策略 |
| **发布清单** | 发布步骤分散在 scripts 和 formula 中。建议新增 `RELEASE.md`：版本号更新、构建、Homebrew 发布、GitHub Release 流程 |
| **API 变更日志** | 无 CHANGELOG。建议引入 `CHANGELOG.md` 按版本记录 |
| **贡献指南** | 缺少 CONTRIBUTING.md |
| **代码注释** | Core 模块注释良好，但 `web/handlers/` 和 `cli/live-view.ts` 注释偏少 |

---

*本文档由 CodeWhale agent 基于 `src/`、`tests/`、`web-ui/` 和现有文档自动生成。*
