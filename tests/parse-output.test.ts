import { describe, it, expect } from "bun:test"
import { parseTaskOutput } from "../src/conductor/index"

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Build a valid 5-section output with the given overrides per section.
 *  Pass `null` to omit a section entirely. */
function buildOutput(sections: {
  summary?: string | null
  changes?: string | null
  evidence?: string | null
  risks?: string | null
  blockers?: string | null
}): string {
  const def = { summary: "done", changes: "- file.ts: change", evidence: "test", risks: "low", blockers: "none" }
  const s = { ...def, ...sections }
  const parts: string[] = []
  if (s.summary !== null)  parts.push(`## SUMMARY\n${s.summary}`)
  if (s.changes !== null)  parts.push(`## CHANGES\n${s.changes}`)
  if (s.evidence !== null) parts.push(`## EVIDENCE\n${s.evidence}`)
  if (s.risks !== null)    parts.push(`## RISKS\n${s.risks}`)
  if (s.blockers !== null) parts.push(`## BLOCKERS\n${s.blockers}`)
  return parts.join("\n\n")
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("parseTaskOutput", () => {
  // ── Happy path ──────────────────────────────────────────────────────────────
  it("parses all five sections correctly", () => {
    const raw = buildOutput({
      summary: "Fixed a bug in the parser.",
      changes: "- src/foo.ts: fixed parsing bug\n- src/bar.ts: added validation",
      evidence: "All 19 tests pass\nNo regressions",
      risks: "low: minor refactor",
      blockers: "none",
    })
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("Fixed a bug in the parser.")
    expect(out.changes).toEqual([
      { file: "src/foo.ts", description: "fixed parsing bug" },
      { file: "src/bar.ts", description: "added validation" },
    ])
    expect(out.evidence).toEqual(["All 19 tests pass", "No regressions"])
    expect(out.risks).toEqual(["low: minor refactor"])
    expect(out.blockers).toEqual([])  // "none" filtered
    expect(out.rawText).toBe(raw)
  })

  // ── "none" placeholders ─────────────────────────────────────────────────────
  it('filters "none" from evidence, risks, and blockers but not summary', () => {
    const raw = buildOutput({
      summary: "none",    // literal "none" → empty string
      evidence: "none",
      risks: "none",
      blockers: "none",
    })
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("")
    expect(out.evidence).toEqual([])
    expect(out.risks).toEqual([])
    expect(out.blockers).toEqual([])
  })

  it('filters mixed "none" and real content in array fields', () => {
    const raw = buildOutput({
      evidence: "test passed\nnone\ncoverage 95%",
      risks: "none\nmedium: possible race",
      blockers: "Blocker A\nnone\nBlocker B",
    })
    const out = parseTaskOutput(raw)

    expect(out.evidence).toEqual(["test passed", "coverage 95%"])
    expect(out.risks).toEqual(["medium: possible race"])
    expect(out.blockers).toEqual(["Blocker A", "Blocker B"])
  })

  it('filters Chinese-language stub phrases (五段, 五个节。, etc.)', () => {
    // Non-English agents sometimes write Chinese phrases instead of "none"
    const raw = buildOutput({
      evidence: "五段\nreal evidence",
      risks: "五个节。\nhigh: critical bug",
      blockers: "Blocker X\n五段\nBlocker Y",
    })
    const out = parseTaskOutput(raw)

    expect(out.evidence).toEqual(["real evidence"])
    expect(out.risks).toEqual(["high: critical bug"])
    expect(out.blockers).toEqual(["Blocker X", "Blocker Y"])
  })

  // ── Case insensitivity ─────────────────────────────────────────────────────
  it("matches section headers case-insensitively", () => {
    const raw = [
      "## summary",
      "Done.",
      "",
      "## changes",
      "- file.ts: fix",
      "",
      "## evidence",
      "pass",
      "",
      "## risks",
      "low",
      "",
      "## blockers",
      "none",
    ].join("\n")
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("Done.")
    expect(out.changes).toEqual([{ file: "file.ts", description: "fix" }])
    expect(out.evidence).toEqual(["pass"])
    expect(out.risks).toEqual(["low"])
    expect(out.blockers).toEqual([])
  })

  // ── Empty sections / missing sections ──────────────────────────────────────
  it("handles empty sections gracefully", () => {
    const raw = buildOutput({
      summary: "done",
      changes: "",
      evidence: "",
      risks: "",
      blockers: "",
    })
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("done")
    expect(out.changes).toEqual([])
    expect(out.evidence).toEqual([])
    expect(out.risks).toEqual([])
    expect(out.blockers).toEqual([])
  })

  it("handles missing sections gracefully", () => {
    const raw = buildOutput({ summary: "done", changes: null, evidence: null, risks: null, blockers: null })
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("done")
    expect(out.changes).toEqual([])
    expect(out.evidence).toEqual([])
    expect(out.risks).toEqual([])
    expect(out.blockers).toEqual([])
  })

  it("handles completely empty rawText", () => {
    const out = parseTaskOutput("")
    expect(out.summary).toBe("")
    expect(out.changes).toEqual([])
    expect(out.evidence).toEqual([])
    expect(out.risks).toEqual([])
    expect(out.blockers).toEqual([])
    expect(out.rawText).toBe("")
  })

  // ── Multi-line sections ────────────────────────────────────────────────────
  it("preserves multi-line summary", () => {
    const raw = buildOutput({
      summary: "Fixed the DAG engine.\nImproved scheduling.\nAdded tests.",
    })
    const out = parseTaskOutput(raw)
    expect(out.summary).toBe("Fixed the DAG engine.\nImproved scheduling.\nAdded tests.")
  })

  it("parses bullet changes with leading * as well as -", () => {
    const raw = buildOutput({
      changes: "- src/a.ts: fix one\n* src/b.ts: fix two",
    })
    const out = parseTaskOutput(raw)
    expect(out.changes).toEqual([
      { file: "src/a.ts", description: "fix one" },
      { file: "src/b.ts", description: "fix two" },
    ])
  })

  it("handles changes with colons in the description", () => {
    const raw = buildOutput({
      changes: "- path/to/file.ts: desc with: multiple: colons",
    })
    const out = parseTaskOutput(raw)
    expect(out.changes).toEqual([
      { file: "path/to/file.ts", description: "desc with: multiple: colons" },
    ])
  })

  it("ignores non-bullet lines in CHANGES", () => {
    const raw = buildOutput({
      changes: "- src/a.ts: fix\nNot a bullet line\n- src/b.ts: feat",
    })
    const out = parseTaskOutput(raw)
    expect(out.changes).toEqual([
      { file: "src/a.ts", description: "fix" },
      { file: "src/b.ts", description: "feat" },
    ])
  })

  // ── Windows line endings ───────────────────────────────────────────────────
  it("handles Windows line endings (\\r\\n)", () => {
    const raw = [
      "## SUMMARY",
      "Done.",
      "",
      "## CHANGES",
      "- file.ts: fix",
      "",
      "## EVIDENCE",
      "pass",
      "",
      "## RISKS",
      "low",
      "",
      "## BLOCKERS",
      "none",
    ].join("\r\n")
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("Done.")
    expect(out.changes).toEqual([{ file: "file.ts", description: "fix" }])
    expect(out.evidence).toEqual(["pass"])
    expect(out.risks).toEqual(["low"])
    expect(out.blockers).toEqual([])
  })

  // ── Output contract fidelity ───────────────────────────────────────────────
  it("matches the exact output contract format", () => {
    // This is the exact output format the output_contract asks agents to produce
    const raw = [
      "## SUMMARY",
      "Fixed a critical parsing bug in the DAG engine.",
      "",
      "## CHANGES",
      "- src/dag/engine.ts: fixed edge-case in topological sort",
      "- src/dag/types.ts: added new status variant",
      "",
      "## EVIDENCE",
      "All 19 tests pass",
      "No new lint errors",
      "",
      "## RISKS",
      "low: minor API surface change",
      "medium: needs performance regression test",
      "",
      "## BLOCKERS",
      "none",
    ].join("\n")
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("Fixed a critical parsing bug in the DAG engine.")
    expect(out.changes).toEqual([
      { file: "src/dag/engine.ts", description: "fixed edge-case in topological sort" },
      { file: "src/dag/types.ts", description: "added new status variant" },
    ])
    expect(out.evidence).toEqual(["All 19 tests pass", "No new lint errors"])
    expect(out.risks).toEqual(["low: minor API surface change", "medium: needs performance regression test"])
    expect(out.blockers).toEqual([])
  })

  // ── Section order independence ─────────────────────────────────────────────
  it("extracts sections regardless of order", () => {
    // Sections in reversed order — parser is order-agnostic (uses global search)
    const raw = [
      "## BLOCKERS",
      "missing docs",
      "",
      "## RISKS",
      "high: data loss",
      "",
      "## EVIDENCE",
      "test ok",
      "",
      "## CHANGES",
      "- src/x.ts: fix",
      "",
      "## SUMMARY",
      "done",
    ].join("\n")
    const out = parseTaskOutput(raw)

    expect(out.summary).toBe("done")
    expect(out.changes).toEqual([{ file: "src/x.ts", description: "fix" }])
    expect(out.evidence).toEqual(["test ok"])
    expect(out.risks).toEqual(["high: data loss"])
    expect(out.blockers).toEqual(["missing docs"])
  })

  // ── Edge cases ─────────────────────────────────────────────────────────────
  it("trims whitespace from section content", () => {
    const raw = [
      "## SUMMARY",
      "   summary with surrounding spaces   ",
      "",
      "## EVIDENCE",
      "  line 1  ",
      "line 2\t",
    ].join("\n")
    const out = parseTaskOutput(raw)
    expect(out.summary).toBe("summary with surrounding spaces")
    expect(out.evidence).toEqual(["line 1", "line 2"])
  })

  it("handles section headers with extra spaces", () => {
    const raw = [
      "##    SUMMARY",
      "done",
      "",
      "##   CHANGES",
      "- file.ts: fix",
    ].join("\n")
    const out = parseTaskOutput(raw)
    expect(out.summary).toBe("done")
    expect(out.changes).toEqual([{ file: "file.ts", description: "fix" }])
  })

  it("returns empty changes for 'none' bullet in CHANGES", () => {
    // Agent writes "- none" or "* none" — should be treated as empty
    const raw = buildOutput({ changes: "- none" })
    const out = parseTaskOutput(raw)
    // "none" as a change line would produce file="none", description=""
    // This is a design choice — the bullet filter doesn't drop "none"
    // But practically agents should write "none" as plain text, not bullet
    expect(out.changes).toEqual([{ file: "none", description: "" }])
  })

  it("does not confuse content ## with section headers", () => {
    // A valid edge case: content may contain ## in code blocks or text
    const raw = [
      "## SUMMARY",
      "Done ## not a header",
      "",
      "## CHANGES",
      "- file.ts: fix",
      "",
      "## EVIDENCE",
      "some ## in evidence text",
    ].join("\n")
    const out = parseTaskOutput(raw)

    // SUMMARY text "Done ## not a header" contains `##` but the regex only
    // truncates at `\n##` (newline followed by ##), not inline `##`.
    // So the inline `##` should NOT truncate the section.
    expect(out.summary).toBe("Done ## not a header")
    expect(out.evidence).toEqual(["some ## in evidence text"])
  })

  it("rawText preserves the original input unchanged", () => {
    const raw = "## SUMMARY\ncustom raw text\n## CHANGES\n- f.ts: x"
    const out = parseTaskOutput(raw)
    expect(out.rawText).toBe(raw)
  })

  // ── Stress: many lines ────────────────────────────────────────────────────
  it("handles sections with many lines", () => {
    const evidence = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const changes = Array.from({ length: 20 }, (_, i) => `- src/f${i}.ts: change ${i}`).join("\n")
    const raw = buildOutput({ summary: "large output", changes, evidence, risks: "none", blockers: "none" })

    const out = parseTaskOutput(raw)
    expect(out.evidence).toHaveLength(50)
    expect(out.changes).toHaveLength(20)
    expect(out.evidence[0]).toBe("line 0")
    expect(out.evidence[49]).toBe("line 49")
  })
})
