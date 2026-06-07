import { describe, it, expect } from "bun:test"
import { makeValidateWorker, makeCompareWorker } from "../src/worker/validate-compare"
import { createTaskNode } from "../src/dag/engine"
import type { Artifact, TaskNode } from "../src/dag/types"

// Build a fake sql-worker artifact (content = JSON { rows, rowCount }).
function sqlArtifact(rows: Record<string, unknown>[], id = "art-x", error?: string): Artifact {
  return {
    id, taskId: "t", kind: "json", label: null,
    content: JSON.stringify({ rows, rowCount: rows.length, truncated: false, ...(error ? { error } : {}) }),
    byteSize: 0, createdAt: 0,
  }
}
const task = (promptJson: unknown): TaskNode =>
  createTaskNode({ type: "verify", title: "v", prompt: JSON.stringify(promptJson), scope: [] })

// ─── validate worker ──────────────────────────────────────────────────────────

describe("makeValidateWorker", () => {
  const worker = makeValidateWorker()
  const rows = [{ region: "EU", n: 2 }, { region: "US", n: 3 }]

  it("passes when all rules hold", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "rowCount", min: 1 }, { type: "noNulls", column: "region" }] }), [sqlArtifact(rows)]) as string)
    expect(out.passed).toBe(true)
    expect(out.checked).toBe(2)
    expect(out.failures).toEqual([])
  })

  it("fails rowCount when below min", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "rowCount", min: 5 }] }), [sqlArtifact(rows)]) as string)
    expect(out.passed).toBe(false)
    expect(out.failures[0].rule).toBe("rowCount")
  })

  it("detects nulls in a column", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "noNulls", column: "n" }] }), [sqlArtifact([{ region: "EU", n: null }])]) as string)
    expect(out.passed).toBe(false)
    expect(out.failures[0].detail).toContain("null")
  })

  it("enforces a numeric range", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "range", column: "n", max: 2 }] }), [sqlArtifact(rows)]) as string)
    expect(out.passed).toBe(false)   // n=3 exceeds max 2
  })

  it("detects duplicate values for unique", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "unique", column: "region" }] }), [sqlArtifact([{ region: "EU" }, { region: "EU" }])]) as string)
    expect(out.passed).toBe(false)
  })

  it("noError flags an errored upstream query", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "noError" }] }), [sqlArtifact([], "art-e", "Parser Error")]) as string)
    expect(out.passed).toBe(false)
    expect(out.failures[0].detail).toContain("Parser Error")
  })

  it("reports a missing upstream artifact via noError", () => {
    const out = JSON.parse(worker(task({ rules: [{ type: "noError" }] }), []) as string)
    expect(out.passed).toBe(false)
  })
})

// ─── compare worker ────────────────────────────────────────────────────────────

describe("makeCompareWorker", () => {
  const worker = makeCompareWorker()

  it("reports row-count delta between two results", () => {
    const out = JSON.parse(worker(task({}), [
      sqlArtifact([{ x: 1 }, { x: 2 }, { x: 3 }], "a"),
      sqlArtifact([{ x: 1 }], "b"),
    ]) as string)
    expect(out.rowCountA).toBe(3)
    expect(out.rowCountB).toBe(1)
    expect(out.rowCountDelta).toBe(2)
  })

  it("computes set diff on a key column", () => {
    const out = JSON.parse(worker(task({ keyColumn: "region" }), [
      sqlArtifact([{ region: "EU" }, { region: "US" }, { region: "APAC" }], "a"),
      sqlArtifact([{ region: "EU" }, { region: "US" }], "b"),
    ]) as string)
    expect(out.onlyInA).toEqual(["APAC"])
    expect(out.onlyInB).toEqual([])
    expect(out.common).toBe(2)
    expect(out.identical).toBe(false)
  })

  it("flags identical key sets", () => {
    const out = JSON.parse(worker(task({ keyColumn: "id" }), [
      sqlArtifact([{ id: 1 }, { id: 2 }], "a"),
      sqlArtifact([{ id: 2 }, { id: 1 }], "b"),
    ]) as string)
    expect(out.identical).toBe(true)
  })

  it("errors when fewer than two inputs are provided", () => {
    const out = JSON.parse(worker(task({}), [sqlArtifact([{ x: 1 }], "a")]) as string)
    expect(out.error).toContain("two upstream inputs")
  })
})
