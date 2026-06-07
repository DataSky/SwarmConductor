import type { TaskNode, Artifact } from "../dag/types"
import type { WorkerRunner } from "../executor/worker-executor"

// ─── Validate & Compare workers ───────────────────────────────────────────────
// Deterministic data-flow workers that act on UPSTREAM SQL results (artifacts),
// not on an LLM. They close the "execute → validate → cross-compare" loop the
// project was redirected toward — all without spending tokens.
//
// Convention (consistent with sql-worker): the worker's instruction lives in
// task.prompt as JSON. Upstream results arrive via the `inputs` artifacts whose
// content is the sql-worker's JSON: { rows: [...], rowCount, truncated }.

interface SqlResult { rows: Record<string, unknown>[]; rowCount: number; error?: string }

/** Parse a sql-worker artifact's content into rows; tolerate malformed input. */
function parseResult(artifact: Artifact | undefined): SqlResult {
  if (!artifact) return { rows: [], rowCount: 0, error: "missing upstream artifact" }
  try {
    const o = JSON.parse(artifact.content) as SqlResult
    return { rows: Array.isArray(o.rows) ? o.rows : [], rowCount: o.rowCount ?? 0, error: o.error }
  } catch {
    return { rows: [], rowCount: 0, error: "upstream artifact is not valid JSON" }
  }
}

// ─── Validate worker ──────────────────────────────────────────────────────────

export type ValidationRule =
  | { type: "rowCount"; min?: number; max?: number }
  | { type: "noNulls"; column: string }
  | { type: "range"; column: string; min?: number; max?: number }
  | { type: "unique"; column: string }
  | { type: "noError" }   // upstream query must not have errored

interface ValidateConfig { rules: ValidationRule[] }

/** Build a worker that runs declarative rules against the FIRST upstream result.
 *  Output: { passed: bool, checked: N, failures: [{rule, detail}] }. */
export function makeValidateWorker(): WorkerRunner {
  return (task: TaskNode, inputs: Artifact[]): string => {
    let cfg: ValidateConfig
    try { cfg = JSON.parse(task.prompt) as ValidateConfig } catch { cfg = { rules: [] } }
    const rules = Array.isArray(cfg.rules) ? cfg.rules : []
    const result = parseResult(inputs[0])
    const failures: { rule: string; detail: string }[] = []

    for (const rule of rules) {
      switch (rule.type) {
        case "noError":
          if (result.error) failures.push({ rule: "noError", detail: result.error })
          break
        case "rowCount": {
          const n = result.rowCount
          if (rule.min !== undefined && n < rule.min) failures.push({ rule: "rowCount", detail: `${n} < min ${rule.min}` })
          if (rule.max !== undefined && n > rule.max) failures.push({ rule: "rowCount", detail: `${n} > max ${rule.max}` })
          break
        }
        case "noNulls": {
          const bad = result.rows.filter(r => r[rule.column] === null || r[rule.column] === undefined).length
          if (bad > 0) failures.push({ rule: "noNulls", detail: `${bad} null(s) in "${rule.column}"` })
          break
        }
        case "range": {
          for (const r of result.rows) {
            const v = Number(r[rule.column])
            if (Number.isNaN(v)) { failures.push({ rule: "range", detail: `non-numeric "${rule.column}": ${r[rule.column]}` }); break }
            if (rule.min !== undefined && v < rule.min) { failures.push({ rule: "range", detail: `${rule.column}=${v} < min ${rule.min}` }); break }
            if (rule.max !== undefined && v > rule.max) { failures.push({ rule: "range", detail: `${rule.column}=${v} > max ${rule.max}` }); break }
          }
          break
        }
        case "unique": {
          const vals = result.rows.map(r => JSON.stringify(r[rule.column]))
          if (new Set(vals).size !== vals.length) failures.push({ rule: "unique", detail: `duplicate values in "${rule.column}"` })
          break
        }
      }
    }
    return JSON.stringify({ passed: failures.length === 0, checked: rules.length, failures })
  }
}

// ─── Compare worker ───────────────────────────────────────────────────────────

interface CompareConfig {
  /** Column whose value set is compared across the two inputs (set diff). */
  keyColumn?: string
}

/** Build a worker that cross-compares the FIRST TWO upstream results.
 *  Output: { rowCountDelta, onlyInA, onlyInB, common } (set diff on keyColumn
 *  when provided), else just the row-count comparison. */
export function makeCompareWorker(): WorkerRunner {
  return (task: TaskNode, inputs: Artifact[]): string => {
    let cfg: CompareConfig
    try { cfg = JSON.parse(task.prompt) as CompareConfig } catch { cfg = {} }
    const a = parseResult(inputs[0])
    const b = parseResult(inputs[1])
    if (inputs.length < 2) {
      return JSON.stringify({ error: "compare needs two upstream inputs", inputsSeen: inputs.length })
    }

    const out: Record<string, unknown> = {
      rowCountA: a.rowCount, rowCountB: b.rowCount, rowCountDelta: a.rowCount - b.rowCount,
    }
    if (cfg.keyColumn) {
      const setA = new Set(a.rows.map(r => JSON.stringify(r[cfg.keyColumn!])))
      const setB = new Set(b.rows.map(r => JSON.stringify(r[cfg.keyColumn!])))
      const onlyInA = [...setA].filter(v => !setB.has(v)).map(v => JSON.parse(v))
      const onlyInB = [...setB].filter(v => !setA.has(v)).map(v => JSON.parse(v))
      const common = [...setA].filter(v => setB.has(v)).length
      out["keyColumn"] = cfg.keyColumn
      out["onlyInA"] = onlyInA
      out["onlyInB"] = onlyInB
      out["common"] = common
      out["identical"] = onlyInA.length === 0 && onlyInB.length === 0
    }
    return JSON.stringify(out)
  }
}
