# 常见问题与排错

## 启动问题

### `codewhale: command not found`

CodeWhale 未安装或不在 PATH 中：

```bash
# 确认安装
npm install -g codewhale
# 确认路径
which codewhale

# 或指定完整路径
bun run dev run --bin /path/to/codewhale
```

### Agent 启动超时（`did not become ready within 30000ms`）

原因通常是端口被占用或 CodeWhale 启动慢：

```bash
# 检查端口占用
lsof -i :7878

# 换一个基础端口
bun run dev run --project . # CLI 默认 7878
# 或编程式
const config = defaultConfig({ projectPath: ".", basePort: 8878 })
```

### `Failed to deserialize: missing field 'prompt'`

CodeWhale API 要求 turn body 的字段名是 `prompt`，不是 `message`。如果你直接调用 HTTP API，注意这个字段名。Swarm Conductor 的 `client.ts` 已正确处理。

---

## 调度问题

### 任务一直 blocked，不变成 ready

1. 检查依赖 ID 是否正确：
   ```typescript
   const task = conductor.taskDag.getTask(blockedTaskId)
   console.log(task?.dependsOn)  // 这些 ID 是否都存在于 DAG 中？
   ```

2. 检查依赖任务是否真正完成（status = "done"）：
   ```typescript
   for (const depId of task.dependsOn) {
     const dep = conductor.taskDag.getTask(depId)
     console.log(dep?.title, dep?.status)
   }
   ```

3. 如果用 `addTask`（单个）添加有依赖的任务，依赖必须先加入 DAG：
   ```typescript
   conductor.taskDag.addTask(upstreamTask)   // 先加上游
   conductor.taskDag.addTask(downstreamTask)  // 再加下游
   // ✗ 反过来会报错：depends on unknown task
   ```

### 调度器不分配任务（idle agents + ready tasks，但不跑）

可能原因：

1. **审批门挂起**：检查 `conductor.approvalGate.hasPending()`
2. **scope 冲突**：所有 ready 任务的 scope 与 running 任务冲突，调度器跳过
3. **没有匹配 role 的 agent**：实际上 Conductor 会 fallback 到 `general`，不会卡死

排查：
```typescript
const s = conductor.status()
console.log(s)
// 如果 pendingApprovals > 0，手动 resolve：
const req = conductor.approvalGate.pendingRequests()[0]
conductor.approvalGate.resolve(req.id, "approved")
```

### `Deadlock detected, interrupting task xxx`

正常行为——多个 running 任务互相等待时，Conductor 自动打断最低优先级的任务，该任务重新进入 `interrupted` 状态。

如果频繁出现死锁，检查任务依赖图是否有环：
```typescript
const cycle = conductor.taskDag.detectDeadlock()
console.log("Cycle:", cycle.map(id => conductor.taskDag.getTask(id)?.title))
```

---

## 输出解析问题

### 任务 done 但 output.summary 为空

agent 没有按照 5-section 格式输出。检查 prompt 是否包含明确格式要求：

```typescript
// ✓ prompt 末尾加这句
"Your output MUST contain these 5 sections: ## SUMMARY, ## CHANGES, ## EVIDENCE, ## RISKS, ## BLOCKERS"
```

Conductor 的 `dispatch()` 会自动在 prompt 末尾追加这条指令。如果你直接使用 `CodeWhaleClient`，需要手动加。

### 动态任务没有被插入

检查 `config.dynamicTasks` 是否为 `true`（默认是）。

查看 `output.blockers` 和 `output.risks` 是否有内容：
```typescript
conductor.onEvent(e => {
  if (e.kind === "task.dynamic_inserted") {
    console.log("Dynamic task:", e.payload.title)
  }
})
```

---

## 性能问题

### 任务耗时很长（> 5 分钟）

这是正常的——DeepSeek 的 API 响应时间取决于 prompt 长度和服务器负载。  
自分析 benchmark 显示平均每个 explore 任务耗时 197s。

优化建议：
- 减少 prompt 中包含的源码长度（按需截取，不要全文）
- 使用 `deepseek-v4-flash` 替代 `pro`（在 CodeWhale 配置中设置）
- 降低 `maxConcurrentAgents` 减少 API 并发压力

### `waitForCompletion` 返回 timeout

默认超时是 1 小时（`3_600_000ms`）。对于大型项目的多 phase 流程，可以增加：

```typescript
const result = await conductor.waitForCompletion(7_200_000)  // 2小时
```

---

## 数据库问题

### `SQLITE_BUSY: database is locked`

已内置 `PRAGMA busy_timeout=5000`（等待最多 5 秒）。如果仍然出现，说明有进程没有正确调用 `store.close()`：

```typescript
// 确保 shutdown 被调用
process.on("SIGINT", async () => {
  await conductor.shutdown()  // 内部调用 store.close()
  process.exit(0)
})
```

### 如何重置数据库

```bash
rm -rf .conductor/conductor.db
# 下次启动时会自动重建
```

---

## 兼容性

### CodeWhale 版本

已测试版本：`v0.8.41`。  
Runtime API（`/v1/threads`、`/v1/turns`、SSE events）在 `v0.8.x` 系列稳定。

如果升级后遇到 API 不兼容，检查 `src/runtime/client.ts` 中的端点和 body 格式。

### Bun 版本

已测试：`v1.3.5`。需要 `bun:sqlite` 内置模块（Bun 1.0 起可用）。

不支持 Node.js 运行（用了 `bun:sqlite`、`Bun.file()`、`Bun.Glob`）。
