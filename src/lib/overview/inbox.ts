// src/lib/overview/inbox.ts
// PURE selection cores for the inbox overview (design 2026-06-04). The focus pane
// shows ONE agent: the user's explicit selection if any, else the first agent that
// needs attention, else none ("All clear"). Addressing the focused attention agent
// (it transitions out of the attention status) advances the focus to the next in
// the queue. Framework-free so it is trivially unit-tested; Inbox.svelte is the
// thin reactive shell that feeds it the live roster and renders the result.

import { archivedPaneIds, laneForRow, needsAttention, type AgentRow, type AgentStatus } from './roster';
import { modelLabel } from '$lib/usage/modelLabel';
import type { ConfirmOptions } from '$lib/ui/confirmStore.svelte';

/** Max characters of the roster sub-line (a one-line display); longer messages are
 *  clipped with a trailing ellipsis. Sized for the narrow inbox column + its tooltip
 *  so a multi-paragraph assistant message doesn't render a giant tooltip. */
export const ROW_SUB_MAX_LEN = 140;

/**
 * PURE: collapse a (possibly multi-line) message to a single trimmed line and clip it
 * to `ROW_SUB_MAX_LEN` for the one-line roster sub-line. Returns null for an
 * empty/whitespace-only/absent input so callers can fall through to the next source.
 * Internal runs of whitespace (incl. newlines/tabs) collapse to single spaces.
 */
export function clipLine(
  text: string | null | undefined,
  maxLen: number = ROW_SUB_MAX_LEN
): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return null;
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '…' : oneLine;
}

/** PURE: total session cost as a compact label — `$1.50`, or an em dash when unknown.
 *  Used as the FINISHED-state sub-line fallback (a finished row with no message shows
 *  what it cost). Mirrors the formatting of the old inline `cost` helper. */
export function cost(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `$${value.toFixed(2)}`;
}

/**
 * PURE: the STATE-APPROPRIATE generic sub-line for a row that has NO pending question
 * and NO (live or cached) last message — the per-lane words restored from the old
 * inline `rowSub`. The more-specific lifecycle states win, in precedence order:
 *   - closed (Archived)        → 'Archived'
 *   - paused                   → 'Paused · send a message to resume'
 *   - error                    → 'Errored — needs you'
 *   - attention (waiting, etc) → 'Needs input'
 *   - finished                 → the formatted `cost`
 *   - working / idle / other   → `currentAction`, else 'Working…'
 * Only ever reached as the LAST resort by `rowSub` (a real message always wins first),
 * so e.g. an archived row WITH a (cached) message shows the message, not 'Archived'.
 */
export function stateFallback(
  row: Pick<AgentRow, 'closed' | 'paused' | 'status' | 'currentAction' | 'cost'>
): string {
  if (row.closed) return 'Archived';
  if (row.paused) return 'Paused · send a message to resume';
  if (isAttention(row.status)) {
    if (row.status === 'error') return 'Errored — needs you';
    return 'Needs input';
  }
  if (row.status === 'finished') return cost(row.cost);
  return row.currentAction ?? 'Working…';
}

/**
 * PURE: the secondary "what it last said / is asking" line for a roster row, used for
 * EVERY lane — including archived (closed) and previewing rows. Priority:
 *   1. a pending question — the structured `questions[0].question`, else the compact
 *      `question` string (this is what the agent is waiting on YOU for);
 *   2. the last assistant message — the live `summary`, else the per-session cached
 *      summary the caller injects via `cachedSummary` (a closed pane has no live PTY,
 *      so its `summary` is gone — the cache, recorded while it was live, supplies it);
 *   3. a STATE-APPROPRIATE generic fallback (`stateFallback`) when none of the above
 *      exists — the per-lane word for the row's state (Archived / Paused / Errored /
 *      Needs input / the cost / the current action), NOT a single flat string.
 * Each candidate is clipped to one line; an empty/whitespace candidate is skipped.
 *
 * `cachedSummary` is an injected lookup (`() => string | null`) so this stays a pure
 * function of its inputs and is unit-testable without a live component. Resolving the
 * session id (to key the cache) is the caller's job.
 */
export function rowSub(
  row: Pick<
    AgentRow,
    'question' | 'questions' | 'summary' | 'closed' | 'paused' | 'status' | 'currentAction' | 'cost'
  >,
  cachedSummary: () => string | null = () => null
): string {
  const question =
    row.questions && row.questions.length > 0 ? row.questions[0].question : row.question;
  return (
    clipLine(question) ?? clipLine(row.summary) ?? clipLine(cachedSummary()) ?? stateFallback(row)
  );
}

/** Whether a status means the agent is waiting on YOU (waiting or errored). This is
 *  the STATUS-only check (used for badge/label styling); the attention QUEUE uses
 *  the row-level `needsAttention` so paused/archived agents are excluded. */
export function isAttention(status: AgentStatus): boolean {
  return status === 'waiting' || status === 'error';
}

/**
 * The attention queue: every agent that needs you, in roster order — waiting/errored
 * AND not paused/archived (`needsAttention`). These are the rows the focus pane
 * auto-fills from (top first) and drains as each is addressed.
 */
export function attentionQueue(rows: AgentRow[]): AgentRow[] {
  return rows.filter((r) => needsAttention(r));
}

/**
 * The focused agent for the right pane:
 *   1. the user's explicit selection, if that pane still exists in the roster;
 *   2. else the first agent in the attention queue;
 *   3. else null ("All clear").
 */
export function resolveFocus(rows: AgentRow[], userSelected: string | null): AgentRow | null {
  if (userSelected) {
    const picked = rows.find((r) => r.paneId === userSelected);
    if (picked) return picked;
  }
  return attentionQueue(rows)[0] ?? null;
}

/**
 * PURE: the session to default-select when a project is OPENED — "where the user
 * left off". Deliberately CONSERVATIVE: it restores ONLY the project's explicitly
 * recorded last-used session (`lastSessionId`), and only when a LIVE (non-closed)
 * row with that STABLE session id is still present. It returns null in every other
 * case — no recorded id, the recorded session is gone, or it is now archived — so the
 * caller falls through to the normal focus resolution (attention agent, else "All
 * clear") UNCHANGED.
 *
 * Why so narrow (see the adversarial review that shaped this):
 *   - NO most-recently-active guess: picking an arbitrary MRU row on open would bury
 *     an agent that needs the user behind one that doesn't (a focus regression).
 *   - NO archived rows: a closed row is never auto-selected, so opening/cycling
 *     projects can never spawn a `claude --resume` preview as a navigation side effect.
 *
 * `rows` are the target project's rows (the caller filters by project). `sessionIdOf`
 * maps a row to its stable session id (null for a non-resumable pane), injected so
 * this stays framework-free and unit-testable. Never mutates `rows`.
 */
export function resolveProjectDefaultSession(
  rows: AgentRow[],
  lastSessionId: string | null,
  sessionIdOf: (r: AgentRow) => string | null
): AgentRow | null {
  if (!lastSessionId) return null;
  return rows.find((r) => !r.closed && sessionIdOf(r) === lastSessionId) ?? null;
}

/**
 * PURE: the focus target after the user EXPLICITLY dismisses the shown session
 * (archive / pause / delete) — the next actionable session, excluding the
 * dismissed pane, chosen in roster (display) order:
 *   1. the first Needs-you session (`attentionQueue`), else
 *   2. the first In-flight session (the `flight` lane: working/idle, not
 *      paused/archived/previewing), else
 *   3. null ("All clear").
 *
 * This is a DISTINCT path from the opt-in auto-advance (`resolveFocus` + the
 * grace timer): it is immediate, unconditional (ignores the auto-advance
 * setting), and broadens the target to In-flight. `rows` must be in roster
 * order so "first" matches what the user sees. Pure: never mutates inputs.
 */
export function nextOnDismiss(rows: AgentRow[], dismissedPaneId: string): string | null {
  const others = rows.filter((r) => r.paneId !== dismissedPaneId);
  const attn = attentionQueue(others)[0];
  if (attn) return attn.paneId;
  const flight = others.find((r) => laneForRow(r) === 'flight');
  return flight?.paneId ?? null;
}

/**
 * Step through the attention queue from `currentPaneId` by `dir` (+1 / -1),
 * wrapping around. Returns the next attention pane id, or null when the queue is
 * empty. Used by the focus header's ↑/↓ queue-nav.
 */
export function nextInQueue(
  rows: AgentRow[],
  currentPaneId: string | null,
  dir: 1 | -1
): string | null {
  const q = attentionQueue(rows);
  if (q.length === 0) return null;
  const i = q.findIndex((r) => r.paneId === currentPaneId);
  const base = i < 0 ? 0 : i;
  const next = (base + dir + q.length) % q.length;
  return q[next].paneId;
}

/**
 * Whether to drop the user's pin on the focused agent: it WAS pinned, it used to
 * need attention, and it no longer does (you addressed it). Dropping the pin lets
 * `resolveFocus` advance to the next agent in the queue — "addressing one moves to
 * the next". A non-pinned agent, or one still needing attention, keeps its state.
 */
export function shouldClearPin(
  prev: AgentStatus,
  next: AgentStatus,
  isPinned: boolean
): boolean {
  return isPinned && isAttention(prev) && !isAttention(next);
}

/**
 * PURE: archiving a session with NO user messages is pointless (there's nothing to
 * resume), so it is deleted outright; a session with messages is archived (kept,
 * restorable). `userHash` is the transcript's user-message hash — falsy (null /
 * undefined / empty) means zero user messages.
 */
export function archiveDecision(userHash: string | null | undefined): 'delete' | 'archive' {
  return userHash ? 'archive' : 'delete';
}

/**
 * PURE: what the auto-archive effect should do for a row that just settled. Only a
 * LIVE session that finished cleanly is acted on — already closed/paused/previewing
 * rows are left alone (`'none'`) so the effect fires once. A finished session with
 * NO user messages (e.g. the user only typed `/exit`, which doesn't count) has
 * nothing to resume, so it is DELETED rather than archived; otherwise it is archived
 * (kept, restorable). Mirrors the manual `archiveAgent` decision via `archiveDecision`.
 */
export function autoArchiveAction(
  row: Pick<AgentRow, 'closed' | 'paused' | 'preview' | 'status'>,
  userHash: string | null | undefined
): 'delete' | 'archive' | 'none' {
  if (row.closed || row.paused || row.preview || row.status !== 'finished') return 'none';
  return archiveDecision(userHash);
}

/**
 * PURE: whether a paused/previewing agent should auto-resume — true only once the
 * LIVE user-message COUNT strictly EXCEEDS the baseline captured when it was paused /
 * previewed (the user sent a genuinely new message). Both must be known numbers: an
 * unknown live count (a transient poll gap) or an unestablished baseline never
 * resumes — the caller lazily establishes the baseline from the first known reading.
 *
 * This replaces the old `user_hash` comparison, which keyed on a TAIL-windowed hash
 * that could change WITHOUT a new user message (a `claude --resume` for preview grows
 * the transcript and slides the window), spuriously unarchiving a previewed session.
 * A strictly-increasing whole-file count cannot be moved by assistant output.
 */
export function shouldAutoResume(
  baselineCount: number | null | undefined,
  liveCount: number | null | undefined
): boolean {
  if (typeof liveCount !== 'number' || typeof baselineCount !== 'number') return false;
  return liveCount > baselineCount;
}

/**
 * PURE: the model label to show on an agent card — `modelLabel(r.modelId, r.model)`.
 * Returns a versioned human-readable label like `"Opus 4.8"` for a known id, falls
 * back to the snapshot display name, then `'—'` when both are absent.
 * Introduced as the card-level seam so unit tests cover the exact text the card
 * renders without mounting a Svelte component.
 */
export function rowModelLabel(row: Pick<AgentRow, 'modelId' | 'model'>): string {
  return modelLabel(row.modelId ?? null, row.model ?? null);
}

/**
 * PURE: build a confirmation request for archiving an agent that is currently
 * WORKING (actively producing output), or `null` when no confirmation is needed —
 * any other status archives immediately. Archiving a working session interrupts a
 * running task, so we guard it; the returned `onConfirm` runs the caller's `archive`
 * action ONLY when the user confirms. Mirrors `deleteAllArchivedRequest`'s shape so
 * the caller just `confirmModal.show(req)` when non-null.
 */
export function archiveWorkingConfirm(
  status: AgentStatus,
  archive: () => void
): ConfirmOptions | null {
  if (status !== 'working') return null;
  return {
    title: 'Archive working session?',
    message:
      'This agent is currently working. Archiving will stop it. You can restore it later from Archived.',
    confirmLabel: 'Archive anyway',
    onConfirm: archive
  };
}

/**
 * PURE: build the confirmation request for "delete all archived agents", or `null`
 * when nothing is archived (so the caller hides the action). The returned
 * `onConfirm` deletes every archived pane (`archivedPaneIds`) via `deleteAgent`,
 * clearing the selection first if it points at one of them — so the agents are
 * removed ONLY when the user confirms, and never the agents in other lanes.
 */
export function deleteAllArchivedRequest(
  rows: AgentRow[],
  deps: {
    deleteAgent: (paneId: string) => void;
    getSelected: () => string | null;
    setSelected: (paneId: string | null) => void;
  }
): ConfirmOptions | null {
  const ids = archivedPaneIds(rows);
  if (ids.length === 0) return null;
  const noun = ids.length === 1 ? 'agent' : 'agents';
  return {
    title: 'Delete archived agents',
    message: `Delete all ${ids.length} archived ${noun}? This permanently removes their sessions and cannot be undone.`,
    confirmLabel: 'Delete',
    onConfirm: () => {
      for (const id of ids) {
        if (deps.getSelected() === id) deps.setSelected(null);
        deps.deleteAgent(id);
      }
    }
  };
}

/**
 * PURE: decide whether keyboard navigation onto `selectedPaneId` should expand the
 * collapsed Archived lane. The lane shows only its first `previewCount` rows (the
 * newest-first `archivedPaneIds`) until "Show all" is toggled; a selection beyond
 * that preview is not rendered, so it cannot be revealed without expanding. Returns
 * true ONLY when the lane is still collapsed AND the selected pane is an archived row
 * at or beyond `previewCount`. The `showingAll` short-circuit makes the caller's
 * `showAllArchived = true` write monotonic (true → already-showing → false), so the
 * driving effect converges instead of looping. A null/non-archived selection is false.
 */
export function archivedNavNeedsExpand(
  selectedPaneId: string | null,
  archivedPaneIds: string[],
  previewCount: number,
  showingAll: boolean
): boolean {
  if (showingAll || selectedPaneId === null) return false;
  const idx = archivedPaneIds.indexOf(selectedPaneId);
  return idx >= previewCount;
}
