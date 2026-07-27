## 1. Task model & board store (frontend)

- [x] 1.1 Define the `Task` type and lifecycle states (`assigned | working | blocked | input-required | done | failed`) plus the transition helper in a new `src/lib/orchestration/tasks.ts` (pure, framework-free), with unit tests for legal/illegal transitions and terminal-state rules.
- [x] 1.2 Add a reactive task-board store `src/lib/orchestration/taskBoard.svelte.ts`: in-memory `Record<projectId, Task[]>`, selectors (`listTasks(projectId, state?)`, `getTask(projectId, id)`), and mutators that the executor calls. Tests for selectors + mutation ordering.
- [x] 1.3 Implement id generation and artifact-reference helpers (result-summary size cap; large results resolve to `.agent-desktop/artifacts/<taskId>/…` paths). Tests for the size-cap/by-reference boundary.

## 2. Per-project JSON persistence (Rust)

- [x] 2.1 Add Rust commands `coordinator_tasks_load(projectPath)` and `coordinator_tasks_save(projectPath, json)` in `src-tauri/src/lib.rs` (or a small `tasks_store.rs`), writing `.agent-desktop/coordinator-tasks.json` with atomic tmp+rename (reuse the statusline snapshot write pattern). Register in the handler.
- [x] 2.2 Add an artifacts writer that persists a large result under `.agent-desktop/artifacts/<taskId>/` and returns its relative path. Rust unit/integration test for atomic write + reload round-trip.
- [x] 2.3 Wire the board store to load on project activation and persist (debounced) after each mutation via the new commands.

## 3. Back-channel MCP sidecar

- [x] 3.1 Create `src-tauri/resources/back-channel-mcp.cjs` — a stdio MCP server exposing `report_progress`, `report_done`, `report_blocked`, `ask_coordinator`, mirroring the structure of `orchestration-mcp.cjs`. It reads `AGENT_DESKTOP_TASK_ID` (+ project/pane env) and stamps them onto every forwarded call; forwards over the control socket; fails closed with a structured error when the Task id is unresolved.
- [x] 3.2 Add a `back-channel-mcp.test.ts` covering arg stamping, the four tools' request shapes, and the fail-closed path.
- [x] 3.3 Install the new sidecar alongside the existing baked resources (extend `install_usage_assets` / resource baking in `src-tauri/src/lib.rs`); expose its installed path for launch wiring.

## 4. Control-socket routing (Rust)

- [x] 4.1 Extend `src-tauri/src/orchestration.rs` / `ipc.rs` to accept the new back-channel ops, assign request ids, and route replies as today. Serialize per **Task id** (extend `TargetQueues` keying) so concurrent reports to one Task don't interleave; different Tasks run concurrently.
- [x] 4.2 Deliver back-channel requests to the frontend via the existing `orchestration://request` event; confirm `orchestration_reply` returns results/errors. Add/extend Rust tests for id routing and per-Task serialization.

## 5. Executor: single-writer task logic (frontend)

- [x] 5.1 In `src/lib/orchestration/executor.svelte.ts`, handle the new back-channel ops (`report_progress/done/blocked/ask_coordinator`) as the **single writer**: validate project + Task scope (fail closed), apply the lifecycle transition, persist, and (for done/blocked/ask) trigger the coordinator notification.
- [x] 5.2 Implement `report_done` as authoritative completion (terminal `done` + result/artifact recording); ensure the `Stop` hook is treated only as a reconcile hint, never as completion.
- [x] 5.3 Implement lost-assignee reconciliation: when an assignee pane exits/errors while its Task is non-terminal, mark the Task `failed` with a reason (hook into the existing pane-exit signal).
- [x] 5.4 Extend `executor.svelte.test.ts`: report handling, scope rejection, transitions, authoritative completion vs Stop, reconcile-on-exit, single-writer serialization.

## 6. Coordinator task tools & spawn goal (frontend)

- [x] 6.1 Add `assign_task(goal, specialist?)`, `list_tasks(state?)`, `get_task(id)` to the coordinator toolkit (`orchestration-mcp.cjs` tool list + executor dispatch), all project-scoped. `assign_task` creates a Task, spawns+binds a worker, dispatches it, and returns the Task id.
- [x] 6.2 Add optional `goal` to `spawn_agent`; when present, auto-create+assign a Task and dispatch the worker. Return the pane identity and Task id.
- [x] 6.3 Tests for the new tools: creation, binding, project scoping, and the `spawn_agent(goal)` shortcut.

## 7. Worker dispatch wiring (launch)

- [x] 7.1 Extend `src/lib/orchestration/launchArgs.ts` and `src/lib/usage/spawn.ts` to, when dispatching a Task-bound worker, attach the back-channel MCP (`--mcp-config`), stamp `AGENT_DESKTOP_TASK_ID` in env, and append the Task-contract instruction to the worker's system prompt — without altering worker rendering.
- [x] 7.2 Ensure the back-channel MCP is attached ONLY for Task-dispatched workers (not plain user sessions, not the coordinator). Update `src/lib/launcher/plan.ts` as needed for the env/args plumbing.
- [x] 7.3 Tests in `launchArgs.test.ts` for: back-channel attached on dispatch, absent otherwise, Task id stamped, prompt contract appended, specialist composition preserved.

## 8. Push-when-idle notification

- [x] 8.1 Implement the coordinator notification in the executor: on `report_done/blocked/ask_coordinator`, inject a compact structured line into the coordinator pane when idle (reuse the existing idle-gated injection); defer when busy without losing board state.
- [x] 8.2 Default `report_progress` to board-only (no push). Tests for idle-push, busy-defer (board still authoritative), and progress-not-pushed.

## 9. Coordinator prompt & behavior

- [x] 9.1 Rewrite `ORCHESTRATOR_SYSTEM_PROMPT` in `src/lib/orchestration/coordinator.ts` to drive off the Task board and pushed structured reports (create Tasks, react to done/blocked/ask, answer via `message_agent`, verify via `read_agent` when needed) instead of a poll loop. Keep the coordinator a chat surface.
- [x] 9.2 Confirm coordinator launch attaches the task tools; update `coordinator.svelte.ts`/`launchArgs` if the toolkit config needs it. Update `coordinator.test.ts` for the new prompt/launch expectations.

## 10. Roster attribution (backend-first UI)

- [x] 10.1 Surface each worker's current Task and state in `src/lib/overview/roster.ts` attribution (reuse existing specialist/coordinator attribution; no dedicated board panel). Test the attribution derivation.

## 11. Integration & close-out

- [x] 11.1 End-to-end test (frontend, mocked transport): coordinator `assign_task` → worker dispatched with back-channel → worker `report_done` → Task `done` + coordinator pushed when idle → `list_tasks` reflects state.
- [x] 11.2 Run the full suite (`yarn test` / `cargo test`) and lint; fix regressions. Verify no change to plain-session or existing coordinator behavior when no Task is assigned. — Frontend 1325 pass (1 flaky statusline timeout, passes in isolation). Rust 300 pass; 3 pre-existing env-sensitive git::tests failures (untouched module: master/main default-branch + Windows worktree temp dirs), not regressions.
- [ ] 11.3 `openspec validate add-coordinator-task-backchannel --strict`; reconcile any conversation drift into the specs/tasks; run the `adversarial-code-review` gate over the diff and resolve criticals.
