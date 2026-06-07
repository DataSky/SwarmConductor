import { describe, it, expect } from "bun:test"
import { buildFanOutTasks, parseSpawnDirective } from "../src/conductor/fan-out"
import { createTaskNode } from "../src/dag/engine"
import type { TaskNode, ArtifactRef } from "../src/dag/types"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parentTask(over: Partial<TaskNode> = {}): TaskNode {
  return { ...createTaskNode({ type: "plan", title: "planner", prompt: "p", scope: ["src"] }), ...over }
}
const artRef = (id: string): ArtifactRef => ({ id, kind: "json", label: null, byteSize: 10 })

// ─── buildFanOutTasks ─────────────────────────────────────────────────────────

describe("buildFanOutTasks", () => {
  it("fans out N children (no 2-task cap)", () => {
    const parent = parentTask()
    const specs = Array.from({ length: 100 }, (_, i) => ({
      type: "verify" as const, title: `validate q${i}`, prompt: "check", dependsOnParent: true,
    }))
    const { nodes } = buildFanOutTasks({ parent, parentArtifacts: [], specs })
    expect(nodes).toHaveLength(100)
    // every child depends on the parent
    expect(nodes.every(n => n.dependsOn.includes(parent.id))).toBe(true)
  })

  it("wires sibling dependencies via key (cross-comparison shape)", () => {
    const parent = parentTask()
    const { nodes, keyToId } = buildFanOutTasks({
      parent, parentArtifacts: [],
      specs: [
        { key: "q1", type: "verify", title: "query 1", prompt: "run", dependsOnParent: true },
        { key: "q2", type: "verify", title: "query 2", prompt: "run", dependsOnParent: true },
        { type: "review", title: "compare q1 vs q2", prompt: "diff", dependsOnKeys: ["q1", "q2"] },
      ],
    })
    expect(nodes).toHaveLength(3)
    const compare = nodes.find(n => n.title === "compare q1 vs q2")!
    expect(compare.dependsOn).toContain(keyToId["q1"])
    expect(compare.dependsOn).toContain(keyToId["q2"])
    expect(compare.dependsOn).toHaveLength(2)
  })

  it("inherits parent artifacts when inputFromParent is set", () => {
    const parent = parentTask({ artifacts: [artRef("art-A"), artRef("art-B")] })
    const { nodes } = buildFanOutTasks({
      parent, parentArtifacts: parent.artifacts!,
      specs: [{ type: "verify", title: "consume", prompt: "use data", inputFromParent: true }],
    })
    expect(nodes[0]!.inputArtifactIds).toEqual(["art-A", "art-B"])
  })

  it("merges explicit inputArtifactIds with parent artifacts", () => {
    const parent = parentTask({ artifacts: [artRef("art-P")] })
    const { nodes } = buildFanOutTasks({
      parent, parentArtifacts: parent.artifacts!,
      specs: [{ type: "review", title: "x", prompt: "p", inputFromParent: true, inputArtifactIds: ["art-X"] }],
    })
    expect(nodes[0]!.inputArtifactIds).toEqual(["art-X", "art-P"])
  })

  it("warns and skips a dependency on an unknown key", () => {
    const parent = parentTask()
    const { nodes, warnings } = buildFanOutTasks({
      parent, parentArtifacts: [],
      specs: [{ type: "verify", title: "orphan", prompt: "p", dependsOnKeys: ["nope"] }],
    })
    expect(nodes[0]!.dependsOn).toHaveLength(0)
    expect(warnings.some(w => w.includes("nope"))).toBe(true)
  })

  it("defaults scope and priority from the parent when omitted", () => {
    const parent = parentTask({ scope: ["src/x"], priority: 77 })
    const { nodes } = buildFanOutTasks({
      parent, parentArtifacts: [],
      specs: [{ type: "verify", title: "inherit", prompt: "p" }],
    })
    expect(nodes[0]!.scope).toEqual(["src/x"])
    expect(nodes[0]!.priority).toBe(77)
  })
})

// ─── parseSpawnDirective ──────────────────────────────────────────────────────

describe("parseSpawnDirective", () => {
  it("parses a fenced JSON SPAWN block", () => {
    const out = [
      "## SUMMARY", "planned 2 queries", "",
      "## SPAWN", "```json",
      JSON.stringify([
        { type: "verify", title: "q1", prompt: "run q1", dependsOnParent: true },
        { type: "verify", title: "q2", prompt: "run q2", dependsOnParent: true },
      ]),
      "```",
    ].join("\n")
    const specs = parseSpawnDirective(out)
    expect(specs).toHaveLength(2)
    expect(specs[0]!.title).toBe("q1")
    expect(specs[0]!.dependsOnParent).toBe(true)
  })

  it("parses a bare JSON array without fences", () => {
    const out = `## SPAWN\n[{"type":"review","title":"r","prompt":"p"}]`
    expect(parseSpawnDirective(out)).toHaveLength(1)
  })

  it("returns [] when there is no SPAWN section", () => {
    expect(parseSpawnDirective("## SUMMARY\ndone\n## CHANGES\nnone")).toEqual([])
  })

  it("returns [] on malformed JSON rather than throwing", () => {
    expect(parseSpawnDirective("## SPAWN\n```json\n[ {bad json ]\n```")).toEqual([])
  })

  it("drops specs with invalid type or missing required fields", () => {
    const out = `## SPAWN\n${JSON.stringify([
      { type: "bogus", title: "x", prompt: "p" },     // invalid type
      { type: "verify", title: "", prompt: "p" },      // empty title
      { type: "verify", title: "ok", prompt: "p" },    // valid
      { type: "verify", title: "no-prompt" },          // missing prompt
    ])}`
    const specs = parseSpawnDirective(out)
    expect(specs).toHaveLength(1)
    expect(specs[0]!.title).toBe("ok")
  })

  it("preserves key, dependsOnKeys, and inputFromParent", () => {
    const out = `## SPAWN\n${JSON.stringify([
      { type: "review", title: "cmp", prompt: "p", key: "c1",
        dependsOnKeys: ["q1", "q2"], inputFromParent: true },
    ])}`
    const spec = parseSpawnDirective(out)[0]!
    expect(spec.key).toBe("c1")
    expect(spec.dependsOnKeys).toEqual(["q1", "q2"])
    expect(spec.inputFromParent).toBe(true)
  })

  it("parses inputFromDeps for cross-comparison tasks", () => {
    const out = `## SPAWN\n${JSON.stringify([
      { type: "review", title: "compare all", prompt: "p",
        dependsOnKeys: ["a", "b"], inputFromDeps: true },
    ])}`
    const spec = parseSpawnDirective(out)[0]!
    expect(spec.inputFromDeps).toBe(true)
  })
})

// ─── inputFromDeps wiring (fan-out → cross-comparison data flow) ──────────────

describe("buildFanOutTasks inputFromDeps", () => {
  it("sets inputFromDeps on the generated node", () => {
    const parent = parentTask()
    const { nodes } = buildFanOutTasks({
      parent, parentArtifacts: [],
      specs: [
        { key: "a", type: "verify", title: "analyze a", prompt: "p", dependsOnParent: true },
        { key: "b", type: "verify", title: "analyze b", prompt: "p", dependsOnParent: true },
        { type: "review", title: "compare", prompt: "diff", dependsOnKeys: ["a", "b"], inputFromDeps: true },
      ],
    })
    const compare = nodes.find(n => n.title === "compare")!
    expect(compare.inputFromDeps).toBe(true)
    // depends on both analysis tasks — at dispatch their artifacts will inline.
    expect(compare.dependsOn).toHaveLength(2)
  })

  it("marks every fan-out node as dataflow (so heuristics skip them)", () => {
    const parent = parentTask()
    const { nodes } = buildFanOutTasks({
      parent, parentArtifacts: [],
      specs: [
        { type: "review", title: "x", prompt: "p", dependsOnParent: true },
        { type: "verify", title: "y", prompt: "p", dependsOnParent: true },
      ],
    })
    expect(nodes.every(n => n.dataflow === true)).toBe(true)
  })
})
