<!-- src/lib/overview/Inbox.svelte -->
<script lang="ts">
  // The INBOX — the primary overview surface (replaces the lane-of-cards
  // Overview). Left: a grouped roster of every agent (Needs you / In flight /
  // Paused / Archived), each a row with a status circle. Right: a single focus pane —
  // a thin header, then the SELECTED agent's live terminal (auto-focused +
  // scrolled to bottom; no footer), or an "All clear" panel when nothing needs
  // you and nothing is open.
  //
  // The live terminal is NOT re-mounted here: the single mounted workspace
  // surface (all PaneNodes/PTYs, owned by +page) is teleported into `focusSlot`
  // via surfaceSlot + the portal action. Selecting an agent is just
  // setActiveWorkspace + setFocusIn — the existing display:none workspace swap —
  // so no PTY is ever double-spawned. All selection logic is pure (inbox.ts).

  import { tick } from 'svelte';
  import { workspace } from '$lib/layout/workspace.svelte';
  import { snapshots } from '$lib/usage/snapshots.svelte';
  import { launcher } from '$lib/launcher/launcherStore.svelte';
  import { startNewSession } from '$lib/launcher/newSession';
  import { surfaceSlot } from '$lib/layout/surfaceSlot.svelte';
  import { focusTerminal, scrollTerminalToBottom } from '$lib/layout/terminals';
  import {
    buildRoster,
    groupByLane,
    needsAttention,
    isArchivedCoordinator,
    showContext,
    LANE_ORDER,
    laneForRow,
    reorderLane,
    orderRowsByLane,
    type AgentLane,
    type AgentRow,
    type AgentStatus
  } from './roster';
  import {
    isAttention,
    attentionQueue,
    resolveFocus,
    resolveProjectDefaultSession,
    nextInQueue,
    nextOnDismiss,
    archiveDecision,
    autoArchiveAction,
    shouldAutoResume,
    deleteAllArchivedRequest,
    archiveWorkingConfirm,
    archivedNavNeedsExpand,
    rowSub as rowSubText
  } from './inbox';
  import { toRosterWorkspaces, toNavWorkspaces } from './rosterInputs';
  import { noteStatus, runtimeMap } from './runtime';
  import { navigateTarget } from './navigate';
  import { focusAgent } from './focusAgent.svelte';
  import { focusRequest } from './focusRequest.svelte';
  import { activity } from './activity.svelte';
  import { events } from './events.svelte';
  import { titles } from './titles.svelte';
  import { summaries } from './summaries.svelte';
  import { costs } from './costs.svelte';
  import { subagents } from './subagents.svelte';
  import { subagentsVisible } from '$lib/settings/subagentsVisible.svelte';
  import {
    groupSubagentsByPhase,
    formatDurationAlive,
    liveSubagents,
    type WorkflowGroup
  } from './subagentRows';
  import { projects } from '$lib/projects/projects.svelte';
  import { projectFilter } from '$lib/projects/projectFilter.svelte';
  import {
    filterRowsByProject,
    filterOrder,
    stepFilter,
    unassignedCount
  } from '$lib/projects/projectRollup';
  import { projectForId } from '$lib/projects/projects';
  import ProjectPanel from '$lib/projects/ProjectPanel.svelte';
  import ProjectIcon from '$lib/icons/ProjectIcon.svelte';
  import Icon from '$lib/icons/Icon.svelte';
  import { confirmModal } from '$lib/ui/confirmStore.svelte';
  import StatusBar from '$lib/usage/StatusBar.svelte';
  import { tooltip } from '$lib/ui/tooltip';
  import { friendlyTime } from './friendlyTime';
  import { rowModelLabel } from './inbox';
  import ContextMenu, { type MenuItem } from '$lib/ui/ContextMenu.svelte';
  import TasksLauncher from '$lib/tasks/TasksLauncher.svelte';
  // import SpecialistsPanel from '$lib/specialists/SpecialistsPanel.svelte'; // temporarily hidden
  import { ALL, UNASSIGNED } from '$lib/projects/projectRollup';
  import {
    resolveCoordinatorPin,
    coordinatorStartId,
    coordinatorStartProject,
    coordinatorNavOrder
  } from './coordinatorPin';
  import CoordinatorStart from '$lib/orchestration/CoordinatorStart.svelte';
  import { coordinatorNeedsInput } from '$lib/orchestration/coordinatorNeedsInput.svelte';
  import { autoAdvance } from '$lib/settings/autoAdvance.svelte';
  import { compactMode } from '$lib/settings/compactMode.svelte';
  import { uiPrefs } from '$lib/settings/uiPrefs.svelte';

  // --- Sessions / Tasks split (Sessions roster on top / Tasks bottom) ----------
  // The `.col-list` column splits into the Sessions roster (top, resizable) and
  // the bottom region (Tasks launcher + Agents library). The bottom region's
  // height is a persisted fraction of the column (clamped) so the Sessions area
  // resizes by dragging the gutter between them; driven via flex-basis.
  // The bottom region's height is a persisted fraction of the column, stored in
  // the durable `ui` settings slice (`uiPrefs`) — NOT localStorage.
  const tasksFrac = $derived(uiPrefs.data.tasksLauncherFrac);
  function setTasksFrac(f: number) {
    uiPrefs.setTasksLauncherFrac(f);
  }
  /** Drag the gutter: convert pointer Y within the column into a bottom fraction. */
  function startTasksResize(e: PointerEvent) {
    e.preventDefault();
    const gutter = e.currentTarget as HTMLElement;
    const col = gutter.parentElement;
    if (!col) return;
    gutter.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = col.getBoundingClientRect();
      if (rect.height <= 0) return;
      const frac = (rect.bottom - ev.clientY) / rect.height;
      setTasksFrac(frac);
    };
    const up = (ev: PointerEvent) => {
      gutter.releasePointerCapture(ev.pointerId);
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', up);
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', up);
  }

  // 1-second clock so working -> waiting flips as the PTY goes quiet (matches the
  // old Overview). Epoch ms to match the runtime registry.
  let nowMs = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => (nowMs = Date.now()), 1000);
    return () => clearInterval(id);
  });

  const rosterWorkspaces = $derived(toRosterWorkspaces(workspace.workspaces));
  const navWorkspaces = $derived(toNavWorkspaces(workspace.workspaces));

  // The set of coordinator paneIds that explicitly called `request_user_input`
  // (tasks 10.11–10.12). A coordinator in this set surfaces "needs you" even with no
  // pending AskUserQuestion; the default keep-working heuristic never flags it.
  const coordNeedsInputSet = $derived(new Set(Object.keys(coordinatorNeedsInput.all())));
  const allRows = $derived(
    buildRoster(
      snapshots.byPane,
      rosterWorkspaces,
      runtimeMap(),
      nowMs,
      activity.bySession,
      undefined,
      events.activityMap(),
      coordNeedsInputSet
    )
  );

  // CLEAR the explicit coordinator needs-input flag once the coordinator RESUMES (its
  // effective status is `working` again) — the documented clear trigger: the user
  // delivered input and the coordinator is back to work. Runs off the same per-second
  // roster recompute. `coordinatorNeedsInput` is the orchestration store (read above),
  // not the roster's pure `coordinatorNeedsInput` helper.
  $effect(() => {
    for (const r of allRows) {
      if (r.role === 'coordinator') coordinatorNeedsInput.clearOnWorking(r.paneId, r.status);
      // Record each row's FINAL (post-override) status as the hysteresis memory for the
      // next derivation: a pane shown `working` holds In flight through a brief silence
      // instead of bouncing to `waiting` (see deriveStatus / IDLE_GRACE_MS). The runtime
      // registry is non-reactive, so this write does not retrigger the roster recompute;
      // `rowFor` reads the value recorded on the previous tick.
      noteStatus(r.paneId, r.status);
    }
  });
  const rows = $derived(filterRowsByProject(allRows, projectFilter.selected));

  // Per-lane DISPLAY ORDER. Every bucket lists its agents most-recently-added-to-
  // that-column first; the Needs-you (attn) and Paused orders PERSIST across restarts
  // (localStorage) so a returning agent keeps its slot rather than jumping by load
  // order. The map holds paneIds top-first per lane. `reorderLane` keeps the
  // established order while jumping a newcomer to the top, and drops agents
  // that left the lane; `orderRowsByLane` projects it onto the rendered rows so the
  // lanes, the attention queue, and focus resolution all agree on order.
  // The manual orders for the draggable lanes (attn + paused) persist in the
  // durable `ui` settings slice (`uiPrefs`), NOT localStorage. The non-draggable
  // lanes (flight/done) start empty and re-derive newest-first each session.
  let laneOrder = $state<Record<AgentLane, string[]>>({
    attn: [],
    flight: [],
    paused: [],
    done: []
  });

  // One-time seed from the durable prefs once they have hydrated (the settings
  // load is async, kicked off on app mount). Until then `laneOrder` holds defaults
  // and the reconcile effect below is gated off, so a returning agent's saved slot
  // is never overwritten by mount-order before the saved order arrives.
  let laneSeeded = $state(false);
  $effect(() => {
    if (laneSeeded || !uiPrefs.loaded) return;
    laneOrder = {
      attn: [...uiPrefs.data.laneOrder.attn],
      flight: [],
      paused: [...uiPrefs.data.laneOrder.paused],
      done: []
    };
    laneSeeded = true;
  });

  /** Persist ONLY the manually-reorderable lanes (attn + paused); flight/done are
   *  re-derived newest-first each session, so they are never stored. */
  function saveLaneOrder() {
    uiPrefs.setLaneOrder({ attn: laneOrder.attn, paused: laneOrder.paused });
  }

  // Reconcile every lane's order against the live roster. Computed over `allRows`
  // (UNFILTERED) so the order is stable as the project filter changes — the display
  // sorts the filtered `rows` by this global order. Idempotent: a recompute with the
  // same lane membership returns the same arrays (no write / no thrash off the clock).
  $effect(() => {
    // Hold off until the saved order has hydrated + seeded, so reconciliation never
    // persists mount-order over a returning agent's saved slot (see `laneSeeded`).
    if (!laneSeeded) return;
    const present: Record<AgentLane, string[]> = { attn: [], flight: [], paused: [], done: [] };
    for (const r of allRows) present[laneForRow(r)].push(r.paneId);
    const next: Record<AgentLane, string[]> = { ...laneOrder };
    let changed = false;
    let persistChanged = false;
    for (const lane of LANE_ORDER) {
      const reordered = reorderLane(laneOrder[lane], present[lane]);
      const same =
        reordered.length === laneOrder[lane].length &&
        reordered.every((id, i) => id === laneOrder[lane][i]);
      if (!same) {
        next[lane] = reordered;
        changed = true;
        if (lane === 'attn' || lane === 'paused') persistChanged = true;
      }
    }
    if (changed) {
      laneOrder = next;
      if (persistChanged) saveLaneOrder();
    }
  });

  const viewRows = $derived(orderRowsByLane(rows, laneOrder));

  const queue = $derived(attentionQueue(viewRows));

  // Flash a card briefly when its agent JUST enters the "needs you" state — a real
  // transition from not-attention → attention while we're watching (driven by the
  // per-second `nowMs` clock flipping working → waiting). We hold the paneId in a
  // reactive set for the 1.2s the CSS flash runs, then drop it. `prevAttn` /
  // `attnSeeded` are plain (untracked) trackers, like `lastShownId` above; seeding
  // on the first roster means agents ALREADY needing attention at mount don't flash
  // — only genuine transitions do.
  const FLASH_MS = 2500;
  let prevAttn = new Map<string, boolean>();
  let attnSeeded = false;
  let flashPanes = $state(new Set<string>());
  $effect(() => {
    const seen = new Set<string>();
    for (const r of viewRows) {
      seen.add(r.paneId);
      const now = needsAttention(r);
      if (attnSeeded && prevAttn.get(r.paneId) === false && now) {
        const id = r.paneId;
        flashPanes.add(id);
        flashPanes = new Set(flashPanes);
        setTimeout(() => {
          flashPanes.delete(id);
          flashPanes = new Set(flashPanes);
        }, FLASH_MS);
      }
      prevAttn.set(r.paneId, now);
    }
    for (const id of [...prevAttn.keys()]) if (!seen.has(id)) prevAttn.delete(id);
    attnSeeded = true;
  });

  // The active project for the coordinator pin: the concrete project chosen in the
  // project filter (null on All / Unassigned). Only with a concrete project does the
  // roster pin a coordinator / show the Start affordance (tasks 10.2–10.4).
  const activeCoordProjectId = $derived(
    projectFilter.selected === ALL || projectFilter.selected === UNASSIGNED
      ? null
      : projectFilter.selected
  );
  const activeCoordProject = $derived(projectForId(projects.list, activeCoordProjectId));
  // Pull the live coordinator out of the lanes (pinned atop the list) and decide
  // whether to show the not-started "Start coordinator" affordance.
  const pin = $derived(resolveCoordinatorPin(viewRows, activeCoordProjectId));
  // Lanes rendered BELOW the rule exclude the pinned coordinator (it never renders
  // twice). Keyboard nav uses `coordinatorNavOrder` (coordinator/affordance first),
  // not these render lanes, so the pinned coordinator stays reachable. `pin.rest`
  // is already lane-grouped + within-lane ordered (viewRows → orderRowsByLane), so
  // groupByLane just re-partitions it — including the Archived (done) lane, already
  // newest-first via `laneOrder` (no extra reverse needed).
  const renderGrouped = $derived(groupByLane(pin.rest));

  // The Archived lane collapses to its latest 2 rows (newest-first via `laneOrder`
  // — see above; no reverse — so the first 2 ARE the most recent) with a "Show all /
  // Collapse" toggle below; long archives don't bury the live lanes. Default collapsed.
  const ARCHIVED_PREVIEW = 2;
  let showAllArchived = $state(false);

  // Group metadata (label) for the left list, in attn -> flight -> paused -> done
  // order. `done` is the Archived lane (closed sessions); `paused` sits above it.
  const LANES: Record<AgentLane, { title: string }> = {
    attn: { title: 'Needs you' },
    flight: { title: 'In flight' },
    paused: { title: 'Paused' },
    done: { title: 'Archived' }
  };

  // The user's explicit pin (a watched agent), or null to let attention drive.
  let userSelected = $state<string | null>(null);

  // The agent actually SHOWN in the focus pane. Automatic, status-driven advances
  // LAG by ADVANCE_DELAY_MS: when the agent you're on stops needing you (e.g. it
  // goes Working) and another agent needs you, the focus moves to the TOP of the
  // queue after the grace; it never advances to nothing (you keep the agent if
  // nobody else needs you). User clicks / keyboard nav are immediate.
  let shownId = $state<string | null>(null);
  let advanceTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingTarget: string | null = null;
  // Plain (non-reactive) trackers to detect the shown agent leaving attention.
  let lastShownId: string | null = null;
  let lastShownStatus: AgentStatus | null = null;
  const ADVANCE_DELAY_MS = 1000;
  function clearAdvance() {
    if (advanceTimer) {
      clearTimeout(advanceTimer);
      advanceTimer = undefined;
    }
    pendingTarget = null;
  }

  // Whether the project pane (left of the roster) is collapsed — remembered across
  // app restarts via the durable `ui` settings slice (`uiPrefs`), NOT localStorage
  // (which WKWebView drops on an abrupt restart).
  const projectPaneCollapsed = $derived(uiPrefs.data.projectPaneCollapsed);
  function toggleProjectPane() {
    uiPrefs.setProjectPaneCollapsed(!projectPaneCollapsed);
  }

  // Right-click context menu for a roster row (open / close the agent).
  let menu = $state<{ open: boolean; x: number; y: number; items: MenuItem[] }>({
    open: false,
    x: 0,
    y: 0,
    items: []
  });

  // The focused (shown) agent row.
  const focus = $derived(viewRows.find((r) => r.paneId === shownId) ?? null);

  // Publish the shown agent so the always-mounted alert driver (+page.svelte) can
  // resolve the OVERVIEW-mode `viewedPaneId` for the `agent-unfocused` alert mode.
  // The Inbox is mounted only in overview mode, so it must NOT own the alert driver
  // itself — it only publishes this selection (needs-input-alerts, design D7b/D7c).
  $effect(() => {
    focusAgent.paneId = focus?.paneId ?? null;
  });

  // Honor an INBOUND select request from outside the inbox — a clicked needs-input
  // notification (capability `alert-click-focus`). The always-mounted route writes
  // `focusRequest` from the activation event; we select that agent here through the
  // normal `selectAgent` path and CONSUME the request. The inbox mounts only in
  // overview mode, so a click from grid view sets the request BEFORE this component
  // exists; consuming a HELD request (rather than diffing a baseline captured at
  // mount, which would already equal the just-issued request and swallow it) makes
  // delivery independent of mount timing, and consuming prevents a stale request from
  // re-firing on a later remount. A request for a pane no live row carries is consumed
  // without selecting — the window is already focused by the route, matching the
  // "dead pane → focus-only" behavior. (While idle, `paneId` is null and the effect
  // returns before reading `viewRows`, so it does not re-run on every roster tick.)
  $effect(() => {
    const paneId = focusRequest.paneId;
    if (paneId === null) return;
    focusRequest.consume();
    if (viewRows.some((r) => r.paneId === paneId)) {
      selectAgent(paneId);
    }
  });

  // --- Rename the focused session (header inline-edit) -----------------------
  // Click the focus-pane header title (or pick "Rename" in the agent card menu) to
  // give the session a CUSTOM title. The same inline-input shape as the session
  // rail: `editingTitle`/`titleDraft` $state, commit on Enter or blur, cancel on
  // Esc. Committing calls `titles.setManualTitle`, which makes the custom title
  // STICKY — auto-generation stops for that session and it persists across restart.
  let editingTitle = $state(false);
  let titleDraft = $state('');
  let titleInput = $state<HTMLInputElement | null>(null);
  // The paneId the header edit belongs to, so switching to a DIFFERENT agent
  // abandons the rename (but selecting THIS agent — e.g. the menu "Rename" path —
  // does not).
  let editingPaneId = $state<string | null>(null);

  /** The app-owned Claude session id for a row's pane (keys the durable title cache),
   *  resolved against the row's OWN workspace so it's correct even when the focused
   *  agent lives in a non-active workspace. Null for a non-claude/shell pane. */
  function sessionIdOf(r: AgentRow): string | null {
    return workspace.sessionIn(r.workspaceId, r.paneId).sessionId ?? null;
  }

  /** The workflow → phase groups of LIVE subagents to nest under a row (every
   *  session/lane, not just the focused one), or [] when the user has hidden
   *  subagents (the Sessions-panel setting), the session has none, or all have
   *  exited. Exited (done/errored) subagents are filtered out, so only in-flight
   *  ones remain. */
  function subagentGroupsFor(r: AgentRow): WorkflowGroup[] {
    if (!subagentsVisible.prefs.enabled) return [];
    const sid = sessionIdOf(r);
    if (!sid) return [];
    return groupSubagentsByPhase(liveSubagents(subagents.forSession(sid)));
  }

  /** Map a subagent's verbatim status to a row class. Known terminal states map to
   *  `done`/`error`; everything else (running/queued/unknown/null) is the neutral
   *  `running` style, so an unrecognized state never throws or looks broken. */
  function subStatusClass(status?: string | null): 'done' | 'error' | 'running' {
    const s = (status ?? '').toLowerCase();
    if (s === 'done' || s === 'completed' || s === 'success') return 'done';
    if (s === 'error' || s === 'failed') return 'error';
    return 'running';
  }

  /** Enter header edit mode for the focused session, seeding the draft with the
   *  currently-shown title. The coordinator's title is pinned ("Coordinator") and
   *  is not user-renamable, so editing is suppressed for it. */
  async function startTitleEdit(target: AgentRow | null = focus) {
    if (!target || isCoordinator(target)) return;
    titleDraft = focusTitle(target);
    editingPaneId = target.paneId;
    editingTitle = true;
    await tick();
    titleInput?.focus();
    titleInput?.select();
  }

  /** Commit the header edit: a non-empty draft becomes the session's custom title
   *  (sticky + persisted); an empty/whitespace draft is dropped (keeps the prior
   *  title). Idempotent — safe to call from both Enter and blur. Commits against the
   *  pane the edit was started on (not whatever is shown now). */
  function commitTitleEdit() {
    if (!editingTitle) return;
    editingTitle = false;
    const row = viewRows.find((r) => r.paneId === editingPaneId);
    if (row && titleDraft.trim() !== focusTitle(row)) {
      titles.setManualTitle(row.paneId, sessionIdOf(row), titleDraft);
    }
    editingPaneId = null;
    titleDraft = '';
  }

  /** Cancel the header edit (Esc): discard the draft, keep the prior title. */
  function cancelTitleEdit() {
    editingTitle = false;
    editingPaneId = null;
    titleDraft = '';
  }

  function onTitleKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTitleEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTitleEdit();
    }
  }

  /** Agent card "Rename" menu item: focus the agent (so its header is shown), then
   *  open the SAME header inline edit. Routes through `selectAgent` so the live
   *  terminal is the focus and the header — with its title input — is on screen. */
  function renameAgent(row: AgentRow) {
    selectAgent(row.paneId);
    void startTitleEdit(row);
  }

  // Switching to a DIFFERENT agent (or the edited one going away) abandons an
  // in-progress rename rather than committing it to the wrong agent. Selecting the
  // edited agent itself — the menu "Rename" path — leaves the edit intact.
  $effect(() => {
    if (editingTitle && shownId !== editingPaneId) cancelTitleEdit();
  });

  // When `shownId` is the coordinator-start SENTINEL (not a real pane), the main
  // pane shows the Start empty-state for that project instead of a terminal (10.4).
  // Resolved to a concrete project, else null (a stale sentinel falls through to the
  // normal empty panel).
  const startProject = $derived(
    projectForId(projects.list, coordinatorStartProject(shownId))
  );

  // Reconcile the SHOWN agent toward what attention wants (resolveFocus = pin >
  // attention queue, arrival-ordered). First focus / the shown agent being closed
  // switches immediately. While the shown agent ITSELF needs you, we never auto-
  // advance away from it (you handle it on your own time, even as others request
  // input). Once it stops needing you, focus advances to the earliest waiting agent
  // after the grace; if nobody else needs you, the current agent stays.
  $effect(() => {
    // The coordinator-start sentinel is a deliberate, sticky main-pane selection
    // (no underlying pane) — never auto-resolve it away to an attention agent.
    if (coordinatorStartProject(shownId) !== null) {
      clearAdvance();
      return;
    }
    const shownRow = viewRows.find((r) => r.paneId === shownId) ?? null;
    // The agent we're on just LEFT attention (handled / went Working)?
    const sameAgent = shownId !== null && shownId === lastShownId;
    const leftAttention =
      sameAgent &&
      lastShownStatus !== null &&
      isAttention(lastShownStatus) &&
      shownRow !== null &&
      !isAttention(shownRow.status);
    lastShownId = shownId;
    lastShownStatus = shownRow?.status ?? null;

    // First focus, or the shown agent was closed -> switch immediately to the
    // focus target (earliest waiting agent, or none).
    if (shownId === null || shownRow === null) {
      clearAdvance();
      userSelected = null;
      shownId = resolveFocus(viewRows, null)?.paneId ?? null;
      return;
    }

    // A PINNED agent we're on that left attention yields to the queue: drop the pin
    // so focus can advance to the next waiting agent (else resolveFocus keeps it).
    if (leftAttention && userSelected === shownId && queue.some((r) => r.paneId !== shownId)) {
      userSelected = null;
    }

    // The agent we're showing still needs you -> stay put. Don't auto-jump to a
    // different agent just because it now wants input. A PAUSED shown agent does not
    // count (needsAttention excludes it), so pausing it lets focus advance.
    if (needsAttention(shownRow)) {
      clearAdvance();
      return;
    }

    const target = resolveFocus(viewRows, userSelected);
    let wantId = target?.paneId ?? shownId; // never advance to nothing
    if (wantId === shownId) {
      clearAdvance();
      return;
    }
    // A grace already counting down for this same target keeps riding: the roster
    // recomputes every second and `leftAttention` is only true on the single
    // transition tick, so without this the timer would never survive to fire.
    if (advanceTimer && pendingTarget === wantId) return;
    // A DIFFERENT agent now wants focus. Only auto-advance when we JUST handled the
    // agent we were on — i.e. it LEFT attention (you finished a waiting agent, so
    // move on to the next one) AND the user opted into auto-advance (the setting
    // defaults OFF — inbox-auto-advance spec). NEVER yank focus off an agent you're
    // parked on that didn't need input just because another agent now wants input;
    // the queue indicator still shows it's waiting and you can step to it (click /
    // ⌘↓) when you choose. Manual nav (⌘↑/↓, the next/prev buttons) bypasses this
    // effect entirely, so it is unaffected by the setting.
    if (!leftAttention || !autoAdvance.prefs.enabled) {
      clearAdvance();
      return;
    }
    clearAdvance();
    pendingTarget = wantId;
    const next = wantId;
    advanceTimer = setTimeout(() => {
      advanceTimer = undefined;
      pendingTarget = null;
      userSelected = null;
      shownId = next;
    }, ADVANCE_DELAY_MS);
  });

  // Default-select the last used session when the user OPENS a project — i.e. the
  // project filter changes to a CONCRETE project. Restores the project's recorded
  // last-used session when a LIVE row with that stable id is still present (see
  // `resolveProjectDefaultSession`); in every other case it does nothing and the
  // reconcile effect above resolves focus as before (attention agent / All-clear).
  // Only ever `selectAgent` (never a preview spawn) — the resolver excludes archived
  // rows, so opening or keyboard-cycling projects can never respawn a `claude --resume`
  // as a side effect of navigation. Skips ALL / UNASSIGNED (no single project) and the
  // first hydrated run (so it fires on an actual open, not on app launch — a launch-time
  // restore is intentionally out of scope, as the roster may not have populated yet).
  // Gated on `uiPrefs.loaded` so the persisted map is present before the first switch.
  //
  // Ordering matters: this effect is created BEFORE the recorder below so that, within
  // the single flush a project switch triggers, it reads the UNCORRUPTED stored value
  // and pins the restored session BEFORE the recorder observes the settled focus — else
  // the reconcile effect's transient attention pick would be recorded over the real
  // last-used session and the restore would be defeated.
  let lastProjectSel: string | null = null;
  let projectSelSeeded = false;
  $effect(() => {
    if (!uiPrefs.loaded) return;
    const sel = projectFilter.selected;
    if (!projectSelSeeded) {
      lastProjectSel = sel;
      projectSelSeeded = true;
      return;
    }
    if (sel === lastProjectSel) return;
    lastProjectSel = sel;
    if (sel === ALL || sel === UNASSIGNED) return;
    const last = uiPrefs.data.lastSessionByProject[sel] ?? null;
    const target = resolveProjectDefaultSession(viewRows, last, sessionIdOf);
    if (target) selectAgent(target.paneId);
  });

  // Record the session shown in the focus pane as PER-PROJECT last-used, so the effect
  // above can restore it on a later open. Keyed by the STABLE registry sessionId
  // (survives restart / `--resume`), not the paneId. Created AFTER the restore effect
  // (see its ordering note) so it observes the SETTLED focus, never the reconcile
  // transient. Gated on `uiPrefs.loaded` so a pre-hydrate focus can't persist a
  // defaults-only `ui` slice over the user's real prefs. `setLastSessionForProject`
  // no-ops when unchanged (so steady-state roster ticks never write); a genuine focus
  // move to a new session persists once, matching the codebase's other discrete
  // (non-debounced) `ui` setters. Only project-bound, resumable sessions are recorded
  // (null projectId / sessionId skipped), so the UNASSIGNED bucket gets no entry.
  $effect(() => {
    if (!uiPrefs.loaded) return;
    const r = focus;
    if (!r || !r.projectId || r.closed) return;
    // Skip ARCHIVED rows (symmetric with the resolver's read-side `!r.closed`
    // filter): previewing an archived session must not overwrite the project's
    // live last-used session, which the resolver would then refuse to restore.
    const sid = sessionIdOf(r);
    if (!sid) return;
    uiPrefs.setLastSessionForProject(r.projectId, sid);
  });

  // Immediately switch to a session the user just created (in-inbox "+" or the
  // launcher dialog). `workspace.launch` stamps `lastLaunchedId`; selecting it pins
  // focus so the new agent's terminal shows at once.
  let lastSeenLaunch: string | null = null;
  $effect(() => {
    const id = workspace.lastLaunchedId;
    if (id && id !== lastSeenLaunch) {
      lastSeenLaunch = id;
      selectAgent(id);
    }
  });

  // Teleport the live surface to the shown agent + auto-focus its terminal on
  // entry. With no shown agent, clear the target so the surface goes home (hidden)
  // and the empty panel shows.
  let focusSlot = $state<HTMLDivElement | null>(null);
  let lastFocusId: string | null = null;
  // Bumped on every explicit switch (click / keyboard / queue-nav) so the effect
  // re-focuses the terminal even when re-selecting the same agent.
  let focusNonce = $state(0);
  let lastFocusNonce = -1;

  $effect(() => {
    const f = focus;
    const nonce = focusNonce;
    // A closed (Archived) agent has no live terminal — the inbox shows its own
    // closed panel, so send the surface home rather than teleporting it.
    if (!f || f.closed || !focusSlot) {
      surfaceSlot.clear();
      lastFocusId = null;
      lastFocusNonce = nonce;
      return;
    }
    const target = navigateTarget(navWorkspaces, f.paneId);
    if (target) {
      workspace.setActiveWorkspace(target.workspaceId);
      workspace.setFocusIn(target.workspaceId, target.leafId);
    }
    surfaceSlot.set(focusSlot);

    // Focus the terminal + pin to the bottom whenever we SWITCH to a Claude window
    // (the shown agent changed, or the user re-selected it) — after the display
    // swap + fit settle. Not on the per-second roster reruns, so typing is safe.
    if (lastFocusId !== f.paneId || lastFocusNonce !== nonce) {
      const id = f.paneId;
      void tick().then(() =>
        requestAnimationFrame(() => {
          scrollTerminalToBottom(id);
          if (!editingTitle) focusTerminal(id);
        })
      );
    }
    lastFocusId = f.paneId;
    lastFocusNonce = nonce;
  });

  // Release the teleport target + cancel any pending advance on teardown.
  $effect(() => () => {
    clearAdvance();
    surfaceSlot.clear();
  });

  /** Select (watch) an agent: show it immediately, pin it, and focus its terminal. */
  function selectAgent(paneId: string) {
    clearAdvance();
    userSelected = paneId;
    shownId = paneId;
    focusNonce += 1;
  }

  /** Focus the not-started coordinator affordance: select the start SENTINEL so the
   *  main pane shows the Start empty-state for `projectId` (task 10.4). It isn't a
   *  real pane, so we pin it like a selection but don't bump the terminal nonce. */
  function selectCoordinatorStart(projectId: string) {
    clearAdvance();
    userSelected = null;
    shownId = coordinatorStartId(projectId);
  }

  /** The coordinator was launched from the main-pane Start state — focus the now-real
   *  coordinator pane (reuses the normal select path). */
  function onCoordinatorStarted(paneId: string) {
    selectAgent(paneId);
  }

  /** PREVIEW an archived session: respawn `claude --resume` so its transcript shows
   *  live, but keep it presented as Archived (out of attention) until a message is
   *  sent. Captures the current user-message COUNT as the unarchive baseline, then
   *  watches it (unarchives only once a NEW message lifts the count). `previewArchived`
   *  is a no-op for a non-resumable pane (no session id); `selectAgent` still shows
   *  it. A null count (transcript unread) is established lazily by the gate effect. */
  function startPreview(paneId: string) {
    workspace.previewArchived(paneId, activity.forPane(paneId).userMsgCount ?? null);
    selectAgent(paneId);
  }

  /** A roster row was clicked: an archived (closed) session resumes for preview;
   *  everything else (live / paused / already-previewing) is just selected. */
  function onRowClick(r: AgentRow) {
    if (r.closed) startPreview(r.paneId);
    else selectAgent(r.paneId);
  }

  /** Step through the attention queue from the header ↑/↓ controls (immediate). */
  function stepQueue(dir: 1 | -1) {
    const next = nextInQueue(viewRows, shownId, dir);
    if (next) {
      clearAdvance();
      userSelected = next;
      shownId = next;
      focusNonce += 1;
    }
  }

  /** Whether a LIVE/paused session is EMPTY by our definition (no real user
   *  messages — e.g. the user only typed `/exit`). Such a session has nothing to
   *  resume, so its archive action is presented (and behaves) as Delete, not Archive. */
  function isEmptySession(paneId: string): boolean {
    return archiveDecision(activity.forPane(paneId).userHash) === 'delete';
  }

  /** Advance focus after the user EXPLICITLY dismisses the SHOWN session (archive /
   *  pause / delete): jump immediately to the next actionable session — first
   *  Needs-you, else first In-flight, else All clear (`nextOnDismiss`). A no-op
   *  unless `paneId` is the one currently shown, so dismissing a BACKGROUND row never
   *  steals focus. This is unconditional — it ignores the auto-advance setting (the
   *  setting only gates the separate leave-attention auto-advance in the reconcile
   *  effect). Read `viewRows` BEFORE the caller mutates the workspace; `nextOnDismiss`
   *  excludes `paneId`, so the other rows (unaffected by this dismissal) scan right.
   *
   *  When the target is an IN-FLIGHT pane (no Needs-you exists), the reconcile effect
   *  KEEPS it parked via its "never advance to nothing" fallback (`wantId = target ??
   *  shownId`) — `resolveFocus` alone would resolve to null there. That fallback is
   *  load-bearing for this path: do not "simplify" it to `?? null`. */
  function advanceAfterDismiss(paneId: string) {
    if (shownId !== paneId) return;
    clearAdvance();
    userSelected = null;
    shownId = nextOnDismiss(viewRows, paneId);
    focusNonce += 1;
  }

  /** Perform the archive: an EMPTY session (no user messages) has nothing to resume,
   *  so it is DELETED outright; a real session is archived (kept, restorable). Drops
   *  the pin so focus advances to whatever needs you next. */
  function performArchive(paneId: string) {
    advanceAfterDismiss(paneId);
    if (userSelected === paneId) userSelected = null;
    if (archiveDecision(activity.forPane(paneId).userHash) === 'delete') {
      workspace.deleteAgent(paneId);
    } else {
      workspace.closeAgent(paneId);
    }
  }

  /** ARCHIVE an agent's session → moves it to Archived (terminates the terminal but
   *  keeps it, restorable). Archiving a WORKING agent interrupts a running task, so we
   *  confirm first; any other status archives immediately (not destructive for a real
   *  session). Covers the buttons, context menu, and ⌘W alike via this one chokepoint. */
  function archiveAgent(paneId: string) {
    const status = viewRows.find((r) => r.paneId === paneId)?.status ?? 'idle';
    const req = archiveWorkingConfirm(status, () => performArchive(paneId));
    if (req) confirmModal.show(req);
    else performArchive(paneId);
  }

  /** PAUSE (defer) an agent: keep it live but move it to the Paused lane, out of
   *  attention. Records the current user-message COUNT so only a NEW message resumes
   *  it. Drops the pin so focus advances. */
  function pauseAgent(paneId: string) {
    advanceAfterDismiss(paneId);
    if (userSelected === paneId) userSelected = null;
    workspace.pauseAgent(paneId, activity.forPane(paneId).userMsgCount ?? null);
  }

  /** RESUME a paused agent (manual): clear paused and watch it. */
  function resumeAgent(paneId: string) {
    workspace.resumeAgent(paneId);
    selectAgent(paneId);
  }

  /** DELETE an Archived agent for good (after a confirm). Drops the pin. */
  function deleteAgent(paneId: string, name: string) {
    const ok =
      typeof confirm === 'function'
        ? confirm(`Delete "${name}"? This permanently removes the session.`)
        : true;
    if (!ok) return;
    advanceAfterDismiss(paneId);
    if (userSelected === paneId) userSelected = null;
    workspace.deleteAgent(paneId);
  }

  /** DELETE every Archived agent at once, behind a confirmation modal. The pure
   *  `deleteAllArchivedRequest` builds the prompt + delete callback (targeting the
   *  Archived/done lane shown under the header) and returns null when nothing is
   *  archived; we just feed it the live deps and show the modal. */
  function deleteAllArchived() {
    const req = deleteAllArchivedRequest(pin.rest, {
      deleteAgent: (id) => workspace.deleteAgent(id),
      getSelected: () => userSelected,
      setSelected: (v) => (userSelected = v)
    });
    if (req) confirmModal.show(req);
  }

  // Auto-archive on completion: when an agent's process exits CLEANLY (its task
  // ended — `finished`, not a crash) AND it isn't paused, move it to Archived so it
  // stops occupying a live slot and persists as a restorable closed session. Guarded
  // on `!r.closed` so it fires once per session, and `!r.preview` so a resumed-for-
  // preview session is never re-archived out from under the viewer. Crashes (`error`)
  // stay in Needs-you. An EMPTY finished session (no user messages — e.g. the user
  // only typed `/exit`) has nothing to resume, so it is DELETED instead of archived,
  // matching the manual "Archive session" decision.
  $effect(() => {
    for (const r of allRows) {
      const action = autoArchiveAction(r, activity.forPane(r.paneId).userHash);
      if (action === 'delete') workspace.deleteAgent(r.paneId);
      else if (action === 'archive') workspace.closeAgent(r.paneId);
    }
  });

  // Auto-preview a focused archived session: whenever the SHOWN agent is still
  // closed (Archived), resume it for preview so its actual transcript renders in the
  // panel — never the "Session archived" placeholder. Clicking a row previews
  // synchronously via `onRowClick`; this covers every OTHER path that lands focus on
  // a closed session (keyboard ⌘↑/↓, the queue stepper, a restored layout, or
  // returning to a session the grace timer just re-archived). The session stays
  // presented as Archived until the user replies (the auto-unarchive effect below
  // commits it). `previewArchived` is a no-op for a non-resumable pane (no session
  // id) — those rare cases still fall back to the placeholder.
  $effect(() => {
    const f = focus;
    if (f?.closed) {
      workspace.previewArchived(f.paneId, activity.forPane(f.paneId).userMsgCount ?? null);
    }
  });

  // Auto-resume / auto-unarchive: a PAUSED agent returns to its live status, and a
  // PREVIEWING (resumed-from-Archived) agent unarchives, the moment the user sends a
  // new message — detected when the live user-message COUNT strictly exceeds the
  // baseline captured at pause/preview time. The count (whole-file) is the signal,
  // NOT the windowed hash: resuming a session for preview grows its transcript, which
  // would shift the hash but never the user-message count, so a previewed session no
  // longer unarchives itself. Runs off the activity poll (the ~1s clock re-derives
  // rows).
  //
  // When the baseline is still UNKNOWN (the pane was paused/previewed before its
  // transcript had been polled — e.g. an archived pane auto-previewed on a restored
  // layout), establish it from the first known live count instead of comparing. This
  // closes the cold-start race where a null baseline would read the first real count
  // as "the user replied".
  $effect(() => {
    for (const r of allRows) {
      const liveCount = activity.forPane(r.paneId).userMsgCount;
      if (r.paused) {
        if (r.pausedCount == null && typeof liveCount === 'number') {
          workspace.establishPausedBaseline(r.paneId, liveCount);
        } else if (shouldAutoResume(r.pausedCount, liveCount)) {
          workspace.resumeAgent(r.paneId);
        }
      }
      if (r.preview) {
        if (r.previewCount == null && typeof liveCount === 'number') {
          workspace.establishPreviewBaseline(r.paneId, liveCount);
        } else if (shouldAutoResume(r.previewCount, liveCount)) {
          workspace.commitPreview(r.paneId);
        }
      }
    }
  });

  // Record each LIVE row's last assistant message into the durable, sessionId-keyed
  // summary cache (mirrors the title cache). When the agent is later ARCHIVED its PTY
  // is gone, so its live `summary` disappears — the roster sub-line then falls back to
  // this cache (`rowSub` → `summaries.summaryFor`) so an archived row still shows the
  // last thing it said. `record` ignores empty/closed-pane reads, so a closed row never
  // overwrites the message it had while live. Runs off the same ~1s roster re-derive.
  $effect(() => {
    for (const r of allRows) {
      if (r.closed || r.preview) continue; // a closed/previewing pane has no fresh live message
      if (r.summary) summaries.record(sessionIdOf(r), r.summary);
      costs.record(sessionIdOf(r), r.cost); // freeze cost before snapshot resets on reopen
    }
  });

  // Re-archive a previewing session the user has walked away from. While a previewing
  // session is the SHOWN agent (the user is on its window) no timer runs; once it
  // stops being shown, a grace timer starts and — if the user neither returns nor
  // sends a message within PREVIEW_GRACE_MS — `closeAgent` terminates its resumed PTY
  // and returns it to true Archived. Timers are keyed per pane (the non-reactive map
  // is mutated in place; nothing renders from it).
  const PREVIEW_GRACE_MS = 60_000;
  const previewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function cancelPreviewTimer(paneId: string) {
    const t = previewTimers.get(paneId);
    if (t) {
      clearTimeout(t);
      previewTimers.delete(paneId);
    }
  }
  $effect(() => {
    const previewing = new Set(allRows.filter((r) => r.preview).map((r) => r.paneId));
    // Drop timers for panes that stopped previewing (committed / deleted / closed).
    for (const paneId of [...previewTimers.keys()]) {
      if (!previewing.has(paneId)) cancelPreviewTimer(paneId);
    }
    for (const paneId of previewing) {
      if (paneId === shownId) {
        cancelPreviewTimer(paneId); // on its window — hold off
      } else if (!previewTimers.has(paneId)) {
        // Left its window — start the grace countdown (once; per-second roster reruns
        // see the timer already pending and don't restart it).
        previewTimers.set(
          paneId,
          setTimeout(() => {
            previewTimers.delete(paneId);
            workspace.closeAgent(paneId);
          }, PREVIEW_GRACE_MS)
        );
      }
    }
  });
  // Clear every pending re-archive timer on teardown.
  $effect(() => () => {
    for (const t of previewTimers.values()) clearTimeout(t);
    previewTimers.clear();
  });

  /** Whether a row is the project COORDINATOR. The coordinator follows the SAME
   *  archive/delete rules as ordinary sessions (coordinator-lifecycle), so it is no
   *  longer special-cased in the archive/pause paths. It IS still excluded from inline
   *  rename (its title is pinned "Coordinator"), so the menu drops the Rename item for
   *  it. Normal rows are unaffected. */
  function isCoordinator(r: AgentRow | null): boolean {
    return r?.role === 'coordinator';
  }

  /** Right-click a roster row. An Archived agent — closed OR being previewed (it's
   *  still presented as archived until you reply) — offers only Delete (restore is the
   *  focus-header Resume / a row click); a paused agent offers Open / Resume / Archive;
   *  a live agent offers Open / Pause / Archive. An EMPTY live/paused session presents
   *  its archive action as Delete instead. The COORDINATOR follows the SAME rules: a
   *  LIVE/paused coordinator gets Open / Pause / Archive routed through `archiveAgent`
   *  (so an empty coordinator DELETES and a non-empty one ARCHIVES); only Rename is
   *  omitted (its title is pinned). An ARCHIVED coordinator offers Delete (and Restore
   *  via the header), like any archived session. */
  function openAgentMenu(e: MouseEvent, row: AgentRow, name: string) {
    e.preventDefault();
    // The archive action for a live/paused row: an empty session deletes (nothing to
    // keep) and reads as "Delete"; a session with messages archives (restorable). This
    // is the SAME decision for the coordinator — `archiveAgent` runs its userHash
    // through `archiveDecision` just like any other row.
    const archiveItem: MenuItem = isEmptySession(row.paneId)
      ? { label: 'Delete', icon: 'trash-2', danger: true, onClick: () => archiveAgent(row.paneId) }
      : { label: 'Archive session', icon: 'archive', danger: true, onClick: () => archiveAgent(row.paneId) };
    // The coordinator's title is pinned ("Coordinator"), so inline rename is suppressed
    // — drop the Rename item for it (it would be a no-op) while keeping everything else.
    const renameItem: MenuItem[] = isCoordinator(row)
      ? []
      : [{ label: 'Rename', icon: 'pencil', onClick: () => renameAgent(row) }];
    const items: MenuItem[] = row.closed || row.preview
      ? [
          { label: 'Delete', icon: 'trash-2', danger: true, onClick: () => deleteAgent(row.paneId, name) }
        ]
      : row.paused
        ? [
            { label: 'Open terminal', icon: 'terminal', onClick: () => selectAgent(row.paneId) },
            ...renameItem,
            { label: 'Resume', icon: 'play', onClick: () => resumeAgent(row.paneId) },
            archiveItem
          ]
        : [
            { label: 'Open terminal', icon: 'terminal', onClick: () => selectAgent(row.paneId) },
            ...renameItem,
            { label: 'Pause', icon: 'pause', onClick: () => pauseAgent(row.paneId) },
            archiveItem
          ];
    menu = { open: true, x: e.clientX, y: e.clientY, items };
  }

  /** The agent's display title (generated session title or its fallback name). */
  function displayName(paneId: string, fallback: string): string {
    return titles.titleFor(paneId) ?? fallback;
  }

  /** Title shown in the focus-pane header. The coordinator always reads
   *  "Coordinator" — matching its pinned row title — instead of its underlying
   *  workspace name ("Session N"); everything else uses its generated session
   *  title, falling back to its name. */
  function focusTitle(r: AgentRow): string {
    return isCoordinator(r) ? 'Coordinator' : displayName(r.paneId, r.name);
  }

  /** New session: when a project is already selected, launch straight into it (no
   *  dialog); otherwise open the launcher to pick/create a project. */
  function newAgent() {
    // Fire-and-forget: startNewSession is async (it may create a worktree first).
    void startNewSession();
  }

  // Flat ⌘↑/↓ cycling order: the project's COORDINATOR (its running row, or — when
  // not started — its Start affordance, a `start` sentinel target) FIRST, then the
  // rest in lane order. So the coordinator/affordance is always keyboard-reachable,
  // including when it's the ONLY entry (task 10.8). Built from the same pin decision
  // the render uses, so nav and render agree.
  const navTargets = $derived(coordinatorNavOrder(viewRows, activeCoordProjectId));

  // The scrollable session-list container; the reveal effect scrolls the selected
  // row into view within it on keyboard navigation.
  let listScrollEl = $state<HTMLDivElement | null>(null);

  // AUTO-EXPAND the Archived lane when navigation selects an archived session hidden
  // beyond its collapsed preview — otherwise the row isn't rendered and can't be
  // revealed. Fired ONCE per selection TRANSITION (guarded by `lastNavExpandId`, a
  // plain non-reactive tracker like `lastShownId`), NOT continuously: re-asserting
  // expansion every time the effect re-runs would defeat the manual "Collapse" button
  // while a hidden archived row stays selected, and would re-evaluate every second
  // (since `renderGrouped` recomputes on the roster's 1s clock). The early return on an
  // unchanged selection also shrinks this effect's tracked deps to just `shownId`.
  let lastNavExpandId: string | null = null;
  $effect(() => {
    const id = shownId;
    if (id === lastNavExpandId) return;
    lastNavExpandId = id;
    if (
      archivedNavNeedsExpand(
        id,
        renderGrouped.done.map((r) => r.paneId),
        ARCHIVED_PREVIEW,
        showAllArchived
      )
    ) {
      showAllArchived = true;
    }
  });

  // REVEAL the selected session: when the selection (or the Archived expansion that
  // brings a hidden row into the DOM) changes, scroll the `.sel` row into view within
  // the list after the DOM updates. `block: 'nearest'` no-ops when the row is already
  // fully visible, so clicks / auto-advance to a visible row never jump the list. The
  // `.sel` class covers lane rows AND the pinned-coordinator / start-affordance slot.
  $effect(() => {
    void shownId; // re-run when the selection changes
    void showAllArchived; // and after an auto-expand renders a newly-visible row
    const container = listScrollEl;
    if (!container) return;
    void tick().then(() => {
      container.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
    });
  });

  /** Focus a nav target: a real pane selects normally (a closed/archived one is then
   *  auto-previewed by the focus effect, as before); the not-started `start` sentinel
   *  does exactly what clicking the affordance does (shows the Start empty-state). */
  function focusNavTarget(t: { kind: 'pane'; paneId: string } | { kind: 'start'; projectId: string }) {
    if (t.kind === 'start') selectCoordinatorStart(t.projectId);
    else selectAgent(t.paneId);
  }

  /** The index of the currently-shown target within `navTargets`: a `start` sentinel
   *  matches the shown start-project; a `pane` matches `shownId`. -1 when off-list. */
  function currentNavIndex(): number {
    const startProj = coordinatorStartProject(shownId);
    return navTargets.findIndex((t) =>
      t.kind === 'start' ? t.projectId === startProj : t.paneId === shownId
    );
  }

  /** Keyboard shortcuts on the inbox, all ⌘-modified so plain keys still reach the
   *  PTY: ⌘↑/↓ step the roster; ⌘W archives the focused session (delete-if-empty);
   *  ⌘. pauses/resumes it. */
  function onNavKey(e: KeyboardEvent) {
    if (launcher.open) return;

    // ⌘⇧↑/↓ — cycle the project filter up/down the panel's order. Handled before
    // the ⌘-only guard below since this one intentionally uses Shift; ⌘↑/↓ (no
    // shift) still steps the agent roster.
    if (
      e.metaKey &&
      e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    ) {
      e.preventDefault();
      const order = filterOrder(projects.list, unassignedCount(allRows) > 0);
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      projectFilter.select(stepFilter(order, projectFilter.selected, dir));
      return;
    }

    // All remaining inbox shortcuts use ⌘ alone (no alt/ctrl/shift), so a literal
    // key still reaches the terminal.
    if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey) return;

    // ⌘W — archive (or delete-if-empty) the focused session. preventDefault also
    // stops ⌘W from closing the app window via the webview. The COORDINATOR follows the
    // SAME archive/delete rule (coordinator-lifecycle) — no longer excluded here.
    if (e.key === 'w' || e.key === 'W') {
      if (!focus || focus.closed) return;
      e.preventDefault();
      archiveAgent(focus.paneId);
      return;
    }

    // ⌘. — pause the focused session, or resume it if already paused. The COORDINATOR
    // follows the SAME pause rule (coordinator-lifecycle) — no longer excluded here.
    if (e.key === '.') {
      if (!focus || focus.closed) return;
      e.preventDefault();
      if (focus.paused) resumeAgent(focus.paneId);
      else pauseAgent(focus.paneId);
      return;
    }

    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (navTargets.length === 0) return;
    e.preventDefault();
    const dir = e.key === 'ArrowDown' ? 1 : -1;
    const i = currentNavIndex();
    const ni =
      i < 0
        ? dir === 1
          ? 0
          : navTargets.length - 1
        : Math.min(navTargets.length - 1, Math.max(0, i + dir));
    focusNavTarget(navTargets[ni]);
  }

  // ---- Display helpers ------------------------------------------------------

  function projAvatar(
    projectId: string | null
  ): { icon: string; color: string; logo?: string } {
    const p = projectForId(projects.list, projectId);
    return p
      ? { icon: p.icon, color: p.color, logo: p.logo }
      : { icon: 'folder', color: '#7B8499' };
  }

  /** Context-window usage as a compact percent. Only rendered when known (the meta
   *  span is gated on `showContext`), so this never sees a null. */
  function ctxLabel(pct: number | null): string {
    return pct === null ? '—' : `${Math.round(pct)}%`;
  }

  /** The status dot class for a row. Paused/archived rows are muted (they don't
   *  need you), so a paused waiting agent shows a standby dot, not an orange one.
   *  Live working/idle rows (the In-flight lane) get the slowly flashing blue
   *  `b-flight` dot — the "this agent is in flight" signal, the blue counterpart
   *  to the needs-you dot. */
  function badgeClass(r: AgentRow): string {
    if (r.closed || r.paused) return 'b-standby';
    if (r.status === 'error') return 'b-abort';
    if (isAttention(r.status)) return 'b-review';
    if (r.status === 'finished') return 'b-nominal';
    return 'b-flight';
  }

  /** The secondary line for a roster row: the agent's last message or pending question,
   *  shown for EVERY lane including archived (closed) rows. Delegates the priority +
   *  clipping to the pure `rowSubText` (question → live summary → cached summary →
   *  generic fallback) and injects the per-session cached last-summary lookup so a
   *  CLOSED pane — whose live `summary` is gone with its PTY — still shows the last
   *  thing it said (recorded into `summaries` while it was live). */
  function rowSub(r: AgentRow): string {
    return rowSubText(r, () => summaries.summaryFor(sessionIdOf(r)));
  }
</script>

<svelte:window onkeydown={onNavKey} />

<!-- One roster row — shared by the pinned coordinator (top slot) and the lane lists
     below the rule, so the markup never diverges. `lane` only drives the row's
     selection accent class. `isCoordPin` marks the row as the project's OWN pinned
     coordinator: its title is forced to "Coordinator" and its own coordinator badge
     is suppressed (task 10.5) — only that single pinned row, not the agents it
     spawned (which keep their "coordinated" attribution). -->
{#snippet sessionRow(r: AgentRow, lane: AgentLane, isCoordPin = false)}
  <button
    type="button"
    class="row {lane}"
    class:sel={focus?.paneId === r.paneId}
    class:flash-attn={flashPanes.has(r.paneId)}
    onclick={() => onRowClick(r)}
    oncontextmenu={(e) => openAgentMenu(e, r, displayName(r.paneId, r.name))}
  >
    <ProjectIcon {...projAvatar(r.projectId)} size={30} />
    <span class="nm">
      <span class="t">
        {isCoordPin ? 'Coordinator' : (titles.titleFor(r.paneId) ?? r.name)}
        {#if isCoordPin}
          <!-- The pinned coordinator's own row carries no role badge (task 10.5). -->
        {:else if isArchivedCoordinator(r)}
          <!-- An ARCHIVED (closed) coordinator is labeled with the bot "Coordinator"
               badge (agent-roster-display) so its archived roster row is identifiable.
               A LIVE coordinator's presentation (below) is unchanged. -->
          <span
            class="spec-badge coord-badge"
            use:tooltip={'Archived project coordinator'}
          >
            <Icon name="bot" size={9} />Coordinator
          </span>
        {:else if r.role === 'coordinator'}
          <span
            class="spec-badge coord-badge"
            use:tooltip={'Project coordinator (orchestrates other agents)'}
          >
            <Icon name="bot" size={9} />coordinator
          </span>
        {:else if r.coordinatorPaneId}
          <span
            class="spec-badge coord-badge coord-badge-icon"
            use:tooltip={'Spawned by the project coordinator'}
          >
            <Icon name="compass" size={9} />
          </span>
        {/if}
        {#if r.specialist}
          <span class="spec-badge" use:tooltip={`Spawned as specialist “${r.specialist}”`}>
            <Icon name="bot" size={9} />{r.specialist}
          </span>
        {/if}
      </span>
      <span class="s" class:q={needsAttention(r)} use:tooltip={rowSub(r)}>{rowSub(r)}</span>
      {#if !compactMode.prefs.enabled}
        <span class="meta">
          {#if showContext(r)}
            <span class="m ctx" use:tooltip={'Context window used by this agent'}>
              <span class="ctxbar"><StatusBar pct={r.contextPct} /></span>
              {ctxLabel(r.contextPct)}
            </span>
          {/if}
          <span class="m" use:tooltip={'Model'}>
            <Icon name="cpu" size={11} />{rowModelLabel(r)}
          </span>
          <span class="m" use:tooltip={'Time since last activity'}>
            <Icon name="clock" size={11} />{friendlyTime(r.lastTs, nowMs)}
          </span>
        </span>
      {/if}
    </span>
    <!-- Status dot: orange when it needs you, flashing blue while actively In flight.
         An `idle` row (a quiet engaged coordinator, or a not-yet-wired pane) is in the
         flight lane but NOT running, so it shows no dot rather than a misleading flash. -->
    {#if needsAttention(r) || (lane === 'flight' && r.status !== 'idle')}
      <span class="badge {badgeClass(r)} dotonly"><span class="dot"></span></span>
    {/if}
  </button>
{/snippet}

<!-- Nested LIVE subagents under a parent agent row, on EVERY session/lane (not just
     the focused one). Exited (done/errored) subagents are filtered out so only
     in-flight ones show; grouped by workflow then phase, always expanded. Each row:
     a status dot, the subagent label, and its "duration alive" (ticking off the same
     `nowMs` clock the roster uses for relative times). -->
{#snippet subagentBlock(r: AgentRow)}
  {@const groups = subagentGroupsFor(r)}
  {#each groups as g (g.workflowId ?? '∅')}
    <div class="sa-wf">
      {#each g.phases as p (p.phaseTitle ?? '∅')}
        {#if p.phaseTitle}
          <div class="sa-phase">{p.phaseTitle}</div>
        {/if}
        {#each p.subagents as s (s.id)}
          {@const dur = formatDurationAlive(s, nowMs)}
          <div class="sa-row">
            <span class="sa-dot {subStatusClass(s.status)}"></span>
            <span class="sa-label" use:tooltip={s.label ?? s.id}>{s.label ?? s.id}</span>
            {#if dur}
              <span class="sa-dur" use:tooltip={'Time alive'}>{dur}</span>
            {/if}
          </div>
        {/each}
      {/each}
    </div>
  {/each}
{/snippet}

<div class="inbox-shell" class:project-collapsed={projectPaneCollapsed}>
  <ProjectPanel
    rows={allRows}
    collapsed={projectPaneCollapsed}
    onToggle={toggleProjectPane}
  />

  <section class="inbox" aria-label="Agent inbox">
    <!-- LEFT: grouped roster -->
    <div class="col-list">
      <div class="lh">
        <img class="logo" src="/logomark.svg" alt="" aria-hidden="true" />
        <h1>Sessions <span class="count">{rows.length}</span></h1>
        <button type="button" class="launch" onclick={newAgent} aria-label="New session" use:tooltip={'New session (⌘N)'}>＋</button>
      </div>

      <!-- Middle region: the agent roster (or its empty state). Flexes to fill
           the space left between the header and the bottom Tasks launcher. -->
      <div class="agent-region">
        <div class="list-scroll" bind:this={listScrollEl}>
          <!-- Coordinator TOP SLOT (tasks 10.2–10.3, 10.6): the project's live
               coordinator pinned above all sessions, OR — when none is running —
               a focusable "Start coordinator" affordance. A rule separates it from
               the rest. This renders FIRST, even with no other sessions, so the
               coordinator/affordance + rule always head the list and the "No sessions
               yet" empty state sits BELOW them (task 10.6). -->
          {#if pin.coordinator}
            {@render sessionRow(pin.coordinator, laneForRow(pin.coordinator), true)}
            {@render subagentBlock(pin.coordinator)}
            <hr class="coord-rule" />
          {:else if pin.showStart && activeCoordProject}
            <button
              type="button"
              class="row coord-start"
              class:sel={coordinatorStartProject(shownId) === activeCoordProjectId}
              onclick={() => selectCoordinatorStart(activeCoordProject.id)}
            >
              <ProjectIcon {...projAvatar(activeCoordProject.id)} size={30} />
              <span class="nm">
                <!-- No "not started" badge on the affordance (task 10.5); the
                     "Start to orchestrate" subline + play CTA convey the state. -->
                <span class="t">Coordinator</span>
                <span class="s">Start to orchestrate this project</span>
              </span>
              <span class="start-cta"><Icon name="play" size={13} /></span>
            </button>
            <hr class="coord-rule" />
          {/if}

          {#if pin.rest.length === 0}
            <!-- No NON-coordinator sessions — shown BELOW the coordinator + rule
                 (tasks 10.6, 10.10). Gated on `pin.rest` (the lane rows after the
                 pinned coordinator is removed), NOT the total row count, so the box
                 still appears when the only session is the pinned coordinator. With
                 no concrete project (All / Unassigned) the coordinator isn't pinned,
                 so `pin.rest` is just `rows` and this matches "zero rows" as before. -->
            <div class="empty-list">
              <p>No sessions yet.</p>
              <button type="button" class="btn-primary" onclick={newAgent}>＋ New session</button>
            </div>
          {:else}
            {#each LANE_ORDER as lane (lane)}
              {@const items = renderGrouped[lane]}
              {@const collapsedArchive = lane === 'done' && !showAllArchived}
              {@const visible = collapsedArchive ? items.slice(0, ARCHIVED_PREVIEW) : items}
              {#if items.length > 0}
                <div class="group-h {lane}">
                  {LANES[lane].title} <span class="gn">· {items.length}</span><span class="rule"></span>
                  {#if lane === 'done'}
                    <button
                      type="button"
                      class="group-action"
                      title="Delete all archived agents"
                      onclick={deleteAllArchived}
                    >
                      Delete all
                    </button>
                  {/if}
                </div>
                {#each visible as r (r.paneId)}
                  {@render sessionRow(r, lane)}
                  {@render subagentBlock(r)}
                {/each}
                {#if lane === 'done' && items.length > ARCHIVED_PREVIEW}
                  <button
                    type="button"
                    class="show-all"
                    onclick={() => (showAllArchived = !showAllArchived)}
                  >
                    {showAllArchived ? 'Collapse' : `Show all (${items.length})`}
                  </button>
                {/if}
              {/if}
            {/each}
          {/if}
        </div>
      </div>

      <!-- Draggable splitter that resizes the Sessions roster (top); the bottom
           region takes the persisted remainder. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="tasks-gutter" onpointerdown={startTasksResize} use:tooltip={'Drag to resize'}></div>

      <!-- Bottom region: the Tasks launcher. The Agents (specialists) panel is
           temporarily hidden — restore the commented sibling below to bring it back. -->
      <div class="tasks-region" style="flex: 0 0 {tasksFrac * 100}%">
        <div class="launch-pane"><TasksLauncher /></div>
        <!-- <div class="launch-pane sp"><SpecialistsPanel /></div> -->
      </div>
    </div>

    <!-- RIGHT: focus pane (header + teleported live TUI / Archived / All clear) -->
    <div class="col-focus">
      {#if startProject}
        <!-- The not-started coordinator affordance is focused: the main pane invites
             starting the orchestrator (task 10.4). On Start, the now-real coordinator
             pane is focused via onStarted. -->
        <CoordinatorStart project={startProject} onStarted={onCoordinatorStarted} />
        <!-- Slot kept bound (hidden) so the teleport target survives this state. -->
        <div class="focus-slot hidden" bind:this={focusSlot}></div>
      {:else if focus && !focus.closed}
        {@const av = projAvatar(focus.projectId)}
        <div class="fhead">
          <ProjectIcon {...av} size={26} />
          {#if editingTitle}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="ttl-edit"
              bind:this={titleInput}
              bind:value={titleDraft}
              onkeydown={onTitleKey}
              onblur={commitTitleEdit}
              aria-label="Rename session"
              autofocus
            />
          {:else if isCoordinator(focus)}
            <span class="ttl">{focusTitle(focus)}</span>
          {:else}
            <button
              type="button"
              class="ttl ttl-btn"
              onclick={() => startTitleEdit()}
              use:tooltip={'Rename session'}
            >{focusTitle(focus)}</button>
          {/if}
          <span class="spc"></span>
          {#if needsAttention(focus) && queue.length > 1}
            <span class="nav">
              <button type="button" onclick={() => stepQueue(-1)} aria-label="Previous" use:tooltip={'Previous needs-attention agent'}>↑</button>
              <button type="button" onclick={() => stepQueue(1)} aria-label="Next" use:tooltip={'Next needs-attention agent'}>↓</button>
            </span>
          {/if}
          {#if focus.preview}
            <!-- Resumed-from-Archived preview: still an archived session (it stays
                 archived until you reply), so it offers only Delete. -->
            <button
              type="button"
              class="hbtn danger"
              onclick={() => deleteAgent(focus.paneId, displayName(focus.paneId, focus.name))}
              use:tooltip={'Delete session'}
            >Delete</button>
          {:else}
            <!-- The COORDINATOR follows the SAME archive/delete rules as ordinary
                 sessions (coordinator-lifecycle): Pause + Archive (non-empty) / Delete
                 (empty), routed through the same handlers — no longer delete-only. -->
            {#if focus.paused}
              <button type="button" class="hbtn" onclick={() => resumeAgent(focus.paneId)} use:tooltip={'Resume (⌘.)'}>Resume</button>
            {:else}
              <button type="button" class="hbtn" onclick={() => pauseAgent(focus.paneId)} use:tooltip={'Pause / defer for later (⌘.)'}>Pause</button>
            {/if}
            {#if isEmptySession(focus.paneId)}
              <button type="button" class="hbtn danger" onclick={() => archiveAgent(focus.paneId)} use:tooltip={'Delete empty session (⌘W)'}>Delete</button>
            {:else}
              <button type="button" class="hbtn danger" onclick={() => archiveAgent(focus.paneId)} use:tooltip={'Archive session (⌘W)'}>Archive</button>
            {/if}
          {/if}
        </div>
        <!-- The single mounted workspace surface is teleported in here. -->
        <div class="focus-slot" class:attn={needsAttention(focus)} bind:this={focusSlot}></div>
      {:else if focus && focus.closed}
        {@const av = projAvatar(focus.projectId)}
        <div class="fhead">
          <ProjectIcon {...av} size={26} />
          <span class="ttl">{focusTitle(focus)}</span>
          <span class="spc"></span>
          <button type="button" class="hbtn" onclick={() => startPreview(focus.paneId)} use:tooltip={'Resume (claude --resume)'}>Resume</button>
          <button
            type="button"
            class="hbtn danger"
            onclick={() => deleteAgent(focus.paneId, displayName(focus.paneId, focus.name))}
            use:tooltip={'Delete session'}
          >Delete</button>
        </div>
        <div class="empty">
          <div class="ring closed">✓</div>
          <h3>Session archived</h3>
          <p>Select this session to pick up where it left off (<code>claude --resume</code>) — it stays archived until you send a message.</p>
        </div>
        <!-- Slot stays bound (hidden) so the teleport target survives this state. -->
        <div class="focus-slot hidden" bind:this={focusSlot}></div>
      {:else}
        <div class="empty">
          <div class="ring">✓</div>
          <h3>All clear</h3>
          <p>No agent is waiting on you. The next one that needs input lands here automatically — or pick any agent on the left to watch its terminal.</p>
        </div>
        <!-- Slot still bound so a fresh attention agent can teleport in without a remount. -->
        <div class="focus-slot hidden" bind:this={focusSlot}></div>
      {/if}
    </div>
  </section>

  <ContextMenu
    open={menu.open}
    x={menu.x}
    y={menu.y}
    items={menu.items}
    onClose={() => (menu = { ...menu, open: false })}
  />
</div>

<style>
  .inbox-shell { display: flex; flex-direction: row; flex: 1 1 auto; width: 100%; min-height: 0; }
  .inbox-shell :global(.ppanel) { flex: 0 0 220px; width: 220px; }
  /* Collapsed: the project pane shrinks to a thin icon rail. */
  .inbox-shell.project-collapsed :global(.ppanel) { flex: 0 0 48px; width: 48px; }
  .inbox {
    display: grid; grid-template-columns: 360px 1fr;
    flex: 1 1 auto; min-width: 0; height: 100%; min-height: 0;
    background: var(--space-850); color: var(--fg-1); font-family: var(--font-sans);
  }
  .col-list { border-right: 1px solid var(--line-subtle); background: var(--space-900); display: flex; flex-direction: column; min-height: 0; }
  .lh { display: flex; align-items: center; gap: 10px; padding: 15px 16px 11px; flex: none; }
  .lh .logo { width: 22px; height: 22px; }
  .lh h1 { font-family: var(--font-display); font-weight: 600; font-size: 17px; margin: 0; display: flex; align-items: baseline; gap: 8px; }
  .lh .count { font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); background: var(--space-750); border: 1px solid var(--line-subtle); border-radius: var(--r-full); padding: 2px 8px; }
  /* Text-on-accent-button color is intentionally NOT --fg-on-accent: that alias
     is tuned near-black (contrast-optimized) and would flip this button's text
     dark in both themes. White reads fine on --blue-500 in both dark (~3.8:1,
     the pre-theming app's own choice) and light (~4.6:1). */
  .lh .launch { margin-left: auto; font-family: var(--font-sans); font-weight: 700; font-size: 15px; color: #fff; background: var(--blue-500); border: none; border-radius: var(--r-md); width: 30px; height: 30px; cursor: pointer; }
  /* Middle region holds the agent list (or empty state); flexes to fill. */
  .agent-region { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
  .list-scroll { overflow-y: auto; flex: 1; min-height: 0; padding-bottom: 20px; }
  .empty-list { padding: 40px 18px; text-align: center; color: var(--fg-3); display: flex; flex-direction: column; gap: 12px; }
  /* The horizontal splitter between the agent roster and the Tasks launcher. */
  .tasks-gutter { flex: 0 0 5px; cursor: row-resize; background: var(--space-900); border-top: 1px solid var(--line-subtle); }
  .tasks-gutter:hover { background: var(--blue-500); }
  /* The bottom region: the Tasks launcher + Specialists panel stacked, sized to a
     persisted fraction. Each pane scrolls independently and shares the height. */
  .tasks-region { min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  .launch-pane { flex: 1 1 0; min-height: 0; overflow: hidden; }
  .launch-pane.sp { border-top: 1px solid var(--line-subtle); }

  .group-h { display: flex; align-items: center; gap: 8px; padding: 14px 16px 6px; font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: var(--tracking-label); }
  .group-h.attn { color: var(--orange-300); }
  .group-h.flight { color: var(--blue-300); }
  .group-h.done { color: var(--fg-4); }
  .group-h .gn { color: var(--fg-4); }
  .group-h .rule { flex: 1; height: 1px; background: var(--line-faint); }
  /* Right-aligned lane action (e.g. "Delete all" on Archived). Subtle until hover,
     where it reveals its destructive intent. Inherits the mono/uppercase header. */
  .group-h .group-action {
    flex-shrink: 0;
    border: none;
    background: transparent;
    padding: 0;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    color: var(--fg-4);
    cursor: pointer;
  }
  .group-h .group-action:hover { color: var(--danger); }

  /* "Show all / Collapse" toggle under the Archived lane's preview rows. Mono/
     uppercase to read as a lane affordance, full-width row indent to align with
     the rows above it. */
  .show-all {
    display: block;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    padding: 6px 16px 8px 16px;
    font-family: var(--font-mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: var(--tracking-label);
    color: var(--fg-4);
    cursor: pointer;
    transition: color var(--dur-fast);
  }
  .show-all:hover { color: var(--fg-2); }

  .row { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; padding: 10px 16px; cursor: pointer; border: none; border-left: 2px solid transparent; background: none; transition: background var(--dur-fast); }
  .row:hover { background: var(--line-faint); }
  .row.sel { background: var(--blue-tint); border-left-color: var(--blue-500); }
  .row.attn.sel { background: var(--orange-tint); border-left-color: var(--orange-500); }
  /* When an agent JUST enters "needs you", flash its card from 50% of the orange
     accent to clear in 2.5s. An overlay pseudo-element keeps the wash behind the
     row's content and above its base (hover/sel) background; it ends fully
     transparent so there is no snap back to normal. One-shot — the `.flash-attn`
     class is held only while it runs (see `flashPanes` / `FLASH_MS`). */
  .row.flash-attn { position: relative; }
  .row.flash-attn > * { position: relative; z-index: 1; }
  .row.flash-attn::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    background: var(--orange-500);
    animation: needsYouFlash 2.5s var(--ease-out) forwards;
  }
  @keyframes needsYouFlash { from { opacity: 0.5; } to { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .row.flash-attn::after { animation: none; opacity: 0; }
  }
  /* The coordinator top slot: a rule separating the pinned coordinator / Start
     affordance from the rest of the sessions (tasks 10.2–10.3). */
  .coord-rule { margin: 4px 16px 2px; border: none; border-top: 1px solid var(--line-default); }
  /* The not-started "Start coordinator" affordance reuses the row layout with a
     play-cta on the right; its coordinator badge reads in the orange accent. */
  .row.coord-start .start-cta { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: var(--r-sm); background: var(--orange-tint); color: var(--orange-200); }
  .row.coord-start:hover .start-cta { color: var(--orange-300); }
  .row .nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .row .nm .t { font-weight: 600; font-size: 13px; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
  /* Specialist attribution: a compact blue-tinted pill (icon + name) next to the
     agent's title, marking a pane spawned AS a specialist (task 5.4). */
  .row .nm .t .spec-badge { flex: none; display: inline-flex; align-items: center; gap: 3px; max-width: 120px; padding: 1px 6px 1px 5px; border-radius: var(--r-full); background: var(--blue-tint); color: var(--blue-200); font-family: var(--font-mono); font-size: 9.5px; font-weight: 500; letter-spacing: 0.02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .nm .t .spec-badge :global(.mc-icon) { opacity: 0.85; }
  /* Coordinator badges (the coordinator itself, and its coordinated agents) use a
     distinct orange tint so an orchestration is visible at a glance (task 6.5). */
  .row .nm .t .coord-badge { background: var(--orange-tint); color: var(--orange-200); max-width: 130px; }
  /* The coordinated-agent badge is icon-only (a single compass glyph, no text), so
     it collapses to a square chip: symmetric padding, no gap/max-width meant for a
     trailing label (task 1.2). */
  .row .nm .t .coord-badge-icon { gap: 0; max-width: none; padding: 2px; }
  .row .nm .s { font-size: 11px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; }
  .row .nm .s.q { color: var(--orange-300); }
  /* The tiny third row: context · cost · last activity, each an icon + value. */
  .row .nm .meta { display: flex; align-items: center; gap: 10px; margin-top: 3px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 10px; color: var(--fg-4); }
  .row .nm .meta .m { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
  .row .nm .meta .m :global(svg) { opacity: 0.75; }
  /* The context measure leads with a compact colored bar, then the percent. */
  .row .nm .meta .ctx { gap: 5px; }
  .row .nm .meta .ctx .ctxbar { display: inline-flex; width: 34px; }
  .row .nm .meta .ctx .ctxbar :global(.bar) { width: 34px; min-width: 34px; flex: 0 0 34px; height: 4px; }

  /* Nested workflow subagents under a parent agent row (active lanes only). Indented
     to sit under the parent's name (icon 30 + gap 11 + padding 16). A subtle left
     guide rail ties each workflow's phases + rows to the parent above. */
  .sa-wf { margin: 1px 0 3px 0; padding-left: 57px; }
  .sa-phase {
    padding: 3px 16px 1px 0; font-family: var(--font-mono); font-size: 9px;
    text-transform: uppercase; letter-spacing: var(--tracking-label); color: var(--fg-4);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sa-row {
    display: flex; align-items: center; gap: 7px; padding: 2px 16px 2px 0;
    border-left: 1px solid var(--line-subtle); margin-left: -8px; padding-left: 8px;
  }
  .sa-dot { flex: none; width: 6px; height: 6px; border-radius: var(--r-full); background: var(--fg-4); }
  .sa-dot.done { background: var(--nominal-500); }
  .sa-dot.error { background: var(--abort-500); }
  .sa-dot.running { background: var(--info-500); }
  .sa-label {
    flex: 1; min-width: 0; font-size: 11px; color: var(--fg-2);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sa-dur {
    flex: none; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
    font-size: 10px; color: var(--fg-4);
  }

  .col-focus { background: var(--space-850); min-width: 0; display: flex; flex-direction: column; min-height: 0; }
  .fhead { flex: none; display: flex; align-items: center; gap: 11px; padding: 11px 18px; border-bottom: 1px solid var(--line-subtle); background: var(--space-900); }
  .fhead .ttl { font-weight: 600; font-size: 13.5px; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* The clickable title (renames on click) reads as plain text until hovered. */
  .fhead .ttl-btn { display: inline-flex; align-items: center; max-width: 100%; padding: 2px 6px; margin: -2px -6px; border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; cursor: text; text-align: left; font-family: var(--font-sans); }
  .fhead .ttl-btn:hover { background: var(--line-faint); border-color: var(--line-subtle); }
  /* The inline rename input mirrors the session-rail rename affordance. */
  .fhead .ttl-edit { flex: 1 1 auto; min-width: 0; max-width: 100%; font-weight: 600; font-size: 13.5px; font-family: var(--font-sans); color: var(--fg-1); background: var(--space-800); border: 1px solid var(--blue-500); box-shadow: var(--focus-ring); border-radius: var(--r-sm); padding: 2px 6px; outline: none; }
  .fhead .spc { flex: 1; }
  .fhead .nav { display: flex; gap: 4px; flex: none; }
  .fhead .nav button { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-sm); background: var(--space-750); border: 1px solid var(--line-subtle); color: var(--fg-3); cursor: pointer; font-size: 13px; }
  .fhead .nav button:hover { color: var(--fg-1); border-color: var(--line-default); }
  /* Named text action buttons in the header (Pause/Resume/Archive/Restore/Delete). */
  .fhead .hbtn { flex: none; height: 26px; padding: 0 12px; display: inline-flex; align-items: center; border-radius: var(--r-sm); background: var(--space-750); border: 1px solid var(--line-subtle); color: var(--fg-2); cursor: pointer; font-family: var(--font-sans); font-size: 12px; font-weight: 600; }
  .fhead .hbtn:hover { color: var(--fg-1); border-color: var(--line-default); }
  /* Destructive actions (Archive / Delete) read red at rest, intensifying on hover. */
  .fhead .hbtn.danger { color: var(--abort-bright); border-color: color-mix(in srgb, var(--abort-bright) 32%, transparent); }
  .fhead .hbtn.danger:hover { color: var(--abort-bright); border-color: color-mix(in srgb, var(--abort-bright) 50%, transparent); background: var(--abort-tint); }

  .focus-slot { flex: 1; min-height: 0; display: flex; padding: 10px; }
  /* The teleported surface fills the slot. */
  .focus-slot :global(.surface),
  .focus-slot :global(.workspace) { flex: 1 1 auto; min-width: 0; min-height: 0; }
  .focus-slot.attn { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--orange-500) 18%, transparent); border-radius: var(--r-md); }
  .focus-slot.hidden { display: none; }

  .empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center; padding: 40px; }
  .empty .ring { width: 64px; height: 64px; border-radius: 50%; background: var(--nominal-tint); color: var(--nominal-bright); display: flex; align-items: center; justify-content: center; font-size: 30px; }
  .empty .ring.closed { background: var(--space-750); color: var(--fg-3); }
  .empty p code { font-family: var(--font-mono); font-size: 12px; color: var(--fg-2); background: var(--space-750); padding: 1px 5px; border-radius: var(--r-sm); }
  .empty h3 { font-family: var(--font-display); font-weight: 600; font-size: 18px; margin: 0; color: var(--fg-1); }
  .empty p { margin: 0; font-size: 13.5px; color: var(--fg-3); max-width: 340px; line-height: 1.5; }

  /* status badges (shared look) */
  .badge { display: inline-flex; align-items: center; gap: 6px; }
  .badge.dotonly { padding: 0; }
  .badge .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
  /* In-flight agents: a blue dot that flashes slowly (the blue counterpart to the
     needs-you dot) so a working/idle agent reads as "in flight" at a glance. */
  .b-flight { color: var(--blue-300); }
  .b-flight .dot { animation: flightflash 2.4s ease-in-out infinite; }
  @keyframes flightflash {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 1px color-mix(in srgb, var(--blue-400) 35%, transparent); }
    50% { opacity: 0.3; box-shadow: 0 0 0 0 transparent; }
  }
  @media (prefers-reduced-motion: reduce) { .b-flight .dot { animation: none; } }
  .b-review { color: var(--orange-300); }
  .b-nominal { color: var(--nominal-bright); }
  .b-abort { color: var(--abort-bright); }
  .b-standby { color: var(--fg-3); }

  /* See .lh .launch above re: why this stays literal white, not --fg-on-accent. */
  .btn-primary { font-family: var(--font-sans); font-weight: 600; font-size: 13px; color: #fff; background: var(--blue-500); border: none; border-radius: var(--r-md); padding: 9px 15px; cursor: pointer; }
</style>
