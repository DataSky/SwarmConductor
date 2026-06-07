import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api"
import type { TaskNode } from "../dag/types"
import type { WorkerRunner } from "../executor/worker-executor"

// ─── DuckDB SQL worker ────────────────────────────────────────────────────────
// A WorkerRunner that runs the task's SQL (task.prompt) against a DuckDB
// instance and returns a CLEAN, JSON-serializable result. This is the bridge
// from the generic worker abstraction to a real analytical engine.
//
// Why a normalization layer is mandatory (discovered in the spike): DuckDB
// returns BigInt for COUNT/SUM-of-int and a {width,scale,value} object for
// DECIMAL. Those are NOT JSON-serializable / not LLM-friendly, and artifacts
// must be plain text consumed downstream. So every cell is normalized here.

/** Convert one DuckDB cell into a clean, JSON-serializable value. */
export function normalizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === "bigint") {
    // Keep precision: only downgrade to number when it's safe.
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(v)
      : v.toString()
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    // DuckDB temporal wrappers (Neo client) → readable ISO-ish strings.
    //   DATE      → { days }            (days since 1970-01-01)
    //   TIMESTAMP → { micros }          (microseconds since epoch)
    //   TIME      → { micros }          (microseconds since midnight)
    if ("days" in o && typeof o["days"] === "number" || "days" in o && typeof o["days"] === "bigint") {
      const days = Number(o["days"])
      return new Date(days * 86_400_000).toISOString().slice(0, 10)   // YYYY-MM-DD
    }
    if ("micros" in o && (typeof o["micros"] === "bigint" || typeof o["micros"] === "string" || typeof o["micros"] === "number")) {
      const micros = BigInt(String(o["micros"]))
      const ctor = (v as { constructor?: { name?: string } }).constructor?.name
      if (ctor === "DuckDBTimeValue") {
        // time-of-day: format from microseconds since midnight
        const totalSec = Number(micros / 1_000_000n)
        const hh = String(Math.floor(totalSec / 3600)).padStart(2, "0")
        const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0")
        const ss = String(totalSec % 60).padStart(2, "0")
        return `${hh}:${mm}:${ss}`
      }
      return new Date(Number(micros / 1000n)).toISOString()   // timestamp → ISO
    }
    // DuckDB DECIMAL → { width, scale, value } where value is the unscaled int.
    if ("scale" in o && "value" in o && typeof o["scale"] === "number") {
      const raw = typeof o["value"] === "bigint" ? o["value"] : BigInt(String(o["value"]))
      const scale = o["scale"] as number
      const num = Number(raw) / Math.pow(10, scale)
      return Number.isFinite(num) ? num : raw.toString()
    }
    // Native JS Date (defensive — some paths may yield it).
    if (v instanceof Date) return v.toISOString()
    // Fallback: normalize nested arrays/objects recursively.
    if (Array.isArray(v)) return v.map(normalizeCell)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(o)) out[k] = normalizeCell(val)
    return out
  }
  return v   // string | number | boolean already clean
}

/** Normalize an array of row objects into clean JSON-serializable rows. */
export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(r => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) out[k] = normalizeCell(v)
    return out
  })
}

export interface SqlWorkerOptions {
  /** Max rows to materialize into an artifact, guarding against huge result
   *  sets exploding memory / the downstream prompt. Extra rows are dropped with
   *  a truncation flag in the output. */
  maxRows?: number
}

/**
 * Build a WorkerRunner backed by DuckDB. Each invocation gets its own
 * connection from the shared instance (the spike confirmed per-connection
 * concurrency). The SQL comes from task.prompt. Returns a JSON string:
 *   { rows: [...], rowCount: N, truncated: bool }
 *
 * The instance MUST be opened READ_ONLY by the caller for analytical safety —
 * this runner never opens it, so it can't accidentally grant write access.
 */
export function makeSqlWorker(instance: DuckDBInstance, opts: SqlWorkerOptions = {}): WorkerRunner {
  const maxRows = opts.maxRows ?? 10_000
  return async (task: TaskNode): Promise<string> => {
    // SQL workers act on task.prompt (the query); they don't consume upstream
    // artifacts, so the `inputs` parameter is intentionally unused here.
    const sql = task.prompt?.trim()
    if (!sql) return JSON.stringify({ error: "no SQL in task.prompt", rows: [], rowCount: 0 })

    let conn: DuckDBConnection | null = null
    try {
      conn = await instance.connect()
      const reader = await conn.runAndReadAll(sql)
      const allRows = reader.getRowObjects() as Record<string, unknown>[]
      const truncated = allRows.length > maxRows
      const rows = normalizeRows(truncated ? allRows.slice(0, maxRows) : allRows)
      return JSON.stringify({ rows, rowCount: allRows.length, truncated })
    } catch (err) {
      // Surface SQL errors as a structured result, not a throw — the worker
      // executor turns a throw into task failure, but a bad query is data the
      // downstream (or a human) may want to see and react to.
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err), rows: [], rowCount: 0 })
    } finally {
      conn?.closeSync?.()
    }
  }
}
