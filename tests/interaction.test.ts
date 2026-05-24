import { describe, it, expect, afterEach } from "bun:test"
import { loadTaskFile } from "../src/cli/task-file"
import { goalToTaskGraph } from "../src/cli/goal-planner"
import { writeFileSync, rmSync } from "fs"
import { join } from "path"

const TMP = join(process.cwd(), ".test-taskfile")

function writeYAML(name: string, content: string): string {
  const path = join(TMP, name)
  require("fs").mkdirSync(TMP, { recursive: true })
  writeFileSync(path, content)
  return path
}

afterEach(() => rmSync(TMP, { recursive: true, force: true }))

describe("loadTaskFile", () => {
  it("parses goal, agents, and simple task list", () => {
    const path = writeYAML("simple.yaml", `
goal: "Fix auth bugs"
agents: 3
phases:
  - name: explore
    tasks:
      - title: "Scan auth module"
        type: explore
        scope: ["src/auth"]
      - title: "Check test coverage"
        type: explore
`)
    const r = loadTaskFile(path)
    expect(r.goal).toBe("Fix auth bugs")
    expect(r.agents).toBe(3)
    expect(r.nodes).toHaveLength(2)
    expect(r.nodes[0]!.type).toBe("explore")
    expect(r.nodes[0]!.title).toBe("Scan auth module")
    expect(r.nodes[1]!.title).toBe("Check test coverage")
  })

  it("wires depends_on_phase correctly", () => {
    const path = writeYAML("deps.yaml", `
phases:
  - name: explore
    tasks:
      - title: "Task A"
        type: explore
      - title: "Task B"
        type: explore
  - name: implement
    tasks:
      - title: "Task C"
        type: implement
        depends_on_phase: explore
`)
    const r = loadTaskFile(path)
    expect(r.nodes).toHaveLength(3)
    const c = r.nodes.find(n => n.title === "Task C")!
    const aId = r.nodes.find(n => n.title === "Task A")!.id
    const bId = r.nodes.find(n => n.title === "Task B")!.id
    expect(c.dependsOn).toContain(aId)
    expect(c.dependsOn).toContain(bId)
  })

  it("wires depends_on by title", () => {
    const path = writeYAML("title-dep.yaml", `
phases:
  - name: all
    tasks:
      - title: "Explore"
        type: explore
      - title: "Plan"
        type: plan
        depends_on: ["Explore"]
      - title: "Implement"
        type: implement
        depends_on: ["Plan"]
`)
    const r = loadTaskFile(path)
    const explore = r.nodes.find(n => n.title === "Explore")!
    const plan    = r.nodes.find(n => n.title === "Plan")!
    const impl    = r.nodes.find(n => n.title === "Implement")!
    expect(plan.dependsOn).toContain(explore.id)
    expect(impl.dependsOn).toContain(plan.id)
    expect(impl.dependsOn).not.toContain(explore.id)
  })

  it("uses default prompt when prompt is omitted", () => {
    const path = writeYAML("noprompt.yaml", `
phases:
  - name: p
    tasks:
      - title: "Do something"
        type: implement
`)
    const r = loadTaskFile(path)
    expect(r.nodes[0]!.prompt).toContain("Do something")
    expect(r.nodes[0]!.prompt).toContain("## SUMMARY")
  })

  it("throws on unknown depends_on title", () => {
    const path = writeYAML("bad-dep.yaml", `
phases:
  - name: p
    tasks:
      - title: "Task A"
        type: implement
        depends_on: ["Nonexistent Task"]
`)
    expect(() => loadTaskFile(path)).toThrow('depends_on unknown title: "Nonexistent Task"')
  })

  it("throws on unknown depends_on_phase", () => {
    const path = writeYAML("bad-phase.yaml", `
phases:
  - name: p
    tasks:
      - title: "Task A"
        type: implement
        depends_on_phase: ghost
`)
    expect(() => loadTaskFile(path)).toThrow('Unknown phase: "ghost"')
  })
})

describe("goalToTaskGraph", () => {
  it("produces explore → plan → implement+review → verify", () => {
    const r = goalToTaskGraph("Refactor auth module", "/tmp/project")
    expect(r.nodes).toHaveLength(5)

    const types = r.nodes.map(n => n.type)
    expect(types).toContain("explore")
    expect(types).toContain("plan")
    expect(types).toContain("implement")
    expect(types).toContain("review")
    expect(types).toContain("verify")
  })

  it("plan depends on explore", () => {
    const r = goalToTaskGraph("Fix something", "/tmp")
    const explore = r.nodes.find(n => n.type === "explore")!
    const plan    = r.nodes.find(n => n.type === "plan")!
    expect(plan.dependsOn).toContain(explore.id)
  })

  it("implement depends on plan", () => {
    const r = goalToTaskGraph("Fix something", "/tmp")
    const plan = r.nodes.find(n => n.type === "plan")!
    const impl = r.nodes.find(n => n.type === "implement")!
    expect(impl.dependsOn).toContain(plan.id)
  })

  it("verify depends on both implement and review", () => {
    const r = goalToTaskGraph("Fix something", "/tmp")
    const impl   = r.nodes.find(n => n.type === "implement")!
    const review = r.nodes.find(n => n.type === "review")!
    const verify = r.nodes.find(n => n.type === "verify")!
    expect(verify.dependsOn).toContain(impl.id)
    expect(verify.dependsOn).toContain(review.id)
  })

  it("all prompts contain 5-section contract", () => {
    const r = goalToTaskGraph("Build feature X", "/tmp")
    for (const n of r.nodes) {
      expect(n.prompt).toContain("## SUMMARY")
    }
  })
})
