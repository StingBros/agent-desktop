## MODIFIED Requirements

### Requirement: Spawn new agents
The toolkit SHALL let the orchestrator spawn a new `claude` agent pane in its
project with a given initial prompt and an optional working directory within the
project. The toolkit SHALL also accept an optional `goal`; when a `goal` is
provided, spawning SHALL create a Task for that goal and bind it to the new pane as
that pane's assignee (per the `coordinator-task-board` capability), and the spawned
worker SHALL be dispatched with the back-channel toolset attached and its Task id
stamped (per the worker-dispatch requirement below). The new agent's identity, and
the created Task's id when a `goal` was given, SHALL be returned to the
orchestrator.

#### Scenario: Orchestrator spawns an agent
- **WHEN** the orchestrator calls `spawn_agent` with a prompt
- **THEN** a new agent pane is launched in the orchestrator's project with that prompt as its initial input
- **AND** the new agent's identity is returned to the orchestrator

#### Scenario: Orchestrator spawns an agent with a goal
- **WHEN** the orchestrator calls `spawn_agent` with a prompt and a `goal`
- **THEN** a new agent pane is launched and a Task for that goal is created and bound to the pane
- **AND** the pane is dispatched with the back-channel toolset and its Task id stamped
- **AND** the new agent's identity and the created Task's id are returned

## ADDED Requirements

### Requirement: Coordinator task tools
The toolkit SHALL expose task tools to the orchestrator: `assign_task(goal,
specialist?)`, `list_tasks(state?)`, and `get_task(id)`. `assign_task` SHALL create
a Task, spawn a worker (composed from the specialist when one is given), bind the
Task to that worker as its assignee, dispatch the worker with the back-channel
toolset and its Task id stamped, and return the Task id. `list_tasks` SHALL return
the project's Tasks (optionally filtered by state) and `get_task` SHALL return a
single Task's details, so the orchestrator can plan off the Task board. All task
tools SHALL be scoped to the orchestrator's project.

#### Scenario: assign_task creates and dispatches
- **WHEN** the orchestrator calls `assign_task` with a goal
- **THEN** a Task is created, a worker is spawned and bound to it as assignee, the worker is dispatched with the back-channel toolset and its Task id stamped, and the Task id is returned

#### Scenario: assign_task with a specialist composes the worker
- **WHEN** the orchestrator calls `assign_task` with a goal and a specialist
- **THEN** the spawned worker is composed from that specialist's definition and bound to the created Task

#### Scenario: Orchestrator reads the board
- **WHEN** the orchestrator calls `list_tasks` (optionally with a state) or `get_task` with an id
- **THEN** the matching project Tasks, or the single Task's details, are returned

### Requirement: Worker dispatch wires the back-channel and Task contract
When the toolkit dispatches a worker for a Task (via `assign_task` or `spawn_agent`
with a `goal`), it SHALL attach the back-channel MCP adapter to that worker, stamp
the worker's environment with its Task id, and append to the worker's system prompt
a short instruction that it was dispatched Task `<id>` and must call `report_done`
when finished, `report_blocked` when stuck, and `ask_coordinator` to ask a
question. This dispatch SHALL NOT change how the worker renders — it remains a
`claude` CLI PTY pane.

#### Scenario: Dispatched worker is wired for the back-channel
- **WHEN** the toolkit dispatches a worker for a Task
- **THEN** the worker launches with the back-channel MCP attached, its Task id in its environment, and a system-prompt instruction to report via the back-channel tools

#### Scenario: Dispatch does not alter worker rendering
- **WHEN** a worker is dispatched for a Task
- **THEN** it still runs and renders as an ordinary `claude` CLI PTY pane
