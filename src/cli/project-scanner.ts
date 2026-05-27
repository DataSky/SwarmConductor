import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const STACK_FILES = [
  "package.json", "tsconfig.json", "pyproject.toml",
  "go.mod", "Cargo.toml", "pom.xml",
]

const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".conductor",
  "__pycache__", "target", ".next", "coverage", ".turbo",
])

const MAX_TREE_LINES = 200
const MAX_DEPTH      = 4

/**
 * Produce a compact project-context string for the AI planner:
 *   ## Tech Stack   — detected config files + key package.json fields
 *   ## Directory Tree — depth-limited file tree, ≤200 lines
 *
 * Total output is kept under ~4000 chars (~1200 tokens) so it fits
 * comfortably in a planner prompt without crowding out the goal text.
 */
export function scanProjectContext(projectPath: string): string {
  const parts: string[] = []

  // ── Tech stack detection ──────────────────────────────────────────────────
  const detected: string[] = []
  const keyFields: string[] = []

  for (const sf of STACK_FILES) {
    if (!existsSync(join(projectPath, sf))) continue
    detected.push(sf)

    if (sf === "package.json") {
      try {
        const pkg = JSON.parse(readFileSync(join(projectPath, sf), "utf8")) as Record<string, unknown>
        if (typeof pkg["name"] === "string") keyFields.push(`name: ${pkg["name"]}`)
        if (pkg["scripts"] && typeof pkg["scripts"] === "object") {
          const scripts = Object.keys(pkg["scripts"] as object).slice(0, 6)
          if (scripts.length) keyFields.push(`scripts: ${scripts.join(", ")}`)
        }
        const deps = Object.keys(
          (pkg["dependencies"] as Record<string,string> | undefined) ?? {}
        ).slice(0, 8)
        if (deps.length) keyFields.push(`deps: ${deps.join(", ")}`)
      } catch { /* malformed JSON — skip key fields */ }
    }
  }

  parts.push("## Tech Stack")
  parts.push(detected.length ? detected.join(", ") : "unknown")
  parts.push(...keyFields)

  // ── Directory tree ────────────────────────────────────────────────────────
  const treeLines: string[] = []

  function walk(dir: string, indent: string, depth: number): void {
    if (depth > MAX_DEPTH || treeLines.length >= MAX_TREE_LINES) return
    let entries: string[]
    try { entries = readdirSync(dir).sort() } catch { return }

    for (const name of entries) {
      if (treeLines.length >= MAX_TREE_LINES) return
      if (name.startsWith(".") || EXCLUDE_DIRS.has(name)) continue

      const full = join(dir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { continue }

      if (isDir) {
        treeLines.push(`${indent}${name}/`)
        walk(full, indent + "  ", depth + 1)
      } else {
        treeLines.push(`${indent}${name}`)
      }
    }
  }

  walk(projectPath, "", 0)

  parts.push("")
  parts.push("## Directory Tree")
  parts.push(...treeLines)

  return parts.join("\n")
}
