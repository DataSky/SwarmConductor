# 项目进展报告

> Swarm Conductor 项目当前进展概况，基于 `main` 分支代码和测试现状。
> 最后更新：2026-05-28

---

## 1. 项目概述

Swarm Conductor 是一个基于 [CodeWhale](https://github.com/Hmbown/CodeWhale) CLI 构建的**多 Agent 并行任务编排框架**。它作为 CodeWhale 的上层调度器，将大型软件工程任务拆解为声明式 DAG，由最多 20 个 CodeWhale agent 实例并行执行，自动处理依赖解析、文件锁冲突检测、SQLite 持久化共享记忆、崩溃恢复和人工审批。

核心定位：**不改动 CodeWhale 本身**，通过 `codewhale serve --http` 暴露的 REST + SSE API，以外部编排层的方式控制多个 agent 实例协同工作。

版本：**v0.1.0**（早期开发阶段）

---

## 2. 技术栈

| 层次 | 技术 | 说明 |
|------|------|------|
| 语言 | TypeScript (strict mode) | `noUncheckedIndexedAccess` 启用，类型安全贯穿始终 |
| 运行时 | Bun ≥ 1.3 | 包管理、测试运行器、构建工具一体化 |
| 包管理 | bun (bun.lock) | 零 npm/pnpm 依赖 |
| 数据库 | SQLite (WAL 模式) | `better-sqlite3` 同等接口，`busy_timeout=5000` |
| 前端框架 | React 18.3 | 函数组件 + hooks |
| 状态管理 | Zustand 5.0 | `useRunStore` + `useServeStore` |
| 构建（前端） | Vite 6 + vite-plugin-singlefile | SPA 单文件输出 |
| 分发 | Homebrew (Formula/swarm-conductor.rb) | 预编译二进制，无需 Bun |
| CI/CD | GitHub Actions (`release.yml`) | 自动构建 + Homebrew formula 更新 |
| Schema 校验 | Zod 3.24 | 运行时输入校验 |
| SSE 客户端 | eventsource 2.0 | CodeWhale SSE 事件流消费 |
| 测试 | Bun test | 原生测试运行器，零配置 |

---

## 3. 模块架构

所有源码位于 `src/` 目录，按职责划分为 8 个子模块：

### 3.1 CLI 层 (`src/cli/`)

| 文件 | 职责 |
|------|------|
| `index.ts` | CLI 入口，命令路由（`serve`、`run`、`start`、`demo`） |
| `ai-planner.ts` | AI 规划器 — 调用 DMXAPI 将自然语言 goal 转换为结构化任务图 |
| `goal-planner.ts` | 目标规划器 — 将 AI 返回的 plan 转为 TaskNode 列表并注入 DAG |
| `interactive.ts` | 交互式终端 UI — 三栏布局终端渲染 |
| `live-view.ts` | 实时 dashboard 视图 — phase 进度、agent 状态、token 统计 |
| `project-scanner.ts` | 项目扫描器 — 自动检测 `package.json`、`tsconfig.json`、`AGENTS.md` 等 |
| `task-file.ts` | YAML 任务文件解析器 — 加载 `example-tasks.yaml` 等声明式任务定义 |

### 3.2 Conductor 调度核心 (`src/conductor/`)

| 文件 | 职责 |
|------|------|
| `index.ts` | 核心调度器 — `tick()` 循环、任务分配、`dispatch()`、输出解析 `parseTaskOutput()` |
| `approval-gate.ts` | 审批门 — phase 边界审批、高风险操作拦截、`promptStdin` 交互 |
| `crash-recovery.ts` | 崩溃恢复 — 心跳监控（默认 15s 间隔）、超时检测（45s）、自动重启（最多 3 次） |
| `dynamic-tasks.ts` | 动态任务生成 — 解析 agent 输出的 `BLOCKERS`/`RISKS` 自动插入新任务 |

### 3.3 任务 DAG 引擎 (`src/dag/`)

| 文件 | 职责 |
|------|------|
| `engine.ts` | `TaskDAG` 类 — 状态流转（pending→ready→running→done/failed）、依赖解析、死锁检测 `detectDeadlock()`、`conflictingRunning()` scope 冲突检查 |
| `types.ts` | 类型定义 — `TaskNode`、`ConductorConfig`、`AgentInstance`、`TaskOutput`、事件类型，`defaultConfig()` 工厂函数 |
| `index.ts` | 模块导出 |

**状态流转：**
```
pending → ready → running → done
  ↓         ↓                  ↓
blocked   (retry) → running → failed
                              interrupted (死锁强制中断)
```

### 3.4 共享记忆 (`src/memory/`)

| 文件 | 职责 |
|------|------|
| `store.ts` | `ConductorStore` — SQLite 持久化：`runs`、`tasks`、`memory`（三层：project_map / context / event_log）、`memory_tags`、`event_log` 五张表 |
| `bus.ts` | `EventBus` — 内存事件总线，`onEvent()` 订阅，驱动 WebSocket 推送和 Web UI 实时更新 |
| `index.ts` | 模块导出 |

### 3.5 Agent 运行时 (`src/runtime/`)

| 文件 | 职责 |
|------|------|
| `agent-manager.ts` | `AgentProcessManager` — agent 进程生命周期：启动 `codewhale serve --http`、adopt 已有进程、role 匹配、idle/busy 状态管理 |
| `client.ts` | `CodeWhaleClient` — HTTP 封装：`createThread()`、`postTurn()`、`waitForTurn()`（SSE 流消费） |
| `warm-pool.ts` | `WarmPool` — agent 预热池，预启动 agent 进程减少冷启动延迟 |
| `index.ts` | 模块导出 |

### 3.6 工作空间管理 (`src/workspace/`)

| 文件 | 职责 |
|------|------|
| `file-lock.ts` | `FileLockRegistry` — 内存级逻辑锁：`tryAcquire(paths, agentId, taskId)` 原子锁定，TTL 过期自动释放，防 crash 后永久占用 |
| `git-manager.ts` | `GitWorkspaceManager` — 每个 agent 独立分支工作，phase 结束自动合并，冲突上报人工处理 |
| `index.ts` | 模块导出 |

### 3.7 Web 服务 (`src/web/`)

| 文件 | 职责 |
|------|------|
| `server.ts` | Web 服务器 — Bun HTTP server，WebSocket 推送状态，多 run 并发管理 |
| `standalone.ts` | 独立服务器入口 |
| `assets.ts` | 静态资源服务（前端 SPA + API 路由） |
| `goal-store.ts` | 历史 goal 持久化 |
| `handlers/start-run.ts` | 启动 run 的 HTTP handler |
| `handlers/replay.ts` | 历史 run 回放 handler |
| `handlers/port-pool.ts` | Agent 端口池管理 |

### 3.8 Benchmark (`src/bench/`)

| 文件 | 职责 |
|------|------|
| `run-benchmark.ts` | 自分析 benchmark — 9 个 agent 三阶段（explore → review → plan）分析项目自身 |
| `scheduler-bench.ts` | 调度器性能 benchmark |

---

## 4. 当前进展

### 4.1 已实现的核心功能

- **DAG 引擎** — 完整的状态机，支持依赖解析、死锁检测、scope 冲突检测、优先级调度
- **Conductor 调度器** — 500ms tick 循环，双重调度防护（`markBusy` + `dag.assign` 同步执行），异步 `dispatch()` 不阻塞 tick
- **CodeWhale HTTP 客户端** — `createThread` → `postTurn` → SSE `waitForTurn`，正确区分 `agent_message` 与 `agent_reasoning`
- **SQLite 持久化** — 5 张表，WAL 模式 + `busy_timeout`，支持 conductor 重启后恢复
- **文件锁** — 内存级逻辑锁，TTL 自动过期，`scope=[]` 任务无限并发
- **动态任务生成** — `BLOCKERS` → implement 任务，`RISKS` → review 任务，含去重逻辑
- **崩溃恢复** — 心跳监控（15s 间隔，45s 超时），自动重启（最多 3 次）
- **审批门** — phase 边界审批、高风险操作拦截，支持终端交互和编程式响应
- **Git 隔离** — 每 agent 独立分支，phase 结束自动合并
- **CLI 入口** — 4 个命令：`serve`（Web 常驻）、`run`（命令行单次）、`start`（交互式）、`demo`（架构验证）
- **AI 规划器** — 自然语言 goal → 结构化任务图
- **YAML 任务文件** — 声明式任务定义，多 phase 支持
- **项目扫描器** — 自动检测项目上下文注入 agent prompt
- **Agent 预热池** — 预启动进程减少冷启动延迟
- **Agent 进程管理** — 端口分配、进程 adopt、role 匹配

### 4.2 已完成的 Bug 修复

- **Bug 1**: `addTask`（单任务）遗漏反向边 `blocks[]` 连线，导致下游任务永不 unblock — 已修复并添加回归测试（`bugfix-regression.test.ts`）
- **Bug 2**: `ConductorStore.upsertTask` 未正确更新 status 字段 — 已修复

### 4.3 CI/CD 与分发

- GitHub Actions `release.yml` — 自动构建 + Homebrew formula 更新
- Homebrew tap: `DataSky/swarm-conductor`
- 构建产物：`dist/swarm-conductor`（单文件可执行）

---

## 5. 测试覆盖

### 5.1 测试文件清单（15 个文件）

| 测试文件 | 覆盖模块 | 主要测试内容 |
|----------|---------|-------------|
| `tests/dag.test.ts` (301 行) | `src/dag/engine.ts` | TaskDAG 状态流转、依赖解析、死锁检测、scope 冲突、`readyTasks()` 排序、重试逻辑 |
| `tests/parse-output.test.ts` (367 行) | `src/conductor/index.ts` | `parseTaskOutput()` 5-section 解析、缺 section、空白行容错、CRITICAL 风险提取 |
| `tests/store.test.ts` (207 行) | `src/memory/store.ts` | ConductorStore 增删改查、runs/tasks/memory/events 表操作、tag 过滤、WAL 写入 |
| `tests/m3-unit.test.ts` (218 行) | `src/conductor/dynamic-tasks.ts` + `approval-gate.ts` | `generateFollowupTasks()` BLOCKERS→implement、RISKS→review、去重逻辑；审批门请求/决议生命周期 |
| `tests/interaction.test.ts` (168 行) | `src/cli/task-file.ts` + `goal-planner.ts` | YAML 解析、phase 解析、depends_on_phase 支持、goal→任务图映射 |
| `tests/conductor-e2e.test.ts` (219 行) | `src/conductor/index.ts` | 完整调度闭环：spawnAgents → addTasks → startScheduler → waitForCompletion；动态任务、审批门 |
| `tests/parallel.test.ts` (145 行) | `src/runtime/agent-manager.ts` + `file-lock.ts` | 3 个真实 agent 并行 dispatch、scope 冲突检测、agent idle/busy 切换 |
| `tests/warm-pool.test.ts` (230 行) | `src/runtime/warm-pool.ts` | WarmPool 预启动、复用、spawn 失败回退、并发压力 |
| `tests/agent-manager-adopt.test.ts` (160 行) | `src/runtime/agent-manager.ts` | AgentProcessManager 进程 adopt、role 匹配、`getBestIdle` 选择逻辑 |
| `tests/git-workspace.test.ts` (136 行) | `src/workspace/git-manager.ts` | 每 agent 独立分支创建、commit、merge、冲突检测 |
| `tests/scope-concurrency.test.ts` (117 行) | `src/dag/engine.ts` | `scope=[]` 无限并发、`scopesConflict` 逻辑、`conflictingRunning` 正确排除 |
| `tests/bugfix-regression.test.ts` (163 行) | `src/dag/engine.ts` + `store.ts` | Bug 1: addTask 反向边连线；Bug 2: upsertTask status 更新 |
| `tests/ai-planner-graph.test.ts` (149 行) | `src/cli/ai-planner.ts` | AI 规划器图构建逻辑（mocked API） |
| `tests/project-scanner.test.ts` (130 行) | `src/cli/project-scanner.ts` | `scanProjectContext()` 检测 package.json、tsconfig、AGENTS.md |
| `tests/integration.test.ts` (83 行) | `src/runtime/client.ts` | 真实 CodeWhale HTTP 客户端：createThread、postTurn、SSE 流消费 |

### 5.2 测试运行方式

```bash
bun test                    # 运行全部测试
bun test tests/dag.test.ts  # 运行单个文件
```

---

## 6. 文档现状

### 6.1 现有文档（`docs/` 目录）

| 文档 | 内容 | 行数 |
|------|------|------|
| `docs/01-installation.md` | 系统要求、Homebrew/源码安装步骤、配置字段说明、AGENTS.md 注入 | — |
| `docs/02-quickstart.md` | demo/run/bench 命令、编程式 API 示例、多 phase 流程、审批控制 | — |
| `docs/03-architecture.md` | 模块详解、并发模型、数据流图、SSE 解析细节 | 211 |
| `docs/04-api-reference.md` | 所有公开 API 完整参考（Conductor/TaskDAG/ApprovalGate/ConductorStore） | 247 |
| `docs/05-troubleshooting.md` | 常见问题与排错指南 | — |
| `docs/06-project-progress.md` | 本文件 — 项目进展报告 | — |

### 6.2 项目根目录分析文档

| 文件 | 说明 |
|------|------|
| `README.md` (303 行) | 项目主文档：核心能力、安装、快速开始、CLI 参考 |
| `PROJECT_ANALYSIS.md` | 项目分析 |
| `PROJECT_OVERVIEW.md` | 项目概览 |
| `PROJECT_SUMMARY.md` | 项目总结 |
| `TEST_PROMPTS.md` (567 行) | 正式测试 prompt 手册（T1-T6 六层测试） |
| `example-tasks.yaml` | 示例 YAML 任务文件 |

### 6.3 架构图

| 文件 | 说明 |
|------|------|
| `diagrams/01-architecture.svg` | 整体架构图 |
| `diagrams/02-core-flow.svg` | 核心调度流程 |
| `diagrams/03-dag-statemachine.svg` | DAG 状态机 |
| `diagrams/index.html` | 图表预览页 |

---

## 7. Web UI 进展

基于 React 18 + Zustand + Vite 构建的单页应用（SPA），通过 `vite-plugin-singlefile` 编译为单个 HTML 文件内嵌于后端服务。

### 7.1 组件清单（10 个组件）

| 组件 | 文件 | 功能 | 状态 |
|------|------|------|------|
| `App` | `web-ui/src/App.tsx` | 主应用入口，Run 完成横幅 | ✅ 完成 |
| `LaunchOverlay` | `web-ui/src/components/LaunchOverlay.tsx` | Goal 输入、agent 数量、模型选择、启动 Run | ✅ 完成 |
| `TaskDag` | `web-ui/src/components/TaskDag.tsx` | DAG 任务图可视化 | ✅ 完成 |
| `AgentSlots` | `web-ui/src/components/AgentSlots.tsx` | Agent 状态槽位（idle/busy/crashed） | ✅ 完成 |
| `LogStream` | `web-ui/src/components/LogStream.tsx` | 实时日志流 | ✅ 完成 |
| `ApprovalModal` | `web-ui/src/components/ApprovalModal.tsx` | 审批弹窗（approve/reject） | ✅ 完成 |
| `InjectModal` | `web-ui/src/components/InjectModal.tsx` | 任务注入弹窗 | ✅ 完成 |
| `HistoryDrawer` | `web-ui/src/components/HistoryDrawer.tsx` | 历史 Run 抽屉 | ✅ 完成 |
| `Header` | `web-ui/src/components/Header.tsx` | 顶部状态栏（phase、token 统计、risk 计数） | ✅ 完成 |
| `TabBar` | `web-ui/src/components/TabBar.tsx` | 多 Run Tab 切换 | ✅ 完成 |
| `DebugPanel` | `web-ui/src/components/DebugPanel.tsx` | 调试面板 | ✅ 完成 |

### 7.2 基础架构

| 模块 | 技术 | 说明 |
|------|------|------|
| 状态管理 | Zustand 5.0 | `useRunStore`（Run 状态）+ `useServeStore`（服务器状态） |
| WebSocket | 自定义 hook (`useWebSocket.ts`) | 实时双向通信 |
| 样式 | CSS Modules (`*.module.css`) | 组件隔离样式 |
| 构建 | Vite 6 + `vite-plugin-singlefile` | 单 HTML 文件输出 |

### 7.3 支持功能

- 多 Run 并发（Tab 切换）
- 历史 Run 回放
- 实时 agent 状态更新
- 审批交互
- Token 统计与成本估算
- 任务注入（动态添加任务到运行中的 DAG）

---

## 8. 后续建议

### 8.1 短期（v0.2.0 方向）

- **错误处理增强** — 完善 SSE 断连重试、agent 超时处理、HTTP 请求重试策略
- **测试覆盖提升** — 增加 `crash-recovery.test.ts`（心跳/重启逻辑）、`git-manager.test.ts`（merge 冲突场景）、更多边界条件测试
- **Web UI 优化** — 改进 DAG 可视化（支持大规模任务图）、移动端适配
- **文档完善** — 补充 `PROJECT_ANALYSIS.md` / `PROJECT_OVERVIEW.md` / `PROJECT_SUMMARY.md` 的内容一致性和更新

### 8.2 中期方向

- **插件体系** — 支持自定义 task type、自定义审批策略、自定义输出解析器
- **多项目支持** — conductor 同时管理多个项目的 run
- **CLI 体验** — 完善交互式 TUI，支持键盘快捷键和更丰富的可视化
- **性能优化** — WarmPool 预热策略优化、调度器 tick 自适应间隔

### 8.3 技术债务

- 类型安全：部分 `any` 类型需要替换为具体类型（主要在 `src/web/` 和测试 mock 中）
- 错误消息：部分错误消息为英文，建议统一中文（面向国内用户）
- 代码注释：`src/web/` 和 `src/bench/` 部分文件缺少 JSDoc

---

## 9. 关键文件索引

| 路径 | 说明 |
|------|------|
| `src/conductor/index.ts` | 核心调度器 |
| `src/dag/engine.ts` | DAG 引擎 |
| `src/dag/types.ts` | 所有类型定义 |
| `src/memory/store.ts` | SQLite 持久化 |
| `src/runtime/agent-manager.ts` | Agent 进程管理 |
| `src/runtime/client.ts` | CodeWhale HTTP 客户端 |
| `src/workspace/file-lock.ts` | 文件锁 |
| `src/workspace/git-manager.ts` | Git 工作空间管理 |
| `src/cli/index.ts` | CLI 入口 |
| `src/cli/ai-planner.ts` | AI 规划器 |
| `src/web/server.ts` | Web 服务器 |
| `web-ui/src/App.tsx` | Web UI 入口 |
| `tests/` | 15 个测试文件 |
| `README.md` | 项目主文档 |
| `TEST_PROMPTS.md` | 测试手册 |
| `example-tasks.yaml` | 示例任务文件 |
