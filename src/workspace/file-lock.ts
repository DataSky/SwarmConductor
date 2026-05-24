import type { FileLock } from "../dag/types"

function normalizePath(p: string): string {
  // Simple normalization: resolve relative segments without node:path
  return p.replace(/\/+/g, "/").replace(/\/$/, "")
}

export class FileLockRegistry {
  private locks: Map<string, FileLock> = new Map()
  private ttlMs: number

  constructor(ttlMs = 300_000) {
    this.ttlMs = ttlMs
  }

  /** Try to acquire locks for all paths. Returns false if any is already held. */
  tryAcquire(paths: string[], agentId: string, taskId: string): boolean {
    this.evictExpired()
    const normalized = paths.map(p => normalizePath(p))

    for (const p of normalized) {
      if (this.locks.has(p)) return false
    }

    const now = Date.now()
    for (const p of normalized) {
      this.locks.set(p, {
        path: p,
        heldBy: agentId,
        taskId,
        acquiredAt: now,
        expiresAt: now + this.ttlMs,
      })
    }
    return true
  }

  releaseByTask(taskId: string): void {
    for (const [path, lock] of this.locks) {
      if (lock.taskId === taskId) this.locks.delete(path)
    }
  }

  releaseByAgent(agentId: string): void {
    for (const [path, lock] of this.locks) {
      if (lock.heldBy === agentId) this.locks.delete(path)
    }
  }

  isLocked(path: string): boolean {
    this.evictExpired()
    return this.locks.has(normalizePath(path))
  }

  conflicts(paths: string[]): FileLock[] {
    this.evictExpired()
    return paths
      .map(p => this.locks.get(normalizePath(p)))
      .filter((l): l is FileLock => l !== undefined)
  }

  allLocks(): FileLock[] {
    this.evictExpired()
    return Array.from(this.locks.values())
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [path, lock] of this.locks) {
      if (lock.expiresAt < now) this.locks.delete(path)
    }
  }
}
