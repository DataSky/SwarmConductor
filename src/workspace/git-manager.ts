import { spawnSync } from "child_process"

// ─── Git Workspace Manager ───────────────────────────────────────────────────
// Manages per-agent branches and merge strategy

export class GitWorkspaceManager {
  private projectPath: string
  private baseBranch: string

  constructor(projectPath: string, baseBranch = "main") {
    this.projectPath = projectPath
    this.baseBranch = baseBranch
  }

  private git(...args: string[]): string {
    const result = spawnSync("git", args, {
      cwd: this.projectPath,
      encoding: "utf8",
    })
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
    }
    return result.stdout.trim()
  }

  isGitRepo(): boolean {
    try {
      this.git("rev-parse", "--git-dir")
      return true
    } catch {
      return false
    }
  }

  currentBranch(): string {
    return this.git("rev-parse", "--abbrev-ref", "HEAD")
  }

  createAgentBranch(agentId: string, taskId: string): string {
    const branchName = `agent/${agentId.slice(0, 8)}/${taskId.slice(0, 8)}`
    this.git("checkout", "-b", branchName, this.baseBranch)
    return branchName
  }

  switchBranch(branch: string): void {
    this.git("checkout", branch)
  }

  stageAndCommit(message: string, agentId: string): void {
    this.git("add", "-A")
    this.git(
      "-c", `user.name=agent-${agentId.slice(0, 8)}`,
      "-c", "user.email=agent@swarm-conductor",
      "commit", "--allow-empty", "-m", message
    )
  }

  /** Try to merge agent branch into target. Returns true if clean merge. */
  tryMerge(agentBranch: string, targetBranch: string): { success: boolean; conflicts: string[] } {
    try {
      this.git("checkout", targetBranch)
      this.git("merge", "--no-ff", agentBranch, "-m", `merge: ${agentBranch}`)
      return { success: true, conflicts: [] }
    } catch {
      const conflictOutput = this.git("diff", "--name-only", "--diff-filter=U")
      const conflicts = conflictOutput.split("\n").filter(Boolean)
      this.git("merge", "--abort")
      return { success: false, conflicts }
    }
  }

  deleteBranch(branch: string): void {
    try {
      this.git("branch", "-D", branch)
    } catch {
      // ignore if already deleted
    }
  }

  createPhaseBranch(phase: number): string {
    const branch = `merge/phase-${phase}`
    try {
      this.git("checkout", "-b", branch, this.baseBranch)
    } catch {
      // already exists, just switch
      this.git("checkout", branch)
    }
    return branch
  }

  listAgentBranches(): string[] {
    const output = this.git("branch", "--list", "agent/*")
    return output.split("\n").map(b => b.replace(/^\*?\s+/, "")).filter(Boolean)
  }

  diff(from: string, to: string): string {
    return this.git("diff", "--stat", from, to)
  }
}
