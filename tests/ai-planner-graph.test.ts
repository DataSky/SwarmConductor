import { describe, it, expect, afterEach } from "bun:test"

// ─── We test buildGraph in isolation by exporting it or testing via the public API ──
// buildGraph is not exported, so we test aiGoalToTaskGraph with a mocked fetch
// and verify the full graph wiring behaviour.

// Minimal fake PlannerResponse shapes for buildGraph behaviour tests
interface FakePlan {
  description: string
  tasks: Array<{
    title: string
    type: string
    role?: string
    prompt: string
    scope: string[]
    priority: number
    dependsOn?: string[]
    forkContext?: boolean
  }>
}

// We need to reach buildGraph's logic. Since it's private, we re-implement
// the mapping logic here and assert on the public aiGoalToTaskGraph output.
// Alternatively we mock the DMXAPI call and validate nodes come back correctly.

// ── Mock fetch globally ────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch

function mockFetch(plan: FakePlan): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  ) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ─── Import after mock setup to avoid module-level fetch calls ────────────────
import { aiGoalToTaskGraph } from "../src/cli/ai-planner"

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("buildGraph dependsOn resolution", () => {
  it("exact title match wires dependency correctly", async () => {
    mockFetch({
      description: "test plan",
      tasks: [
        { title: "Explore codebase", type: "explore", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: ["src"], priority: 100 },
        { title: "Implement feature", type: "implement", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: ["src"], priority: 80, dependsOn: ["Explore codebase"] },
      ],
    })
    const result = await aiGoalToTaskGraph("test goal", "/tmp/proj")
    const explore = result.nodes.find(n => n.title === "Explore codebase")!
    const impl    = result.nodes.find(n => n.title === "Implement feature")!
    expect(explore).toBeDefined()
    expect(impl).toBeDefined()
    expect(impl.dependsOn).toContain(explore.id)
    expect(explore.blocks).toContain(impl.id)
  })

  it("case-insensitive normalize recovers mismatched casing", async () => {
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnMessages.push(String(args[0]))

    mockFetch({
      description: "test",
      tasks: [
        { title: "Explore Codebase", type: "explore", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: [], priority: 100 },
        { title: "Implement",        type: "implement", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: [], priority: 80, dependsOn: ["explore codebase"] },
      ],
    })
    const result = await aiGoalToTaskGraph("goal", "/tmp/proj")
    console.warn = origWarn

    const explore = result.nodes.find(n => n.title === "Explore Codebase")!
    const impl    = result.nodes.find(n => n.title === "Implement")!
    // Should have wired via normalize
    expect(impl.dependsOn).toContain(explore.id)
    // Should have emitted a warn
    expect(warnMessages.some(m => m.includes("normalized"))).toBe(true)
  })

  it("unknown dependsOn title emits warn but does NOT throw", async () => {
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnMessages.push(String(args[0]))

    mockFetch({
      description: "test",
      tasks: [
        { title: "Task A", type: "implement", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: [], priority: 50, dependsOn: ["NonExistent Task XYZ"] },
      ],
    })

    let result: Awaited<ReturnType<typeof aiGoalToTaskGraph>> | undefined
    expect(async () => {
      result = await aiGoalToTaskGraph("goal", "/tmp/proj")
    }).not.toThrow()

    console.warn = origWarn

    expect(result?.nodes).toHaveLength(1)
    expect(result?.nodes[0]!.dependsOn).toHaveLength(0)
    expect(warnMessages.some(m => m.includes("not found"))).toBe(true)
  })

  it("node count equals plan.tasks count even with broken deps", async () => {
    mockFetch({
      description: "test",
      tasks: [
        { title: "A", type: "explore",   prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: [], priority: 100 },
        { title: "B", type: "implement", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: [], priority: 80, dependsOn: ["MISSING"] },
        { title: "C", type: "review",    prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: [], priority: 60, dependsOn: ["A"] },
      ],
    })
    const result = await aiGoalToTaskGraph("goal", "/tmp/proj")
    expect(result.nodes).toHaveLength(3)
  })

  it("relative scope paths are resolved to absolute paths", async () => {
    mockFetch({
      description: "test",
      tasks: [
        { title: "T", type: "implement", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: ["src/auth.ts", "tests/auth.test.ts"], priority: 50 },
      ],
    })
    const result = await aiGoalToTaskGraph("goal", "/my/project")
    const node = result.nodes[0]!
    expect(node.scope).toContain("/my/project/src/auth.ts")
    expect(node.scope).toContain("/my/project/tests/auth.test.ts")
  })

  it("absolute scope paths are kept as-is", async () => {
    mockFetch({
      description: "test",
      tasks: [
        { title: "T", type: "implement", prompt: "p\n## SUMMARY\n## CHANGES\n## EVIDENCE\n## RISKS\n## BLOCKERS", scope: ["/already/absolute/path.ts"], priority: 50 },
      ],
    })
    const result = await aiGoalToTaskGraph("goal", "/my/project")
    expect(result.nodes[0]!.scope).toContain("/already/absolute/path.ts")
  })
})
