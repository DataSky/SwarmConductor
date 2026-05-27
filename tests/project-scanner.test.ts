import { describe, it, expect, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { scanProjectContext } from "../src/cli/project-scanner"

const TMP = join(process.cwd(), ".test-scanner")

function setup(files: Record<string, string>): string {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })
  for (const [rel, content] of Object.entries(files)) {
    const full = join(TMP, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
  }
  return TMP
}

afterEach(() => rmSync(TMP, { recursive: true, force: true }))

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scanProjectContext", () => {
  it("detects package.json and extracts name/scripts/deps", () => {
    const dir = setup({
      "package.json": JSON.stringify({
        name: "my-project",
        scripts: { dev: "bun run dev", build: "bun build", test: "bun test" },
        dependencies: { typescript: "^5", zod: "^3" },
      }),
    })
    const out = scanProjectContext(dir)
    expect(out).toContain("package.json")
    expect(out).toContain("name: my-project")
    expect(out).toContain("scripts:")
    expect(out).toContain("dev")
    expect(out).toContain("deps:")
    expect(out).toContain("typescript")
  })

  it("detects multiple stack files", () => {
    const dir = setup({
      "package.json": JSON.stringify({ name: "x" }),
      "tsconfig.json": '{"compilerOptions":{}}',
    })
    const out = scanProjectContext(dir)
    expect(out).toContain("package.json")
    expect(out).toContain("tsconfig.json")
  })

  it("returns unknown for empty directory with no stack files", () => {
    const dir = setup({})
    const out = scanProjectContext(dir)
    expect(out).toContain("## Tech Stack")
    expect(out).toContain("unknown")
    expect(out).toContain("## Directory Tree")
  })

  it("does not throw on non-existent projectPath", () => {
    // A missing directory should not throw — walk handles the error
    expect(() => scanProjectContext("/nonexistent/path/12345")).not.toThrow()
  })

  it("excludes node_modules and .git from the tree", () => {
    const dir = setup({
      "src/index.ts": "",
      "node_modules/lodash/index.js": "",
      ".git/HEAD": "",
    })
    const out = scanProjectContext(dir)
    expect(out).not.toContain("node_modules")
    expect(out).not.toContain(".git")
    expect(out).toContain("src/")
  })

  it("directory tree does not exceed 200 lines", () => {
    // Create 250 files in src/
    const files: Record<string, string> = {}
    for (let i = 0; i < 250; i++) files[`src/file${i}.ts`] = ""
    const dir = setup(files)
    const out = scanProjectContext(dir)
    const treeSection = out.split("## Directory Tree")[1] ?? ""
    const lines = treeSection.split("\n").filter(l => l.trim())
    expect(lines.length).toBeLessThanOrEqual(200)
  })

  it("depth is capped at 4 levels", () => {
    const dir = setup({
      "a/b/c/d/e/deep.ts": "",  // depth 5 from root
      "a/b/c/shallow.ts": "",    // depth 3 — should appear
    })
    const out = scanProjectContext(dir)
    expect(out).toContain("shallow.ts")
    expect(out).not.toContain("deep.ts")
  })

  it("total output length stays under 8000 chars", () => {
    // Create a moderately complex project
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "big-project",
        scripts: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`script${i}`, "cmd"])),
        dependencies: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`dep${i}`, "1.0.0"])),
      }),
    }
    for (let i = 0; i < 100; i++) files[`src/module${i}/index.ts`] = ""
    const dir = setup(files)
    const out = scanProjectContext(dir)
    expect(out.length).toBeLessThanOrEqual(8000)
  })

  it("ignores dot-files and dot-directories", () => {
    const dir = setup({
      ".env": "SECRET=123",
      ".conductor/conductor.db": "",
      "src/main.ts": "",
    })
    const out = scanProjectContext(dir)
    expect(out).not.toContain(".env")
    expect(out).not.toContain(".conductor")
    expect(out).toContain("src/")
  })

  it("handles malformed package.json without throwing", () => {
    const dir = setup({ "package.json": "{ not valid json }" })
    expect(() => scanProjectContext(dir)).not.toThrow()
    const out = scanProjectContext(dir)
    expect(out).toContain("package.json")  // still detected, key fields just omitted
  })
})
