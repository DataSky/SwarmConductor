import { describe, it, expect } from "bun:test"
import { defaultConfig } from "../src/dag/types"

describe("M2 – ConductorConfig centralised limits", () => {
  it("defaultConfig includes all new limit fields with correct defaults", () => {
    const cfg = defaultConfig({ projectPath: "/tmp/test" })
    expect(cfg.maxContextEntries).toBe(5)
    expect(cfg.maxEntryChars).toBe(1_600)
    expect(cfg.maxOutputChars).toBe(80_000)
    expect(cfg.sqliteBusyTimeoutMs).toBe(5_000)
    expect(cfg.replayEventLimit).toBe(300)
    expect(cfg.sqlWorkerMaxRows).toBe(10_000)
  })

  it("custom values override all defaults", () => {
    const cfg = defaultConfig({
      projectPath: "/tmp/test",
      maxContextEntries: 10,
      maxEntryChars: 3_200,
      maxOutputChars: 160_000,
      sqliteBusyTimeoutMs: 10_000,
      replayEventLimit: 1_000,
      sqlWorkerMaxRows: 50_000,
    })
    expect(cfg.maxContextEntries).toBe(10)
    expect(cfg.maxEntryChars).toBe(3_200)
    expect(cfg.maxOutputChars).toBe(160_000)
    expect(cfg.sqliteBusyTimeoutMs).toBe(10_000)
    expect(cfg.replayEventLimit).toBe(1_000)
    expect(cfg.sqlWorkerMaxRows).toBe(50_000)
  })

  it("pre-existing defaults are unchanged", () => {
    const cfg = defaultConfig({ projectPath: "/tmp/test" })
    expect(cfg.maxConcurrentAgents).toBe(10)
    expect(cfg.fileLockTtlMs).toBe(300_000)
    expect(cfg.schedulerTickMs).toBe(500)
    expect(cfg.minStartIntervalMs).toBe(0)
    expect(cfg.maxStartsPerMinute).toBe(0)
  })
})
