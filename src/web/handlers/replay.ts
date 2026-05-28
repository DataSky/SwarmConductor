import { Database } from "bun:sqlite"
import { join } from "path"
import type { GoalStore } from "../goal-store"

// ─── Replay handler ───────────────────────────────────────────────────────────
// Reads a completed run's conductor.db and returns a snapshot suitable for
// the frontend replay view.

export function handleReplay(
  runId: string,
  goalStore: GoalStore,
  json: (data: unknown) => Response,
): Response {
  const meta = goalStore.getRunMeta(runId)
  if (!meta) return new Response("Run not found", { status: 404 })
  if (!meta.conductorDir) return new Response("No conductor data for this run", { status: 404 })

  const dbPath = join(meta.conductorDir, "conductor.db")
  try {
    const db = new Database(dbPath, { readonly: true })

    const tasks = (db.prepare(`SELECT * FROM tasks WHERE run_id=?`).all(runId) as Record<string, unknown>[])
      .map((r) => ({
        id: r["id"], type: r["type"], title: r["title"], status: r["status"],
        priority: r["priority"], role: r["role"],
        scope:     JSON.parse(r["scope"]     as string),
        dependsOn: JSON.parse(r["depends_on"] as string),
        output:    r["output"]     ? JSON.parse(r["output"]     as string) : null,
        error:     r["error"]      ?? null,
        createdAt:   r["created_at"]   ?? null,
        startedAt:   r["started_at"]   ?? null,
        completedAt: r["completed_at"] ?? null,
        tokenUsage:  r["token_usage"]  ? JSON.parse(r["token_usage"] as string) : null,
      }))

    const events = (db.prepare(
      `SELECT kind, payload, timestamp FROM event_log WHERE run_id=? ORDER BY id DESC LIMIT 300`
    ).all(runId) as Record<string, unknown>[]).reverse()

    const log = events.map((e) => {
      const p  = JSON.parse(e["payload"] as string) as Record<string, unknown>
      const ts = new Date(e["timestamp"] as number).toLocaleTimeString("en-GB", { hour12: false })
      const title = p["title"] as string ?? ""
      return `${ts}  [${e["kind"]}]${title ? " " + title : ""}`
    })

    let inputTokens = 0, outputTokens = 0, cacheHitTokens = 0, cacheMissTokens = 0
    for (const t of tasks) {
      if (t.tokenUsage) {
        inputTokens     += (t.tokenUsage as Record<string, number>)["inputTokens"]     ?? 0
        outputTokens    += (t.tokenUsage as Record<string, number>)["outputTokens"]    ?? 0
        cacheHitTokens  += (t.tokenUsage as Record<string, number>)["cacheHitTokens"]  ?? 0
        cacheMissTokens += (t.tokenUsage as Record<string, number>)["cacheMissTokens"] ?? 0
      }
    }
    const totalTokens  = inputTokens + outputTokens
    const cacheHitRate = inputTokens > 0 ? Math.round(cacheHitTokens / inputTokens * 100) : 0

    db.close()

    return json({
      runId,
      goalText:   meta.goalText ?? "",
      status:     meta.status,
      createdAt:  meta.createdAt,
      finishedAt: meta.finishedAt,
      agents:     meta.agents,
      tasks,
      log,
      tokenStats: { inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, totalTokens, cacheHitRate },
      costUsd:    meta.costUsd,
    })
  } catch (err) {
    return new Response(`Failed to read run data: ${(err as Error).message}`, { status: 500 })
  }
}
