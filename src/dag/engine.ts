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
    }
  }

  interrupt(taskId: string): void {
    const task = this.mustGet(taskId)
    task.assignedTo = null
    this.transition(taskId, "interrupted")
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

  /** Returns task IDs that form the detected cycle, empty if no cycle. */
  detectDeadlock(): string[] {
    const running = this.runningTasks()
    const runningIds = new Set(running.map(t => t.id))
    const cycle: string[] = []

    for (const task of running) {
      if (task.dependsOn.some(depId => runningIds.has(depId))) {
        cycle.push(task.id)
      }
    }
    return cycle
  }

  /** Checks if two scopes (file lists) overlap — used for conflict detection. */
  scopesConflict(a: string[], b: string[]): boolean {
    const setA = new Set(a)
    return b.some(f => setA.has(f))
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

    const allDone = task.dependsOn.every(depId => {
      const dep = this.graph.tasks.get(depId)
      return dep?.status === "done"
    })

    if (allDone) {
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
