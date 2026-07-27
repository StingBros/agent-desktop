## ADDED Requirements

### Requirement: Back-channel toolset attached only to Task-dispatched workers
The system SHALL provide a worker back-channel toolset exposed over a bundled
stdio MCP adapter, attached to a `claude` worker only when that worker is
dispatched with a Task. The toolset SHALL expose `report_progress`, `report_done`,
`report_blocked`, and `ask_coordinator`. A worker not dispatched with a Task (for
example a session the user started by hand) SHALL NOT have the back-channel
toolset attached.

#### Scenario: Dispatched worker gets the toolset
- **WHEN** the coordinator dispatches a worker bound to a Task
- **THEN** that worker's `claude` session has the back-channel toolset available

#### Scenario: Undispatched session has no toolset
- **WHEN** the user starts a `claude` session by hand (no Task)
- **THEN** that session does not have the back-channel toolset

### Requirement: Back-channel calls are scoped to their Task and fail closed
Each back-channel call SHALL be stamped with the worker's Task id (sourced from the
worker's environment) and routed over the app control channel to the single-writer
executor. A call whose Task id cannot be resolved, or that targets a Task outside
the worker's project, SHALL be rejected with a structured error and SHALL NOT
mutate any Task.

#### Scenario: Call is stamped with its Task
- **WHEN** a worker invokes a back-channel tool
- **THEN** the call carries the worker's Task id and is delivered to the executor for that Task

#### Scenario: Unresolvable or cross-project call is rejected
- **WHEN** a back-channel call has no resolvable Task id, or names a Task in another project
- **THEN** the call is rejected with a structured error and no Task is mutated

### Requirement: report_progress records progress without ending the Task
`report_progress(note)` SHALL append a progress note to the worker's Task and keep
the Task in its `working` state. By default a progress note SHALL update the Task
board only and SHALL NOT push a notification to the coordinator.

#### Scenario: Progress note updates the board
- **WHEN** a worker calls `report_progress` with a note
- **THEN** the note is recorded on its Task and the Task stays `working`

### Requirement: report_done is the authoritative completion signal
`report_done(result, artifacts?)` SHALL transition the worker's Task to the terminal
`done` state, record the result (by reference when large, per the task-board
storage rules), and be the authoritative completion signal for that Task. The
system SHALL treat the worker's `Stop` turn-boundary as a hint to reconcile — never
as completion — so a Task becomes `done` only via `report_done`.

#### Scenario: report_done completes the Task
- **WHEN** a worker calls `report_done` with a result
- **THEN** its Task transitions to `done` and the result (or a reference to it) is recorded

#### Scenario: Stop hook does not complete the Task
- **WHEN** a dispatched worker emits a `Stop` turn-boundary without calling `report_done`
- **THEN** its Task is NOT marked `done` by that signal

### Requirement: report_blocked marks a Task blocked
`report_blocked(reason)` SHALL transition the worker's Task to `blocked` and record
the reason, and SHALL notify the coordinator so it can act.

#### Scenario: Worker reports blocked
- **WHEN** a worker calls `report_blocked` with a reason
- **THEN** its Task transitions to `blocked`, the reason is recorded, and the coordinator is notified

### Requirement: ask_coordinator routes a question to the coordinator only
`ask_coordinator(question)` SHALL record the question on the worker's Task
(moving it to `input-required`) and notify the coordinator so the coordinator can
answer via its existing agent-messaging tool. This tool SHALL NOT intercept a
worker's `AskUserQuestion`, SHALL NOT answer questions on the user's behalf, and
SHALL NOT escalate to the user — those governance behaviors are out of scope for
this capability.

#### Scenario: Question reaches the coordinator
- **WHEN** a worker calls `ask_coordinator` with a question
- **THEN** the question is recorded on its Task, the Task moves to `input-required`, and the coordinator is notified so it can reply via message

#### Scenario: No user escalation
- **WHEN** a worker calls `ask_coordinator`
- **THEN** the user is not prompted and the worker's own `AskUserQuestion` flow is unaffected

### Requirement: Reports push to the coordinator when it is idle
When the executor applies a back-channel report that warrants coordinator action
(`report_done`, `report_blocked`, `ask_coordinator`), it SHALL notify the
coordinator by injecting a compact structured line into the coordinator's session
when the coordinator is idle, reusing the existing idle-gated injection. When the
coordinator is not idle, the notification MAY be deferred; the Task board SHALL
remain the durable record so the coordinator can reconcile from it on its next
turn. A notification that is deferred or dropped SHALL NOT lose the underlying Task
state change.

#### Scenario: Idle coordinator is pushed a report
- **WHEN** a report warranting action is applied and the coordinator is idle
- **THEN** a compact structured line describing the report is injected into the coordinator's session

#### Scenario: Busy coordinator relies on the durable board
- **WHEN** a report warranting action is applied while the coordinator is busy
- **THEN** the Task board still reflects the change and the coordinator can reconcile it via a task-read tool on its next turn
- **AND** the Task state change is not lost
