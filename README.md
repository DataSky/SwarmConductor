# Swarm Conductor

Multi-agent orchestration layer for [CodeWhale](https://codewhale.dev). Coordinates up to 10+ parallel AI coding agents on a single project using a task DAG, file-lock registry, shared memory bus, and deadlock-safe scheduler.

## Architecture

```
Conductor
├── TaskDAG          — directed acyclic graph of tasks with dependency resolution
├── AgentManager     — spawns / pools CodeWhale agent instances by role
├── FileLockRegistry — prevents scope conflicts between concurrent agents
├── SharedMemoryBus  — agents read/write context across tasks (3 layers)
└── GitWorkspaceManager — git repo detection, branch management
```

### Task lifecycle

```
pending → blocked → ready → running → done
                                   ↘ failed → (retry) → interrupted
```

### Agent roles

| Role | Task type |
|------|-----------|
| `explore` | file/structure scan |
| `plan` | generate implementation plan |
| `implementer` | write / modify code |
| `review` | code review |
| `verifier` | run tests, validate changes |
| `general` | merge, misc |

### Shared memory layers

| Layer | Purpose |
|-------|---------|
| `project_map` | global project structure, written once |
| `context` | per-task summaries shared across agents |
| `event_log` | audit trail of task completions and failures |

## Requirements

- [Bun](https://bun.sh) ≥ 1.0
- [CodeWhale](https://codewhale.dev) CLI installed and accessible as `codewhale`

## Install

```bash
git clone https://github.com/DataSky/SwarmConductor.git
cd SwarmConductor
bun install
```

## Usage

```bash
# Verify architecture with a sample DAG (no live agents needed)
bun run dev demo

# Target a real project with 5 agents
bun run dev demo --project /path/to/your/project --agents 5

# With auto-approve (skips human-in-the-loop confirmations)
bun run dev demo --project /path/to/your/project --auto-approve

# Custom codewhale binary path
bun run dev demo --bin /usr/local/bin/codewhale
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project <path>` | `cwd` | Target project directory |
| `--agents <n>` | `10` | Max concurrent agents |
| `--auto-approve` | `false` | Auto-approve all agent tool calls |
| `--bin <path>` | `codewhale` | Path to CodeWhale binary |

## Programmatic API

```typescript
import { Conductor } from "./src/conductor"
import { createTaskNode } from "./src/dag/engine"

const conductor = new Conductor({
  projectPath: "/your/project",
  maxConcurrentAgents: 5,
  basePort: 7878,
  fileLockTtlMs: 300_000,
  deadlockTimeoutMs: 300_000,
  schedulerTickMs: 500,
  autoApprove: false,
  codewhalebin: "codewhale",
})

await conductor.initialize()

// Build a DAG
const explore = createTaskNode({
  type: "explore",
  title: "Scan file structure",
  prompt: "List all source files and module boundaries.",
  scope: ["/your/project/src"],
  priority: 100,
})

const implement = createTaskNode({
  type: "implement",
  title: "Add feature X",
  prompt: "Implement feature X based on the exploration results.",
  scope: ["/your/project/src/feature-x"],
  priority: 80,
  dependsOn: [explore.id],
})

conductor.taskDag.addTasks([explore, implement])

// Listen to events
conductor.onEvent(e => console.log(e.kind, e.payload))

// Start scheduler (dispatches tasks to agents automatically)
conductor.startScheduler()
```

### Agent output contract

Each CodeWhale subagent must return output with these 5 sections:

```
## SUMMARY
## CHANGES
## EVIDENCE
## RISKS
## BLOCKERS
```

The conductor parses this structure and writes findings to the shared memory bus for downstream agents.

## Development

```bash
bun run typecheck   # type-check only
bun test            # run tests
bun run build       # bundle to dist/
```

## Status

**Milestone 1 complete** — DAG engine, scheduler, file-lock registry, shared memory bus, CodeWhale runtime client, git workspace manager, and CLI demo are all implemented and verified.

Next milestone: live agent dispatch against real CodeWhale instances.

## License

MIT
