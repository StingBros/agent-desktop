## MODIFIED Requirements

### Requirement: Coordinator runs dynamic workflows over specialists and existing sessions
Given a goal, the coordinator SHALL orchestrate a dynamic, ephemeral workflow using
the toolkit — creating Tasks and spawning specialists for them, and reading /
messaging both those specialists and the user's existing project sessions —
iterating until the goal is met. The coordinator SHALL plan off the Task board:
it SHALL create Tasks for the work it delegates, drive progress by reacting to the
workers' structured back-channel reports (which are pushed to it when it is idle
and are otherwise readable via the task-read tools), and treat a Task's
`report_done` as the authoritative completion of that unit of work rather than
inferring completion from a worker going idle. The system SHALL persist Task state
per project (per the `coordinator-task-board` capability) but SHALL NOT persist a
reusable workflow definition and SHALL NOT provide a visual workflow builder.

#### Scenario: Coordinator orchestrates specialists toward a goal
- **WHEN** the user gives the coordinator a goal
- **THEN** the coordinator creates Tasks and spawns the needed specialists for them, and coordinates them via the toolkit until the goal is met

#### Scenario: Coordinator advances on a structured report
- **WHEN** a worker reports done or blocked via the back-channel
- **THEN** the coordinator advances the workflow based on that structured report (assigning the next Task, answering, or re-planning) rather than inferring state from scraped transcript text

#### Scenario: Coordinator weaves in an existing session
- **WHEN** a goal involves a `claude` session the user already started in the project
- **THEN** the coordinator can read and message that existing session as part of the workflow

#### Scenario: No stored or visual workflow
- **WHEN** a workflow completes
- **THEN** no reusable workflow definition is persisted and no builder UI is involved
- **AND** the Task board's per-project records are retained as the durable account of the work

### Requirement: Coordinator is a claude pane with the toolkit attached
The coordinator SHALL be a `claude` session running in a PTY pane bound to the
project, marked with a coordinator role. It MUST be launched with the
`agent-orchestration-runtime` toolkit attached — including the task tools
(`assign_task`, `list_tasks`, `get_task`) — and with an orchestrator system prompt
that defines its role: take a goal and plan, create Tasks, spawn and coordinate
specialists and existing sessions to accomplish it, and drive off the Task board
and pushed structured reports rather than a read/poll loop.

#### Scenario: Coordinator launch wiring
- **WHEN** a coordinator is started for a project
- **THEN** the launched pane runs `claude` with `cwd` inside the project and a coordinator role marker
- **AND** the orchestration toolkit, including the task tools, is configured for that session
- **AND** the orchestrator system prompt is applied

#### Scenario: Coordinator remains a chat surface
- **WHEN** the coordinator is running
- **THEN** it remains an interactive `claude` session the user can converse with, and driving Tasks does not remove or replace that chat interaction
