## Why

The per-project coordinator cannot reliably coordinate a fleet because it has no
structured link to the agents it delegates to. Today it drives workers by typing
into their PTY (idle-gated, best-effort) and learns their state only by scraping
the last few assistant messages out of a transcript. There is **no first-class
task**, and **no authoritative completion signal** — the only turn boundary is the
`Stop` hook, which means "went idle," which is indistinguishable from "task done."
So the coordinator *guesses* when work is finished, and workers have no way to
report progress, hand back a result, or ask the coordinator anything. This change
gives the coordinator real, structured coordination while keeping the coordinator
a chat surface and workers raw `claude` CLI panes. (Phase 1 of
`docs/a2a-coordination-deep-dive.md`.)

## What Changes

- **First-class Task object with a lifecycle**, persisted per project as a JSON
  snapshot at `.agent-desktop/coordinator-tasks.json` (sibling to the existing
  `tasks.json` / `config.json`). States: `assigned → working → blocked →
  input-required → done → failed`. Fields include a stable id, goal, assignee
  paneId, specialist, a result pointer, artifact references, `parentTaskId`, and
  timestamps. Large results/artifacts are stored **by reference on disk**, never
  inline (to respect MCP output caps).
- **A worker back-channel MCP toolset** — a second bundled stdio MCP adapter,
  attached to coordinator-spawned workers the same way the orchestration adapter
  is attached to the coordinator. Tools: `report_progress(note)`,
  `report_done(result, artifacts?)`, `report_blocked(reason)`, and
  `ask_coordinator(question)`. Calls route worker → Rust control socket → the
  frontend `OrchestrationExecutor`, which is the **single writer** of Task state.
- **Push-when-idle coordination.** When a worker reports, the executor updates the
  Task board and, if the coordinator is idle, injects a compact structured line
  into the coordinator's chat so it reacts autonomously (assigns the next step,
  answers a question via `message_agent`, etc.) rather than only when the user
  prompts it. `ask_coordinator` notifies the coordinator to answer — it does
  **not** intercept a worker's `AskUserQuestion` or escalate to the user (that is
  Phase 2).
- **Authoritative completion.** `report_done` writes a terminal Task state; the
  coordinator stops inferring completion from `Stop`. `read_agent` is retained.
- **Explicit task creation with a spawn shortcut.** A new coordinator tool
  `assign_task(goal, specialist?)` creates a Task and spawns/binds a worker;
  `spawn_agent` gains an optional `goal` that auto-creates and assigns a Task. New
  coordinator-facing read tools `list_tasks` / `get_task` let it plan off the
  board.
- **Worker dispatch teaches the contract.** When the coordinator assigns work, the
  spawned worker's launch attaches the back-channel MCP, stamps the Task id/env,
  and appends a short instruction: "you were dispatched Task `<id>`; call
  `report_done` when finished, `report_blocked` if stuck, `ask_coordinator` to
  ask." Workers still render and behave as raw `claude` CLI panes.
- **Coordinator system prompt rewritten** (`ORCHESTRATOR_SYSTEM_PROMPT`) to drive
  off the Task board and structured signals instead of the current poll loop.
- **Roster attribution.** The roster surfaces each worker's current Task and state
  (reusing existing attribution), so the fleet is legible. A dedicated task-board
  panel UI is intentionally deferred (backend-first).

Out of scope (explicit): the governance/escalation layer — automatic interception
of a worker's `AskUserQuestion`, `answer_question`, hybrid autonomy, and hard
guardrails — which remains the separate, unbuilt `add-project-coordinator` change
(Phase 2). Also out: stream-json / Agent SDK transport and a deterministic
orchestration engine (Phase 3), SQLite storage, and any change to how workers
render.

## Capabilities

### New Capabilities
- `coordinator-task-board`: the first-class Task model, its lifecycle state
  machine, per-project JSON persistence at `.agent-desktop/coordinator-tasks.json`,
  single-writer authority, and artifact-by-reference storage.
- `agent-back-channel`: the worker-side MCP toolset (`report_progress`,
  `report_done`, `report_blocked`, `ask_coordinator`) and its transport from a
  spawned worker back to the executor, including push-when-idle notification of
  the coordinator.

### Modified Capabilities
- `agent-orchestration-runtime`: add coordinator-facing task tools (`assign_task`,
  `list_tasks`, `get_task`), an optional `goal` on `spawn_agent`, attachment of
  the back-channel MCP + Task-id env stamping to spawned workers, and
  authoritative Task completion via `report_done` (replacing completion inference).
- `agent-coordinator-workflows`: the coordinator plans off the Task board and
  reacts to pushed structured signals rather than running a read/poll loop; its
  system prompt and launch wiring are updated accordingly.

## Impact

- **Frontend:** `src/lib/orchestration/{coordinator.ts, coordinator.svelte.ts,
  executor.svelte.ts, launchArgs.ts}` (new task ops, single-writer mutations,
  push-when-idle, prompt rewrite, worker launch wiring); `src/lib/usage/spawn.ts`
  and `src/lib/launcher/plan.ts` (attach back-channel MCP + stamp Task env on
  spawned workers); `src/lib/overview/roster.ts` (task attribution); a new
  task-board store module.
- **Bundled resources:** a new child-side `back-channel-mcp.cjs` under
  `src-tauri/resources/` (peer of `orchestration-mcp.cjs`), plus install wiring in
  `src-tauri/src/lib.rs`.
- **Rust backend:** `src-tauri/src/{orchestration.rs, ipc.rs, lib.rs}` (route the
  back-channel ops over the control socket; per-project task JSON read/write
  commands under `.agent-desktop/`). No change to the PTY/event pipeline.
- **Persistence:** new per-project file `.agent-desktop/coordinator-tasks.json` and
  an artifacts directory for by-reference results.
- **Compatibility:** additive. Existing coordinator/worker behavior continues to
  work if no Task is assigned; `read_agent` and the eight existing toolkit ops
  remain. No breaking changes to stored layout/projects formats.
