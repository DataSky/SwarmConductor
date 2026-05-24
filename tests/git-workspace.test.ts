/**
 * Git workspace isolation tests.
 * Tests per-agent branch creation, commit, and merge strategy.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { GitWorkspaceManager } from "../src/workspace/git-manager"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { spawnSync } from "child_process"

const REPO_DIR = join(process.cwd(), ".test-git-workspace")

function git(...args: string[]) {
  return spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf8" })
}

beforeAll(() => {
  rmSync(REPO_DIR, { recursive: true, force: true })
  mkdirSync(REPO_DIR, { recursive: true })
  git("init")
  git("config", "user.email", "test@swarm")
  git("config", "user.name", "SwarmTest")
  // Initial commit
  writeFileSync(join(REPO_DIR, "README.md"), "# Test Repo\n")
  git("add", "-A")
  git("commit", "-m", "init")
  // Rename default branch to main
  git("branch", "-m", "main")
})

afterAll(() => {
  rmSync(REPO_DIR, { recursive: true, force: true })
})

describe("GitWorkspaceManager", () => {
  it("detects a git repo", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)
    expect(mgr.isGitRepo()).toBe(true)
  })

  it("returns current branch as main", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)
    expect(mgr.currentBranch()).toBe("main")
  })

  it("creates and switches to agent branch", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)
    const branch = mgr.createAgentBranch("agent-abc123", "task-xyz789")
    expect(branch).toMatch(/^agent\//)
    expect(mgr.currentBranch()).toBe(branch)
    // Clean up: switch back to main
    mgr.switchBranch("main")
  })

  it("commits changes on agent branch", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)
    const branch = mgr.createAgentBranch("agent-commit01", "task-c01")

    writeFileSync(join(REPO_DIR, "feature.ts"), "export const x = 1\n")
    mgr.stageAndCommit("feat: add feature.ts", "agent-commit01")

    const log = git("log", "--oneline", "-1")
    expect(log.stdout).toContain("feat: add feature.ts")

    mgr.switchBranch("main")
    mgr.deleteBranch(branch)
  })

  it("merges agent branch into phase branch cleanly", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)
    const agentBranch = mgr.createAgentBranch("agent-merge01", "task-m01")

    writeFileSync(join(REPO_DIR, "merged.ts"), "export const merged = true\n")
    mgr.stageAndCommit("feat: add merged.ts", "agent-merge01")
    mgr.switchBranch("main")

    const phaseBranch = mgr.createPhaseBranch(1)
    const result = mgr.tryMerge(agentBranch, phaseBranch)

    expect(result.success).toBe(true)
    expect(result.conflicts).toHaveLength(0)

    mgr.switchBranch("main")
    mgr.deleteBranch(agentBranch)
    mgr.deleteBranch(phaseBranch)
  })

  it("detects merge conflict and aborts cleanly", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)

    // Create conflicting content on two branches
    const branchA = mgr.createAgentBranch("agent-conflict-a", "task-ca")
    writeFileSync(join(REPO_DIR, "conflict.ts"), "export const val = 'from-A'\n")
    mgr.stageAndCommit("feat: A version", "agent-ca")
    mgr.switchBranch("main")

    const branchB = mgr.createAgentBranch("agent-conflict-b", "task-cb")
    writeFileSync(join(REPO_DIR, "conflict.ts"), "export const val = 'from-B'\n")
    mgr.stageAndCommit("feat: B version", "agent-cb")
    mgr.switchBranch("main")

    // Merge A first (clean)
    const phaseBranch = mgr.createPhaseBranch(2)
    const resultA = mgr.tryMerge(branchA, phaseBranch)
    expect(resultA.success).toBe(true)

    // Now merge B — should conflict
    mgr.switchBranch(phaseBranch)
    const resultB = mgr.tryMerge(branchB, phaseBranch)
    expect(resultB.success).toBe(false)
    expect(resultB.conflicts).toContain("conflict.ts")

    // Should be back on phase branch cleanly (merge --abort was called)
    expect(mgr.currentBranch()).toBe(phaseBranch)

    mgr.switchBranch("main")
    mgr.deleteBranch(branchA)
    mgr.deleteBranch(branchB)
    mgr.deleteBranch(phaseBranch)
  })

  it("lists all agent branches", () => {
    const mgr = new GitWorkspaceManager(REPO_DIR)
    const suffix = Date.now().toString(36)
    const brA = mgr.createAgentBranch(`agentLA-${suffix}`, `taskLA-${suffix}`)
    mgr.switchBranch("main")
    const brB = mgr.createAgentBranch(`agentLB-${suffix}`, `taskLB-${suffix}`)
    mgr.switchBranch("main")

    const branches = mgr.listAgentBranches()
    expect(branches).toContain(brA)
    expect(branches).toContain(brB)

    for (const b of [brA, brB]) mgr.deleteBranch(b)
  })
})
