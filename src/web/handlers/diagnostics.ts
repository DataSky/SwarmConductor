import { Database } from "bun:sqlite"
import { join } from "path"
import type { GoalStore } from "../goal-store"
import { ConductorStore } from "../../memory/store"

// ─── Diagnostics handlers (M3) ───────────────────────────────────────────────
// Read-only endpoints that open the conductor.db for a completed/running run
// and return structured diagnostic data. Auth follows the same token-gated
// pattern as the replay handler (callers must hold a bearer token for the
// /api/dataflow/* group; these are on the public /api/runs/* route, same as
// replay, so no extra auth layer is added here).

function openStore(runId: string, goalStore: GoalStore): ConductorStore | null {
  const meta = goalStore.getRunMeta(runId)
  if (!meta?.conductorDir) return null
  try {
    // ConductorStore opens the DB in WAL mode — we want read-only here. Bun's
    // SQLite supports { readonly: true } but ConductorStore sets up PRAGMA and
    // migrations. Re-use the store (which is safe to open read-write even for
    // finished runs — WAL is designed for concurrent access) and just never
    // write to it from these handlers.
    return new ConductorStore(meta.conductorDir, runId)
  } catch { return null }
}

/** GET /api/runs/{id}/summary — aggregated stats + failed tasks + key events */
export function handleRunSummary(
  runId: string,
  goalStore: GoalStore,
  json: (data: unknown) => Response,
): Response {
  const store = openStore(runId, goalStore)
  if (!store) return new Response("Run not found or has no conductor data", { status: 404 })
  try {
    const summary = store.getRunSummary()
    store.close()
    return json(summary)
  } catch (err) {
    store.close()
    return new Response(`Failed to read summary: ${(err as Error).message}`, { status: 500 })
  }
}

/** GET /api/runs/{id}/trace?since=<seq>&limit=<n> — paginated event trace */
export function handleRunTrace(
  runId: string,
  goalStore: GoalStore,
  searchParams: URLSearchParams,
  json: (data: unknown) => Response,
): Response {
  const store = openStore(runId, goalStore)
  if (!store) return new Response("Run not found or has no conductor data", { status: 404 })
  try {
    const sinceSeq = searchParams.has("since") ? parseInt(searchParams.get("since")!, 10) : undefined
    const limit    = searchParams.has("limit")  ? parseInt(searchParams.get("limit")!,  10) : undefined
    const events = store.getRunTrace({ sinceSeq, limit })
    store.close()
    return json({ runId, events, nextSeq: events.length > 0 ? events[events.length - 1]!.id : sinceSeq ?? 0 })
  } catch (err) {
    store.close()
    return new Response(`Failed to read trace: ${(err as Error).message}`, { status: 500 })
  }
}

/** GET /api/artifacts/{id}/lineage?run=<runId> — full ancestor tree */
export function handleArtifactLineage(
  artifactId: string,
  runId: string,
  goalStore: GoalStore,
  json: (data: unknown) => Response,
): Response {
  const store = openStore(runId, goalStore)
  if (!store) return new Response("Run not found or has no conductor data", { status: 404 })
  try {
    const lineage = store.getArtifactLineage(artifactId)
    store.close()
    return json({ artifactId, runId, lineage })
  } catch (err) {
    store.close()
    return new Response(`Failed to read lineage: ${(err as Error).message}`, { status: 500 })
  }
}
