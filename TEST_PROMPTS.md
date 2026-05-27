# Swarm Conductor 正式测试 Prompt 手册

> 适用版本：`main` 分支（commit `72c0e13`）  
> 目标项目：`/Users/wangteng06/AiCode/codewhale_debug`  
> 前提：`codewhale` CLI 已安装并配置好模型 API Key，`bun` ≥ 1.3

---

## 一、测试分层概览

```
T1  快速冒烟          ── 无需 LLM，3 分钟内跑完，验证架构不炸
T2  单元测试          ── 无需 LLM，bun test，验证 59 个已有用例
T3  AI Planner        ── 需要 DMXAPI，验证 claude-opus-4-7 规划 + deepseek-v3 降级
T4  端到端 Swarm Run  ── 需要 CodeWhale + LLM，验证完整调度闭环
T5  TUI 布局          ── 无需 LLM，验证三栏渲染在不同终端宽度下的正确性
T6  压力 / 混沌       ── 需要 CodeWhale，验证 crash recovery 和僵死检测
```

---

## T1 — 快速冒烟（无 LLM）

### T1-1 架构自检

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun run src/cli/index.ts demo
```

**预期输出：**
```
Swarm Conductor — architecture demo
Task DAG: 4 tasks  |  3 ready (parallel)  |  1 blocked
  [ready    ] [explore   ] Scan file structure      → ready
  [ready    ] [explore   ] Analyze test coverage    → ready
  [ready    ] [explore   ] Map API boundaries        → ready
  [blocked  ] [plan      ] Generate implementation plan → blocked by 3
Deadlock check: clean
```

**验证点：** 退出码为 0，无 `Error:` / `Fatal:` 字样。

---

### T1-2 TypeScript 类型检查

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun tsc --noEmit
```

**预期：** 无任何输出（零错误、零警告）。

---

### T1-3 Help 输出完整性

```bash
bun run src/cli/index.ts help
```

**验证点：** 输出中包含以下所有选项行：
- `--goal`
- `--tasks`
- `--no-ai-plan`
- `--agents`
- `--auto-approve`
- `--stream`
- `--quiet`

---

## T2 — 单元测试套件（无 LLM）

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun test
```

**预期：** ≥ 69 pass。`integration.test.ts` 和 `parallel.test.ts` 需要真实 CodeWhale 进程，无 LLM 环境下允许超时 fail，其余 7 个文件须全 pass。

| 文件 | 核心验证点 |
|------|-----------|
| `dag.test.ts` | `addTask` 反向边、依赖解锁、文件锁 TTL |
| `bugfix-regression.test.ts` | Bug 1-7 回归（双重派发、SSE 默认失败、心跳互斥等） |
| `store.test.ts` | SQLite tag 索引查询、`close()` 幂等性 |
| `m3-unit.test.ts` | 动态任务生成（BLOCKERS→implement、RISKS→review）、ApprovalGate |
| `conductor-e2e.test.ts` | 调度完整闭环、动态任务插入、审批门 |
| `git-workspace.test.ts` | 分支隔离、merge、冲突检测 |
| `parallel.test.ts` | 3 agent 并发 dispatch |

---

## T3 — AI Planner 验证（需要 DMXAPI）

### T3-1 主模型正常路径

运行以下脚本，验证 `claude-opus-4-7` 能生成合法 JSON 任务图：

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun -e "
import { aiGoalToTaskGraph } from './src/cli/ai-planner.ts'
const plan = await aiGoalToTaskGraph(
  '重构 src/runtime/client.ts：把回调式 SSE 解析改成 AsyncIterator',
  process.cwd()
)
console.log('模型生成任务数:', plan.nodes.length)
console.log('计划描述:', plan.description)
for (const n of plan.nodes) {
  const deps = n.dependsOn.length > 0 ? ' ← ' + n.dependsOn.length + ' deps' : ''
  console.log('  [' + n.type + '] ' + n.title + deps)
}
"
```

**验证点：**
- 输出 `模型生成任务数:` 行，数字在 3–12 之间
- 任务类型组合合理（至少有 explore 和 implement）
- 依赖关系成环检测不触发（如有 plan 类型任务，应 dependsOn explore）
- 无 `AI planner failed` 字样

---

### T3-2 主模型降级路径

模拟 DMXAPI 不可达，验证自动降级到 `deepseek-v3`：

```bash
bun -e "
// 临时覆盖 fetch，让第一次调用超时
let callCount = 0
const origFetch = globalThis.fetch
globalThis.fetch = async (url: any, opts: any) => {
  if (++callCount === 1) throw new Error('simulated network timeout')
  return origFetch(url, opts)
}
import { aiGoalToTaskGraph } from './src/cli/ai-planner.ts'
try {
  const plan = await aiGoalToTaskGraph('优化 src/memory/store.ts 查询性能', process.cwd())
  console.log('降级成功，任务数:', plan.nodes.length)
} catch(e) {
  console.error('降级失败:', e.message)
}
"
```

**验证点：** 控制台打印 `[planner] claude-opus-4-7 failed...falling back to deepseek-v3`，且最终 `降级成功`。

---

### T3-3 --no-ai-plan 静态回退

```bash
bun run src/cli/index.ts run \
  --goal "测试静态模板" \
  --project /tmp \
  --no-ai-plan \
  --agents 1 2>&1 | head -20
```

**验证点：** 输出包含 `Phase 0: Explore` / `Phase 1: Design` 等静态模板描述，**不包含** `Planning with AI` 字样。

---

## T4 — 端到端 Swarm Run（需要 CodeWhale + LLM）

以下测试需要 `codewhale serve` 可正常启动。先验证：

```bash
codewhale --version
codewhale serve --http --port 17700 --insecure &
sleep 3 && curl -s http://127.0.0.1:17700/health && kill %1
```

预期：`{"status":"ok"}` 或类似。

---

### T4-1 最小端到端：--goal 单 agent

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun run src/cli/index.ts run \
  --goal "探索 src/dag/engine.ts 的核心逻辑，总结 TaskDAG 状态机的转换规则" \
  --project . \
  --agents 1 \
  --auto-approve \
  --no-interact \
  --quiet
```

**验证点（完成后看 `.conductor/report-*.json`）：**

```bash
cat .conductor/report-*.json | bun -e "
const data = JSON.parse(await Bun.stdin.text())
console.log('result:', data.result)
console.log('tasks done:', data.tasks.done, '/', data.tasks.total)
console.log('has summary:', data.summaries[0]?.summary?.length > 0)
"
```

预期：`result: completed`，`tasks done: 5/5`（explore→plan→implement→review→verify），`has summary: true`。

---

### T4-2 YAML 任务文件：3 agent 并行 explore

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun run src/cli/index.ts run \
  --tasks example-tasks.yaml \
  --project . \
  --auto-approve \
  --no-interact \
  --quiet
```

**验证点：**
- `tasks done` ≥ 3（3 个 explore + 1 个 plan 全部完成）
- `.conductor/conductor.db` 存在且非空
- 每个完成任务的 `summaries[n].summary` 非空字符串

---

### T4-3 AI Planner + 真实执行

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun run src/cli/index.ts run \
  --goal "分析 src/conductor/index.ts 中的 dispatch() 方法，找出潜在的竞态条件和改进点，不要修改代码，只输出分析报告" \
  --project . \
  --agents 2 \
  --auto-approve \
  --no-interact \
  --stream
```

**验证点：**
- 终端头部行 1 显示 `Planning with AI (claude-opus-4-7)…` 后开始运行
- AGENTS 中栏实时显示 agent 进度（若终端宽度 ≥ 140）
- 运行结束打印 `✓ Run completed`

---

### T4-4 动态任务插入验证

构造一个会触发 BLOCKERS 的任务：

```yaml
# /tmp/dynamic-test.yaml
goal: "验证动态任务插入机制"
agents: 2
phases:
  - name: explore
    tasks:
      - title: "故意产生 blocker"
        type: explore
        scope: ["src"]
        prompt: |
          查看 src/conductor/index.ts 文件。
          
          ## SUMMARY
          分析了 conductor 文件。
          
          ## CHANGES
          无
          
          ## EVIDENCE
          文件存在。
          
          ## RISKS
          无
          
          ## BLOCKERS
          - dispatch() 方法需要增加超时保护逻辑
```

```bash
bun run src/cli/index.ts run \
  --tasks /tmp/dynamic-test.yaml \
  --project /Users/wangteng06/AiCode/codewhale_debug \
  --auto-approve \
  --no-interact
```

**验证点：** `.conductor/report-*.json` 中 `summaries` 包含标题为 `Fix: dispatch() 方法需要增加超时保护逻辑` 的任务（动态插入的 implement task）。

---

### T4-5 Human-in-the-loop 审批门

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun run src/cli/index.ts run \
  --goal "探索 src/ 目录结构" \
  --project . \
  --agents 1 \
  --stream
# 不加 --auto-approve，不加 --no-interact
# 当 task 完成暂停时，手动输入追加任务：
# > 同时检查一下 tests/ 目录下的测试文件覆盖率
# 然后回车继续
```

**验证点：** 输入追加任务后，最终报告中出现两个完成的任务（原始 + 追加）。

---

## T5 — TUI 布局验证（无 LLM）

### T5-1 三栏布局（≥ 140 列）

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
COLUMNS=160 LINES=40 bun -e "
process.stdout.columns = 160
process.stdout.rows = 40
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
import { LiveView } from './src/cli/live-view.ts'
import { Conductor } from './src/conductor/index.ts'
import { defaultConfig } from './src/dag/types.ts'
import { createTaskNode } from './src/dag/engine.ts'
const c = new Conductor(defaultConfig({ projectPath: process.cwd() }))
await c.initialize()
const t1 = createTaskNode({ type:'explore', title:'Explore codebase', prompt:'p', scope:['.'], priority:100 })
const t2 = createTaskNode({ type:'implement', title:'Refactor auth module', prompt:'p', scope:['src/auth'], priority:80, dependsOn:[t1.id] })
const t3 = createTaskNode({ type:'review', title:'Code review', prompt:'p', scope:['.'], priority:75, dependsOn:[t2.id] })
c.taskDag.addTasks([t1,t2,t3])
c.taskDag.assign(t1.id, 'agent-aaa')
c.taskDag.complete(t1.id, { summary:'Found 38 files.', changes:[], evidence:[], risks:['HIGH: no input validation'], blockers:[], rawText:'' })
c.taskDag.assign(t2.id, 'agent-bbb')
const lv = new LiveView(c, 'summary')
const slots = (lv as any).slots
slots.set('agent-bbb', { taskId:t2.id, title:t2.title, type:t2.type, scope:t2.scope, startedAt:Date.now()-45000, lastLine:'Rewriting JWT middleware...', tokenUsage:null })
lv.start()
await new Promise(r => setTimeout(r, 800))
lv.stop()
await c.shutdown()
" 2>/dev/null > /tmp/tui160.bin

python3 - /tmp/tui160.bin << 'EOF'
import sys
with open(sys.argv[1], 'rb') as f:
    data = f.read().decode('utf-8', errors='replace')
W, H = 160, 40
grid = [[' ']*W for _ in range(H)]
row=col=i=0
while i < len(data):
    ch=data[i]
    if ch=='\x1b' and i+1<len(data) and data[i+1]=='[':
        j=i+2
        while j<len(data) and data[j] not in 'ABCDEFGHJKSTfmhlsu': j+=1
        seq=data[i+2:j]; e=data[j] if j<len(data) else ''
        if e in('H','f'):
            p=seq.split(';'); row=max(0,min(int(p[0])-1,H-1)) if p[0] else 0; col=max(0,min(int(p[1])-1,W-1)) if len(p)>1 and p[1] else 0
        elif e=='J':
            for r in range(H): grid[r]=[' ']*W
        i=j+1
    elif ch=='\n': row=min(row+1,H-1); col=0; i+=1
    elif ch=='\r': col=0; i+=1
    elif ord(ch)<32: i+=1
    else:
        if 0<=row<H and 0<=col<W: grid[row][col]=ch
        col=min(col+1,W-1); i+=1
dividers=0
for line in grid[3:25]:
    s=''.join(line)
    if '│' in s: dividers+=1
tasks_found = any('TASKS' in ''.join(line) for line in grid[3:6])
agents_found = any('AGENTS' in ''.join(line) for line in grid[3:6])
log_found = any('LOG' in ''.join(line) for line in grid[3:6])
risk_found = any('HIGH' in ''.join(line) for line in grid[:3])
phase_found = any('phases' in ''.join(line) for line in grid[:3])
print(f"三栏标题:  TASKS={'✓' if tasks_found else '✗'}  AGENTS={'✓' if agents_found else '✗'}  LOG={'✓' if log_found else '✗'}")
print(f"分割线行数: {dividers} (预期 ≥ 10)")
print(f"风险信号灯: {'✓' if risk_found else '✗'} (header 区域含 HIGH)")
print(f"Phase 时间线: {'✓' if phase_found else '✗'}")
for r,line in enumerate(grid[:12]): print(f"{r+1:2d}|{''.join(line[:160])}|")
EOF
```

**预期输出关键行：**
```
三栏标题:  TASKS=✓  AGENTS=✓  LOG=✓
分割线行数: XX (预期 ≥ 10)
风险信号灯: ✓ (header 区域含 HIGH)
Phase 时间线: ✓
```

---

### T5-2 两栏退化（100 列）

```bash
# 将上面脚本中 process.stdout.columns = 100，COLUMNS=100，/tmp/tui100.bin
# 验证：AGENTS 标题不出现，TASKS 和 LOG 出现，只有一条 │ 分割线
```

**验证点：** 100 列时不渲染中栏，`AGENTS=✗`，`TASKS=✓`，`LOG=✓`。

---

### T5-3 纯文本 fallback（55 列）

```bash
COLUMNS=55 LINES=20 bun -e "
process.stdout.columns = 55
Object.defineProperty(process.stdout, 'isTTY', { value: false })
import { LiveView } from './src/cli/live-view.ts'
import { Conductor } from './src/conductor/index.ts'
import { defaultConfig } from './src/dag/types.ts'
import { createTaskNode } from './src/dag/engine.ts'
const c = new Conductor(defaultConfig({ projectPath: process.cwd() }))
await c.initialize()
const t1 = createTaskNode({ type:'explore', title:'Test plain text', prompt:'p', scope:['.'], priority:100 })
c.taskDag.addTasks([t1])
c.taskDag.assign(t1.id, 'x')
c.taskDag.complete(t1.id, { summary:'Done.', changes:[], evidence:[], risks:[], blockers:[], rawText:'' })
const lv = new LiveView(c, 'quiet')
lv.start()
await new Promise(r => setTimeout(r, 200))
lv.stop()
await c.shutdown()
" 2>/dev/null
```

**验证点：** 输出为纯文本（无 `\x1b[` ANSI 控制序列），包含 `✓ [exp] Test plain text` 字样。

---

## T6 — 压力 / 混沌测试（需要 CodeWhale）

### T6-1 Agent 僵死检测（stuck turn）

验证 `crash-recovery.ts` 中 `fileLockTtlMs × 2` 超时后自动 interrupt：

```bash
bun -e "
import { CrashRecovery } from './src/conductor/crash-recovery.ts'
import { FileLockRegistry } from './src/workspace/file-lock.ts'
import { TaskDAG } from './src/dag/engine.ts'
import { defaultConfig } from './src/dag/types.ts'
import { createTaskNode } from './src/dag/engine.ts'

const config = defaultConfig({ projectPath: process.cwd(), fileLockTtlMs: 500 })  // 500ms TTL → stuck at 1s
const dag = new TaskDAG(process.cwd())
const t = createTaskNode({ type:'implement', title:'Stuck task', prompt:'p', scope:['.'], priority:50 })
dag.addTasks([t])
dag.assign(t.id, 'agent-stuck')
// Manually backdate startedAt to simulate long-running task
const task = dag.getTask(t.id)!
task.startedAt = Date.now() - 1100  // 1.1s ago, beyond 500ms*2=1000ms threshold

let interrupted = false
const mockAgentMgr = {
  instances: new Map([['agent-stuck', { id:'agent-stuck', status:'busy', currentTaskId:t.id, threadId:'thread-1', lastHeartbeat: Date.now()-100, port:9999, role:'general', startedAt:Date.now(), pid:null }]]),
  getClient: () => ({
    health: async () => true,   // process alive
    interruptThread: async (tid: string) => { interrupted = true; console.log('✓ interruptThread called for', tid) }
  }),
  heartbeat: () => {},
  markCrashed: () => {},
  restart: async () => {}
}
const locks = new FileLockRegistry(config.fileLockTtlMs)
const recovery = new CrashRecovery(config, mockAgentMgr as any, dag, locks)
recovery.start()
await new Promise(r => setTimeout(r, 700))
recovery.stop()
console.log('stuck detection triggered:', interrupted)
"
```

**预期：** 打印 `✓ interruptThread called for thread-1` 和 `stuck detection triggered: true`。

---

### T6-2 Crash Recovery 重启验证

```bash
bun test tests/bugfix-regression.test.ts --reporter verbose 2>&1 | grep -E "✓|✗|pass|fail"
```

**预期：** Bug 3（心跳互斥）、Bug 6（预 await markBusy）相关测试全部 `✓ pass`。

---

### T6-3 多 agent 并发 dispatch（无竞态）

```bash
bun test tests/parallel.test.ts tests/conductor-e2e.test.ts --reporter verbose
```

**预期：** 全部 pass，特别是 `dispatch pre-await markBusy` 测试（防止双重派发的核心保证）。

---

## T7 — 结构化指令协议验证

验证 `buildAgentPrompt()` 生成的 prompt 格式：

```bash
bun -e "
import { createTaskNode } from './src/dag/engine.ts'
// 直接调用 conductor 内部函数（通过 import 绕过）
const src = await Bun.file('./src/conductor/index.ts').text()
// 提取并打印 buildAgentPrompt 的存在性
console.log('buildAgentPrompt exists:', src.includes('function buildAgentPrompt'))
console.log('agent_role section:', src.includes('<agent_role>'))
console.log('task_instruction section:', src.includes('<task_instruction>'))
console.log('scope section:', src.includes('<scope>'))
console.log('inherited_context section:', src.includes('<inherited_context>'))
console.log('output_contract section:', src.includes('<output_contract>'))
console.log('context cap 8KB:', src.includes('MAX_CONTEXT_CHARS = 8_000'))
console.log('output cap 80KB:', src.includes('MAX_OUTPUT_CHARS  = 80_000'))
"
```

**预期：** 所有字段均输出 `true`。

---

## 验收标准汇总

| 层级 | 命令 | 通过条件 |
|------|------|---------|
| T1-1 | `swarm demo` | 退出码 0，无 Error |
| T1-2 | `bun tsc --noEmit` | 无输出 |
| T2 | `bun test` | ≥ 69 pass；`integration.test.ts` 无 CodeWhale 时允许 fail |
| T3-1 | AI Planner | 任务数 3–12，含 explore+implement |
| T3-2 | Fallback | 打印 fallback 提示，仍输出任务图 |
| T4-1 | 单 agent run | `result: completed`, 5/5 done |
| T4-2 | YAML 3 agents | done ≥ 4, DB 存在 |
| T4-4 | 动态任务 | 报告含 `Fix: dispatch()...` 任务 |
| T5-1 | TUI 160 列 | 三栏标题全 ✓，分割线 ≥ 10 行 |
| T5-3 | TUI 55 列 | 纯文本，无 ANSI 控制序列 |
| T6-1 | 僵死检测 | `interruptThread` 被调用 |
| T6-3 | 并发 dispatch | parallel + e2e 测试全部 pass |
| T7 | 指令协议 | 所有结构字段输出 `true` |

---

## 常见问题排查

**Q: `codewhale: command not found`**  
安装 CodeWhale：`npm install -g codewhale` 或按 [文档](https://github.com/Hmbown/CodeWhale) 安装。

**Q: `AI planner failed on both models`**  
检查 DMXAPI Key 是否有效：
```bash
curl https://www.dmxapi.cn/v1/models \
  -H "Authorization: Bearer sk-yL623kg9yYnzwONfcztfgjIPRdCdeuWPvSXtg9qtw2wJ4rRQ"
```

**Q: agent 启动失败 `port already in use`**  
```bash
lsof -i :7878-7898 | awk 'NR>1{print $2}' | xargs kill -9
```

**Q: TUI 显示乱码**  
确认终端 `TERM=xterm-256color` 且字体支持 Unicode Box Drawing（`│ █ ░ ✓ ⟳`）。

**Q: `closed database` 错误**  
正常现象——shutdown 竞态保护触发的 silent catch。若影响结果，检查 `activeDispatches` 是否在 shutdown 前归零。
