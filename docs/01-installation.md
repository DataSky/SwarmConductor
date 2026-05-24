# 安装与配置

## 系统要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| [Bun](https://bun.sh) | ≥ 1.3 | JavaScript 运行时，内置 SQLite |
| [CodeWhale](https://github.com/Hmbown/CodeWhale) | ≥ 0.8.41 | AI coding CLI，充当 agent worker |
| Git | 任意版本 | 可选，启用分支隔离功能 |
| macOS / Linux | — | Windows 未测试 |

---

## 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
# 验证
bun --version   # 应 ≥ 1.3
```

## 安装 CodeWhale

```bash
npm install -g codewhale
# 或 Cargo
cargo install codewhale-cli --locked
cargo install codewhale-tui --locked

# 验证
codewhale --version
```

CodeWhale 需要配置 API Key。支持 DeepSeek（默认）或任意 OpenAI 兼容端点：

```bash
# DeepSeek
codewhale login --provider deepseek
# 或手动写入 ~/.deepseek/config.toml
```

---

## 安装 Swarm Conductor

```bash
git clone https://github.com/your-org/swarm-conductor.git
cd swarm-conductor
bun install
```

验证安装：

```bash
bun run dev demo
# 应输出：Architecture verified. Milestone 1 complete.
```

---

## 配置

所有配置通过 `defaultConfig()` 工厂函数创建，无配置文件，直接在代码中传参。

### 完整配置字段

```typescript
import { defaultConfig } from "./src/dag/types"

const config = defaultConfig({
  // 必填
  projectPath: "/path/to/your/project",

  // Agent 并发
  maxConcurrentAgents: 10,   // 最大并发 agent 数，硬限 20
  basePort: 7878,            // 第一个 agent 的 HTTP 端口，后续递增

  // 超时与重试
  fileLockTtlMs: 300_000,    // 文件锁过期时间（ms），防 crash 后永久锁定
  deadlockTimeoutMs: 300_000,// 死锁检测超时（ms）
  schedulerTickMs: 500,      // 调度器轮询间隔（ms）

  // CodeWhale
  autoApprove: false,        // true = 跳过所有 tool call 审批（YOLO 模式）
  codewhalebin: "codewhale", // CodeWhale 二进制路径

  // Crash recovery
  heartbeatIntervalMs: 15_000,  // 心跳检查间隔（ms）
  heartbeatTimeoutMs: 45_000,   // 无心跳超过此时间视为 crashed
  maxAgentRestarts: 3,           // 单个 agent 最大重启次数

  // 动态任务
  dynamicTasks: true,   // 解析 BLOCKERS/RISKS，自动插入新任务
})
```

### 推荐生产配置

```typescript
const config = defaultConfig({
  projectPath: process.cwd(),
  maxConcurrentAgents: 5,   // 从 5 开始，稳定后再增加
  schedulerTickMs: 1000,    // 降低 CPU 占用
  autoApprove: false,       // 保持人工审批
  heartbeatIntervalMs: 30_000,
  heartbeatTimeoutMs: 90_000,
  dynamicTasks: true,
})
```

---

## AGENTS.md 注入

在目标项目根目录放置 `AGENTS.md`（或 `CLAUDE.md`），Conductor 会自动读取并注入每个 agent 的 prompt：

```markdown
# AGENTS.md

## 代码规范
- 使用 TypeScript strict 模式
- 所有公共函数必须有 JSDoc
- 禁止 any 类型

## 禁止操作
- 不得修改 package.json 的 version 字段
- 不得删除 tests/ 目录下的文件
```

搜索顺序：`AGENTS.md` → `CLAUDE.md` → `.conductor/AGENTS.md`，找到第一个即使用。
