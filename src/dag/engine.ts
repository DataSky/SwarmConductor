import type {
  TaskGraph,
  TaskNode,
  TaskType,
  TaskStatus,
  AgentRole,
  TaskOutput,
} from "./types"

// ─── Factory helpers ─────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID()
}

export function createTaskNode(
  partial: Pick<TaskNode, "type" | "title" | "prompt" | "scope"> &
    Partial<Omit<TaskNode, "id" | "status" | "createdAt" | "output" | "error" | "assignedTo" | "startedAt" | "completedAt" | "retryCount">>
): TaskNode {
  const roleForType: Record<TaskType, AgentRole> = {
    explore: "explore",
    plan: "plan",
    implement: "implementer",
    review: "review",
    verify: "verifier",
    merge: "general",
  }

  return {
    id: uuid(),
    status: "pending",
    priority: partial.priority ?? 50,
    dependsOn: partial.dependsOn ?? [],
    blocks: partial.blocks ?? [],
    assignedTo: null,
    role: partial.role ?? roleForType[partial.type],
    output: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    retryCount: 0,
    maxRetries: partial.maxRetries ?? 2,
    forkContext: partial.forkContext ?? false,
    tokenUsage: null,
    ...partial,
  }
}

export function createTaskGraph(projectPath: string): TaskGraph {
  return {
    id: uuid(),
    projectPath,
    tasks: new Map(),
    phase: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ─── DAG engine ──────────────────────────────────────────────────────────────

export class TaskDAG {
  private graph: TaskGraph
  private listeners: Array<(taskId: string, prev: TaskStatus, next: TaskStatus) => void> = []

  constructor(projectPath: string) {
    this.graph = createTaskGraph(projectPath)
  }

  get id() { return this.graph.id }
  get phase() { return this.graph.phase }
  get projectPath() { return this.graph.projectPath }

  // ── Mutation ────────────────────────────────────────────────────────────────

  addTask(node: TaskNode): void {
    if (this.graph.tasks.has(node.id)) {
      throw new Error(`Task ${node.id} already exists`)
    }
    this.graph.tasks.set(node.id, { ...node })
    // Wire reverse edges for existing deps (mirrors addTasks behaviour)
    for (const depId of node.dependsOn) {
      const dep = this.graph.tasks.get(depId)
      if (!dep) throw new Error(`Task ${node.id} depends on unknown task ${depId}`)
      if (!dep.blocks.includes(node.id)) dep.blocks.push(node.id)
    }
    this.recomputeStatus(node.id)
    this.touch()
  }

  /** Add multiple tasks at once, wiring up `blocks` arrays automatically. */
  addTasks(nodes: TaskNode[]): void {
    for (const node of nodes) {
      this.graph.tasks.set(node.id, { ...node })
    }
    // Wire reverse edges
    for (const node of nodes) {
      for (const depId of node.dependsOn) {
        const dep = this.graph.tasks.get(depId)
        if (!dep) throw new Error(`Task ${node.id} depends on unknown task ${depId}`)
        if (!dep.blocks.includes(node.id)) dep.blocks.push(node.id)
      }
    }
    for (const node of nodes) {
      this.recomputeStatus(node.id)
    }
    this.touch()
  }

  assign(taskId: string, agentId: string): void {
    this.transition(taskId, "running")
    const task = this.mustGet(taskId)
    task.assignedTo = agentId
    task.startedAt = Date.now()
  }

  complete(taskId: string, output: TaskOutput): void {
    const task = this.mustGet(taskId)
    task.output = output
    task.assignedTo = null
    task.completedAt = Date.now()
    this.transition(taskId, "done")
    this.unblockDownstream(taskId)
  }

  fail(taskId: string, error: string): void {
    const task = this.mustGet(taskId)
    task.error = error
    task.assignedTo = null

    if (task.retryCount < task.maxRetries) {
      task.retryCount++
      task.error = null
      task.startedAt = null
      this.transition(taskId, "ready")
    } else {
      task.completedAt = Date.now()
      this.transition(taskId, "failed")
      this.unblockDownstream(taskId)
    }
  }

  interrupt(taskId: string): void {
    const task = this.mustGet(taskId)
    task.assignedTo = null
    this.transition(taskId, "interrupted")
    this.unblockDownstream(taskId)
  }

  advancePhase(): void {
    this.graph.phase++
    this.touch()
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  getTask(id: string): TaskNode | undefined {
    return this.graph.tasks.get(id)
  }

  allTasks(): TaskNode[] {
    return Array.from(this.graph.tasks.values())
  }

  readyTasks(): TaskNode[] {
    return this.allTasks()
      .filter(t => t.status === "ready")
      .sort((a, b) => b.priority - a.priority)
  }

  runningTasks(): TaskNode[] {
    return this.allTasks().filter(t => t.status === "running")
  }

  isComplete(): boolean {
    return this.allTasks().every(
      t => t.status === "done" || t.status === "failed" || t.status === "interrupted"
    )
  }

  hasCriticalFailure(): boolean {
    return this.allTasks().some(
      t => t.status === "failed" && t.type !== "review"
    )
  }

  /**
   * Detect cycles among running tasks using DFS with 3‑color marking.
   * Returns the first cycle found (task IDs in cycle order), or empty array.
   *
   * A deadlock exists when running tasks form a circular dependency:
   *   A depends on B (directly or transitively) AND B depends on A.
   * Simple chains (A→B with both running) are NOT deadlocks —
   * they are normal concurrent execution with unmet dependencies.
   */
  detectDeadlock(): string[] {
    const running = this.runningTasks()
    if (running.length < 2) return []

    const runningIds = new Set(running.map(t => t.id))

    // Build adjacency: taskId → ids of running deps this task depends on
    const graph = new Map<string, string[]>()
    for (const t of running) {
      const runningDeps = t.dependsOn.filter(depId => runningIds.has(depId))
      if (runningDeps.length > 0) {
        graph.set(t.id, runningDeps)
      }
    }

    // No edges → no cycle possible
    if (graph.size === 0) return []

    // DFS with 3‑color marking
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    const parent = new Map<string, string>()

    for (const id of graph.keys()) {
      color.set(id, WHITE)
    }

    function dfs(node: string): string[] | null {
      color.set(node, GRAY)
      const neighbors = graph.get(node) ?? []
      for (const neighbor of neighbors) {
        const c = color.get(neighbor)
        if (c === GRAY) {
          // Found a back edge — reconstruct the cycle
          const cycle: string[] = [neighbor]
          let cur = node
          while (cur !== neighbor) {
            cycle.push(cur)
            cur = parent.get(cur)!
          }
          cycle.push(neighbor) // close the cycle
          cycle.reverse()
          return cycle
        }
        if (c === WHITE) {
          parent.set(neighbor, node)
          const result = dfs(neighbor)
          if (result) return result
        }
      }
      color.set(node, BLACK)
      return null
    }

    for (const id of graph.keys()) {
      if (color.get(id) === WHITE) {
        const cycle = dfs(id)
        if (cycle) return cycle
      }
    }

    return []
  }

  /** Checks if two scopes (file/dir lists) overlap — used for conflict detection.
   *  A conflict exists when any path in one list is equal to, or is a path-prefix
   *  ancestor/descendant of, any path in the other list.
   *  The "+ '/'" guard prevents "/src/auth" from incorrectly matching "/src/authz". */
  scopesConflict(a: string[], b: string[]): boolean {
    return b.some(pb =>
      a.some(pa =>
        pa === pb ||
        pa.startsWith(pb + "/") ||
        pb.startsWith(pa + "/")
      )
    )
  }

  /** Find running tasks whose scope conflicts with given scope. */
  conflictingRunning(scope: string[]): TaskNode[] {
    return this.runningTasks().filter(t => this.scopesConflict(t.scope, scope))
  }

  // ── Serialization ────────────────────────────────────────────────────────────

  toJSON(): object {
    return {
      ...this.graph,
      tasks: Array.from(this.graph.tasks.entries()),
    }
  }

  static fromJSON(data: ReturnType<TaskDAG["toJSON"]> & { tasks: [string, TaskNode][], id: string, projectPath: string, phase: number, createdAt: number, updatedAt: number }): TaskDAG {
    const dag = new TaskDAG(data.projectPath)
    dag.graph.id = data.id
    dag.graph.phase = data.phase
    dag.graph.createdAt = data.createdAt
    dag.graph.updatedAt = data.updatedAt
    dag.graph.tasks = new Map(data.tasks)
    return dag
  }

  // ── Subscriptions ────────────────────────────────────────────────────────────

  onStatusChange(cb: (taskId: string, prev: TaskStatus, next: TaskStatus) => void): void {
    this.listeners.push(cb)
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private mustGet(id: string): TaskNode {
    const task = this.graph.tasks.get(id)
    if (!task) throw new Error(`Task ${id} not found`)
    return task
  }

  private transition(id: string, next: TaskStatus): void {
    const task = this.mustGet(id)
    const prev = task.status
    if (prev === next) return
    task.status = next
    this.touch()
    for (const cb of this.listeners) cb(id, prev, next)
  }

  private recomputeStatus(id: string): void {
    const task = this.mustGet(id)
    if (task.status !== "pending" && task.status !== "blocked") return

    if (task.dependsOn.length === 0) {
      this.transition(id, "ready")
      return
    }

    // Unblock when every dependency has reached a terminal state
    // (done, failed, or interrupted), regardless of whether it succeeded.
    const allTerminal = task.dependsOn.every(depId => {
      const dep = this.graph.tasks.get(depId)
      return dep?.status === "done" || dep?.status === "failed" || dep?.status === "interrupted"
    })

    if (allTerminal) {
      this.transition(id, "ready")
    } else {
      this.transition(id, "blocked")
    }
  }

  private unblockDownstream(completedId: string): void {
    const task = this.mustGet(completedId)
    for (const blockId of task.blocks) {
      this.recomputeStatus(blockId)
    }
  }

  private touch(): void {
    this.graph.updatedAt = Date.now()
  }
}
