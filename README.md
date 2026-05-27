# Swarm Conductor

> 基于 [CodeWhale](https://github.com/Hmbown/CodeWhale) 构建的多 Agent 并行编排层。  
> 让 10+ 个 AI coding agent 同时处理一个大型项目，自动协调任务依赖、文件冲突和上下文共享。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **并行调度** | 最多 20 个 CodeWhale agent 实例同时运行，按任务依赖自动编排顺序 |
| **任务 DAG** | 声明式任务图，支持跨任务依赖、优先级、重试 |
| **文件锁** | 每个任务声明 `scope`（文件列表），调度器自动检测冲突，同一文件不会被两个 agent 同时写入 |
| **Shared Memory** | SQLite 三层记忆总线（project\_map / context / event\_log），agent 之间传递上下文 |
| **动态任务** | agent 输出的 `BLOCKERS` 自动触发新的 implement 任务，`RISKS` 触发 review 任务 |
| **Crash Recovery** | 心跳监控 + 自动重启崩溃的 agent，中断任务自动重新排队 |
| **Human-in-the-loop** | Phase 边界审批、高风险操作拦截，支持终端交互和编程式两种响应模式 |
| **Git 隔离** | 每个 agent 在独立分支工作，phase 结束时自动合并，冲突上报人工处理 |
| **SQLite 持久化** | 所有 task 状态、events、context 存入本地 SQLite，支持 conductor 重启后恢复 |
| **AGENTS.md 注入** | 自动读取项目根目录的 `AGENTS.md` 或 `CLAUDE.md`，注入每个 agent 的 system prompt |

---

## 系统要求

- **CodeWhale** CLI（`codewhale`）已安装并在 PATH 中（[安装](https://github.com/Hmbown/CodeWhale)）
- macOS arm64 / x64（Homebrew 安装无需 Bun）
- **Bun** ≥ 1.3 仅源码构建时需要（[安装](https://bun.sh)）

---

## 安装

### Homebrew（推荐，无需 Bun）

```bash
brew tap DataSky/swarm-conductor https://github.com/DataSky/SwarmConductor
brew install swarm-conductor
```

安装后同时提供两个命令，功能完全相同：

```bash
swarm demo          # 短别名
swarm-conductor demo
```

升级：

```bash
brew upgrade swarm-conductor
```

### 从源码构建

```bash
git clone https://github.com/DataSky/SwarmConductor.git
cd SwarmConductor
bun install
bun run dev demo          # 直接运行（需要 Bun）

# 或编译成本机可执行文件
bun build --compile src/cli/index.ts --outfile swarm-conductor
./swarm-conductor demo
```

---

## 快速开始

### 1. 验证安装

```bash
swarm demo
```

输出示例：
```
Task DAG: 4 tasks  |  3 ready (parallel)  |  1 blocked
  [ready    ] [explore   ] Scan file structure      → ready
  [ready    ] [explore   ] Analyze test coverage    → ready
  [ready    ] [explore   ] Map API boundaries        → ready
  [blocked  ] [plan      ] Generate plan             → blocked by 3
Deadlock check: clean ✓
```

### 2. 对真实项目运行

#### 方式一：Web 界面（推荐）

```bash
swarm serve --port 9000 --project /path/to/your/project
```

浏览器自动打开 `http://localhost:9000`，在界面中输入 Goal、选择 agent 数量和模型，点击 **Start Run** 启动。支持多个 run 并发、历史回放、任务注入等。

#### 方式二：命令行 + 自然语言目标

```bash
swarm run --goal "分析项目结构，找出主要模块和潜在问题" \
          --project /path/to/your/project \
          --agents 5 \
          --auto-approve
```

> 如需同时打开浏览器 Dashboard，加上 `--web 9000` 参数。

#### 方式三：YAML 任务文件（精确控制）

```bash
swarm run --tasks example-tasks.yaml --auto-approve
```

仓库根目录提供了一份开箱即用的示例文件 [`example-tasks.yaml`](./example-tasks.yaml)，也可以参考它的结构自定义：

```yaml
# example-tasks.yaml
goal: "分析并优化项目代码质量"
agents: 3

phases:
  - name: explore           # Phase 0：并行探索（3 个 agent 同时跑）
    tasks:
      - title: "分析项目结构"
        type: explore
        scope: ["src"]
        prompt: "分析 src 目录的文件结构、模块划分和主要依赖关系，列出关键文件"

      - title: "检查测试覆盖"
        type: explore
        scope: ["tests"]
        prompt: "检查测试文件，找出哪些模块缺少测试覆盖"

      - title: "识别代码问题"
        type: explore
        scope: ["src"]
        prompt: "查找潜在的 bug、重复代码、不一致的错误处理模式"

  - name: plan              # Phase 1：汇总制定计划（等 explore 全部完成）
    tasks:
      - title: "制定优化方案"
        type: plan
        depends_on_phase: explore
        prompt: "根据探索阶段的发现，制定代码质量优化的优先级列表和实施步骤"
```

运行时显示实时 dashboard：
```
Phase 0  [████████████████░░░░░░░░░░░░]  2/3 (67%)
  running:1  ready:0  blocked:1  failed:0
Agents  idle:2  busy:1  crashed:0  locks:1
Tokens  in:32,826  out:156  total:32,982  cache:78%
```

### 3. 自分析 benchmark

```bash
bun run bench
```

用 9 个 agent 对 Swarm Conductor 自身代码做 explore → review → plan 三阶段分析，输出报告到 `.conductor-bench/self-analysis-report.json`。

---

## CLI 参考

```
swarm <command> [options]
```

| 命令 | 说明 |
|------|------|
| `serve` | **常驻 Web 服务（推荐）**：浏览器全控，支持多 run 并发、历史回放 |
| `run` | 命令行启动单次 run，终端实时 dashboard |
| `start` | 交互式输入 Goal，自动开浏览器（`serve` + `run` 的结合） |
| `demo` | 构建示例 DAG，验证架构（不启动真实 agent） |

### `serve` 模式选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--port <n>` | `9000` | Web 服务监听端口 |
| `--project <path>` | `cwd` | 目标项目目录 |
| `--base-port <n>` | `8800` | agent 子进程端口起始值 |

### `run` 模式选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `--goal <text>` | — | 自然语言描述任务目标（与 `--tasks` 二选一，必填） |
| `--tasks <path>` | — | YAML 任务文件路径（与 `--goal` 二选一，必填） |
| `--project <path>` | `cwd` | 目标项目目录 |
| `--agents <n>` | `5` | 最大并发 agent 数量（上限 20） |
| `--auto-approve` | `false` | 自动批准所有 tool call（跳过人工审批） |
| `--no-interact` | `false` | 全自动模式，任务完成后不暂停等待输入 |
| `--web [port]` | — | 同时开启 Web Dashboard（默认端口 9000） |
| `--output <path>` | `.conductor/report-<id>.json` | JSON 报告保存路径 |
| `--dynamic-tasks false` | `true` | 关闭动态任务生成 |
| `--model-worker <model>` | — | 所有 agent 使用同一模型（如 `deepseek-v3`） |
| `--no-ai-plan` | `false` | 跳过 AI 规划，使用内置静态任务模板 |
| `--bin <path>` | `codewhale` | CodeWhale 二进制路径 |

### 命令对比

| | `serve` | `run` | `run --web` |
|---|---|---|---|
| 界面 | 浏览器 | 终端 TUI | 终端 + 浏览器 |
| 多 run 并发 | ✅ | ❌ | ❌ |
| 历史回放 | ✅ | ❌ | ❌ |
| 脚本/自动化 | ❌ | ✅ | ✅ |
| 推荐场景 | 日常使用 | CI / 脚本 | 调试

---

## 项目结构

```
swarm-conductor/
├── src/
│   ├── dag/              # Task DAG 引擎与类型定义
│   │   ├── types.ts      # TaskNode, ConductorConfig, defaultConfig()
│   │   └── engine.ts     # TaskDAG 类，状态机
│   ├── conductor/        # 核心调度器
│   │   ├── index.ts      # Conductor 主类
│   │   ├── dynamic-tasks.ts   # 动态任务生成
│   │   ├── crash-recovery.ts  # 心跳监控与自动重启
│   │   └── approval-gate.ts   # Human-in-the-loop 审批
│   ├── runtime/          # CodeWhale HTTP 客户端
│   │   ├── client.ts     # SSE 流式客户端
│   │   └── agent-manager.ts   # agent 进程池
│   ├── workspace/        # 工作区隔离
│   │   ├── file-lock.ts  # 文件锁注册表
│   │   └── git-manager.ts     # Git 分支管理
│   ├── memory/           # 持久化层
│   │   ├── store.ts      # SQLite ConductorStore（bun:sqlite，WAL 模式）
│   │   └── bus.ts        # 文件系统 SharedMemoryBus（备用）
│   ├── cli/index.ts      # CLI 入口 + ANSI 实时 dashboard
│   └── bench/run-benchmark.ts # 自分析压测脚本
├── tests/                # 59 个测试（unit + integration + e2e）
├── docs/                 # 详细文档
├── Formula/              # Homebrew Formula
└── scripts/              # 构建与发布脚本
```

---

## 开发

```bash
bun run typecheck   # TypeScript 类型检查
bun test            # 运行全套测试（59 个）
bun run build       # 打包到 dist/
```

---

## 测试覆盖

| 测试文件 | 覆盖内容 |
|---------|---------|
| `dag.test.ts` | TaskDAG 状态机、依赖解析、文件锁 |
| `m3-unit.test.ts` | 动态任务生成、ApprovalGate |
| `store.test.ts` | SQLite 持久化、标签查询、写入性能 |
| `git-workspace.test.ts` | 分支隔离、merge、冲突检测 |
| `integration.test.ts` | CodeWhale HTTP API（真实 LLM） |
| `parallel.test.ts` | 3 agent 并发 dispatch |
| `conductor-e2e.test.ts` | 完整调度循环端到端 |
| `bugfix-regression.test.ts` | 自分析发现的 6 个 bug 的回归测试 |

---

## Benchmark 结果（2026-05-24）

**自分析测试**（Swarm Conductor 用 9 个 agent 分析自身代码）：

| 指标 | 数值 |
|------|------|
| 目标项目 | `SwarmConductor`（本项目，2457 行 TS） |
| agent 数量 | 9（5 explore + 3 review + 1 plan） |
| 完成率 | 8/9（plan 任务接近 900s 上限） |
| 总耗时 | 900s |
| 平均任务耗时 | 197s |
| SQLite 写入性能 | 0.04ms / task（1000 次 upsert = 37ms） |

自分析发现并修复了 6 个真实 bug，包括调度器双重派发竞态、SSE 断连默认成功、心跳互斥缺失等。

---

## 发布新版本

```bash
git tag v0.2.0
git push origin v0.2.0
```

GitHub Actions 自动完成：编译 arm64 + x64 → 打包 → 更新 Formula sha256 → 发布 Release。

---

## License

MIT
