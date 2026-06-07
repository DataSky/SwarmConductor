# 数据流分析 API — 自主使用指南

把 SQL 分析任务交给 Swarm Conductor 编排:确定性步骤(查询/校验/对比)走零成本 worker,
需要判断的步骤走 LLM。本指南讲**你怎么自己启动并提交任务**。

## 快速自验证(一条命令)

```bash
bash scripts/dataflow-api-demo.sh
```

它会:生成合成 DuckDB 数据 → 起本地服务 → 演示认证拒绝 → 提交一个真实
`sql → validate → compare` 分析 → 打印结果 → 自动清理。**不用 codewhale、不烧 token。**

## 手动启动

```bash
# 1. 起服务(必须设 token,否则数据流端点返回 503 禁用)
SWARM_API_TOKEN=你的密钥 bun run src/cli/index.ts serve --port 9000 --project .

# 2. 提交分析(另一个终端)
curl -X POST http://127.0.0.1:9000/api/dataflow/run \
  -H "Authorization: Bearer 你的密钥" \
  -H "Content-Type: application/json" \
  -d @your-analysis.json
```

服务只绑 `127.0.0.1`(本机),且 `/api/dataflow/run` 必须带正确 Bearer token——
因为它执行你给的 SQL、可能花 LLM token。没设 `SWARM_API_TOKEN` 时该端点直接禁用。

## 请求格式

```json
{
  "db": "/绝对路径/data.duckdb",   // sql 任务必填(以 READ_ONLY 打开,无法改数据)
  "agents": 1,                      // 有 llm 任务时启动的 agent 数(默认 1)
  "tasks": [
    { "key": "q1", "kind": "sql", "title": "按区域汇总",
      "sql": "SELECT region, SUM(amount) revenue FROM orders GROUP BY region" },

    { "key": "check", "kind": "validate", "dependsOn": ["q1"],
      "rules": [ {"type":"rowCount","min":1}, {"type":"noNulls","column":"region"} ] },

    { "key": "q2", "kind": "sql", "sql": "SELECT DISTINCT region FROM orders WHERE amount > 500" },
    { "key": "diff", "kind": "compare", "dependsOn": ["q1","q2"], "keyColumn": "region" },

    { "key": "judge", "kind": "llm", "dependsOn": ["q1","diff"],
      "prompt": "根据上游结果,指出收入最高的区域并判断分布是否均匀。" }
  ]
}
```

### 任务类型

| kind | 作用 | 关键字段 | 执行 |
|------|------|---------|------|
| `sql` | 跑 DuckDB 查询 | `sql` | worker,零 token,READ_ONLY |
| `validate` | 对上游结果跑规则 | `rules`, `dependsOn` | worker,零 token |
| `compare` | 两个上游结果交叉对比 | `keyColumn`, `dependsOn`(2个) | worker,零 token |
| `llm` | 让模型判读上游结果 | `prompt`, `dependsOn` | LLM,花 token |

`dependsOn` 用其他任务的 `key`;声明依赖后,上游的**完整结果**会自动喂给下游
(SQL 结果传给 validate/compare,或内联进 LLM 的 prompt)。

### validate 规则

```
{"type":"rowCount","min":1,"max":1000}     行数范围
{"type":"noNulls","column":"region"}       某列不得有 null
{"type":"range","column":"amount","min":0} 数值列范围
{"type":"unique","column":"id"}            某列值唯一
{"type":"noError"}                          上游查询不得报错
```

## 响应

```json
{
  "runId": "run-…",
  "status": "completed",
  "tasks": [ {"key":"q1","kind":"sql","status":"done"}, … ],
  "artifacts": { "q1": "{\"rows\":[…],\"rowCount\":4}", "check": "{\"passed\":true,…}", … },
  "tokens": { "inputTokens": 0, "outputTokens": 0 }
}
```

`artifacts[key]` 是每个任务的**完整结果**(JSON 字符串)。`tokens` 反映花费——
纯 worker 链路应为 0,只有 llm 任务才计费。

## 结果类型说明

DuckDB 的 BigInt / DECIMAL / DATE / TIMESTAMP 已自动规范化为干净 JSON
(数字、`YYYY-MM-DD`、ISO 字符串),可直接 `JSON.parse`,也对 LLM 友好。

## 故障语义

单个任务失败被隔离:坏 SQL 返回结构化 `{error}`(不中断整个 run),下游可见。
若要"任一依赖失败则本任务不跑",在任务上设 `failurePolicy: "all"`(默认 `tolerate`)。
