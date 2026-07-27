## Context

The app already runs a solid orchestration substrate: a per-project coordinator
(`role:'coordinator'` `claude` pane) drives worker panes through an MCP toolkit
(`orchestration-mcp.cjs`) that round-trips over a Rust control socket
(`src-tauri/src/orchestration.rs`) to the frontend `OrchestrationExecutor`, which
owns the pane registry and is the sole authority that spawns/messages/archives
panes. What's missing is *semantics*: there is no first-class task, no
authoritative completion signal (only the `Stop` hook, which means "went idle,"
indistinguishable from "task done"), and no way for a worker to speak back to the
coordinator. See `docs/a2a-coordination-deep-dive.md` §2–§5 for the full trace.

This design adds the missing semantics **on top of the existing transport**,
reusing its proven patterns (control socket, request/reply ids, per-target
serialization, env-stamped scoping), while preserving two hard constraints agreed
with the user: the coordinator stays a chat surface, and workers stay raw
`claude` CLI PTY panes.

## Goals / Non-Goals

**Goals:**
- A first-class, persisted **Task** with a lifecycle the coordinator plans off,
  replacing free-text prompts + transcript scraping as the unit of coordination.
- A worker **back-channel** so a worker reports progress/done/blocked and can ask
  the coordinator — via structured tool calls, not terminal restructuring.
- **Authoritative completion**: `report_done` sets a terminal Task state; stop
  guessing from `Stop`.
- **Autonomy**: the coordinator reacts to a worker's report without waiting for the
  user, via a pushed structured line when it is idle.
- Reuse the existing socket/executor/single-writer architecture; no new runtime,
  no change to PTY/event pipelines, no change to how workers render.

**Non-Goals (explicit):**
- Governance/escalation: auto-intercepting a worker's `AskUserQuestion`,
  `answer_question`, hybrid autonomy, hard guardrails — that is the separate,
  unbuilt `add-project-coordinator` (Phase 2). `ask_coordinator` here is plumbing
  only.
- Stream-json / Agent SDK transport, or a deterministic orchestration engine
  (Phase 3). Keystroke injection remains the delivery mechanism.
- SQLite or an event-sourced task log. Storage is a per-project JSON snapshot.
- A dedicated task-board panel UI. This change is backend-first; the roster shows
  task attribution only.

## Decisions

### D1 — Storage: per-project JSON snapshot, single writer
Task state persists to `.agent-desktop/coordinator-tasks.json` per project
(sibling to `tasks.json` / `config.json`), written by Rust with the atomic
tmp+rename pattern already used for the statusline snapshot. The frontend
`OrchestrationExecutor` is the **only** mutator; it computes the next board state
and calls a Rust `coordinator_tasks_save` command. Reads go through
`coordinator_tasks_load`.
- *Why:* matches existing `.agent-desktop/` convention, human-readable and
  git-diffable, trivially inspectable, and a per-project fleet is a handful of
  tasks — whole-file rewrite is cheap. Single-writer + Rust per-target
  serialization eliminates split-brain without a DB.
- *Alternatives:* event-sourced JSONL projection (more machinery than Phase 1
  needs; revisit if we want audit/replay); SQLite (real queries/transactions, but
  binary, migrations, overkill now — the escalation lever, not the start).

### D2 — Back-channel = a second child-side MCP adapter, mirroring the coordinator's
Add `src-tauri/resources/back-channel-mcp.cjs`, a stdio MCP server attached to
**coordinator-spawned workers** exactly as `orchestration-mcp.cjs` is attached to
the coordinator (via `--mcp-config`). It exposes `report_progress`, `report_done`,
`report_blocked`, `ask_coordinator`. Each call is forwarded over the existing Rust
control socket as a new op set, delivered to the executor via
`orchestration://request`, and answered via `orchestration_reply`.
- *Why:* reuses the entire transport, scoping, timeout, and reply-routing
  machinery already built and hardened; nothing new to invent on the wire.
- *Alternatives:* a hook (`Stop`/`PostToolUse`) writing a file the executor polls
  (loses intent + args, still polling); a raw socket protocol (re-implements what
  MCP+control-socket already give). Rejected.

### D3 — Task↔worker correlation via env stamp + prompt contract
On dispatch, the worker launch stamps `AGENT_DESKTOP_TASK_ID` (and reuses the
existing `AGENT_DESKTOP_PANE` / project env) and appends a short instruction to the
worker's system prompt: "You were dispatched Task `<id>`. Call `report_done` when
finished, `report_blocked` if stuck, `ask_coordinator` to ask a question." The
back-channel adapter reads `AGENT_DESKTOP_TASK_ID` from its env and stamps it onto
every call — mirroring how `orchestration-mcp.cjs` stamps `AGENT_DESKTOP_PROJECT_ID`.
- *Why:* consistent with the current scoping approach; keeps the worker a plain
  `claude` CLI pane that merely has extra tools.
- *Trade-off:* like the existing `projectId` stamping, this fails closed if the env
  is not set — mitigated in D7.

### D4 — Explicit `assign_task` + `spawn_agent(goal)` shortcut
`assign_task(goal, specialist?)` creates a Task, spawns a worker (composed from the
specialist when given), binds the Task to that pane, and returns the Task id.
`spawn_agent` gains an optional `goal`; when present it auto-creates and assigns a
Task. New read tools `list_tasks(state?)` and `get_task(id)` let the coordinator
plan off the board.
- *Why:* separates "a running pane" from "a unit of work" (a pane can outlive a
  task; a task has its own lifecycle) while keeping the one-call ergonomic path.
- *Alternative:* implicit (every `spawn_agent` = a task) — conflates the two and
  makes multi-task-per-agent awkward. Rejected.

### D5 — Push-when-idle notification, board as durable fallback
When the executor applies a worker report, it updates the board and then, if the
coordinator pane is idle, injects a compact structured line into the coordinator's
PTY (reusing the existing `message_agent` idle-gated injection), e.g.
`[task T3] researcher DONE — result: .agent-desktop/artifacts/T3/summary.md`. If
the coordinator is busy, the injection is deferred (existing serialization) and the
board still holds the truth, so the coordinator reconciles via `list_tasks` on its
next turn.
- *Why:* the coordinator is an LLM that only acts when it takes a turn; a push is
  what makes it react autonomously to a worker finishing. Idle-gating is acceptable
  because the coordinator is idle almost all the time.
- *Alternative:* pull-only (no autonomy) or a needs-input nudge (still needs a turn
  trigger). Push chosen; pull retained as the durable fallback.

### D6 — Authoritative completion; `Stop` demoted to a hint
`report_done` transitions the Task to `done` and is the authoritative signal. The
`Stop` hook is downgraded from "task done" to "worker may be idle — coordinator
should check the task": it can trigger a reconcile/notify but never marks a Task
done on its own. `read_agent` is unchanged and still available for the coordinator
to inspect a worker's transcript when it wants detail.

### D7 — Failure & orphan handling
- A worker whose assignee pane exits/errors without a terminal report has its Task
  reconciled to `failed` (with a reason) by the executor, using the existing pane
  exit signal. Prevents tasks stuck at `working` forever.
- Back-channel calls lacking a resolvable `AGENT_DESKTOP_TASK_ID`, or targeting a
  Task in another project, are rejected with a structured error (fail-closed,
  mirroring the executor's `projectId` guard). The back-channel MCP is only
  attached to panes that were dispatched with a Task, so a plain user session never
  gets these tools.
- `report_done`'s `result` string is capped (small summary); anything larger goes
  to `.agent-desktop/artifacts/<taskId>/…` and is referenced by path, keeping MCP
  payloads under the ~10k/~25k token caps.

### D8 — Concurrency
Back-channel ops are serialized **per Task id** using the existing Rust
`TargetQueues` mechanism (today keyed on `paneId`), so two reports to the same Task
never interleave; reports to different Tasks run concurrently. The executor remains
the single writer, so board mutations are applied in the order the socket delivers
them.

## Risks / Trade-offs

- **Worker doesn't call `report_done` (or calls it prematurely).** → The prompt
  contract + specialist template teach it; the `Stop`-hint reconcile nudges the
  coordinator to verify via `read_agent`; premature done is recoverable because the
  coordinator can reopen/assign a follow-up Task. We accept that completion is
  cooperative, not enforced (enforcement is Phase 2/3 territory).
- **Push injection into a busy coordinator is deferred/dropped.** → The board is the
  source of truth; deferred injections are queued (existing serialization) and the
  coordinator reconciles via `list_tasks`. No report is lost even if a nudge is.
- **Env-stamp fragility (D3), same class as today's `projectId` stamping.** → Fail
  closed with a clear error; attach the back-channel MCP only on Task dispatch so
  the tools are absent (not broken) when there's no Task.
- **JSON whole-file rewrite races.** → One file per project, Rust-serialized atomic
  writes, single frontend writer. Small files; contention is negligible at fleet
  scale.
- **Scope creep toward governance.** → `ask_coordinator` is deliberately plumbing
  only (notifies the coordinator); no `AskUserQuestion` interception or
  `answer_question`. The spec calls this boundary out so Phase 2 stays separate.

## Migration Plan

Additive, no data migration. If `.agent-desktop/coordinator-tasks.json` is absent,
the board starts empty. Existing coordinator/worker flows keep working when no Task
is assigned; the eight existing toolkit ops and `read_agent` are unchanged.
Rollback = revert the change; older builds simply ignore the new JSON file and the
new env var. The new bundled `back-channel-mcp.cjs` installs alongside the existing
sidecars and is only referenced when a worker is dispatched with a Task.

## Open Questions

- **Worker reuse:** `assign_task` always spawns a fresh worker in this change.
  Reusing an existing idle worker for a new Task is deferred (needs a
  "worker is free" notion beyond Task state).
- **Roster surfacing depth:** exact placement of Task/state attribution in the
  roster row is left to implementation within existing attribution; a dedicated
  board panel is out of scope.
- **`report_progress` frequency:** whether progress notes should ever push to the
  coordinator (vs. board-only) — default is board-only to avoid nagging; revisit
  with usage.
