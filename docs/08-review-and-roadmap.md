# Swarm Conductor — 全面 Review 与演进规划

> 面向执行者(Sonnet 4.6)的自包含文档。基线 commit `b993c98`,2026-06-07。
> 不依赖任何对话上下文。所有坐标精确到 `file:line`(行号以基线为准,改动后会漂移,用符号名复核)。
>
> **阅读顺序**:第 1 章理解项目 → 第 2 章看清现状与缺口 → 第 3 章按里程碑执行 → 第 4 章遵守工作纪律。

---

## 0. 给执行者的元说明(先读这条)

- **项目能跑**:265 个离线测试通过(24 文件),typecheck 干净。四种执行形态真机验证过(代码编辑、并行扇出、混合 LLM+worker、DuckDB SQL)。
- **本文档的目标**:在不破坏现有能力的前提下,为「优化迭代 / 测试 / 基于 Trace 的自我校验 / 自动进化」铺设地基。
- **核心纪律**(违反会埋雷,后面第 4 章详述):
  1. 每个改动后跑离线测试套件 + `bun run typecheck:backend`,全绿才进下一步。
  2. 给 SQLite `tasks`/`artifacts` 表加列,**必须同时改 CREATE TABLE 和 ALTER 迁移**(历史上漏 ALTER 导致复用旧库时静默失败——见 2.3)。
  3. 不要扩大改动范围。一个里程碑只做一件事,跑通再下一步。
  4. 真机 e2e(需 codewhale + DMXAPI key)会烧钱/起进程,跑完务必 `pkill -9 -f codewhale`。优先用纯 worker 的离线压测。
- **运行测试的正确命令**(`bun test tests/` 会跑到需要 codewhale 的在线测试而卡住,**不要用**):
  见第 4.1 节的离线测试白名单。

---

## 1. 项目是什么(自包含背景)

### 1.1 定位

Swarm Conductor 是一个 **单机、通用数据流编排器**:把一个大任务拆成声明式 DAG,由不同的「执行器」并行跑。它从最初的「代码编辑编排器」重定向而来,现在两种形态都支持:

- **代码编辑形态**:LLM agent(spawned `codewhale serve` 进程)跑 explore/plan/implement/review/verify。
- **数据流形态**(当前重心):确定性 worker 跑 SQL/校验/对比(零 token),LLM 只做判读。

目标规模:**≤100 任务、单机**。不追求分布式。

### 1.2 核心抽象(必须先理解这五个)

| 抽象 | 文件 | 职责 |
|---|---|---|
| **TaskDAG** | `src/dag/engine.ts` | 任务依赖图 + 状态机(pending→ready→running→done/failed)。运行时可加任务(addTasks 自动接边)。 |
| **Conductor** | `src/conductor/index.ts` | 调度核心:tick 循环取 ready 任务 → selectExecutor 路由 → reserve slot → dispatch → 解析结果 → 写 artifact → 触发动态任务/审批。 |
| **Executor** | `src/executor/types.ts` | 执行器接口。`actsDirectly` 标记区分 LLM 路径(prompt 构建+解析)和 worker 路径(直接执行)。`LLMExecutor`(默认)、`WorkerExecutor`(SQL/validate/compare)。 |
| **Artifact** | `src/memory/store.ts` | 类型化全保真产物(SQLite)。`inputFromDeps` 让下游拿到上游完整结果;`sourceArtifactIds` 记血缘。 |
| **WorkerRunner** | `src/executor/worker-executor.ts` | `(task, inputs: Artifact[]) => string`。确定性工作的载体。SqlWorker / validate / compare 都是它的实例。 |

### 1.3 一个数据流任务的生命周期(读懂这条 = 读懂系统)

1. 调用方(HTTP `/api/dataflow/run` 或脚本)构造 TaskNode[],`addTasks` 进 DAG。
2. `tick()`(`conductor/index.ts` 约 280-330):取 ready 任务,`selectExecutor(task)` 按 `task.executorKind` 路由到对应执行器,`reserve()` 同步占 slot,`dispatch()` 异步执行。
3. `dispatch()`(约 340-440):
   - `resolveInputArtifacts(task)` 解析上游产物(inputFromDeps/inputArtifactIds)→ 既内联进 LLM prompt,也作为 inputs 传给 worker。
   - `isWorker = executor.actsDirectly === true`:worker 走 `task.prompt`+原样存产物;LLM 走 buildAgentPrompt+parseTaskOutput 五段式。
   - `handle.execute()` 跑;`persistCompletion()` 写 artifact(含 sourceArtifactIds 血缘)+ memory + event。
   - `insertDynamicTasks()`:数据流任务(`dataflow=true`)跳过启发式;非数据流走 SPAWN 指令解析 / blocker→implement 等启发式。
   - `handleHighRiskGate()`:autoApprove 自动放行,否则人工审批。
4. 完成 → `dag.complete()` → 解锁下游 → 下一轮 tick。

### 1.4 入口清单(执行者可调用)

| 入口 | 命令 | 用途 |
|---|---|---|
| 离线测试 | `bun test tests/<file>.test.ts` | 验证逻辑,无依赖 |
| HTTP 服务 | `bun run src/cli/index.ts serve --port 9000` | 数据流 API,token 自动生成并打印 |
| 数据流压测 | `bun run scripts/dataflow-load.ts [N]` | 纯 worker 离线压测(无需 codewhale) |
| SQL e2e | `bun run scripts/sql-e2e.ts` | 真机 SQL+LLM(需 codewhale+key) |
| 自助 demo | `bash scripts/dataflow-api-demo.sh` | 一键端到端(含认证演示) |


---

## 2. 现状评估(诚实的家底盘点)

每条标注 **✅ 已有** / **⚠️ 部分** / **❌ 缺口**,带 file 坐标。这是规划的依据。

### 2.1 事件系统 — Trace 的原始素材

- ✅ `ConductorEventKind` 有 **15 种事件**(`src/dag/types.ts`,task.status_changed / agent.crashed / lock.* / deadlock.detected / approval.* / run.* 等),每个 `ConductorEvent` 带 `timestamp`。
- ✅ `emit()`(`conductor/index.ts`)实时广播给 `eventListeners`;WebDashboard 订阅推前端。
- ❌ **致命缺口**:15 种事件**只有 3 种**(`task.completed`/`task.failed`/`sse.malformed`)经 `logEvent()` 落库到 `event_log` 表。其余 12 种**只在内存广播,run 结束即丢**。
- ❌ 事件 payload 是 `Record<string, unknown>`,**无强类型契约**。
- ❌ 无因果链(事件 A 触发事件 B 的关系没记录)。

> **这是「基于 Trace 的自我校验」最大的地基缺口**:你无法事后完整回放一个 run 发生了什么。M1 解决。

### 2.2 持久化与统计

- ✅ SQLite 五表:`runs` / `tasks` / `memory` / `event_log` / `artifacts` + `agent_restarts`(`src/memory/store.ts`)。WAL 模式。
- ✅ `tokenStats()`:聚合 input/output/cache token + 命中率。`taskStats()`:total/done/failed/interrupted/avgDurationMs。
- ✅ `artifacts` 表有 `source_artifact_ids`(血缘)列。
- ⚠️ 统计够做宏观复盘(成功率、token、耗时),**不够做事件级 trace**(谁在何时触发 deadlock、agent 何时 crash 全查不到)。

### 2.3 错误处理与可诊断性

- ⚠️ 全项目 **54 处 `catch {`**(静默吞)。多数是合理的「DB 关闭期容错」,但混杂了真错误被吞的风险。
- ✅ 关键路径有 `console.error`:dispatch 失败、writeArtifact 失败、agent 重启失败。
- ✅ worker/SQL 失败返回结构化 `{error}` 而非抛异常,单任务失败被隔离(不污染整个 run)。
- ❌ console.error 输出**不收集**(run 结束就丢,只有 live view 临时可见)。
- ❌ 无「运行时间线」:谁、何时、干了啥、失败原因、重试几次——无单一可查处。

> **历史教训(必读)**:`artifacts` 表加 `source_artifact_ids` 列时,只改了 CREATE TABLE 漏了 ALTER 迁移,导致复用旧 DB 时 `writeArtifact` 抛错,又被 `persistCompletion` 的 `catch` 静默吞掉,e2e「假成功」。**加列必须 CREATE+ALTER 双写;catch 只吞 `closed database`,其他 console.error。**

### 2.4 Artifact 血缘

- ✅ `sourceArtifactIds` 在 `persistCompletion`(`conductor/index.ts`)写入,`resolveInputArtifacts` 计算来源。
- ⚠️ 可反查上游,但**需手工递归**(无现成 helper 遍历完整血缘树)。
- ❌ 无反向索引(「谁依赖我」做影响分析)。
- ❌ 血缘字段可选(undefined),无完整性校验。无可视化。

### 2.5 配置与魔法数字

- ✅ `ConductorConfig`(`src/dag/types.ts`)有 14 个旋钮:maxConcurrentAgents(10)、fileLockTtlMs(300k)、heartbeat*、minStartIntervalMs(0)、maxStartsPerMinute(0)、modelMap 等,`defaultConfig` 给默认值。
- ❌ **散落的魔法数字未进 config**:`conductor/index.ts` 的 `MAX_CONTEXT_ENTRIES=5`/`MAX_ENTRY_CHARS=1600`/`MAX_OUTPUT_CHARS=80_000`;SQLite `busy_timeout=5000`;replay 的 `LIMIT 300`;sql-worker 的 `maxRows=10_000`。运行时无法调。

### 2.6 测试覆盖

- ✅ **离线单元/集成**(24 文件,265 测试):dag / store / artifact-store / validate-compare / rate-limiter / warm-pool / fan-out / executor-routing / scheduler-scale / sql-worker / dataflow-handler / terminate 等。
- ⚠️ **需真实 codewhale**(不在离线集):`integration.test.ts` / `conductor-e2e.test.ts` / `parallel.test.ts`。
- ❌ **盲区**:无 trace/事件持久化测试;无长跑稳定性测试(内存泄漏/deadlock);无血缘完整性测试;CrashRecovery 无专项测试;e2e 只覆盖成功路径无故障注入。

### 2.7 接口现状

- ✅ HTTP:`/api/goals` `/api/runs` `/api/server/state` `/api/runs/{id}/replay` `/api/dataflow/run`(token 认证,localhost 绑定)。WebSocket `/ws` 实时推事件。
- ❌ replay 硬限最近 **300 条事件**(`handlers/replay.ts`),无分页/游标/按 kind 筛选。无法拉完整历史事件流。

### 2.8 已验证的性能基线(压测实测,2026-06-07)

| 负载 | 结果 | 吞吐 | RSS 峰值 |
|---|---|---|---|
| 120 任务(60 SQL@5万行 + 60 校验) | 全 done,0 失败,0 token | 2000+/秒 | 137MB |
| 1000 任务(10× 目标) | 全 done,0 失败,0 token | 352/秒 | 311MB |

吞吐降速 = 真实 SQL 查询工作量(非调度开销);内存 = DAG 保留任务输出(run 结束释放,非泄漏)。**含 LLM 任务的大规模长跑稳定性未验证**(token 预算 / provider 限流 / agent 进程长跑泄漏)。


---

## 3. 演进路线图(按依赖顺序的里程碑)

每个里程碑:**目标 → 为什么 → 改哪里 → 怎么验证 → 完成标准**。严格按顺序——后面的依赖前面的。

> 核心原则:**先把 Trace 地基打牢(M1),自我校验和自动进化才有立足点**。没有完整可回放的执行记录,「自我校验」就是空中楼阁。

### M1 — 全量事件持久化 + Trace 基础(最高优先级,一切的地基)

**目标**:让一个 run 的**完整执行过程**可事后回放。

**为什么**:当前 15 种事件只有 3 种落库(见 2.1)。「基于 Trace 的自我校验」要求能回答「这个 run 到底发生了什么、为什么失败」——没有完整事件流就无从谈起。

**改哪里**:
1. `conductor/index.ts` 的 `emit()`:每次广播的同时,把 `ConductorEvent` 写入 `event_log`(复用现有表,kind 已是字符串,payload 已是 JSON)。注意:`emit` 是高频路径,DB 写要容错(closed database 静默,其他 console.error)。
2. `src/memory/store.ts`:加 `logConductorEvent(event)` 方法(区别于现有低级 `logEvent`),或扩展 `logEvent` 接受完整事件。给 `event_log` 加 `seq INTEGER`(自增已有 id 可复用)保证顺序。
3. 加 `getRunTrace(runId)`:按时间顺序返回该 run 的全部事件(替代 replay 的 300 条硬限,支持游标分页)。
4. **可选但推荐**:事件 payload 加 `causedBy?: eventSeq` 字段,记录因果(approval.required 由哪个 task.completed 触发)。

**怎么验证**:新增 `tests/event-trace.test.ts`(离线):构造一个小 run(用 FakeExecutor,参考 `tests/dataflow-fanout.test.ts` 的 FakeExecutor 写法),跑完后 `getRunTrace(runId)` 应包含全部状态转换事件,顺序正确,可 JSON 序列化。

**完成标准**:离线测试证明 15 种事件全部可从 DB 回放;现有 265 测试不回归;典型 run 的事件写入开销 < 5%(压测对比)。

---

### M2 — 配置集中化(M3+ 调参的前置)

**目标**:消除散落魔法数字,所有可调参数进 `ConductorConfig`。

**为什么**:M5 的「自动进化」要在运行时调参(改 slot 数、超时、截断阈值看效果),参数必须先可配置。

**改哪里**:
1. `ConductorConfig`(`src/dag/types.ts`)加:`maxContextEntries`(默认 5)、`maxEntryChars`(1600)、`maxOutputChars`(80_000)、`sqliteBusyTimeoutMs`(5000)、`replayEventLimit`(300→可配)、`sqlWorkerMaxRows`(10_000)。
2. `conductor/index.ts` 顶部的 `MAX_*` 常量改读 config。`sql-worker.ts` 的 maxRows、`store.ts` 的 PRAGMA、`replay.ts` 的 LIMIT 同理。
3. `defaultConfig` 补默认值(保持现有行为不变)。

**怎么验证**:`tests/config.test.ts`:defaultConfig 含全部新字段且默认值等于旧硬编码值;传入自定义值能覆盖。现有测试不回归(默认值不变 = 行为不变)。

**完成标准**:`grep -rn "MAX_CONTEXT_ENTRIES\|MAX_OUTPUT_CHARS\|10_000\|busy_timeout" src/` 不再有未走 config 的散落常量。

---

### M3 — Run 复盘与诊断 API(把 Trace 变成可用工具)

**目标**:一个 run 失败/完成后,能一键拿到「发生了什么、为什么、血缘如何」。

**为什么**:M1 把数据存下来了,M3 让它可查、可诊断——这是「自我校验」的查询层。

**改哪里**:
1. `src/memory/store.ts` 加诊断查询:
   - `getRunTrace(runId, {sinceSeq, limit})`:分页事件流(M1 已建基础)。
   - `getArtifactLineage(artifactId)`:递归遍历 sourceArtifactIds,返回完整血缘树(补 2.4 的缺口)。
   - `getRunSummary(runId)`:聚合 taskStats + tokenStats + 失败任务列表 + 关键事件(crash/deadlock/approval)。
2. HTTP 加 `GET /api/runs/{id}/trace`(分页)、`GET /api/runs/{id}/summary`、`GET /api/artifacts/{id}/lineage`(复用 dataflow 的 token 认证)。
3. 新增 `scripts/diagnose-run.ts <runId>`:CLI 复盘工具,打印时间线 + 失败根因 + 血缘。

**怎么验证**:`tests/diagnostics.test.ts`:跑一个含失败任务的 FakeExecutor run,`getRunSummary` 正确报告失败任务和原因;`getArtifactLineage` 对扇出→对比的图返回完整树。

**完成标准**:能用 `scripts/diagnose-run.ts` 对任意历史 run 打印完整可读复盘。


---

### M4 — 基于 Trace 的自我校验(核心能力之一)

**目标**:run 结束后,系统**自动**对自己的执行做一致性检查,发现异常并报告。

**为什么**:这是你要的「自我校验」。建立在 M1(完整 trace)+ M3(查询层)之上。

**改哪里**:新增 `src/conductor/self-check.ts`,定义一组**确定性不变量检查**(零 LLM,先做这层):
- **状态机不变量**:每个 done 任务必有产物;每个 running→done 必有 startedAt<completedAt;无任务停在 running(run 结束时)。
- **数据流不变量**:每个 `inputFromDeps` 任务的 sourceArtifactIds 非空且全部存在;血缘无悬空引用;无环。
- **资源不变量**:无 agent 卡在 busy;无锁未释放;dispatch 次数 == 任务数(无重复派发/丢失)。
- **预算不变量**:实际 token 在预期范围;worker 任务 token == 0。
输出 `SelfCheckReport { passed, violations: [{rule, severity, detail, relatedTaskIds}] }`,写入 event_log(kind=`selfcheck.completed`)。
- **可选 LLM 层**(M4.5,后置):对结构检查通过但「结果可疑」的 run,用一个 LLM judge 任务读 trace summary 做语义校验(「这个分析的结论和数据矛盾吗」)。这才用 token,且可关。

**怎么验证**:`tests/self-check.test.ts`:构造正常 run(全部不变量通过)+ 故意制造违规的 run(如手动删一个 artifact 制造悬空血缘),验证 self-check 准确报告。

**完成标准**:self-check 能对真实 run 自动跑出报告;违规检出无漏报(测试覆盖每条不变量)。

---

### M5 — 长跑稳定性验证(把「稳定」从声称变事实)

**目标**:验证含 LLM 任务的多 run 长跑不泄漏、不累积、不退化。

**为什么**:压测只压过纯 worker(见 2.8)。含 LLM 的长跑稳定性(agent 进程泄漏、token 累积、内存增长)是「生产可用」最后一个没点亮的角。

**改哪里**(主要是新增测试/脚本,不改核心):
1. `scripts/stability-soak.ts`:连续跑 N 个独立 run(每个含 1-2 个真实 LLM 任务 + 几个 worker),每个 run 后采样:agent 进程数、RSS、SQLite 文件大小、token 累计。断言:进程数 run 后归零(无泄漏)、RSS 不单调增长。
2. 若发现泄漏:重点查 `agent-manager.ts` 的 `stopAll`/`terminate`、`warm-pool.ts` 的进程清理、`store.ts` 的连接关闭。
3. **纯 worker 长跑**(离线,可进 CI):`scripts/dataflow-load.ts` 扩展为循环 M 次,验证内存回归基线。

**怎么验证**:soak 脚本跑 10+ run,报告进程/内存曲线。纯 worker 循环版可做成离线测试。

**完成标准**:10 run 连续跑,结束时 codewhale 进程数为 0,RSS 回到基线 ±合理范围;有一份可复现的稳定性报告。

---

### M6 — 自动进化(最高阶,谨慎,建立在 M1-M5 之上)

**目标**:系统能基于历史 trace **自动改进自己的编排决策**。

**为什么**:这是你愿景的终点。但它**风险最高、最易跑偏**——必须建在可靠的 trace(M1)+ 自我校验(M4)+ 稳定性(M5)之上,否则是在流沙上盖楼。

**分层推进(每层可独立交付,后层依赖前层)**:

- **M6.1 参数自调(确定性,最安全先做)**:基于历史 run 的 trace 统计,自动建议/调整 config 参数。例:多次观察到 SQL worker 8 slot 时排队 → 建议提到 12;observe 到 LLM 撞限流 → 自动调高 `minStartIntervalMs`。**纯规则,不用 LLM,可回滚**。产出「调参建议报告」,人工确认后应用(先不自动应用)。

- **M6.2 任务图自优化(中等风险)**:基于 trace 发现低效模式。例:某 SQL 总是失败 → 标记;某两个任务总是顺序跑但无依赖 → 建议并行;某 validate 从不失败 → 建议降频。产出「图优化建议」。

- **M6.3 LLM 驱动的反思进化(最高风险,最后做)**:让一个 LLM 读 run 的 trace summary + self-check 报告,提出改进(改 prompt、调任务拆分、加校验规则)。**必须**:① 改进先写成「提案」不直接生效;② 提案要能在沙盒 run 上 A/B 验证(新旧对比);③ 人工或自动校验(M4)守门;④ 全程可回滚、可审计(每次进化记入 event_log)。

**关键护栏(M6 不可违反)**:
- 任何自动改动**必须可回滚**(记录改动前状态)。
- 进化的「效果」必须用 M4 的 self-check + 客观指标(成功率/token/耗时)**量化验证**,不能靠「感觉变好了」。
- LLM 提案默认**不自动生效**,需通过验证闸门。
- 每次进化决策**全量记入 trace**(自己也要被自己校验)。

**怎么验证**:M6.1 先做——`tests/auto-tune.test.ts`:喂入造好的历史 trace(模拟排队/限流),验证调参建议正确。M6.3 必须有 A/B 沙盒验证框架才能上。

**完成标准**:M6.1 能基于真实历史 trace 产出可信调参建议;M6.2/M6.3 视前序成熟度再启动,不强求。


---

## 4. 工作纪律与参考(执行者必须遵守)

### 4.1 离线测试白名单(复制即用)

**不要用 `bun test tests/`**——它会跑 `integration.test.ts`/`conductor-e2e.test.ts`/`parallel.test.ts`,这些需要真实 codewhale,会卡住或失败。每次改动后跑这个离线集:

```bash
cd /Users/wangteng06/AiCode/codewhale_debug
bun test tests/dag.test.ts tests/scope-concurrency.test.ts tests/parse-output.test.ts \
  tests/m3-unit.test.ts tests/store.test.ts tests/bugfix-regression.test.ts \
  tests/warm-pool.test.ts tests/project-scanner.test.ts tests/ai-planner-graph.test.ts \
  tests/interaction.test.ts tests/agent-manager-adopt.test.ts tests/terminate.test.ts \
  tests/llm-executor.test.ts tests/artifact-store.test.ts tests/fan-out.test.ts \
  tests/rate-limiter.test.ts tests/git-workspace.test.ts tests/dataflow-fanout.test.ts \
  tests/worker-executor.test.ts tests/executor-routing.test.ts tests/scheduler-scale.test.ts \
  tests/sql-worker.test.ts tests/validate-compare.test.ts tests/dataflow-handler.test.ts
bun run typecheck:backend
```
基线:**265 pass / 0 fail**,typecheck EXIT 0。新增测试文件记得加进这个列表。

### 4.2 改动纪律(血泪教训)

1. **SQLite 加列**:必须同时改 `SCHEMA` 的 CREATE TABLE **和**构造函数里的 `ALTER TABLE ... ADD COLUMN`(try/catch 包,列已存在则忽略)。漏 ALTER → 复用旧库静默失败。已有 5 个 ALTER 迁移参考(`store.ts` 构造函数:input_artifact_ids / input_from_deps / dataflow / executor_kind / failure_policy / source_artifact_ids)。
2. **catch 不要静默吞真错误**:`catch` 里只对 `msg.includes("closed database")` 静默,其余 `console.error`。参考 `persistCompletion` 修复后的写法。
3. **Executor 路由靠 `actsDirectly`,不靠 kind 字符串**:加新 worker 类型时设 `actsDirectly=true`,kind 随意。
4. **真机 e2e 后清进程**:`pkill -9 -f codewhale`。优先用纯 worker 离线压测(`dataflow-load.ts`)。
5. **Write 工具大文件分块**:超 50 行内容分多次 Edit。

### 4.3 关键文件地图(改动定位)

| 要改什么 | 去哪个文件 |
|---|---|
| 调度循环 / dispatch / 路由 | `src/conductor/index.ts`(705行,已拆 resolveInputArtifacts/persistCompletion/handleHighRiskGate) |
| 任务状态机 / failurePolicy | `src/dag/engine.ts` |
| 类型 / config / 事件种类 | `src/dag/types.ts` |
| SQLite schema / 查询 / 统计 | `src/memory/store.ts`(442行) |
| 执行器接口 / 能力标记 | `src/executor/types.ts` |
| LLM 执行器 | `src/executor/llm-executor.ts` |
| Worker 执行器 / runner 签名 | `src/executor/worker-executor.ts` |
| SQL worker / 结果规范化 | `src/worker/sql-worker.ts` |
| validate / compare worker | `src/worker/validate-compare.ts` |
| HTTP 数据流入口 / 认证 | `src/web/standalone.ts` + `src/web/handlers/dataflow-run.ts` |
| 扇出 / SPAWN 解析 | `src/conductor/fan-out.ts` |
| 启发式动态任务 | `src/conductor/dynamic-tasks.ts` |
| 背压限流 | `src/conductor/rate-limiter.ts` |
| 崩溃恢复 | `src/conductor/crash-recovery.ts` |

### 4.4 里程碑依赖图与建议顺序

```
M1 事件持久化(地基) ──┬──> M3 复盘/诊断 API ──> M4 自我校验 ──> M6 自动进化
                       │                              ↑              ↑
M2 配置集中化 ─────────┘──────────────────────────────┘    M5 长跑稳定性
```

**强烈建议顺序**:M1 → M2 → M3 → M4 → M5 →(M6.1 → M6.2 → M6.3)。
M1 是一切的地基,**先做 M1**。M2 可与 M1 并行。M5 可在 M3 后任意时机插入。M6 三个子层严格递进,M6.3 最危险放最后。

### 4.5 反模式警告(别做这些)

- ❌ 不要为了「自动进化」先堆 LLM 反思,**没有 M1 的完整 trace 就没有进化的依据**。
- ❌ 不要让自动进化的改动直接生效不留回滚。
- ❌ 不要引入分布式/Redis/消息队列——目标是单机 ≤100,现有内存+SQLite 足够(压测 1000 任务仍稳)。
- ❌ 不要重写已验证的调度内核——只加新能力,不动 tick/dispatch 的核心逻辑(除非 M1 的事件持久化必须碰 emit)。
- ❌ 不要跳过测试验证就进下一个里程碑。

### 4.6 当前基线快照(供回归对照)

- commit: `b993c98`(+ 本会话未提交改动:executor 抽象/artifact/fanout/worker/dataflow API 等)
- 离线测试:265 pass / 24 文件
- 后端 LOC:~7948(`src/**/*.ts`)
- 依赖:`@duckdb/node-api ^1.5.3-r.3`、`eventsource ^2.0.2`、`zod ^3.24.0`
- 记忆文件:`~/.claude/projects/-Users-wangteng06-AiCode-codewhale-debug/memory/swarm_conductor_redirect.md` 有完整演进史

---

## 5. 一句话总结给执行者

项目已是一个能跑、有测试、四形态验证过的数据流编排器。**你的使命是把它从「能跑」推向「能自我观测、自我校验、自我进化」**。地基是 **M1 全量事件持久化**——没有它,后面全是空谈。按里程碑顺序走,每步测试全绿再前进,守住 4.2 的纪律。不要贪快,不要扩大范围,不要在没有 trace 的情况下谈进化。




