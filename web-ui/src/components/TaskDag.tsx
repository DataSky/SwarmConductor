import { useState } from "react"
import { useRunStore } from "../store/run"
import { useServeStore } from "../store/serve"
import {
  STATUS_ICON, STATUS_COLOR, TYPE_SHORT, fmtElapsed,
} from "../utils"
import styles from "./TaskDag.module.css"

function computeTaskDepth(
  taskMap: Record<string, { dependsOn: string[] }>,
  id: string,
  cache: Record<string, number> = {},
): number {
  if (cache[id] !== undefined) return cache[id]!
  const t = taskMap[id]
  if (!t || t.dependsOn.length === 0) { cache[id] = 0; return 0 }
  const depths = t.dependsOn.map((pid) => computeTaskDepth(taskMap, pid, cache))
  cache[id] = Math.max(...depths) + 1
  return cache[id]!
}

export function TaskDag() {
  const tasks          = useRunStore((s) => s.tasks)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const activeTabId    = useServeStore((s) => s.activeTabId)

  const sorted = [...tasks].sort((a, b) => a.createdAt - b.createdAt)
  const taskMap: Record<string, { dependsOn: string[] }> = {}
  sorted.forEach((t) => { taskMap[t.id] = t })
  const depthCache: Record<string, number> = {}
  sorted.forEach((t) => computeTaskDepth(taskMap, t.id, depthCache))

  const maxWave = sorted.reduce((m, t) => Math.max(m, depthCache[t.id] ?? 0), 0)
  const waves: typeof sorted[] = []
  for (let w = 0; w <= maxWave; w++) {
    waves.push(sorted.filter((t) => (depthCache[t.id] ?? 0) === w))
  }

  const done = sorted.filter((t) => t.status === "done").length

  function selectTask(id: string) {
    setSelectedId((prev) => (prev === id ? null : id))
  }

  function openInject() {
    // Handled by InjectModal via global state
    document.dispatchEvent(new CustomEvent("swarm:open-inject"))
  }

  return (
    <div className="pane" id="dag-pane">
      <div className="pane-header">
        Tasks
        <span style={{ color: "var(--dim)", fontWeight: "normal", fontSize: 11 }}>
          {done}/{sorted.length}
        </span>
      </div>
      <div className="pane-body">
        {waves.map((waveTasks, waveIdx) => waveTasks.length === 0 ? null : (
          <div key={waveIdx} className={styles.phaseGroup}>
            <div className={styles.phaseLabel}>Phase {waveIdx}</div>
            {waveTasks.map((task) => {
              const isDynamic = /^(Fix:|Review risk:|Verify:)/.test(task.title)
              return (
                <div
                  key={task.id}
                  className={`${styles.taskRow} ${styles[task.status] ?? ""} ${selectedId === task.id ? styles.selected : ""}`}
                  style={waveIdx > 0 ? { paddingLeft: 12 + waveIdx * 10 } : undefined}
                  onClick={() => selectTask(task.id)}
                >
                  {isDynamic && <span className={styles.dynamic}>⊕</span>}
                  <span
                    className={styles.icon}
                    style={{ color: STATUS_COLOR[task.status] ?? "var(--dim)" }}
                  >
                    {STATUS_ICON[task.status] ?? "·"}
                  </span>
                  <span className={styles.typeTag}>
                    {TYPE_SHORT[task.type] ?? task.type.slice(0, 3)}
                  </span>
                  <span className={styles.title}>{task.title}</span>
                  {task.status === "running" && task.startedAt && (
                    <span className={styles.elapsed}>
                      {fmtElapsed(Date.now() - task.startedAt)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {activeTabId && (
        <div className={styles.addTaskBtn} onClick={openInject}>+ Add Task</div>
      )}

      {selectedId && <TaskDetail taskId={selectedId} tasks={sorted} onClose={() => setSelectedId(null)} />}
    </div>
  )
}

function TaskDetail({
  taskId, tasks, onClose,
}: {
  taskId: string
  tasks: ReturnType<typeof useRunStore.getState>["tasks"]
  onClose: () => void
}) {
  const task = tasks.find((t) => t.id === taskId)
  if (!task) return null

  const depTitles  = task.dependsOn.map((did) => tasks.find((t) => t.id === did)?.title ?? did.slice(0, 12) + "…")
  const blocksList = tasks.filter((t) => t.dependsOn.includes(taskId)).map((t) => t.title)
  const out = task.output

  return (
    <div className={styles.detail}>
      <button className={`btn ${styles.detailClose}`} onClick={onClose}>✕</button>
      <div className={styles.detailMeta}>
        <span>Type: <strong>{task.type}</strong></span>
        <span>Status: <strong style={{ color: STATUS_COLOR[task.status] }}>{task.status}</strong></span>
        {task.startedAt && task.completedAt && (
          <span>Duration: <strong>{fmtElapsed(task.completedAt - task.startedAt)}</strong></span>
        )}
        {task.tokenUsage && (
          <span>Tokens: <strong>in:{task.tokenUsage.inputTokens.toLocaleString()} out:{task.tokenUsage.outputTokens.toLocaleString()}</strong></span>
        )}
      </div>
      {depTitles.length  > 0 && <div className={styles.detailDeps}>↑ {depTitles.join(" → ")}</div>}
      {blocksList.length > 0 && <div className={styles.detailDeps}>↓ {blocksList.join(", ")}</div>}
      {out ? (
        <div className={styles.detailSections}>
          <div className={styles.detailSection}><h4>Summary</h4><pre>{out.summary || "none"}</pre></div>
          <div className={styles.detailSection}><h4>Changes</h4><pre>{out.changes.map((c) => `- ${c.file}: ${c.description}`).join("\n") || "none"}</pre></div>
          <div className={styles.detailSection}><h4>Risks</h4><pre>{out.risks.join("\n") || "none"}</pre></div>
          <div className={styles.detailSection}><h4>Blockers</h4><pre>{out.blockers.join("\n") || "none"}</pre></div>
          <div className={styles.detailSection}><h4>Evidence</h4><pre>{out.evidence.join("\n") || "none"}</pre></div>
        </div>
      ) : (
        <div style={{ color: "var(--dim)", fontSize: 12 }}>No output yet</div>
      )}
      {task.error && <div className={styles.detailError}>Error: {task.error}</div>}
    </div>
  )
}
