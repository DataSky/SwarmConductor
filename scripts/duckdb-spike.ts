#!/usr/bin/env bun
/**
 * SPIKE: kill the biggest unknown — can Bun load the DuckDB native addon and
 * run real queries? Also probes the concurrency model (parallel reads on one
 * instance). This is a throwaway de-risking script, not production code.
 */
import { DuckDBInstance } from "@duckdb/node-api"

console.log("[spike] importing @duckdb/node-api … OK (import didn't crash Bun)")

// 1. In-memory instance + connection
const instance = await DuckDBInstance.create(":memory:")
const conn = await instance.connect()
console.log("[spike] created in-memory instance + connection … OK")

// 2. DDL + insert
await conn.run(`CREATE TABLE orders (id INTEGER, region VARCHAR, amount DECIMAL(10,2))`)
await conn.run(`INSERT INTO orders VALUES (1,'EU',100.50),(2,'US',250.00),(3,'EU',75.25),(4,'APAC',300.00)`)
console.log("[spike] created table + inserted 4 rows … OK")

// 3. Aggregate query → materialize rows
const reader = await conn.runAndReadAll(`SELECT region, COUNT(*) n, SUM(amount) total FROM orders GROUP BY region ORDER BY total DESC`)
const rows = reader.getRowObjects()
console.log("[spike] aggregate query returned:", JSON.stringify(rows, (_k, v) => typeof v === "bigint" ? v.toString() : v))

// 4. Concurrency probe: fire N read queries "in parallel" on separate connections
console.log("[spike] probing parallel reads on separate connections …")
const t0 = Date.now()
const results = await Promise.all(
  Array.from({ length: 8 }, async (_, i) => {
    const c = await instance.connect()                // one connection per "slot"
    const r = await c.runAndReadAll(`SELECT ${i} AS slot, COUNT(*) AS n FROM orders`)
    return r.getRowObjects()
  })
)
console.log(`[spike] 8 parallel reads on separate connections … OK (${Date.now() - t0}ms), got ${results.length} results`)

// 5. read_only mode probe (safety: analytical queries should not mutate)
//    Persist a file, reopen read-only, confirm a write is rejected.
const { rmSync } = await import("fs")
const tmpDb = "/tmp/spike-ro.duckdb"
rmSync(tmpDb, { force: true })
const wInst = await DuckDBInstance.create(tmpDb)
const wConn = await wInst.connect()
await wConn.run(`CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)`)
wInst.closeSync?.()
try {
  const roInst = await DuckDBInstance.create(tmpDb, { access_mode: "READ_ONLY" })
  const roConn = await roInst.connect()
  const rr = await roConn.runAndReadAll(`SELECT COUNT(*) n FROM t`)
  console.log("[spike] reopened READ_ONLY, read OK:", JSON.stringify(rr.getRowObjects(), (_k, v) => typeof v === "bigint" ? v.toString() : v))
  try {
    await roConn.run(`INSERT INTO t VALUES (2)`)
    console.log("[spike] ⚠️ WRITE SUCCEEDED in READ_ONLY — unexpected!")
  } catch (e) {
    console.log("[spike] write correctly REJECTED in READ_ONLY mode … OK")
  }
  roInst.closeSync?.()
} catch (e) {
  console.log("[spike] READ_ONLY probe error:", (e as Error).message)
}
rmSync(tmpDb, { force: true })

console.log("\n[spike] ✅ DuckDB runs under Bun. Concurrency=per-connection. read_only enforceable.")
