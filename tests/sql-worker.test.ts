import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { DuckDBInstance } from "@duckdb/node-api"
import { normalizeCell, normalizeRows, makeSqlWorker } from "../src/worker/sql-worker"
import { createTaskNode } from "../src/dag/engine"
import type { TaskNode } from "../src/dag/types"

const task = (sql: string): TaskNode =>
  createTaskNode({ type: "verify", title: "q", prompt: sql, scope: [] })

// ─── normalizeCell (pure, deterministic) ──────────────────────────────────────

describe("normalizeCell", () => {
  it("passes through clean primitives", () => {
    expect(normalizeCell("EU")).toBe("EU")
    expect(normalizeCell(42)).toBe(42)
    expect(normalizeCell(true)).toBe(true)
    expect(normalizeCell(null)).toBeNull()
  })

  it("downgrades safe BigInt to number", () => {
    expect(normalizeCell(5n)).toBe(5)
    expect(normalizeCell(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("keeps unsafe BigInt as string to preserve precision", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n
    expect(normalizeCell(huge)).toBe(huge.toString())
  })

  it("converts DuckDB DECIMAL {width,scale,value} to a number", () => {
    // 30000 unscaled, scale 2 → 300.00
    expect(normalizeCell({ width: 38, scale: 2, value: 30000n })).toBe(300)
    expect(normalizeCell({ width: 10, scale: 2, value: "17575" })).toBe(175.75)
  })

  it("normalizes nested arrays and objects recursively", () => {
    expect(normalizeCell([1n, 2n])).toEqual([1, 2])
    expect(normalizeCell({ a: 1n, b: { c: 3n } })).toEqual({ a: 1, b: { c: 3 } })
  })
})

describe("normalizeRows", () => {
  it("produces JSON-serializable rows", () => {
    const rows = normalizeRows([{ region: "EU", n: 2n, total: { width: 38, scale: 2, value: 17575n } }])
    // The whole point: this must not throw and must round-trip through JSON.
    const json = JSON.stringify(rows)
    expect(JSON.parse(json)).toEqual([{ region: "EU", n: 2, total: 175.75 }])
  })
})

// ─── makeSqlWorker against real in-memory DuckDB ──────────────────────────────

describe("makeSqlWorker (real DuckDB)", () => {
  let instance: DuckDBInstance

  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:")
    const conn = await instance.connect()
    await conn.run(`CREATE TABLE orders (id INTEGER, region VARCHAR, amount DECIMAL(10,2))`)
    await conn.run(`INSERT INTO orders VALUES (1,'EU',100.50),(2,'US',250.00),(3,'EU',75.25),(4,'APAC',300.00)`)
    conn.closeSync?.()
  })
  afterAll(() => { instance.closeSync?.() })

  it("runs an aggregate and returns clean JSON rows", async () => {
    const worker = makeSqlWorker(instance)
    const out = JSON.parse(await worker(task(
      `SELECT region, COUNT(*) n, SUM(amount) total FROM orders GROUP BY region ORDER BY total DESC`,
    )) as string)
    expect(out.rowCount).toBe(3)
    expect(out.truncated).toBe(false)
    // EU: 2 rows, 175.75 total — proves BigInt + DECIMAL normalization end to end.
    const eu = out.rows.find((r: { region: string }) => r.region === "EU")
    expect(eu.n).toBe(2)
    expect(eu.total).toBe(175.75)
  })

  it("returns a structured error (not a throw) for bad SQL", async () => {
    const worker = makeSqlWorker(instance)
    const out = JSON.parse(await worker(task(`SELECT * FROM no_such_table`)) as string)
    expect(out.error).toBeDefined()
    expect(out.rows).toEqual([])
  })

  it("flags truncation when result exceeds maxRows", async () => {
    const worker = makeSqlWorker(instance, { maxRows: 2 })
    const out = JSON.parse(await worker(task(`SELECT * FROM orders`)) as string)
    expect(out.rowCount).toBe(4)     // true total
    expect(out.rows).toHaveLength(2) // materialized capped
    expect(out.truncated).toBe(true)
  })

  it("handles empty SQL gracefully", async () => {
    const worker = makeSqlWorker(instance)
    const out = JSON.parse(await worker(task(`   `)) as string)
    expect(out.error).toContain("no SQL")
  })

  it("normalizes DuckDB temporal types to readable strings", async () => {
    const worker = makeSqlWorker(instance)
    const out = JSON.parse(await worker(task(
      `SELECT DATE '2026-02-15' AS d, TIMESTAMP '2026-02-15 10:30:00' AS ts, TIME '10:30:00' AS t`,
    )) as string)
    const row = out.rows[0]
    expect(row.d).toBe("2026-02-15")                       // DATE → YYYY-MM-DD
    expect(row.ts).toBe("2026-02-15T10:30:00.000Z")        // TIMESTAMP → ISO
    expect(row.t).toBe("10:30:00")                          // TIME → HH:MM:SS
    // And the whole thing must round-trip through JSON cleanly.
    expect(() => JSON.stringify(out.rows)).not.toThrow()
  })
})
