import type { DuckDBInstance } from "@duckdb/node-api"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import type {
  SchemaResult, SqlResult, ChartResult, PythonResult, ToolResult,
} from "./tools"

// ─── Wiki search (BM25 via search.py) ────────────────────────────────────────

const WIKI_SEARCH_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "uni-wiki-vector", "uni-wiki", "search.py"
)

export interface WikiSearchResult {
  pages: Array<{
    rank: number
    path: string
    title: string
    score: number
    norm: number
    stability: string   // "🟢 S1-Stable" | "🟡 S2-Semi-stable" | "🔴 S3-Volatile" | ""
    content: string     // compact excerpt
    hitBy: string[]
  }>
  checklist: string
  warnings: string[]
  rawOutput: string
}

export async function execSearchWiki(params: {
  queries: string[]
  top?: number
  pinPages?: string[]
}): Promise<WikiSearchResult> {
  const { queries, top = 5, pinPages = [] } = params

  const args = [
    WIKI_SEARCH_SCRIPT,
    "--queries", ...queries,
    "--top", String(Math.min(top, 10)),
    "--compact",
    "--checklist",
  ]
  if (pinPages.length > 0) {
    args.push("--pin-pages", ...pinPages)
  }

  const proc = Bun.spawn(["python3", ...args], {
    cwd: join(dirname(fileURLToPath(import.meta.url)), "uni-wiki-vector", "uni-wiki"),
    stdout: "pipe",
    stderr: "pipe",
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited

  if (proc.exitCode !== 0 && !stdout.trim()) {
    return {
      pages: [],
      checklist: "",
      warnings: [`Wiki search failed: ${stderr.slice(0, 300)}`],
      rawOutput: stderr,
    }
  }

  // Parse the raw output into structured form
  return parseWikiOutput(stdout, queries)
}

function parseWikiOutput(raw: string, _queries: string[]): WikiSearchResult {
  const pages: WikiSearchResult["pages"] = []
  const warnings: string[] = []

  // Extract checklist block
  const checklistMatch = raw.match(/── Checklist ──[\s\S]*?(?=\n={10,}|\n\[uni-wiki|\z)/m)
  const checklist = checklistMatch ? checklistMatch[0].trim() : ""

  // Extract S3/deprecated warnings
  if (raw.includes("[WARN]") || raw.includes("S3-Volatile") || raw.includes("deprecated")) {
    const warnLines = raw.split("\n").filter(l => l.includes("[WARN]") || l.includes("fallback"))
    warnings.push(...warnLines.map(l => l.trim()).filter(Boolean))
  }

  // Parse page blocks: each starts with [N] path  (score=...) «title» [badge]
  const pageBlockRe = /\[(\d+)\] (wiki\/\S+\.md)\s+\(score=([\d.]+), norm=([\d.]+)\)\s+[《"]*([^》"\n]+)[》"]*/g
  let m: RegExpExecArray | null
  while ((m = pageBlockRe.exec(raw)) !== null) {
    const rank = parseInt(m[1]!)
    const path = m[2]!
    const score = parseFloat(m[3]!)
    const norm = parseFloat(m[4]!)
    const title = m[5]!.trim()

    // Extract stability badge
    const stabilityRe = /\[(🟢 S1-Stable|🟡 S2-Semi-stable|🔴 S3-Volatile|❌deprecated)\]/
    const afterHeader = raw.slice(m.index, m.index + 2000)
    const stabilityMatch = stabilityRe.exec(afterHeader)
    const stability = stabilityMatch ? stabilityMatch[1]! : ""

    if (stability.includes("S3") || stability.includes("deprecated")) {
      warnings.push(`[WARN] Page ${path} is ${stability} — use with caution`)
    }

    // Extract hit_by
    const hitByMatch = afterHeader.match(/hit_by=\[([^\]]+)\]/)
    const hitBy = hitByMatch
      ? hitByMatch[1]!.replace(/'/g, "").split(", ")
      : []

    // Extract content excerpt (everything between separator lines, up to ~50 lines)
    const sepStart = raw.indexOf("=" .repeat(10), m.index)
    const contentStart = sepStart !== -1 ? raw.indexOf("\n", sepStart) + 1 : m.index + m[0].length
    const nextSep = raw.indexOf("=" .repeat(10), contentStart + 10)
    const contentEnd = nextSep !== -1 ? nextSep : contentStart + 3000
    const content = raw.slice(contentStart, contentEnd).trim().slice(0, 2000)

    pages.push({ rank, path, title, score, norm, stability, content, hitBy })
  }

  return { pages, checklist, warnings, rawOutput: raw }
}

// ─── Schema exploration ───────────────────────────────────────────────────────

export async function execExploreSchema(
  instance: DuckDBInstance,
  table?: string
): Promise<SchemaResult> {
  const conn = await instance.connect()
  try {
    if (!table) {
      const rows = (await conn.runAndReadAll(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='main' ORDER BY table_name`
      )).getRowObjects() as { table_name: string }[]
      return { tables: rows.map(r => r.table_name) }
    }
    const colRows = (await conn.runAndReadAll(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name=? ORDER BY ordinal_position`,
      [table]
    )).getRowObjects() as { column_name: string; data_type: string }[]

    const sample = (await conn.runAndReadAll(
      `SELECT * FROM "${table}" LIMIT 3`
    )).getRowObjects() as Record<string, unknown>[]

    return {
      columns: colRows.map(r => ({ name: r.column_name, type: r.data_type })),
      sample: sanitizeRows(sample),
    }
  } finally {
    conn.closeSync?.()
  }
}

// ─── SQL execution ────────────────────────────────────────────────────────────

export async function execRunSql(
  instance: DuckDBInstance,
  sql: string,
  maxRows = 500
): Promise<SqlResult> {
  const conn = await instance.connect()
  try {
    const allRows = (await conn.runAndReadAll(sql)).getRowObjects() as Record<string, unknown>[]
    const truncated = allRows.length > maxRows
    return {
      rows: sanitizeRows(truncated ? allRows.slice(0, maxRows) : allRows),
      rowCount: allRows.length,
      truncated,
    }
  } catch (err) {
    return { rows: [], rowCount: 0, truncated: false, error: String(err) }
  } finally {
    conn.closeSync?.()
  }
}

// ─── Chart generation ─────────────────────────────────────────────────────────
// Converts data spec into a ready-to-render ECharts option object.

export function execMakeChart(params: {
  title: string
  chartType: string
  data: Record<string, unknown>
  xLabel?: string
  yLabel?: string
}): ChartResult {
  const { title, chartType, data, xLabel, yLabel } = params
  let option: Record<string, unknown> = {
    title: { text: title, left: "center", textStyle: { fontSize: 14 } },
    tooltip: { trigger: chartType === "pie" ? "item" : "axis" },
    backgroundColor: "transparent",
  }

  if (chartType === "pie") {
    const items = (data.items ?? []) as { name: string; value: number }[]
    option = {
      ...option,
      series: [{
        type: "pie", radius: "60%",
        data: items,
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: "rgba(0,0,0,0.5)" } },
      }],
    }
  } else if (chartType === "scatter") {
    const points = (data.points ?? []) as { x: number; y: number; name?: string }[]
    option = {
      ...option,
      xAxis: { type: "value", name: xLabel ?? "" },
      yAxis: { type: "value", name: yLabel ?? "" },
      series: [{ type: "scatter", data: points.map(p => [p.x, p.y]) }],
    }
  } else {
    const categories = (data.categories ?? []) as string[]
    const series = (data.series ?? []) as { name: string; data: number[] }[]
    option = {
      ...option,
      legend: { bottom: 0 },
      xAxis: { type: "category", data: categories, name: xLabel ?? "", axisLabel: { rotate: categories.length > 8 ? 30 : 0 } },
      yAxis: { type: "value", name: yLabel ?? "" },
      series: series.map(s => ({
        name: s.name, data: s.data,
        type: chartType === "area" ? "line" : chartType,
        ...(chartType === "area" ? { areaStyle: {} } : {}),
        smooth: chartType === "line" || chartType === "area",
      })),
    }
  }

  return { title, chartType, echartsOption: option }
}

// ─── Python sandbox (E2B) ─────────────────────────────────────────────────────

export async function execRunPython(code: string): Promise<PythonResult> {
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) {
    return { output: "", images: [], error: "E2B_API_KEY not set — Python sandbox unavailable" }
  }

  // Dynamically import e2b to avoid hard dependency when not used
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Sandbox: { create: (opts: Record<string, unknown>) => Promise<unknown> }
  try {
    // @ts-ignore — optional peer dependency, not in package.json
    const mod = await import("e2b") as Record<string, unknown>
    Sandbox = (mod.Sandbox ?? mod.default) as typeof Sandbox
  } catch {
    return { output: "", images: [], error: "e2b package not installed. Run: bun add e2b" }
  }

  const sandbox = await Sandbox.create({ apiKey, timeoutMs: 30_000 }) as {
    runCode: (code: string) => Promise<{ stdout: string; stderr: string; error?: string; results: { png?: string }[] }>
    close: () => Promise<void>
  }

  try {
    const result = await sandbox.runCode(code)
    const images = result.results
      .filter(r => r.png)
      .map(r => `data:image/png;base64,${r.png}`)

    return {
      output: result.stdout + (result.stderr ? `\n[stderr] ${result.stderr}` : ""),
      images,
      error: result.error,
    }
  } finally {
    await sandbox.close().catch(() => {})
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === "bigint") return Number(v)
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString()
    if (Array.isArray(v)) return v.map(sanitizeCell)
    const o = v as Record<string, unknown>
    if ("days" in o) return new Date(Number(o.days) * 86_400_000).toISOString().slice(0, 10)
    if ("micros" in o) return new Date(Number(BigInt(String(o.micros)) / 1000n)).toISOString()
    if ("scale" in o && "value" in o) {
      const raw = BigInt(String(o.value))
      return Number(raw) / Math.pow(10, o.scale as number)
    }
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(o)) out[k] = sanitizeCell(val)
    return out
  }
  return v
}

function sanitizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(r => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) out[k] = sanitizeCell(v)
    return out
  })
}

export type { ToolResult }
