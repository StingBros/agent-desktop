## ADDED Requirements

### Requirement: Task is a first-class project-scoped record
The system SHALL represent coordinator work as a first-class Task record scoped to
a project. Each Task SHALL carry a stable id, a goal, an optional assignee pane id,
an optional specialist, a lifecycle state, an optional result pointer, an optional
list of artifact references, an optional `parentTaskId`, and created/updated
timestamps. A Task is distinct from the pane that executes it: a pane MAY outlive
the Task assigned to it, and a Task's lifecycle SHALL be tracked independently of
pane liveness.

#### Scenario: Task carries its identifying fields
- **WHEN** a Task is created for a project
- **THEN** it has a stable id, a goal, a lifecycle state, and created/updated timestamps
- **AND** it records its assignee pane id and specialist when it has been assigned to a worker

#### Scenario: Task is independent of its pane
- **WHEN** a Task's assignee pane is closed but the Task has not reached a terminal state
- **THEN** the Task still exists as a record with its last non-terminal state until it is reconciled

### Requirement: Task lifecycle state machine
A Task's state SHALL be one of `assigned`, `working`, `blocked`, `input-required`,
`done`, or `failed`. `done` and `failed` SHALL be terminal. Transitions SHALL be
driven only by explicit signals (a coordinator action or a worker back-channel
report) or by reconciliation of a lost assignee (which SHALL move a non-terminal
Task to `failed`). The system SHALL NOT infer `done` from a worker merely going
idle.

#### Scenario: Report drives a transition
- **WHEN** a worker reports done for its Task
- **THEN** the Task transitions to `done`

#### Scenario: Idle is not completion
- **WHEN** a worker returns to its prompt without reporting a terminal state
- **THEN** its Task remains in its current non-terminal state and is NOT marked `done`

### Requirement: Task state persists as a per-project JSON snapshot
Task state SHALL persist to `.agent-desktop/coordinator-tasks.json` within the
project, a sibling of the existing project task/config storage. Writes SHALL be
atomic (write-temp-then-rename). When the file is absent, the project's Task board
SHALL be treated as empty. The stored format SHALL be human-readable JSON.

#### Scenario: Board persists across restart
- **WHEN** Tasks exist for a project and the app is restarted
- **THEN** the project's Task board is reloaded from `.agent-desktop/coordinator-tasks.json`

#### Scenario: Absent file is an empty board
- **WHEN** a project has no `.agent-desktop/coordinator-tasks.json`
- **THEN** the project's Task board is empty and creating a Task writes the file

### Requirement: Single-writer authority for Task state
All mutations to Task state SHALL be applied by a single writer — the frontend
orchestration executor. Back-channel reports and coordinator task operations SHALL
be routed to that writer rather than mutating storage directly, and mutations to a
single Task SHALL be serialized so concurrent reports to the same Task do not
interleave.

#### Scenario: Concurrent reports to one Task are serialized
- **WHEN** two back-channel reports target the same Task at nearly the same time
- **THEN** they are applied one after another by the single writer, not interleaved

#### Scenario: Reports do not mutate storage directly
- **WHEN** a worker sends a back-channel report
- **THEN** the Task board is changed only by the executor applying that report, and the JSON snapshot reflects the executor's computed state

### Requirement: Results and artifacts are stored by reference
A Task's inline `result` SHALL be a short summary bounded in size. Any larger output
SHALL be stored on disk under `.agent-desktop/artifacts/<taskId>/` and referenced
from the Task by path, so that Task records and back-channel payloads stay small
and within MCP output limits.

#### Scenario: Large result is stored by reference
- **WHEN** a worker reports done with output larger than the inline summary bound
- **THEN** the large output is written under `.agent-desktop/artifacts/<taskId>/` and the Task records a reference to it rather than the full content inline

### Requirement: Lost assignee reconciles to failed
When a Task's assignee pane exits or errors without the Task having reached a
terminal state, the system SHALL reconcile that Task to `failed` with a reason,
rather than leaving it indefinitely in a non-terminal state.

#### Scenario: Assignee dies mid-task
- **WHEN** the pane assigned to a non-terminal Task exits without a terminal report
- **THEN** the Task is reconciled to `failed` with a reason indicating the assignee was lost
