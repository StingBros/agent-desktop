# A2A coordination — deep dive & implementation options

Status: exploration / discussion doc. No code changes proposed yet.
Date: 2026-07-24.

## TL;DR

You have **already built the substrate** you described: specialists that are
`claude` terminals rooted in a folder, a per-project **coordinator** that spawns
and steers them over an MCP toolkit, and a real transport (MCP adapter → Rust
control socket → frontend executor → panes). The reason "orchestrator mode misses
the mark" is **not** a missing feature set — it's three structural gaps in the
*coordination layer*:

1. **The coordinator↔agent channel is simulated keystrokes + polling.**
   `message_agent` literally types text into a child's PTY (idle-gated, 8s
   busy-wait, then a `busy` error the coordinator must manually retry).
2. **There is no first-class task and no reliable completion signal.** Tasks are
   free-text prompt strings; results are *scraped* out of transcript text. The
   only turn-boundary signal is the `Stop` hook, which means "went idle," which is
   **indistinguishable from "task done."** The coordinator cannot know when a
   delegated task is actually finished — it guesses from scraped summary text.
3. **The back-channel and the whole governance/escalation half are unbuilt.**
   Children have no way to report progress, hand back a result, or ask the
   coordinator anything; the only agent→coordinator push is `request_user_input`.
   The `add-project-coordinator` change (escalation routing, `ask_coordinator`,
   guardrails) is fully specced and **entirely unimplemented**, so a stuck child
   falls through to *you*, not the coordinator.

"A2A" is the right instinct, but the win isn't adopting Google's wire protocol —
it's adding the **semantics** A2A formalizes (a typed Task with a lifecycle, a
structured message envelope, a completion/handoff signal, a back-channel) on top
of the plumbing you already have. The single highest-leverage change is a
**structured completion + back-channel protocol**: give every spawned agent a
small MCP toolset to report done/blocked/progress and to ask the coordinator, and
give the coordinator a real per-project **task board** to plan against instead of
re-reading scraped terminal text every turn.

---

## 0. Confirmed direction (2026-07-25)

Two hard constraints agreed for every option below:

- **The coordinator stays a chat surface.** It remains an interactive Claude
  conversation the user manages the fleet through — in *all* options, including
  the Option C engine. Moving control-flow to an engine changes how the
  coordinator drives *other* agents (the back office), never the human↔coordinator
  conversation. Its own pane may *additively* grow a task-board/team view
  alongside the chat; it never replaces the chat.
- **Workers/specialists stay real `claude` CLI.** They remain raw PTY terminals,
  unchanged in feel. The structured signal comes from the worker *calling* a
  back-channel tool, not from restructuring or scraping its terminal — so Phase 1
  (Option A) delivers the coordination win without touching worker rendering.

Consequence: **Option B's stream-json worker view is de-prioritized** — it trades
away the "feels like `claude` CLI" property for the same worker, which we don't
want. Revisit B only as an opt-in per worker if keystroke injection into busy
workers remains a pain point at scale.

---

## 1. What you already have (don't rebuild this)

Grounded from the code, not the specs:

- **Stack:** Tauri 2 (Rust) + SvelteKit 5 (runes). Terminals are real PTYs via
  `portable-pty` (`src-tauri/src/pty.rs`), rendered with xterm.js
  (`src/lib/TerminalPane.svelte`). Frontend owns the session/pane registry
  (`src/lib/layout/workspace.svelte.ts`, `PaneSession`); Rust owns PTY I/O, local
  sockets, and on-disk transcript/event readers.
- **Agent = terminal in a folder:** every pane spawns with `cwd = the chosen
  folder` (`src/lib/launcher/plan.ts`). `claude` panes are wrapped by
  `buildSpawnOverride` (`src/lib/usage/spawn.ts`) which injects `--session-id`,
  a `--settings` blob (statusline + a full hooks lifecycle), and env
  (`AGENT_DESKTOP_PANE`, `_SNAPSHOT_DIR`, `_SOCKET_PATH`).
- **Specialist = `.claude/agents/<name>.md`** (native Claude Code subagent file:
  frontmatter `name/description/tools/model` + system-prompt body). Applied to a
  spawned pane via `--append-system-prompt` / `--model` / `--allowedTools`
  (`src/lib/orchestration/launchArgs.ts`). This is a clean, file-as-truth model.
- **Coordinator = one `claude` pane per project**, `role:'coordinator'`, launched
  with a hardcoded `ORCHESTRATOR_SYSTEM_PROMPT` (`src/lib/orchestration/
  coordinator.ts`) + `--mcp-config` (the orchestration toolkit) +
  `--disallowedTools Edit Write Bash NotebookEdit Task`. It only plans and
  delegates; it can't do work itself.
- **The toolkit + transport (this part is genuinely good):**
  `orchestration-mcp.cjs` (stdio MCP server on the coordinator) → Rust control
  socket (`src-tauri/src/orchestration.rs`, per-target serialized queues, request
  ids, 30s timeout) → Tauri `orchestration://request` → frontend
  `OrchestrationExecutor` (`src/lib/orchestration/executor.svelte.ts`) → real
  panes. Eight ops: `spawn_agent`, `message_agent`, `read_agent`, `list_agents`,
  `inspect_agent`, `archive_agent`, `unarchive_agent`, `request_user_input`.

**Takeaway:** the identity model (specialists), the lifecycle (spawn/archive), and
the request/reply transport are solid and reusable. The gaps are all in *what
flows over the transport* and *what the coordinator can know*.

---

## 2. Why coordination misses the mark (root causes, with code refs)

### 2.1 Delegation is one-directional keystroke injection
`message_agent` delivers text by `getTerminal(paneId).send(text)` — it types into
the child's PTY (`executor.svelte.ts` ~L558). It is **idle-gated**: it refuses if
the child is `working` (polls up to `BUSY_WAIT_MS = 8000` then returns a `busy`
error) and refuses if the child is sitting on an `AskUserQuestion` menu (free text
+ Enter would select a garbage option and corrupt the transcript, ~L312-319).
There is **no delivery queue, no backpressure, no ack** beyond the Rust
per-target serialization. The coordinator has to poll, retry, and hope.

### 2.2 No first-class task, no result object
"Tasks" are free-text `prompt`/`text` strings. Results come back only via
`read_agent` returning `{status, summary, messages[], question, contextPct}`,
where `summary`/`messages` are the **last few assistant text blocks scraped from
`~/.claude/projects/<cwd>/<sessionId>.jsonl`** (`src-tauri/src/activity.rs`,
256KB tail, last 6 messages). There is no task id, no assignment record, no
dependency graph, no typed artifact, no correlation between "the task I gave" and
"the text I'm reading back."

### 2.3 No reliable completion signal — the core problem
The event pipeline (`event-hook.cjs` → `events.rs` → `events.svelte.ts`) captures
`SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop,
SubagentStop, SessionEnd`. The only turn-boundary is **`Stop` → status `waiting`**,
which means *"finished a turn / went idle,"* **not** *"finished the task."* They
are indistinguishable at the event layer. `finished` status exists only for
process/session lifecycle (PTY exit, archive/close, real `SessionEnd`) — an agent
that completes its task and returns to the prompt reads `waiting`, exactly like an
agent that paused mid-task. A grep of the MCP toolset confirms there is **no**
`report_done` / `task_complete` / `handoff` tool. So to know a task is done the
coordinator must **infer** it from `status:'waiting'` + the content of scraped
`summary`/`messages`. That inference is the thing that keeps failing.

### 2.4 No agent→coordinator back-channel
The only push signal from a child is `request_user_input` — and that's aimed at
the *user*, not the coordinator. Children cannot report progress, surface a
partial result, or ask the coordinator a question. All information flow is
coordinator-pull via polling. A "team" where members can only be interrogated,
never speak up, coordinates poorly by construction.

### 2.5 Governance / escalation is specced but unbuilt
`openspec/changes/add-project-coordinator/` (escalation interception,
`ask_coordinator`, `answer_question`, hybrid autonomy, hard guardrails) is fully
designed with **every task unchecked**. The proposal frames the coordinator's
*reason for existing* as absorbing escalations — and that half doesn't exist. When
a child hits an `AskUserQuestion`, it blocks and falls to the human. This alone
makes the fleet feel uncoordinated.

### 2.6 Status is a tuned heuristic, not ground truth
Status is a union of: PTY-silence windows (`WORKING_WINDOW_MS=2500`,
`IDLE_GRACE_MS=10000`), event in-flight tracking, and **screen-scraping three
English affordance strings** ("esc to interrupt", "ctrl+b to run in background",
`waiting for N dynamic workflow`) from the xterm buffer (`terminalBusy.ts`,
`TerminalPane.svelte` ~L310-322). It's been iteratively hardened against
flicker/bounce (see archived `fix-working-status-bounce`,
`fix-event-status-divergence`, etc.), but it's fragile to CC TUI wording changes
and localization, and there's a known interrupt race requiring a synthetic `Stop`.
Coordination built on top of a heuristic status inherits its fragility.

---

## 3. The key asset: you already have an event backbone

You do **not** need to invent a transport for structured signals. Every
app-spawned `claude` already streams lifecycle hooks over a local socket into
`events.rs` (bounded per-pane ring + durable `events/<sessionId>.jsonl`) and out
to the frontend as `overview://event`. This is exactly the substrate a real A2A
completion/handoff protocol rides on. The missing pieces are **semantics on top of
it**, not a new pipe:

- a tool the child calls to emit an *authoritative* "task done + result" event
  (instead of us guessing from `Stop`);
- a back-channel so those events reach the coordinator as structured data;
- a task record the coordinator plans against.

---

## 4. Reframing "A2A" for this app

Google's **Agent2Agent** protocol (JSON-RPC over HTTP, AgentCard capability
discovery, an 8-state Task lifecycle, SSE streaming) is designed for
*cross-vendor, cross-network* agent delegation. Internally, adopting its **wire
format** is mostly ceremony you don't need. Adopting its **concepts** is exactly
right:

| A2A concept        | Maps onto (here)                                            |
|--------------------|-------------------------------------------------------------|
| AgentCard          | Your specialist `.claude/agents/*.md` (name/desc/tools)     |
| Task + lifecycle   | The missing first-class Task object (§5)                    |
| Message / Artifact | Structured envelope over the existing control socket        |
| Streaming updates  | The existing `overview://event` hook pipeline               |

Recommendation: **build A2A's semantics natively; keep the wire internal.** Revisit
literal A2A-protocol compliance only if you later need Agent Desktop to
interoperate with agents outside the app.

---

## 5. The design space — four options

Each is independently valuable; they stack. Effort is rough (S/M/L/XL).

### Option A — Task object + completion/back-channel protocol *(evolutionary; recommended first)*  — **M**
Keep PTY panes, keep the MCP toolkit + control socket. Add semantics:

- **First-class Task** (per project, persisted like tasks.json): `id, goal,
  assignee paneId, specialist, state (assigned→working→blocked→input-required→
  done→failed), result, artifacts[], parentTaskId`. This is the shared "team
  plan" / blackboard the coordinator reads instead of re-scraping transcripts.
- **Back-channel MCP server attached to every *spawned* agent** (not just the
  coordinator — you already know how to attach one MCP server; this is a second,
  child-side one): `report_progress(note)`, `report_done(result, artifacts?)`,
  `report_blocked(reason)`, `ask_coordinator(question)`. These route child →
  Rust socket → executor → update the Task + notify the coordinator. This single
  addition converts *inference* into a *signal* and gives you the missing
  back-channel at once.
- **Authoritative completion:** `report_done` writes a real terminal state on the
  Task and emits a structured event; the coordinator stops guessing from `Stop`.
  (Belt-and-suspenders: also treat the child's `Stop` as "may be done, check
  Task" rather than "done.")
- **Structured injection envelope:** when the coordinator assigns work, wrap it so
  the child's system prompt teaches it "you were dispatched task <id>; call
  `report_done` when finished." The specialist prompt template carries this.

Why first: highest ROI, reuses the entire transport, no rendering changes, no new
runtime. It directly kills §2.2, §2.3, §2.4. Risk is low and contained.

### Option B — Structured session transport (stream-json) instead of keystroke injection  — **L**
Replace `message_agent`'s PTY typing for coordinator-driven workers with driving
them over `--input-format stream-json` / `--output-format stream-json` (or the
Agent SDK, see C). Worker I/O becomes structured JSON messages, not terminal
bytes — eliminating the entire busy-gating / menu-garble / affordance-scraping
class of bugs (§2.1, §2.6). Cost: coordinator-spawned workers no longer render as
a raw xterm terminal; they need a structured-transcript view. Natural as a
**hybrid** — interactive human-facing panes stay PTY; coordinator-spawned workers
run headless stream-json with a message-list UI. Bigger lift because it forks the
rendering/spawn path.

### Option C — Orchestration engine on the Agent SDK; coordinator stops being an LLM-in-a-terminal  — **XL**
Today the "orchestrator brain" is a Claude session in a pane that calls MCP tools
and polls scraped text every turn — the control-flow itself lives in the LLM.
Instead, build a deterministic orchestration engine (TypeScript sidecar or in the
host) using the Agent SDK `query()`: typed messages, hooks as async callbacks,
per-tool permission callbacks, explicit session spawn/resume. The LLM still
*plans*; the *coordination control-flow* (dispatch, wait-for-done via real events,
dependency graph, retries, escalation routing) becomes real code with real Task
state. This is where dependable multi-agent "team" behavior actually comes from —
you stop asking an LLM to be a scheduler by re-reading a terminal. Cost: a
substantial new subsystem, and the coordinator is no longer "just another pane,"
so it must be reconciled with the frontend-owned pane registry. Best as a
*later* phase once Option A has proven the Task/semantics model.

### Option D — Literal Google A2A protocol compliance  — **XL, likely later/never**
Wrap each agent as an A2A server (AgentCard, JSON-RPC task lifecycle, SSE). Only
worth it for cross-app / cross-vendor interop. Internally you get the same
benefits from A (task model) + C (engine) with far less ceremony. Track as a
"when we need to federate beyond this app" item, not now.

---

## 6. Recommended staged path

1. **Phase 1 — Semantics (Option A).** Task object + child-side back-channel MCP
   (`report_done/report_blocked/report_progress/ask_coordinator`) + a project task
   board the coordinator plans against. Rewrite the `ORCHESTRATOR_SYSTEM_PROMPT`
   to drive off the task board and the new signals rather than a poll loop.
   *Outcome:* the coordinator knows, authoritatively, when work is done, when a
   child is stuck, and what each child produced.
2. **Phase 2 — Escalation/governance (build `add-project-coordinator`).** Route a
   child's `AskUserQuestion`/blocked state to the coordinator first (via the
   Phase-1 back-channel), with `answer_question` + guardrails + a hybrid-autonomy
   policy. *Outcome:* the fleet self-resolves; the human sees only what truly
   needs them (which is the PRODUCT.md promise: "surface what needs you").
3. **Phase 3 — Transport hardening (Option B) and/or engine (Option C),** once the
   semantics are proven and you can measure where the remaining fragility is.

Phases 1–2 are the ones that make it *feel* coordinated; 3 is what makes it
*robust at scale*.

---

## 7. Open questions to decide together

- **Where does Task state live?** *(discussed 2026-07-25 — leaning event-sourced)*
  Ranked for this app:
  1. **Event-sourced task board (preferred).** Add `task_assigned/progress/
     blocked/done/failed` as new kinds on the *existing* event pipeline
     (`event-hook.cjs` → `events.rs` → append-only `events/<sessionId>.jsonl`);
     derive the board as a Svelte runes projection (a fold), exactly like status.
     No new storage subsystem; append-only sidesteps write contention; audit +
     attribution fall out for free.
  2. **Per-project JSON snapshot** — `.agent-desktop/coordinator-tasks.json`,
     sibling to `tasks.json`/`config.json`. Matches convention, human-readable,
     git-diffable. Cost: whole-file rewrites + must serialize writes (Rust owns
     the writer). The pragmatic "just ship it" option.
  3. **SQLite (escalation only)** — Tauri SQL plugin / `rusqlite`. Real
     queries/transactions/indexes; adopt when cross-project queries, analytics,
     or task volume demand it. Not a starting point (binary file, migrations,
     overkill for a per-project fleet).
  4. **Pure in-memory (runes) — avoid alone.** Loses the coordinator's plan on
     crash, exactly when it's wanted; only acceptable backed by 1–3.

  Supporting decisions:
  - **Single-writer authority:** the frontend `OrchestrationExecutor` is the only
    mutator of task state (coordinator + workers both funnel through it via the
    Rust socket); Rust per-target serialization gives ordering. Prevents
    split-brain — matters more than the backend choice.
  - **Artifacts by reference, not inline:** `report_done` payloads (diffs, files,
    summaries) live on disk; the Task holds a pointer. Respects MCP output caps
    (~10k warn / ~25k cap tokens).
  - **Sync with Claude Code's own task list:** map a coordinator Task onto the
    worker's `~/.claude/tasks/<session>/` `in_progress` todo so the roster's
    per-agent task label lights up for free and stays in sync.
- **Does the coordinator stay an in-pane LLM (A/B) or become a real engine (C)?**
  This is the biggest fork; A is reversible, C is a commitment.
- **How much autonomy** should the coordinator have when a child escalates —
  answer on the user's behalf, or always confirm? (Governance policy design.)
- **Hybrid rendering:** are we willing to have coordinator-spawned workers render
  as structured transcripts rather than full terminals (needed for B)?
- **Verification gate:** do we want the coordinator to spawn an independent
  reviewer per task before marking it done (raises quality, costs tokens)?

---

## 8. Reference map (where to look while we discuss)

- Coordinator + prompt: `src/lib/orchestration/coordinator.ts`,
  `coordinator.svelte.ts`, `CoordinatorStart.svelte`
- Executor (delegation logic): `src/lib/orchestration/executor.svelte.ts`
- MCP adapter (coordinator-side): `src-tauri/resources/orchestration-mcp.cjs`
- Control socket transport: `src-tauri/src/orchestration.rs`, `ipc.rs`
- Specialist → CLI flags: `src/lib/orchestration/launchArgs.ts`,
  `src/lib/specialists/*`
- Spawn wrapping / injected settings: `src/lib/usage/spawn.ts`,
  `src/lib/launcher/plan.ts`
- Event pipeline (the backbone): `src-tauri/resources/event-hook.cjs`,
  `src-tauri/src/events.rs`, `src/lib/overview/events.svelte.ts`
- Status derivation: `src/lib/overview/roster.ts`, `events.svelte.ts`,
  `terminalBusy.ts`; specs `openspec/specs/agent-status-derivation/`,
  `activity-events/`, `task-detection/`
- `read_agent` source: `executor.svelte.ts` + `src-tauri/src/activity.rs`
- Durable specs: `openspec/specs/{agent-orchestration-runtime,
  agent-coordinator-workflows,agent-specialists,coordinator-lifecycle}/`
- **Unbuilt** governance: `openspec/changes/add-project-coordinator/` (all tasks
  unchecked) — Phase 2 source material.

### Claude Code primitives relevant to the options (verify exact flags at build time)
- Headless structured I/O: `claude -p --output-format stream-json
  --input-format stream-json` (drives sessions with JSON, not keystrokes).
- Continuity: `--session-id`, `--resume <id>`, `--continue`, `--fork-session`
  (note: `--mcp-config`/`--settings` are **not** restored on resume — must be
  re-passed).
- Hooks already used: `Stop`, `SubagentStop`, `Notification`, `PreToolUse`,
  `PostToolUse`, `SessionStart/End`, `UserPromptSubmit`.
- MCP limits to design around: output warns >10k tokens, caps ~25k
  (`MAX_MCP_OUTPUT_TOKENS`); stdio idle timeout ~30m.
- Agent SDK (`@anthropic-ai/claude-agent-sdk`) `query()` — the Option C engine.
- "A2A" = Google's protocol (not Anthropic); adopt its *concepts*, keep the wire
  internal for now.
