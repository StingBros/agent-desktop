// PURE roster view-model for the agent-overview surface (Stage 1, tasks.md 10.1;
// design D3/D7). Given the live `pane_id -> snapshot` map, a framework-free
// projection of the workspace list, and the per-pane RUNTIME state (PTY output
// activity + process exit), it produces ONE `AgentRow` per app (claude) pane: its
// name/cwd, model, current task, context %, cost, and a working/waiting/finished/
// errored status.
//
// Status is derived from the LIVE terminal — not the statusline snapshot. The
// statusline wrapper only writes a snapshot when claude re-renders its status bar,
// which is sparse and stops entirely while claude waits at a prompt, so a
// heartbeat-based status read "idle" almost always. The PTY byte stream, by
// contrast, flows continuously while claude works (its spinner/token output) and
// falls silent the instant it stops — a far truer "is it working" signal — and
// the process exit code distinguishes a clean finish from an error.
//
// Framework-free (no Svelte/Tauri imports) so it is trivially unit-tested. The
// Overview component is the thin reactive wrapper that projects the workspace
// store's `WorkspaceEntry[]` into `RosterWorkspace[]`, feeds the runtime registry
// in, calls `buildRoster(...)`, and renders the rows. Every "missing" value rolls
// up to `null`, NEVER `NaN`.

import type { Snapshot, SnapshotMap } from '../usage/snapshots.svelte';
import type { EventActivity } from './events';
import { TERMINAL_STATES, type Task, type TaskState } from '../orchestration/tasks';

/**
 * An agent's live status, derived from its terminal activity + process state:
 *  - `working`  — the PTY produced output within the working window (streaming).
 *  - `waiting`  — alive but quiet: claude is at the prompt, needing YOUR input.
 *  - `finished` — the process exited cleanly (code 0 / unknown).
 *  - `error`    — the process exited with a non-zero code.
 *  - `idle`     — no runtime info yet (pane not wired).
 */
export type AgentStatus = 'working' | 'waiting' | 'finished' | 'error' | 'idle';

/**
 * The control-room LANE an agent belongs to — the Overview groups the roster into
 * lanes, ordered top->bottom by how much they need you:
 *  - `attn`   — needs attention: waiting on YOU, or errored (the prominent lane).
 *  - `flight` — in flight: working on its own, or idle (these need you least).
 *  - `paused` — deferred by you for later (kept live; a new message resumes it).
 *  - `done`   — archived: the session is closed (restorable), or finished cleanly.
 */
export type AgentLane = 'attn' | 'flight' | 'paused' | 'done';

/** The lane render order (top -> bottom): needs-attention, in-flight, paused,
 *  archived. Archived sits at the BOTTOM (it needs you least); paused sits just
 *  above it (set aside, but not closed). */
export const LANE_ORDER: readonly AgentLane[] = ['attn', 'flight', 'paused', 'done'];

/** PURE: the lane for a status alone. waiting/error -> attn, finished -> done, else
 *  flight. Does NOT consider the paused/archived row overrides — use `laneForRow`
 *  for a full row. */
export function laneOf(status: AgentStatus): AgentLane {
  if (status === 'waiting' || status === 'error') return 'attn';
  if (status === 'finished') return 'done';
  return 'flight';
}

/**
 * PURE: the lane for a full row, applying the row-level overrides in priority order:
 * ARCHIVED (closed) always sits in `done`; otherwise a PAUSED row sits in `paused`
 * (outranking its underlying status, so a paused waiting agent leaves attention);
 * otherwise the status decides (`laneOf`).
 */
export function laneForRow(row: AgentRow): AgentLane {
  if (row.closed === true || row.preview === true) return 'done';
  if (row.paused === true) return 'paused';
  return laneOf(row.status);
}

/**
 * PURE: whether a COORDINATOR genuinely needs the user's input. The coordinator is
 * an orchestrator expected to keep working/delegating, so the DEFAULT idle/waiting
 * heuristic (a quiet PTY / a `Stop`/`SessionStart` event) must NOT flag it as
 * needing you. It needs you ONLY when:
 *   (a) it asks a question via the built-in AskUserQuestion tool — detected from the
 *       row's pending question(s) (`question`/`questions`, event-sourced), OR
 *   (b) it explicitly called the `request_user_input` orchestration tool — the
 *       `flag` argument (the reactive coordinatorNeedsInput store, read by the caller).
 *
 * Non-coordinator rows never reach this — their needs-input is the normal status
 * heuristic. Pure: depends only on its inputs.
 */
export function coordinatorNeedsInput(
  row: Pick<AgentRow, 'question' | 'questions'>,
  flag: boolean
): boolean {
  const hasQuestion = !!row.question || (Array.isArray(row.questions) && row.questions.length > 0);
  return hasQuestion || flag === true;
}

/**
 * PURE: whether a row is an ARCHIVED COORDINATOR — a `role:'coordinator'` row whose
 * session is CLOSED (Archived). The roster labels exactly these rows with the bot
 * "Coordinator" badge (agent-roster-display: "Archived coordinator is labeled"); a
 * LIVE coordinator keeps its existing presentation (its own pinned-row badge), so it
 * is deliberately NOT matched here. A `preview`-ed coordinator (resumed-from-archived,
 * `closed:false`) is live again and likewise unmatched.
 */
export function isArchivedCoordinator(
  row: Pick<AgentRow, 'role' | 'closed'>
): boolean {
  return row.role === 'coordinator' && row.closed === true;
}

/**
 * PURE: whether a row is actively waiting on YOU — waiting/errored AND neither
 * paused (deferred) nor archived (closed). The inbox's attention queue + focus
 * advance use this so a paused/archived agent never nags or steals focus.
 */
export function needsAttention(row: AgentRow): boolean {
  return (
    (row.status === 'waiting' || row.status === 'error') &&
    !row.paused &&
    !row.closed &&
    !row.preview
  );
}

/**
 * PURE: whether a row is actively WORKING — status `working` AND neither paused
 * (deferred) nor archived (closed) nor previewing. The project panel shows a
 * blue "in flight" dot for a project that has a working agent but none that
 * need you (needsAttention takes precedence), so this is the blue counterpart
 * to that predicate.
 */
export function isWorking(row: AgentRow): boolean {
  return row.status === 'working' && !row.paused && !row.closed && !row.preview;
}

/**
 * PURE: whether a roster row should show the CONTEXT-window measure (mini-bar +
 * percent) in its meta line. Only a LIVE agent — not archived/previewed (closed)
 * or paused — AND only once a context size is actually known: a row with no
 * context percentage yet (`null`) shows NOTHING rather than a placeholder dash /
 * striped bar, so a just-spawned agent's card stays clean until real data lands.
 */
export function showContext(
  row: Pick<AgentRow, 'closed' | 'preview' | 'paused' | 'contextPct'>
): boolean {
  return !row.closed && !row.preview && !row.paused && row.contextPct !== null;
}

/**
 * PURE: partition the roster into its lanes, preserving the original roster order
 * within each lane. Always returns all keys (empty arrays when a lane has no
 * agents) so the Overview can decide whether to render each lane.
 */
export function groupByLane(rows: AgentRow[]): Record<AgentLane, AgentRow[]> {
  const grouped: Record<AgentLane, AgentRow[]> = { attn: [], flight: [], paused: [], done: [] };
  for (const row of rows) grouped[laneForRow(row)].push(row);
  return grouped;
}

/**
 * PURE: reconcile a lane's persisted/established display order against the paneIds
 * currently IN that lane, applying the "most recently added to that column first"
 * rule:
 *  - ids already in `prev` that are still present keep their relative order — this
 *    is what preserves a user's manual drag arrangement (and the established
 *    arrival order) across recomputes;
 *  - ids that are NEW to the lane (just entered it) are prepended ABOVE the kept
 *    order — newest on top — so a freshly-arrived agent jumps to the top of the
 *    bucket. Among several simultaneous newcomers, the one later in `present`
 *    (roster/tree order ≈ most recently spawned) sorts first.
 *
 * `present` is the lane's paneIds in roster order. With a non-empty `present` the
 * result is exactly the present ids (stale ids are dropped). When `present` is
 * EMPTY the remembered order is returned UNCHANGED — an empty column is treated as
 * "no members right now", NOT "forget the order": this is load-bearing for restart
 * persistence, since the roster is briefly empty while the layout restore is still
 * in flight, and dropping every id there would let the caller persist an empty order
 * and destroy the user's saved arrangement before the panes reappear. Pure: never
 * mutates inputs.
 */
export function reorderLane(
  prev: ReadonlyArray<string>,
  present: ReadonlyArray<string>
): string[] {
  if (present.length === 0) return [...prev];
  const presentSet = new Set(present);
  const kept = prev.filter((id) => presentSet.has(id));
  const keptSet = new Set(kept);
  const added = present.filter((id) => !keptSet.has(id));
  added.reverse(); // later-in-roster ⇒ more recently added ⇒ higher
  return [...added, ...kept];
}

/**
 * PURE: move the id `fromId` to the position of `toId` within an ordered list of
 * paneIds (drag-to-reorder inside a lane). Same standard array-move as
 * `reorderProjects`: the dragged id lands exactly at the drop target's slot. A
 * no-op copy when either id is absent or they are equal. Never mutates inputs.
 */
export function moveId(
  order: ReadonlyArray<string>,
  fromId: string,
  toId: string
): string[] {
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * PURE: order roster `rows` for display by grouping them into LANE_ORDER and, within
 * each lane, by that lane's `order` list of paneIds (from `reorderLane`/`moveId`). A
 * row whose paneId is absent from its lane's order sinks to the end of that lane (in
 * its incoming relative order). The result is lane-grouped + within-lane-ordered, so
 * the rendered lanes, the attention queue, and focus resolution all agree on order.
 * Pure: returns a new array, never mutates inputs.
 */
export function orderRowsByLane(
  rows: AgentRow[],
  laneOrder: Record<AgentLane, ReadonlyArray<string>>
): AgentRow[] {
  const rankOf = (r: AgentRow): number => {
    const i = LANE_ORDER.indexOf(laneForRow(r));
    return i < 0 ? LANE_ORDER.length : i;
  };
  const withinOf = (r: AgentRow): number => {
    const order = laneOrder[laneForRow(r)] ?? [];
    const i = order.indexOf(r.paneId);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return rows
    .map((r, idx) => ({ r, idx }))
    .sort((a, b) => {
      const dr = rankOf(a.r) - rankOf(b.r);
      if (dr !== 0) return dr;
      const dw = withinOf(a.r) - withinOf(b.r);
      if (dw !== 0) return dw;
      return a.idx - b.idx; // stable: equal-keyed rows keep their incoming order
    })
    .map((x) => x.r);
}

/**
 * PURE: the paneIds of the ARCHIVED rows — those in the `done` lane (closed or
 * previewing-an-archived-session), in roster order. This is exactly the set shown
 * under the overview's "Archived" header, so it backs the "delete all archived"
 * action. Empty when nothing is archived.
 */
export function archivedPaneIds(rows: AgentRow[]): string[] {
  return rows.filter((row) => laneForRow(row) === 'done').map((row) => row.paneId);
}

/** Per-pane runtime state captured from the live terminal (framework-free). */
export interface PaneRuntime {
  /** Epoch ms of the most recent PTY output, or null if none seen yet. */
  lastOutputAt: number | null;
  /** Whether the pane's process has exited. */
  exited: boolean;
  /** The process exit code once exited, else null (and null for an unknown code). */
  exitCode: number | null;
  /**
   * Epoch ms of the LAST time a recent-terminal active-work indicator was observed
   * (a foreground command running, or in-session background work — see
   * `detectTerminalBusy`), or null/absent if never observed. The indicator is part
   * of a continuously-redrawing TUI sampled per output chunk, so a single sample
   * can momentarily miss an affordance that is still present; `rowFor` therefore
   * treats the In-flight override as active while this timestamp is within
   * `BUSY_GRACE_MS` of now, holding through a flicker instead of bouncing. The
   * TerminalPane stamps it via `noteBusy` (only on a POSITIVE detection); a negative
   * detection leaves it unchanged so the window lapses naturally once work ends.
   */
  terminalBusyAt?: number | null;
  /**
   * Epoch ms of the last SELF-INITIATED terminal resize (the app pushing a
   * `pty_resize`), or null/absent if none. A resize makes Claude's TUI redraw via
   * SIGWINCH, producing output that is NOT work; `noteOutput` ignores the activity
   * stamp for output within `RESIZE_REDRAW_MS` of this time, so selecting an idle
   * agent (which makes its pane visible → refit → resize) does not flash it In
   * flight. Set by `noteResize`; absent means "no recent resize" (fail-safe).
   */
  resizeAt?: number | null;
  /**
   * The pane's PREVIOUSLY-derived (final) status — the hysteresis memory for the
   * silence-based demotion. The Overview records each row's final status here after
   * every roster rebuild (`noteStatus`); `deriveStatus` reads it as `prevStatus` so a
   * pane already shown `working` holds In flight through a brief silence (see
   * `IDLE_GRACE_MS`) instead of bouncing to `waiting`. Optional: absent means "no
   * prior status", in which case derivation is the single-window behavior (fail-safe).
   */
  lastStatus?: AgentStatus;
}

/** The live `pane_id -> runtime` map the Overview feeds into `buildRoster`. */
export type RuntimeMap = Record<string, PaneRuntime>;

/** One selectable option of a pending `AskUserQuestion` (label + longer help). */
export interface QuestionOption {
  /** The option's short label (what the user picks). */
  label: string;
  /** The option's longer description (may be empty). */
  description: string;
}

/** One pending question of an `AskUserQuestion`: header, prompt, options, mode. */
export interface PendingQuestion {
  /** A short header/label for the question (may be empty). */
  header: string;
  /** The question prompt text. */
  question: string;
  /** Whether more than one option may be selected. */
  multiSelect: boolean;
  /** The selectable options (empty for an open-ended free-text question). */
  options: QuestionOption[];
}

/** Transcript-derived activity for an agent (framework-free shape). */
export interface RowActivity {
  /** The agent's last assistant message, or null. */
  summary?: string | null;
  /** A pending AskUserQuestion the agent is waiting on (compact text), or null. */
  question?: string | null;
  /** The full structured pending question(s) — options the user can answer, or null. */
  questions?: PendingQuestion[] | null;
  /** Context-window usage 0..100 from the transcript, or null. */
  contextPct?: number | null;
  /** Unix seconds of the last transcript entry's timestamp — stable across
   *  `claude --resume` reopens. Used as `lastTs` for closed/preview rows. */
  lastMsgTs?: number | null;
}

/** The live `pane_id -> activity` map the Overview feeds into `buildRoster`.
 *  Keyed on the frontend PANE id (the transcript is located from the pane's cwd),
 *  so a row resolves its activity directly with no dependency on the snapshot. */
export type ActivityMap = Record<string, RowActivity>;

/**
 * The live `pane_id -> Task[]` map the Overview feeds into `buildRoster` for
 * coordinator-task attribution (task 10.1). Each key is a worker pane's id; the
 * value is every {@link Task} whose `assigneePaneId` equals that pane — sourced by
 * the reactive Overview wrapper from the per-project `taskBoard` (grouped by
 * assignee), NOT read here (roster.ts stays framework-free with no store/Tauri
 * dependency). A pane with no assigned Task is simply absent from the map. Passing
 * a paneId-keyed map (rather than the raw board) keeps the lookup O(1) per row and
 * fully derived — no new polling.
 */
export type TaskMap = Record<string, Task[]>;

/**
 * PURE: pick a pane's CURRENT Task from every Task assigned to it, for roster
 * attribution. Prefers the most-recently-updated NON-TERMINAL Task (a worker's
 * live work); when the pane has only terminal (`done`/`failed`) Tasks it falls
 * back to the most-recently-updated one overall (so a just-finished worker still
 * shows what it last did). Recency is `updatedAt` (the last-mutation stamp),
 * tie-broken by `createdAt` then higher `id` for determinism. Returns null for an
 * absent/empty list. Never mutates its input.
 */
export function selectCurrentTask(tasks: Task[] | undefined): Task | null {
  if (!tasks || tasks.length === 0) return null;
  const nonTerminal = tasks.filter((t) => !TERMINAL_STATES.has(t.state));
  const pool = nonTerminal.length > 0 ? nonTerminal : tasks;
  return pool.reduce((best, t) => (moreRecentTask(t, best) ? t : best));
}

/** True when task `a` is "more recent" than `b`: later updatedAt, then createdAt, then id. */
function moreRecentTask(a: Task, b: Task): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

/**
 * Output newer than this (ms) counts as "working". It must exceed claude's
 * spinner/token cadence (it re-renders several times a second while working) so
 * an active agent stays `working`, yet be short enough that going quiet flips to
 * `waiting` promptly.
 */
export const WORKING_WINDOW_MS = 2500;

/**
 * Demotion hysteresis window (ms). PROMOTION to `working` stays responsive at
 * `WORKING_WINDOW_MS` (output within it → working), but an agent ALREADY shown
 * `working` holds that status through continued silence until THIS longer window
 * elapses before silence alone demotes it to `waiting`. This kills the
 * `working ↔ waiting` bounce for a quiet-but-active agent (thinking, or a long
 * non-streaming tool): it stays In flight as long as it produces output at least
 * this often, and only a sustained idle gap reads Needs input. Any new output
 * resets the silence measurement, so re-promotion is immediate. Must exceed
 * `WORKING_WINDOW_MS`.
 */
export const IDLE_GRACE_MS = 10_000;

/**
 * Hold window (ms) for the active-work (terminalBusy) In-flight override. The
 * active-work affordance is screen-scraped from a continuously-redrawing TUI on
 * each PTY chunk and sampled by the ~1 s roster heartbeat, so the raw signal can
 * flicker or briefly miss an affordance that is still present. The override is
 * therefore held In flight while the LAST positive detection is within this
 * window; a fresh detection re-arms it immediately (promotion stays responsive),
 * and it lapses only after the affordance has been absent for the whole window.
 * Tuned to comfortably exceed the 1 s heartbeat and typical spinner-redraw gaps
 * while still returning a finished agent to its normal status within a few
 * seconds. Distinct from `IDLE_GRACE_MS` (silence demotion) — different signal,
 * shorter window.
 */
export const BUSY_GRACE_MS = 3000;

/**
 * Suppression window (ms) for output caused by a self-initiated terminal resize.
 * When the app pushes a `pty_resize` (e.g. a pane becomes visible after its
 * workspace is selected), Claude's TUI redraws via SIGWINCH and emits output —
 * which would otherwise stamp `lastOutputAt` and read as `working` for the whole
 * `WORKING_WINDOW_MS`, making a merely-selected idle agent flash In flight. Output
 * arriving within this window after a recorded resize (`PaneRuntime.resizeAt`) is
 * ignored for the silence/activity signal — but ONLY for an otherwise-idle pane
 * (`lastOutputAt` already older than `WORKING_WINDOW_MS`). A genuinely working pane
 * keeps stamping, so no storm of resizes can freeze its `lastOutputAt` and demote
 * it; the suppression strictly targets the idle-select flash.
 */
export const RESIZE_REDRAW_MS = 750;

/** One pane in a workspace, as the roster needs it (framework-free projection). */
export interface RosterPane {
  /** The frontend pane id (== `AGENT_DESKTOP_PANE`, the snapshot key). */
  paneId: string;
  /** The pane's working directory, or null (inherits the app cwd). */
  cwd: string | null;
  /** Whether this pane runs an app (claude) agent. Non-app (shell) panes are
   *  NOT agents and never appear in the roster. */
  isApp: boolean;
  /** The project this agent was launched under, or null/undefined if none. */
  projectId?: string | null;
  /** OPTIONAL name of the SPECIALIST (`.claude/agents/<name>.md`) this pane was
   *  spawned AS by the orchestration toolkit — used to badge/attribute the agent
   *  in the roster. Absent for panes not spawned as a specialist. */
  specialist?: string | null;
  /** OPTIONAL role marker — `'coordinator'` for the per-project coordinator pane.
   *  Used to badge the coordinator in the roster (task 6.5). Absent for ordinary agents. */
  role?: 'coordinator' | null;
  /** OPTIONAL paneId of the COORDINATOR that spawned/drives this agent — so the
   *  roster can attribute the agent to its coordinator's orchestration (task 6.5).
   *  Absent for user-started agents and coordinator panes themselves. */
  coordinatorPaneId?: string | null;
  /** Whether this agent's session is CLOSED (Archived) — its PTY is terminated
   *  and it is retained only for restore/delete. */
  closed?: boolean;
  /** Whether this agent is PAUSED (deferred): kept live, but moved to the Paused
   *  lane and out of attention until a new user message resumes it. */
  paused?: boolean;
  /** The user-message COUNT captured when the agent was paused. The inbox resumes
   *  the agent when the live count strictly exceeds this (a new message was sent).
   *  `null`/absent until lazily established from the first known reading. */
  pausedCount?: number | null;
  /** Whether this agent is being PREVIEWED: an archived session re-opened with
   *  `claude --resume` so its transcript is live + interactive, yet still presented
   *  as Archived (pinned to `done`, out of attention) until the user sends a
   *  message. Runtime-only — never persisted (serialized as `closed`). */
  preview?: boolean;
  /** The user-message COUNT captured when the preview began; the inbox UNARCHIVES the
   *  session when the live count strictly exceeds this (a new message was sent).
   *  `null`/absent until lazily established from the first known reading. */
  previewCount?: number | null;
}

/** One workspace, projected to exactly what the roster reads. */
export interface RosterWorkspace {
  /** The workspace id (the row's `workspaceId`, used to activate it on click). */
  id: string;
  /** The workspace's display name (the rail label); may be empty. */
  name: string;
  /** This workspace's panes, in tree order. */
  panes: RosterPane[];
}

/** One agent in the overview roster — the view-model the Overview renders. */
export interface AgentRow {
  /** The stable pane id (snapshot key) — used to focus/message the pane. */
  paneId: string;
  /** The owning workspace id — used to activate that workspace on navigate. */
  workspaceId: string;
  /** Display name: the workspace name, else a short cwd basename, else paneId. */
  name: string;
  /** The agent's working directory, or null. */
  cwd: string | null;
  /** Display model name from the snapshot, or null when unknown. */
  model: string | null;
  /** Raw model id from the snapshot (e.g. `claude-opus-4-8`), or null when unknown.
   *  Used alongside `model` to derive a versioned human-readable label via
   *  `modelLabel(modelId, model)`. */
  modelId: string | null;
  /** The current in-progress task (`activeForm`), or null. */
  task: string | null;
  /** The agent's last assistant message (high-level "what it just said"), or null. */
  summary: string | null;
  /** A pending AskUserQuestion the agent is waiting on (compact text), or null. */
  question: string | null;
  /** The full structured pending question(s) the user can answer, or null. */
  questions: PendingQuestion[] | null;
  /** The in-flight tool's label (event-sourced, e.g. `Bash:npm test`), or null. */
  currentAction: string | null;
  /** Context-window usage 0..100, or null when unknown. */
  contextPct: number | null;
  /** Total session cost in USD, or null when unknown. */
  cost: number | null;
  /** The agent's last-activity timestamp (snapshot `ts`, unix SECONDS) — when it
   *  last updated its statusline — or null when unknown. Drives the card's friendly
   *  "last interaction" label. */
  lastTs: number | null;
  /** Derived live/idle/needs-attention status. */
  status: AgentStatus;
  /** The project this agent belongs to (registry `projectId`), or null if none. */
  projectId: string | null;
  /** The owning project's display NAME, resolved for the desktop notification title
   *  ("<projectName>: <name>"). Alert-display only and OPTIONAL: it is attached at the
   *  alert callsite (parallel to the `name` title override), not by `rowFor`; roster
   *  fixtures and non-alert consumers may omit it. Null/undefined → no project prefix. */
  projectName?: string | null;
  /** The SPECIALIST this pane was spawned AS (registry `specialist`), or null if
   *  it was not spawned as a specialist. Surfaced as a roster badge so a
   *  coordinator-spawned specialist agent is visibly attributed (task 5.4).
   *  Optional: `rowFor` always sets it, but roster fixtures may omit it. */
  specialist?: string | null;
  /** The role marker — `'coordinator'` for the per-project coordinator pane, else
   *  null. Surfaced so the overview can badge the coordinator (task 6.5). Optional:
   *  `rowFor` always sets it, but roster fixtures may omit it. */
  role?: 'coordinator' | null;
  /** The paneId of the COORDINATOR that spawned/drives this agent, or null. Surfaced
   *  so the roster can attribute the agent to its coordinator's orchestration
   *  (task 6.5). Optional: `rowFor` always sets it, but fixtures may omit it. */
  coordinatorPaneId?: string | null;
  /** Whether the agent's session is CLOSED (Completed): PTY terminated, retained
   *  only for restore (`claude --resume`) or delete. Forces the `finished` status
   *  so a closed agent always sits in the Completed lane. Optional: `rowFor` always
   *  sets it, but roster fixtures may omit it (treated as not-closed). */
  closed?: boolean;
  /** Whether the agent is PAUSED (deferred): kept live but moved to the Paused lane
   *  and out of attention. Optional; roster fixtures may omit it (not-paused). */
  paused?: boolean;
  /** The user-message COUNT captured at pause time; the inbox resumes the agent when
   *  the live count strictly exceeds it (a new message arrived). Null when not yet
   *  established; undefined when not paused. */
  pausedCount?: number | null;
  /** Whether the agent is being PREVIEWED: an archived session resumed for viewing
   *  (live terminal), still pinned to the Archived lane and out of attention until a
   *  new message UNARCHIVES it. Optional; roster fixtures may omit it (not-preview). */
  preview?: boolean;
  /** The user-message COUNT captured when the preview began; the inbox unarchives the
   *  session when the live count strictly exceeds it. Undefined when not previewing. */
  previewCount?: number | null;
  /** Whether this agent has EVER been prompted — it has received its first user prompt
   *  or otherwise begun a turn (event-sourced `everPrompted`, sticky). `false` for an
   *  agent launched with no initial prompt that is still sitting at an empty prompt.
   *  The needs-input ALERTS use this to stay silent until the first prompt (an agent
   *  you just launched yourself is no surprise); it does NOT affect the attention lane.
   *  Optional: `rowFor` always sets it, but roster fixtures may omit it. */
  everPrompted?: boolean;
  /** The id of the coordinator Task this agent is currently executing (its most-recent
   *  non-terminal Task, else its most-recent terminal one — see {@link selectCurrentTask}),
   *  or null when no Task is assigned to the pane. Surfaced so the roster can attribute
   *  the worker to its Task (task 10.1) without a dedicated board panel. Optional:
   *  `rowFor` always sets it, but roster fixtures may omit it. */
  taskId?: string | null;
  /** The current Task's goal (what it is to accomplish), or null when no Task is
   *  assigned. The Overview may truncate it to a short label. Optional; see `taskId`. */
  taskGoal?: string | null;
  /** The current Task's lifecycle state (`assigned`/`working`/`blocked`/
   *  `input-required`/`done`/`failed`), or null when no Task is assigned. Optional;
   *  see `taskId`. */
  taskState?: TaskState | null;
}

/** Coerce to a finite number, else null (guards NaN/Infinity/strings). */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * PURE status for one agent, from its live runtime state + "now" (epoch ms):
 *
 *  - process exited, non-zero code            → `error`   (crashed / failed)
 *  - process exited, code 0 or unknown        → `finished`(session ended cleanly)
 *  - alive, output within the working window  → `working` (streaming right now)
 *  - alive, output older than the window      → `waiting` (quiet — needs input)
 *  - alive, no output yet                     → `working` (just spawned, starting)
 *  - no runtime at all                        → `idle`    (pane not wired yet)
 *
 * Exit state takes precedence over activity (a dead process is never "working").
 * Never throws.
 */
export function deriveStatus(
  runtime: PaneRuntime | undefined,
  nowMs: number,
  workingWindowMs: number = WORKING_WINDOW_MS,
  prevStatus?: AgentStatus
): AgentStatus {
  if (!runtime) return 'idle';
  if (runtime.exited) {
    const code = finiteOrNull(runtime.exitCode);
    return code !== null && code !== 0 ? 'error' : 'finished';
  }
  if (runtime.lastOutputAt === null) return 'working';
  const silent = nowMs - runtime.lastOutputAt;
  // Responsive promote: recent output → working.
  if (silent <= workingWindowMs) return 'working';
  // Demotion hysteresis: a pane that was ALREADY working holds In flight through
  // continued silence until the longer idle-grace window elapses, so a quiet-but-
  // active agent does not bounce working↔waiting. The hold applies ONLY to a pane
  // that was working (a settled `waiting` pane is not re-promoted); with no prior
  // status (`undefined`) this branch is skipped → single-window behavior (fail-safe).
  if (prevStatus === 'working' && silent <= IDLE_GRACE_MS) return 'working';
  return 'waiting';
}

/** The last path segment of a cwd (e.g. `/home/u/parser` -> `parser`), or null. */
function shortCwd(cwd: string | null): string | null {
  if (!cwd) return null;
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : null;
}

/** The display name: workspace name, else short cwd, else the pane id. */
function displayName(wsName: string, cwd: string | null, paneId: string): string {
  const name = wsName.trim();
  if (name.length > 0) return name;
  return shortCwd(cwd) ?? paneId;
}

/**
 * Build one `AgentRow` for an app pane. The name/cwd come from the workspace
 * projection; the model/task/context/cost from the (possibly absent) snapshot;
 * the status from the live runtime state (PTY activity + process exit).
 */
function rowFor(
  workspaceId: string,
  wsName: string,
  pane: RosterPane,
  snapshot: Snapshot | undefined,
  runtime: PaneRuntime | undefined,
  activity: RowActivity | undefined,
  event: EventActivity | undefined,
  nowMs: number,
  workingWindowMs: number,
  coordFlag: boolean,
  tasks: Task[] | undefined
): AgentRow {
  // Status precedence: a process exit is AUTHORITATIVE (a dead process is never
  // "working"); otherwise the event-sourced status wins; the PTY-byte heuristic is
  // the fallback only when events haven't determined a status (or none arrived).
  // `runtime.lastStatus` (the pane's previously-shown final status, recorded by the
  // Overview after each rebuild) drives the silence-demotion hysteresis in deriveStatus.
  const ptyStatus = deriveStatus(runtime, nowMs, workingWindowMs, runtime?.lastStatus);
  // A CLOSED (Completed) agent is always `finished` (Completed lane), regardless of
  // how its PTY exited — overrides the exit-code/event-derived status.
  const closed = pane.closed === true;
  const question = event?.question ?? activity?.question ?? null;
  const questions = event?.questions ?? activity?.questions ?? null;
  // A LIVE (non-exited) process is NEVER `finished` from an event: a `SessionEnd` hook
  // (e.g. `/clear`, `/logout`) ends the CONVERSATION but the claude process restarts in
  // place, so an event-sourced `finished` here is stale — fall back to the live PTY
  // status. Only an actual PTY exit (below) or an explicit close finishes a live row, so
  // the inbox auto-archive never fires on a session the user is still in. Mirror of the
  // exit rule's "a dead process is never working".
  const liveEventStatus = event?.status && event.status !== 'finished' ? event.status : null;
  let status: AgentStatus = closed
    ? 'finished'
    : runtime?.exited
      ? ptyStatus
      : liveEventStatus ?? ptyStatus;
  // COORDINATOR status (tasks 10.11–10.12 + coordinator-idle-when-quiet): a LIVE
  // coordinator does NOT inherit the default idle/waiting heuristic. It derives one of
  // three states; a closed/exited coordinator keeps its derived (finished/error)
  // status — it's not "live".
  //   1. NEEDS YOU (`waiting`, → Needs-you lane) — it asked an AskUserQuestion (its
  //      pending question(s)) OR called `request_user_input` (the `coordFlag`), OR it
  //      has NEVER been prompted: a freshly launched coordinator spawns at an empty
  //      prompt (`startCoordinator` launches with `prompt:''`) and is genuinely
  //      waiting on YOU for its first instruction until its first turn starts
  //      (`everPrompted === true`, set when you type or an escalation is injected).
  //   2. WORKING (In flight) — engaged and ACTUALLY running: streaming output within
  //      the working window (`ptyStatus`) OR a live terminal active-work affordance
  //      ("esc to interrupt" / "Waiting for N dynamic workflow(s)") seen within the
  //      busy grace window. These are the same activity signals a normal pane uses.
  //   3. IDLE — engaged but genuinely quiet at its prompt (no recent output, no
  //      affordance). It stays OUT of attention (it never nags) and is NOT shown In
  //      flight, so it shows no flashing dot — fixing the "always looks like it's
  //      running" bug while preserving the no-nag suppression.
  if (pane.role === 'coordinator' && !closed && !runtime?.exited) {
    const everPrompted = event?.everPrompted === true;
    const needsYou = coordinatorNeedsInput({ question, questions }, coordFlag) || !everPrompted;
    if (needsYou) {
      status = 'waiting';
    } else {
      const busy =
        runtime?.terminalBusyAt != null && nowMs - runtime.terminalBusyAt <= BUSY_GRACE_MS;
      status = ptyStatus === 'working' || busy ? 'working' : 'idle';
    }
  }
  // TERMINAL-BUSY In-flight override (agent-status-derivation): Claude Code may be
  // actively working while its event hooks report idle — a foreground command
  // running in the terminal, or in-session background work (a dynamic workflow /
  // another agent still running). The TerminalPane stamps `runtime.terminalBusyAt`
  // from `detectTerminalBusy` on each positive detection. For a LIVE, NON-coordinator
  // pane with NO pending AskUserQuestion, show it In flight (`working`) rather than
  // Needs input, so it stays out of attention until the work finishes or the user
  // interrupts it.
  //
  // HYSTERESIS (fix-needs-you-bounce): the affordance is screen-scraped from a
  // continuously-redrawing TUI per output chunk and sampled by the ~1 s heartbeat,
  // so the raw signal flickers — a single sample can miss an affordance still
  // present. Keying the override on the LAST positive detection within
  // `BUSY_GRACE_MS` (rather than the instantaneous sample) holds In flight through a
  // flicker, killing the ~1 Hz In-flight↔Needs-you bounce; a fresh detection re-arms
  // it immediately and it lapses a few seconds after the affordance truly ends.
  //
  // Strictly ADDITIVE and fail-safe: with no detection ever (or once the window has
  // lapsed) the result is byte-for-byte the prior derivation. The coordinator path is
  // untouched (decided above by coordinatorNeedsInput), an exited/closed pane is never
  // re-flagged working (a dead process is never working), and a pending question keeps
  // Needs input regardless of any indicator.
  const hasPendingQuestion =
    question != null || (Array.isArray(questions) && questions.length > 0);
  if (
    runtime?.terminalBusyAt != null &&
    nowMs - runtime.terminalBusyAt <= BUSY_GRACE_MS &&
    pane.role !== 'coordinator' &&
    !closed &&
    !runtime.exited &&
    !hasPendingQuestion
  ) {
    status = 'working';
  }
  // Coordinator-task attribution (task 10.1): the pane's current Task among those
  // assigned to it, chosen by `selectCurrentTask` (most-recent non-terminal, else
  // most-recent). Pure derivation from the passed-in map — no store/polling here.
  const currentTask = selectCurrentTask(tasks);
  return {
    paneId: pane.paneId,
    workspaceId,
    name: displayName(wsName, pane.cwd, pane.paneId),
    cwd: pane.cwd,
    model: snapshot?.model ?? null,
    modelId: snapshot?.model_id ?? null,
    task: snapshot?.task ?? null,
    summary: activity?.summary ?? null,
    // The pending question is event-sourced (it rides the PreToolUse event); the
    // transcript sidecar is a fallback for sessions with no event pipeline.
    question,
    questions,
    currentAction: event?.currentAction ?? null,
    // Context % comes from the statusline snapshot — Claude Code computes it
    // against the REAL context window (incl. the 1M variants) and the auto-compact
    // threshold, the same authoritative source the footer uses, so the card and
    // footer always agree. The transcript-derived value is window-BLIND (the
    // transcript records the bare model id with no 1M marker, so it always divides
    // by 200k and pins a 1M session at 100%), hence only a fallback when the
    // snapshot has no value yet.
    contextPct: finiteOrNull(snapshot?.context_pct) ?? finiteOrNull(activity?.contextPct),
    cost: finiteOrNull(snapshot?.cost),
    // For closed/preview sessions use the transcript's last-entry timestamp —
    // stable across `claude --resume` reopens (no new entry until the user
    // replies). Falls back to the snapshot ts. Live sessions use snapshot ts.
    lastTs:
      (pane.closed || pane.preview)
        ? (finiteOrNull(activity?.lastMsgTs) ?? finiteOrNull(snapshot?.ts))
        : finiteOrNull(snapshot?.ts),
    status,
    projectId: pane.projectId ?? null,
    specialist: pane.specialist ?? null,
    role: pane.role ?? null,
    coordinatorPaneId: pane.coordinatorPaneId ?? null,
    closed,
    paused: pane.paused === true,
    pausedCount: pane.pausedCount ?? null,
    preview: pane.preview === true,
    previewCount: pane.previewCount ?? null,
    everPrompted: event?.everPrompted === true,
    // Coordinator-task attribution (task 10.1): the pane's current Task, selected
    // from every Task assigned to it (most-recent non-terminal, else most-recent).
    // Null across all three fields when nothing is assigned — the row is then
    // byte-for-byte its pre-task-board shape.
    taskId: currentTask?.id ?? null,
    taskGoal: currentTask?.goal ?? null,
    taskState: currentTask?.state ?? null
  };
}

/**
 * The whole roster: ONE `AgentRow` per app pane across every workspace, in
 * workspace-then-pane (tree) order. Non-app (shell) panes are skipped entirely.
 * An app pane with no runtime yet still rosters (status `idle` until its terminal
 * wires up), so a freshly-launched agent is never silently dropped.
 *
 * Pure: reads the maps + workspaces + `now`, returns fresh rows, mutates nothing.
 *
 * @param map         the live pane_id -> snapshot map (model/task/context/cost)
 * @param workspaces  the framework-free workspace projection
 * @param runtime     the live pane_id -> runtime map (PTY activity + exit), for status
 * @param nowMs       "now" in epoch ms, for the output-activity window
 * @param activity    the live session_id -> transcript activity map (summary/question)
 * @param workingWindowMs  activity window in ms (default WORKING_WINDOW_MS)
 * @param eventActivity  the live pane_id -> event-sourced activity map (status/question)
 * @param coordNeedsInput  set of coordinator paneIds that explicitly called
 *   `request_user_input` (tasks 10.11–10.12); a coordinator in this set needs you
 *   even with no pending AskUserQuestion. Default empty (no explicit signals).
 * @param tasksByPane  the live pane_id -> Task[] map for coordinator-task attribution
 *   (task 10.1): every Task assigned to each worker pane, grouped by `assigneePaneId`
 *   by the Overview from the per-project `taskBoard`. Default empty (no tasks / board
 *   not wired) — the row's task fields are then all null.
 */
export function buildRoster(
  map: SnapshotMap,
  workspaces: RosterWorkspace[],
  runtime: RuntimeMap,
  nowMs: number,
  activity: ActivityMap = {},
  workingWindowMs: number = WORKING_WINDOW_MS,
  eventActivity: Record<string, EventActivity> = {},
  coordNeedsInput: ReadonlySet<string> = new Set(),
  tasksByPane: TaskMap = {}
): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      if (!pane.isApp) continue;
      // Both activity maps are keyed on the pane id (its transcript/events are
      // located from the cwd / the app-stamped pane env).
      const act = activity[pane.paneId];
      rows.push(
        rowFor(
          ws.id,
          ws.name,
          pane,
          map[pane.paneId],
          runtime[pane.paneId],
          act,
          eventActivity[pane.paneId],
          nowMs,
          workingWindowMs,
          coordNeedsInput.has(pane.paneId),
          tasksByPane[pane.paneId]
        )
      );
    }
  }
  return rows;
}
