import { writeFileSync, readFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "fs"
import { join } from "path"
import type { MemoryEntry, MemoryLayerKind } from "../dag/types"

// ─── Shared Memory Bus ───────────────────────────────────────────────────────
// Three layers backed by filesystem (SQLite in later milestone)

export class SharedMemoryBus {
  private rootDir: string

  constructor(conductorDir: string) {
    this.rootDir = join(conductorDir, "memory")
    for (const layer of ["project_map", "context", "event_log"] as MemoryLayerKind[]) {
      mkdirSync(join(this.rootDir, layer), { recursive: true })
    }
  }

  write(entry: Omit<MemoryEntry, "id" | "timestamp">): MemoryEntry {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const full: MemoryEntry = { ...entry, id, timestamp: Date.now() }

    if (entry.layer === "event_log") {
      // append-only
      appendFileSync(
        join(this.rootDir, "event_log", "log.jsonl"),
        JSON.stringify(full) + "\n"
      )
    } else {
      const file = join(this.rootDir, entry.layer, `${id}.json`)
      writeFileSync(file, JSON.stringify(full, null, 2))
    }

    return full
  }

  readLayer(layer: MemoryLayerKind, tags?: string[]): MemoryEntry[] {
    const dir = join(this.rootDir, layer)
    if (!existsSync(dir)) return []

    if (layer === "event_log") {
      const logFile = join(dir, "log.jsonl")
      if (!existsSync(logFile)) return []
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l: string) => JSON.parse(l) as MemoryEntry)
        .filter((e: MemoryEntry) => !tags || tags.some(t => e.tags.includes(t)))
    }

    const entries: MemoryEntry[] = []
    try {
      const names = readdirSync(dir).filter(n => n.endsWith(".json"))
      for (const name of names) {
        const content = readFileSync(join(dir, name), "utf8")
        const entry = JSON.parse(content) as MemoryEntry
        if (!tags || tags.some(t => entry.tags.includes(t))) {
          entries.push(entry)
        }
      }
    } catch {
      // empty dir or unreadable
    }
    return entries.sort((a, b) => a.timestamp - b.timestamp)
  }

  /** Get the most recent project map summary. */
  getProjectMap(): MemoryEntry | null {
    const entries = this.readLayer("project_map")
    return entries[entries.length - 1] ?? null
  }

  /** Get context entries relevant to given tags. */
  getContext(tags: string[]): MemoryEntry[] {
    return this.readLayer("context", tags)
  }

  /** Get the last N event log entries. */
  getRecentEvents(n = 100): MemoryEntry[] {
    const all = this.readLayer("event_log")
    return all.slice(-n)
  }
}
