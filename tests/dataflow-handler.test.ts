import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { DuckDBInstance } from "@duckdb/node-api"
import { handleDataflowRun } from "../src/web/handlers/dataflow-run"
import { rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

// End-to-end of the dataflow HTTP handler WITHOUT any LLM task — so it runs
// fully offline (sql + validate + compare workers only). Proves the self-service
// entry point wires DuckDB + workers + DAG + dependency routing correctly.

const DB = join(tmpdir(), `dataflow-handler-${process.pid}.duckdb`)

describe("handleDataflowRun (offline: sql + validate + compare)", () => {
  beforeAll(async () => {
    rmSync(DB, { force: true })
    const w = await DuckDBInstance.create(DB)
    const c = await w.connect()
    await c.run(`CREATE TABLE orders (id INTEGER, region VARCHAR, amount DECIMAL(10,2))`)
    await c.run(`INSERT INTO orders VALUES (1,'EU',100),(2,'US',200),(3,'EU',50),(4,'APAC',300)`)
    c.closeSync?.(); w.closeSync?.()
  })
  afterAll(() => rmSync(DB, { force: true }))

  it("runs a sql → validate chain and reports pass", async () => {
    const res = await handleDataflowRun({
      db: DB,
      tasks: [
        { key: "byRegion", kind: "sql", title: "by region", sql: `SELECT region, COUNT(*) n FROM orders GROUP BY region` },
        { key: "check", kind: "validate", title: "non-empty", dependsOn: ["byRegion"], rules: [{ type: "rowCount", min: 1 }, { type: "noNulls", column: "region" }] },
      ],
    })
    expect(res.status).toBe("completed")
    expect(res.tasks.every(t => t.status === "done")).toBe(true)
    // sql produced rows; validate passed.
    const sqlOut = JSON.parse(res.artifacts["byRegion"]!)
    expect(sqlOut.rowCount).toBe(3)
    const valOut = JSON.parse(res.artifacts["check"]!)
    expect(valOut.passed).toBe(true)
    // No LLM tasks → zero tokens.
    expect(res.tokens.inputTokens).toBe(0)
  })

  it("runs two sql queries → compare with set diff", async () => {
    const res = await handleDataflowRun({
      db: DB,
      tasks: [
        { key: "all", kind: "sql", sql: `SELECT DISTINCT region FROM orders` },
        { key: "big", kind: "sql", sql: `SELECT DISTINCT region FROM orders WHERE amount >= 200` },
        { key: "diff", kind: "compare", dependsOn: ["all", "big"], keyColumn: "region" },
      ],
    })
    expect(res.status).toBe("completed")
    const cmp = JSON.parse(res.artifacts["diff"]!)
    // all = {EU,US,APAC}, big = {US,APAC} → onlyInA = [EU]
    expect(cmp.onlyInA).toContain("EU")
    expect(cmp.identical).toBe(false)
  })

  it("rejects an empty task list", async () => {
    await expect(handleDataflowRun({ tasks: [] })).rejects.toThrow(/non-empty/)
  })

  it("rejects sql tasks without a db path", async () => {
    await expect(handleDataflowRun({ tasks: [{ key: "q", kind: "sql", sql: "SELECT 1" }] }))
      .rejects.toThrow(/require a 'db'/)
  })

  it("surfaces a validation failure as passed=false", async () => {
    const res = await handleDataflowRun({
      db: DB,
      tasks: [
        { key: "q", kind: "sql", sql: `SELECT region FROM orders` },
        { key: "v", kind: "validate", dependsOn: ["q"], rules: [{ type: "rowCount", min: 999 }] },
      ],
    })
    const valOut = JSON.parse(res.artifacts["v"]!)
    expect(valOut.passed).toBe(false)
  })
})
