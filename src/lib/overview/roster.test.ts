import { describe, expect, it } from 'vitest';
import {
  buildRoster,
  coordinatorNeedsInput,
  deriveStatus,
  laneOf,
  laneForRow,
  needsAttention,
  isWorking,
  isArchivedCoordinator,
  showContext,
  groupByLane,
  reorderLane,
  moveId,
  orderRowsByLane,
  archivedPaneIds,
  selectCurrentTask,
  LANE_ORDER,
  WORKING_WINDOW_MS,
  IDLE_GRACE_MS,
  BUSY_GRACE_MS,
  type AgentRow,
  type PaneRuntime,
  type RosterWorkspace,
  type RuntimeMap,
  type TaskMap
} from './roster';
import type { Snapshot, SnapshotMap } from '../usage/snapshots.svelte';
import type { EventActivity } from './events';
import type { Task } from '../orchestration/tasks';

// Tests for the PURE roster view-model (Stage 1 of agent-overview). The `it(...)`
// titles are the EXACT `#### Scenario:` names from the agent-overview spec
// (Requirements: Agent Roster Overview) so the scenario-coverage gate maps each
// to this unit test. Visual rendering / click-to-navigate is MANUAL (live window).

function snap(paneId: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    pane_id: paneId,
    session_id: null,
    model: null,
    model_id: null,
    effort: null,
    task: null,
    context_pct: null,
    rate_limits: null,
    cost: null,
    git: null,
    ts: 1,
    ...over
  };
}

function mapOf(...snaps: Snapshot[]): SnapshotMap {
  const m: SnapshotMap = {};
  for (const s of snaps) m[s.pane_id] = s;
  return m;
}

/** A runtime entry for a pane (PTY activity + process state). */
function rt(paneId: string, over: Partial<PaneRuntime> = {}): [string, PaneRuntime] {
  return [paneId, { lastOutputAt: null, exited: false, exitCode: null, ...over }];
}

function runtimeOf(...entries: [string, PaneRuntime][]): RuntimeMap {
  const m: RuntimeMap = {};
  for (const [id, r] of entries) m[id] = r;
  return m;
}

/** One workspace with a single app (claude) pane. */
function ws(
  id: string,
  name: string,
  panes: { paneId: string; cwd: string | null; isApp?: boolean }[]
): RosterWorkspace {
  return {
    id,
    name,
    panes: panes.map((p) => ({
      paneId: p.paneId,
      cwd: p.cwd,
      isApp: p.isApp ?? true
    }))
  };
}

describe('roster — Agent Roster Overview', () => {
  it('Roster reflects running agents', () => {
    const now = 1_000_000; // epoch ms
    const map = mapOf(
      snap('pane-a', {
        model: 'claude-opus',
        task: 'Refactoring the parser',
        context_pct: 42,
        cost: 1.25,
        ts: 1_717_200_000
      }),
      snap('pane-b', {
        model: 'claude-sonnet',
        task: 'Writing tests',
        context_pct: 13,
        cost: 0.4
      })
    );
    // pane-a is streaming output right now (working); pane-b last spoke a while
    // ago and is waiting on the user.
    const runtime = runtimeOf(
      rt('pane-a', { lastOutputAt: now - 200 }),
      rt('pane-b', { lastOutputAt: now - WORKING_WINDOW_MS - 5_000 })
    );
    const workspaces = [
      ws('ws-1', 'Parser', [{ paneId: 'pane-a', cwd: '/home/u/parser' }]),
      ws('ws-2', 'Tests', [{ paneId: 'pane-b', cwd: '/home/u/tests' }])
    ];

    const rows = buildRoster(map, workspaces, runtime, now);

    expect(rows).toHaveLength(2);
    const a = rows.find((r) => r.paneId === 'pane-a')!;
    expect(a.workspaceId).toBe('ws-1');
    expect(a.name).toBe('Parser');
    expect(a.cwd).toBe('/home/u/parser');
    expect(a.model).toBe('claude-opus');
    expect(a.task).toBe('Refactoring the parser');
    expect(a.contextPct).toBe(42);
    expect(a.cost).toBe(1.25);
    expect(a.lastTs).toBe(1_717_200_000);
    expect(a.status).toBe('working');

    const b = rows.find((r) => r.paneId === 'pane-b')!;
    expect(b.model).toBe('claude-sonnet');
    expect(b.task).toBe('Writing tests');
    expect(b.contextPct).toBe(13);
    expect(b.cost).toBe(0.4);
    expect(b.status).toBe('waiting');
  });

  // A `/clear` (or `/logout`) fires a SessionEnd hook that the event pipeline maps to
  // `finished` — but the claude PROCESS is still alive (the conversation restarts in
  // place). A LIVE (non-exited) pane must therefore NEVER be reported `finished` from an
  // event, or the inbox auto-archive effect would archive/delete a session the user is
  // still using. `finished` for a live row can only come from an actual PTY exit or an
  // explicit close — mirror of "a dead process is never working".
  it('A live process is never finished from a SessionEnd event', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a'));
    const workspaces = [ws('ws-1', 'P', [{ paneId: 'pane-a', cwd: '/x' }])];
    // PTY alive and quiet past the working window → the byte heuristic reads `waiting`.
    const runtime = runtimeOf(
      rt('pane-a', { lastOutputAt: now - WORKING_WINDOW_MS - 1_000, exited: false })
    );
    // A SessionEnd hook (e.g. from `/clear`) drove the event-sourced status to `finished`.
    const eventActivity: Record<string, EventActivity> = {
      'pane-a': { status: 'finished', currentAction: null, question: null, questions: null }
    };
    const rows = buildRoster(map, workspaces, runtime, now, {}, WORKING_WINDOW_MS, eventActivity);
    // Falls back to the live PTY status instead of the event's stale `finished`.
    expect(rows[0].status).toBe('waiting');
  });

  // The dual guard still holds the other way: a genuine end (the PTY actually exited) IS
  // `finished` even if the last event said the agent was mid-tool — a dead process is
  // never working. This locks the symmetry the fix above relies on.
  it('An exited process is finished even when an event says working', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a'));
    const workspaces = [ws('ws-1', 'P', [{ paneId: 'pane-a', cwd: '/x' }])];
    const runtime = runtimeOf(rt('pane-a', { exited: true, exitCode: 0 }));
    const eventActivity: Record<string, EventActivity> = {
      'pane-a': { status: 'working', currentAction: 'Bash:x', question: null, questions: null }
    };
    const rows = buildRoster(map, workspaces, runtime, now, {}, WORKING_WINDOW_MS, eventActivity);
    expect(rows[0].status).toBe('finished');
  });

  // Only panes flagged as app (claude) sessions are agents; a plain shell pane in
  // the same workspace is not rostered. A pane with no runtime yet still rosters
  // (status derived from the missing activity), so the roster never silently drops
  // a freshly-launched agent — but a non-app pane never appears at all.
  it('Only app panes become agent rows', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-app', { task: 'Building' }));
    const workspaces = [
      ws('ws-1', 'Mixed', [
        { paneId: 'pane-app', cwd: '/x', isApp: true },
        { paneId: 'pane-shell', cwd: '/x', isApp: false }
      ])
    ];

    const rows = buildRoster(map, workspaces, {}, now);

    expect(rows.map((r) => r.paneId)).toEqual(['pane-app']);
  });

  // Transcript-derived activity (summary + pending question), keyed on the PANE id,
  // is merged onto the agent's row so the overview can show its last message and any
  // pending question.
  it('Agent surfaces its transcript activity', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a'));
    const workspaces = [ws('ws-1', 'P', [{ paneId: 'pane-a', cwd: '/x' }])];
    const activity = {
      'pane-a': { summary: 'Looking at the parser', question: 'Which database?' }
    };

    const rows = buildRoster(map, workspaces, {}, now, activity);
    expect(rows[0].summary).toBe('Looking at the parser');
    expect(rows[0].question).toBe('Which database?');

    // A pane with no matching activity entry carries nulls.
    const noAct = buildRoster(map, workspaces, {}, now, {});
    expect(noAct[0].summary).toBeNull();
    expect(noAct[0].question).toBeNull();
  });

  // Context-window % comes from the statusline snapshot (Claude Code computes it
  // against the REAL window — incl. the 1M variants — and the auto-compact
  // threshold), which is the same authoritative source the footer uses. The
  // transcript-derived contextPct is window-BLIND (the transcript records the bare
  // `claude-opus-4-8` model with no 1M marker, so it always divides by 200k and
  // pins a 1M session at 100%), so it is only a fallback when there is no snapshot
  // value. This keeps the card and footer in agreement.
  it('Context % prefers the statusline snapshot over the window-blind transcript', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a', { context_pct: 20 }));
    const workspaces = [ws('ws-1', 'P', [{ paneId: 'pane-a', cwd: '/x' }])];

    // Transcript claims 100 (a 1M session it mis-scaled to a 200k window); the
    // snapshot's authoritative 20 must win.
    const rows = buildRoster(map, workspaces, {}, now, {
      'pane-a': { contextPct: 100 }
    });
    expect(rows[0].contextPct).toBe(20);

    // With no snapshot value, the transcript number is the fallback.
    const noSnap = buildRoster(
      mapOf(snap('pane-b', { context_pct: null })),
      [ws('ws-2', 'Q', [{ paneId: 'pane-b', cwd: '/y' }])],
      {},
      now,
      { 'pane-b': { contextPct: 37 } }
    );
    expect(noSnap[0].contextPct).toBe(37);
  });

  // The agent's project binding (registry projectId) is carried onto its row so
  // the overview can render the project avatar + filter by project.
  it('Agent carries its project identity', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a'));
    const workspaces: RosterWorkspace[] = [
      {
        id: 'ws-1',
        name: 'Payments',
        panes: [{ paneId: 'pane-a', cwd: '/x', isApp: true, projectId: 'proj-pay' }]
      }
    ];

    const rows = buildRoster(map, workspaces, {}, now);

    expect(rows[0].projectId).toBe('proj-pay');
    // A pane with no project binding rosters with a null projectId (unassigned).
    const noProj = buildRoster(
      mapOf(snap('pane-b')),
      [ws('ws-2', 'X', [{ paneId: 'pane-b', cwd: '/y' }])],
      {},
      now
    );
    expect(noProj[0].projectId).toBeNull();
  });

  // A CLOSED (Completed) agent is always `finished` (Completed lane) and carries
  // `closed`, even when its PTY exited non-zero (a normal kill) — so a user-closed
  // session never lands in Needs-you as an error.
  it('Closed agent is finished regardless of exit code', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a'));
    const workspaces: RosterWorkspace[] = [
      {
        id: 'ws-1',
        name: 'W',
        panes: [{ paneId: 'pane-a', cwd: '/x', isApp: true, closed: true }]
      }
    ];
    // Runtime says it exited non-zero (would be `error`) — closed overrides it.
    const runtime = runtimeOf(rt('pane-a', { exited: true, exitCode: 137 }));

    const rows = buildRoster(map, workspaces, runtime, now);

    expect(rows[0].closed).toBe(true);
    expect(rows[0].status).toBe('finished');
  });

  // Name falls back to a short cwd basename when the workspace name is empty.
  it('Name falls back to short cwd', () => {
    const now = 1_000_000;
    const map = mapOf(snap('pane-a'));
    const workspaces = [
      ws('ws-1', '', [{ paneId: 'pane-a', cwd: '/home/u/projects/agent-desktop' }])
    ];

    const rows = buildRoster(map, workspaces, {}, now);

    expect(rows[0].name).toBe('agent-desktop');
  });
});

describe('roster — Agent status heuristic', () => {
  it('Agent status reflects working, waiting, finished, and errored', () => {
    const now = 1_000_000; // epoch ms

    // Alive + recent PTY output (claude is streaming) => working.
    expect(deriveStatus({ lastOutputAt: now - 100, exited: false, exitCode: null }, now)).toBe(
      'working'
    );
    // Output exactly at the working window is still working (<= window).
    expect(
      deriveStatus({ lastOutputAt: now - WORKING_WINDOW_MS, exited: false, exitCode: null }, now)
    ).toBe('working');
    // Alive but no output recently (claude is quiet at the prompt) => waiting on
    // YOU — the visually prominent "needs input" state.
    expect(
      deriveStatus(
        { lastOutputAt: now - WORKING_WINDOW_MS - 1, exited: false, exitCode: null },
        now
      )
    ).toBe('waiting');
    // Alive + just spawned, no output yet => treated as working (starting up), so
    // a launching agent never flashes idle.
    expect(deriveStatus({ lastOutputAt: null, exited: false, exitCode: null }, now)).toBe(
      'working'
    );

    // Process exited cleanly (code 0 or unknown) => finished.
    expect(deriveStatus({ lastOutputAt: now - 50, exited: true, exitCode: 0 }, now)).toBe(
      'finished'
    );
    expect(deriveStatus({ lastOutputAt: now - 50, exited: true, exitCode: null }, now)).toBe(
      'finished'
    );
    // Process exited non-zero => errored, regardless of prior activity.
    expect(deriveStatus({ lastOutputAt: now - 50, exited: true, exitCode: 1 }, now)).toBe('error');
    expect(deriveStatus({ lastOutputAt: now - 50, exited: true, exitCode: 137 }, now)).toBe(
      'error'
    );

    // No runtime at all (pane not wired yet) => idle.
    expect(deriveStatus(undefined, now)).toBe('idle');
  });
});

describe('roster — silence does not bounce a working agent (demotion hysteresis)', () => {
  const now = 1_000_000; // epoch ms
  const live = (silentMs: number): PaneRuntime => ({
    lastOutputAt: now - silentMs,
    exited: false,
    exitCode: null
  });

  it('A working agent holds In flight through silence within the idle-grace band', () => {
    // Quiet past the short working window but within the longer idle-grace window:
    // a pane that WAS working stays working (no bounce to Needs input).
    const silent = WORKING_WINDOW_MS + 1_000;
    expect(silent).toBeLessThan(IDLE_GRACE_MS);
    expect(deriveStatus(live(silent), now, WORKING_WINDOW_MS, 'working')).toBe('working');
    // The band is inclusive at the idle-grace boundary.
    expect(deriveStatus(live(IDLE_GRACE_MS), now, WORKING_WINDOW_MS, 'working')).toBe('working');
  });

  it('Confirmed idle past the idle-grace window reads Needs input', () => {
    expect(deriveStatus(live(IDLE_GRACE_MS + 1), now, WORKING_WINDOW_MS, 'working')).toBe('waiting');
  });

  it('New output re-promotes immediately regardless of prior status', () => {
    expect(deriveStatus(live(100), now, WORKING_WINDOW_MS, 'waiting')).toBe('working');
  });

  it('A settled waiting pane is not re-promoted by the hold', () => {
    // prevStatus 'waiting' + quiet past the short window stays waiting (the hold
    // only applies to a pane that was working).
    expect(deriveStatus(live(WORKING_WINDOW_MS + 1), now, WORKING_WINDOW_MS, 'waiting')).toBe(
      'waiting'
    );
  });

  it('No recorded prior status falls back to the single-window behavior (fail-safe)', () => {
    // Exactly the pre-change result at the boundary: <= window working, > window waiting.
    expect(deriveStatus(live(WORKING_WINDOW_MS), now, WORKING_WINDOW_MS, undefined)).toBe('working');
    expect(deriveStatus(live(WORKING_WINDOW_MS + 1), now, WORKING_WINDOW_MS, undefined)).toBe(
      'waiting'
    );
  });

  it('A positive signal (process exit) demotes immediately even when prevStatus was working', () => {
    expect(
      deriveStatus(
        { lastOutputAt: now - 50, exited: true, exitCode: 0 },
        now,
        WORKING_WINDOW_MS,
        'working'
      )
    ).toBe('finished');
    expect(
      deriveStatus(
        { lastOutputAt: now - 50, exited: true, exitCode: 1 },
        now,
        WORKING_WINDOW_MS,
        'working'
      )
    ).toBe('error');
  });

  it('rowFor threads the pane runtime lastStatus so the hold survives a quiet tick', () => {
    // A live non-coordinator pane, quiet within the idle-grace band, with no
    // event-sourced status: prior status 'working' on the runtime keeps it In flight.
    const silent = WORKING_WINDOW_MS + 1_000;
    const wsX = ws('wX', 'X', [{ paneId: 'p', cwd: '/r' }]);
    const held = buildRoster(
      {},
      [wsX],
      runtimeOf(rt('p', { lastOutputAt: now - silent, lastStatus: 'working' })),
      now
    );
    expect(held[0].status).toBe('working');
    // Without the prior-working latch the same silence reads waiting.
    const bounced = buildRoster({}, [wsX], runtimeOf(rt('p', { lastOutputAt: now - silent })), now);
    expect(bounced[0].status).toBe('waiting');
  });

  it('An event-sourced waiting overrides the hysteresis hold', () => {
    const silent = WORKING_WINDOW_MS + 1_000;
    const wsX = ws('wX', 'X', [{ paneId: 'p', cwd: '/r' }]);
    const evAct: Record<string, EventActivity> = {
      p: {
        status: 'waiting',
        currentAction: null,
        question: null,
        questions: null,
        everPrompted: true
      }
    };
    const [row] = buildRoster(
      {},
      [wsX],
      runtimeOf(rt('p', { lastOutputAt: now - silent, lastStatus: 'working' })),
      now,
      {},
      WORKING_WINDOW_MS,
      evAct
    );
    expect(row.status).toBe('waiting');
  });
});

describe('roster — control-room lanes', () => {
  // The Overview groups agents into three lanes, ordered top->bottom by how much
  // they need you: needs-attention (waiting/error), completed (finished), then
  // in-flight (working/idle, running on their own).
  it('maps each status to its lane', () => {
    expect(laneOf('waiting')).toBe('attn');
    expect(laneOf('error')).toBe('attn');
    expect(laneOf('finished')).toBe('done');
    expect(laneOf('working')).toBe('flight');
    expect(laneOf('idle')).toBe('flight');
  });

  it('orders lanes attention -> in-flight -> paused -> archived', () => {
    expect(LANE_ORDER).toEqual(['attn', 'flight', 'paused', 'done']);
  });

  const laneRow = (paneId: string, over: Partial<AgentRow> = {}): AgentRow => ({
    paneId,
    workspaceId: 'ws',
    name: paneId,
    cwd: null,
    model: null,
    modelId: null,
    task: null,
    summary: null,
    question: null,
    questions: null,
    currentAction: null,
    contextPct: null,
    cost: null,
    lastTs: null,
    status: 'working',
    projectId: null,
    ...over
  });

  it('groups rows by lane, preserving roster order within each lane', () => {
    const rows = [
      laneRow('a', { status: 'working' }),
      laneRow('b', { status: 'waiting' }),
      laneRow('c', { status: 'finished' }),
      laneRow('d', { status: 'error' }),
      laneRow('e', { status: 'idle' })
    ];

    const grouped = groupByLane(rows);

    expect(grouped.attn.map((r) => r.paneId)).toEqual(['b', 'd']);
    expect(grouped.done.map((r) => r.paneId)).toEqual(['c']);
    expect(grouped.flight.map((r) => r.paneId)).toEqual(['a', 'e']);
    expect(grouped.paused.map((r) => r.paneId)).toEqual([]);
  });

  it('laneForRow: archived -> done, paused -> paused (paused outranks status), else by status', () => {
    // Archived (closed) always lands in the Archived lane.
    expect(laneForRow(laneRow('a', { status: 'finished', closed: true }))).toBe('done');
    // Paused outranks the underlying status: a waiting agent that is paused leaves
    // attention and sits in the Paused lane.
    expect(laneForRow(laneRow('b', { status: 'waiting', paused: true }))).toBe('paused');
    expect(laneForRow(laneRow('c', { status: 'working', paused: true }))).toBe('paused');
    // Archived wins over paused if both somehow set.
    expect(laneForRow(laneRow('d', { status: 'waiting', paused: true, closed: true }))).toBe('done');
    // Otherwise the status decides.
    expect(laneForRow(laneRow('e', { status: 'waiting' }))).toBe('attn');
    expect(laneForRow(laneRow('f', { status: 'working' }))).toBe('flight');
  });

  it('a paused row groups under paused, not its status lane', () => {
    const rows = [
      laneRow('a', { status: 'waiting' }),
      laneRow('b', { status: 'waiting', paused: true }),
      laneRow('c', { status: 'finished', closed: true })
    ];
    const grouped = groupByLane(rows);
    expect(grouped.attn.map((r) => r.paneId)).toEqual(['a']);
    expect(grouped.paused.map((r) => r.paneId)).toEqual(['b']);
    expect(grouped.done.map((r) => r.paneId)).toEqual(['c']);
  });

  it('needsAttention: waiting/error need you, but not when paused or archived', () => {
    expect(needsAttention(laneRow('a', { status: 'waiting' }))).toBe(true);
    expect(needsAttention(laneRow('b', { status: 'error' }))).toBe(true);
    expect(needsAttention(laneRow('c', { status: 'working' }))).toBe(false);
    expect(needsAttention(laneRow('d', { status: 'waiting', paused: true }))).toBe(false);
    expect(needsAttention(laneRow('e', { status: 'waiting', closed: true }))).toBe(false);
  });

  it('isWorking: only status working, and not when paused/archived/previewed', () => {
    expect(isWorking(laneRow('a', { status: 'working' }))).toBe(true);
    // Non-working statuses never count as working.
    expect(isWorking(laneRow('b', { status: 'waiting' }))).toBe(false);
    expect(isWorking(laneRow('c', { status: 'finished' }))).toBe(false);
    expect(isWorking(laneRow('d', { status: 'error' }))).toBe(false);
    expect(isWorking(laneRow('e', { status: 'idle' }))).toBe(false);
    // Deferred / archived / previewed agents don't advertise as working.
    expect(isWorking(laneRow('f', { status: 'working', paused: true }))).toBe(false);
    expect(isWorking(laneRow('g', { status: 'working', closed: true }))).toBe(false);
    expect(isWorking(laneRow('h', { status: 'working', preview: true }))).toBe(false);
  });

  it('Context shown once known', () => {
    // Known context on a live agent → shown (including exactly 0%).
    expect(showContext(laneRow('a', { contextPct: 42 }))).toBe(true);
    expect(showContext(laneRow('b', { contextPct: 0 }))).toBe(true);
  });

  it('Context hidden when unknown', () => {
    // No context size yet (null) → hidden (no placeholder dash / striped bar).
    expect(showContext(laneRow('c', { contextPct: null }))).toBe(false);
    // Archived / previewed / paused rows never show context, even with a value.
    expect(showContext(laneRow('d', { contextPct: 42, closed: true }))).toBe(false);
    expect(showContext(laneRow('e', { contextPct: 42, preview: true }))).toBe(false);
    expect(showContext(laneRow('f', { contextPct: 42, paused: true }))).toBe(false);
  });

  it('A previewing session stays archived and out of attention', () => {
    // A session resumed for preview is LIVE (closed:false) but still presented as
    // Archived until the user sends a message — so it pins to `done` and never nags,
    // exactly like a closed row, regardless of its live status.
    expect(laneForRow(laneRow('a', { status: 'working', preview: true }))).toBe('done');
    expect(laneForRow(laneRow('b', { status: 'waiting', preview: true }))).toBe('done');
    expect(needsAttention(laneRow('c', { status: 'waiting', preview: true }))).toBe(false);
    expect(needsAttention(laneRow('d', { status: 'error', preview: true }))).toBe(false);
    // It groups under done, not its live status lane.
    const grouped = groupByLane([
      laneRow('w', { status: 'waiting' }),
      laneRow('p', { status: 'waiting', preview: true })
    ]);
    expect(grouped.attn.map((r) => r.paneId)).toEqual(['w']);
    expect(grouped.done.map((r) => r.paneId)).toEqual(['p']);
  });

  it('archivedPaneIds: the done-lane paneIds (closed + previewing), in roster order', () => {
    const rows = [
      laneRow('live', { status: 'working' }),
      laneRow('closed', { status: 'finished', closed: true }),
      laneRow('attn', { status: 'waiting' }),
      laneRow('preview', { status: 'working', preview: true })
    ];
    // Both the closed and the previewing-archived rows count; live/attention do not.
    expect(archivedPaneIds(rows)).toEqual(['closed', 'preview']);
  });

  it('archivedPaneIds: empty when nothing is archived', () => {
    const rows = [
      laneRow('a', { status: 'working' }),
      laneRow('b', { status: 'waiting' }),
      laneRow('c', { status: 'waiting', paused: true })
    ];
    expect(archivedPaneIds(rows)).toEqual([]);
  });

  // agent-roster-display: "Archived coordinator is labeled" — an archived (closed)
  // coordinator row carries the bot "Coordinator" badge; a LIVE coordinator does not
  // (it keeps its existing pinned-row presentation, no archived label added).
  it('isArchivedCoordinator: only a closed coordinator row is labeled', () => {
    // The label case: a coordinator whose session is archived (closed).
    expect(
      isArchivedCoordinator(laneRow('coord', { role: 'coordinator', closed: true }))
    ).toBe(true);
    // A LIVE coordinator is NOT labeled (no archived badge on the live presentation).
    expect(
      isArchivedCoordinator(laneRow('coord', { role: 'coordinator' }))
    ).toBe(false);
    // A preview-ed (resumed-from-archived, closed:false) coordinator is live again.
    expect(
      isArchivedCoordinator(laneRow('coord', { role: 'coordinator', closed: false, preview: true }))
    ).toBe(false);
    // A plain archived (closed) agent is NOT a coordinator → no coordinator label.
    expect(
      isArchivedCoordinator(laneRow('agent', { closed: true }))
    ).toBe(false);
    // A coordinator-spawned agent (carries coordinatorPaneId, not role) is not labeled.
    expect(
      isArchivedCoordinator(laneRow('spawned', { coordinatorPaneId: 'coord', closed: true }))
    ).toBe(false);
  });

  it('an archived coordinator sits in the Archived (done) lane', () => {
    // The closed coordinator lands in `done` like any archived row, where its label
    // renders.
    expect(
      laneForRow(laneRow('coord', { role: 'coordinator', status: 'finished', closed: true }))
    ).toBe('done');
  });
});

// Per-lane display ordering: every bucket shows its agents most-recently-added
// first by default, and the Needs-you / Paused buckets are manually reorderable by
// dragging. reorderLane keeps the established/manual order while jumping newcomers
// to the top; moveId performs a drag-move; orderRowsByLane projects both onto the
// roster rows the lanes render.
describe('roster — per-lane display ordering', () => {
  const laneRow = (paneId: string, over: Partial<AgentRow> = {}): AgentRow => ({
    paneId,
    workspaceId: 'ws',
    name: paneId,
    cwd: null,
    model: null,
    modelId: null,
    task: null,
    summary: null,
    question: null,
    questions: null,
    currentAction: null,
    contextPct: null,
    cost: null,
    lastTs: null,
    status: 'working',
    projectId: null,
    ...over
  });

  it('Default order is most recently added to the column first', () => {
    // First population (no prior order): newest-on-top means the order is the
    // REVERSE of the incoming roster/tree order (later in the tree ⇒ more recent).
    expect(reorderLane([], ['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
    // A newcomer to the lane jumps to the very top, above the established order.
    expect(reorderLane(['c', 'b', 'a'], ['c', 'b', 'a', 'd'])).toEqual(['d', 'c', 'b', 'a']);
    // Several simultaneous newcomers: later-in-roster sorts higher.
    expect(reorderLane(['a'], ['a', 'b', 'c'])).toEqual(['c', 'b', 'a']);
  });

  it('A manual order is preserved as agents enter and leave the column', () => {
    // The user dragged the lane into [b, a, c]; a recompute with the same set keeps it.
    expect(reorderLane(['b', 'a', 'c'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    // A new agent still jumps to the top WITHOUT disturbing the manual order below.
    expect(reorderLane(['b', 'a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['d', 'b', 'a', 'c']);
    // An agent that left the lane drops out; the rest keep their manual order.
    expect(reorderLane(['d', 'b', 'a', 'c'], ['b', 'c', 'd'])).toEqual(['d', 'b', 'c']);
  });

  it('An empty column keeps its remembered order (restart-safe, never wiped)', () => {
    // The roster is transiently empty while the layout restore is in flight; a lane
    // with no current members must RETAIN its saved order, not be cleared — otherwise
    // the caller would persist an empty order and lose the user's arrangement before
    // the panes reappear.
    expect(reorderLane(['x', 'y', 'z'], [])).toEqual(['x', 'y', 'z']);
    expect(reorderLane([], [])).toEqual([]);
    // When the same panes re-enter the lane together, the saved order is honored.
    expect(reorderLane(['x', 'y', 'z'], ['x', 'y', 'z'])).toEqual(['x', 'y', 'z']);
  });

  it('Dragging an agent moves it to the drop target within its bucket', () => {
    expect(moveId(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveId(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c']);
    // No-ops return a fresh copy: unknown id, or dropping onto itself.
    expect(moveId(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
    expect(moveId(['a', 'b'], 'x', 'b')).toEqual(['a', 'b']);
  });

  it('orderRowsByLane groups rows by lane and orders within each by its lane order', () => {
    const rows = [
      laneRow('w1', { status: 'waiting' }),
      laneRow('f1', { status: 'working' }),
      laneRow('w2', { status: 'error' }),
      laneRow('p1', { status: 'working', paused: true }),
      laneRow('f2', { status: 'idle' }),
      laneRow('p2', { status: 'working', paused: true })
    ];
    const laneOrder = {
      attn: ['w2', 'w1'], // manually reversed within Needs-you
      flight: ['f2', 'f1'], // newest-first
      paused: ['p2', 'p1'],
      done: []
    };
    const ordered = orderRowsByLane(rows, laneOrder).map((r) => r.paneId);
    // Lanes appear in LANE_ORDER; within each, rows follow that lane's order list.
    expect(ordered).toEqual(['w2', 'w1', 'f2', 'f1', 'p2', 'p1']);
  });

  it('orderRowsByLane sinks rows absent from their lane order to the lane end, stably', () => {
    const rows = [
      laneRow('a', { status: 'waiting' }),
      laneRow('b', { status: 'waiting' }),
      laneRow('c', { status: 'waiting' })
    ];
    // Only 'b' is in the order; 'a' and 'c' have no slot → they trail in input order.
    const ordered = orderRowsByLane(rows, { attn: ['b'], flight: [], paused: [], done: [] });
    expect(ordered.map((r) => r.paneId)).toEqual(['b', 'a', 'c']);
  });
});

// Event-sourced status integration (activity-timeline). buildRoster prefers the
// event-derived status + currentAction + question, with PTY exit authoritative and
// the snapshot still the cost/model source. Titles match the spec scenarios.
describe('roster — event-sourced status', () => {
  const now = 1_000_000;
  const wsX = ws('w1', 'W', [{ paneId: 'pane-x', cwd: '/x' }]);
  const evAct = (over: Partial<EventActivity> = {}): Record<string, EventActivity> => ({
    'pane-x': { status: null, currentAction: null, question: null, questions: null, ...over }
  });

  it('Exit is authoritative', () => {
    // The process exited non-zero; even an event status of "working" must not win.
    const runtime = runtimeOf(rt('pane-x', { exited: true, exitCode: 1, lastOutputAt: now }));
    const [row] = buildRoster({}, [wsX], runtime, now, {}, WORKING_WINDOW_MS, evAct({ status: 'working' }));
    expect(row.status).toBe('error');
  });

  it('Status independent of snapshot', () => {
    // No snapshot at all, yet the event-sourced status + currentAction surface.
    const runtime = runtimeOf(rt('pane-x', { lastOutputAt: now - 999_999 })); // PTY would say "waiting"
    const [row] = buildRoster(
      {},
      [wsX],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'working', currentAction: 'Bash:npm test' })
    );
    expect(row.status).toBe('working');
    expect(row.currentAction).toBe('Bash:npm test');
    expect(row.model).toBeNull();
  });

  it('Cost and model still read from snapshot', () => {
    const map = mapOf(snap('pane-x', { model: 'claude-opus', cost: 2.5 }));
    const [row] = buildRoster(map, [wsX], runtimeOf(), now, {}, WORKING_WINDOW_MS, evAct({ status: 'waiting' }));
    expect(row.model).toBe('claude-opus');
    expect(row.cost).toBe(2.5);
    expect(row.status).toBe('waiting');
  });
});

// Coordinator needs-input suppression (tasks 10.11–10.12): a live coordinator must
// surface "needs you" ONLY for a pending AskUserQuestion OR the explicit
// request_user_input flag — NEVER the default idle/waiting heuristic.
describe('roster — coordinator needs-input suppression', () => {
  const now = 1_000_000;
  /** A single-pane coordinator workspace. */
  const coordWs: RosterWorkspace = {
    id: 'w1',
    name: 'W',
    panes: [{ paneId: 'coord', cwd: '/x', isApp: true, role: 'coordinator', projectId: 'A' }]
  };
  const evAct = (over: Partial<EventActivity> = {}): Record<string, EventActivity> => ({
    coord: { status: null, currentAction: null, question: null, questions: null, ...over }
  });

  it('coordinatorNeedsInput pure helper: true on a pending question OR the flag', () => {
    expect(coordinatorNeedsInput({ question: null, questions: null }, false)).toBe(false);
    expect(coordinatorNeedsInput({ question: 'pick one?', questions: null }, false)).toBe(true);
    expect(
      coordinatorNeedsInput(
        { question: null, questions: [{ header: '', question: 'q?', multiSelect: false, options: [] }] },
        false
      )
    ).toBe(true);
    expect(coordinatorNeedsInput({ question: null, questions: null }, true)).toBe(true);
  });

  it('Engaged but quiet coordinator reads Idle, out of attention', () => {
    // PTY says "waiting" (long silence), no active-work affordance — a coordinator
    // that HAS started a turn (`everPrompted`), with no question and no flag, is now
    // genuinely idle at its prompt: NOT `working` (so no flashing in-flight dot) and
    // NOT `waiting` (so it never nags from the Needs-you lane).
    const runtime = runtimeOf(rt('coord', { lastOutputAt: now - 999_999 }));
    const [row] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'waiting', everPrompted: true })
    );
    expect(row.status).toBe('idle');
    expect(needsAttention(row)).toBe(false);
  });

  it('Actively running coordinator reads Working', () => {
    // Recent PTY output (within the working window) → the coordinator is actively
    // running → `working` (the flashing in-flight dot).
    const runtime = runtimeOf(rt('coord', { lastOutputAt: now }));
    const [row] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'waiting', everPrompted: true })
    );
    expect(row.status).toBe('working');
    expect(needsAttention(row)).toBe(false);
  });

  it('Engaged coordinator with a fresh busy affordance reads Working', () => {
    // Quiet PTY but a fresh terminal active-work affordance (within BUSY_GRACE_MS) —
    // e.g. "esc to interrupt" / "Waiting for N dynamic workflow(s)" — keeps it In
    // flight even between output chunks.
    const runtime = runtimeOf(rt('coord', { lastOutputAt: now - 999_999, terminalBusyAt: now }));
    const [row] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'waiting', everPrompted: true })
    );
    expect(row.status).toBe('working');
  });

  it('Engaged coordinator with a stale busy affordance reads Idle', () => {
    // The busy affordance was last seen longer ago than BUSY_GRACE_MS and the PTY is
    // quiet → the work has ended → Idle (no in-flight dot), out of attention.
    const runtime = runtimeOf(
      rt('coord', { lastOutputAt: now - 999_999, terminalBusyAt: now - (BUSY_GRACE_MS + 1) })
    );
    const [row] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'waiting', everPrompted: true })
    );
    expect(row.status).toBe('idle');
    expect(needsAttention(row)).toBe(false);
  });

  it('Just-launched coordinator awaits the first instruction', () => {
    // It spawns at an empty prompt and has never been prompted (`everPrompted` false,
    // or no events at all), so it is `waiting` ON YOU — not the quiet-stays-working
    // suppression that only applies once it has started its first turn.
    const runtime = runtimeOf(rt('coord', { lastOutputAt: now }));
    const [launched] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'waiting', everPrompted: false })
    );
    expect(launched.status).toBe('waiting');
    expect(needsAttention(launched)).toBe(true);

    // With no event activity at all (events not wired yet) it is likewise waiting.
    const [noEvents] = buildRoster({}, [coordWs], runtime, now);
    expect(noEvents.status).toBe('waiting');
    expect(needsAttention(noEvents)).toBe(true);
  });

  it('a coordinator with a pending AskUserQuestion DOES need attention', () => {
    const runtime = runtimeOf(rt('coord', { lastOutputAt: now }));
    const [row] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'waiting', question: 'which approach?' })
    );
    expect(row.status).toBe('waiting');
    expect(needsAttention(row)).toBe(true);
  });

  it('a coordinator with the explicit request_user_input flag DOES need attention', () => {
    const runtime = runtimeOf(rt('coord', { lastOutputAt: now }));
    const [row] = buildRoster(
      {},
      [coordWs],
      runtime,
      now,
      {},
      WORKING_WINDOW_MS,
      evAct({ status: 'working' }),
      new Set(['coord'])
    );
    expect(row.status).toBe('waiting');
    expect(needsAttention(row)).toBe(true);
  });

  it('a NON-coordinator pane is unaffected by the suppression (default heuristic applies)', () => {
    const normalWs: RosterWorkspace = {
      id: 'w2',
      name: 'N',
      panes: [{ paneId: 'agent', cwd: '/y', isApp: true, projectId: 'A' }]
    };
    const runtime = runtimeOf(rt('agent', { lastOutputAt: now - 999_999 }));
    const [row] = buildRoster({}, [normalWs], runtime, now, {}, WORKING_WINDOW_MS, {
      agent: { status: 'waiting', currentAction: null, question: null, questions: null }
    });
    expect(row.status).toBe('waiting');
    expect(needsAttention(row)).toBe(true);
  });
});

// In-flight vs Needs-input override (agent-status-derivation): when Claude Code is
// actively working but its event hooks report idle, a LIVE non-coordinator pane with
// NO pending question is shown In flight (`working`) rather than Needs input. The
// signal is the per-pane `terminalBusyAt` timestamp (the last positive
// detectTerminalBusy observation); the override holds while that timestamp is within
// `BUSY_GRACE_MS` of now (hysteresis — fix-needs-you-bounce), so a flickering /
// briefly-missed affordance does not bounce the row. The override is strictly
// additive: timestamp absent or older than the window → exactly the prior derivation;
// it never applies to the coordinator or to a pending-question row.
describe('roster — terminal-busy In-flight override', () => {
  const now = 1_000_000;
  // PTY alive and quiet PAST the working window → the byte heuristic alone reads
  // `waiting` (the Needs-input state the override must correct when busy).
  const quiet = (over: Partial<PaneRuntime> = {}): [string, PaneRuntime] =>
    rt('p', { lastOutputAt: now - WORKING_WINDOW_MS - 5_000, ...over });
  // A FRESH busy observation (this tick): timestamp == now, well within BUSY_GRACE_MS.
  const busyNow = (over: Partial<PaneRuntime> = {}): [string, PaneRuntime] =>
    quiet({ terminalBusyAt: now, ...over });
  const normalWs: RosterWorkspace = {
    id: 'w1',
    name: 'N',
    panes: [{ paneId: 'p', cwd: '/x', isApp: true, projectId: 'A' }]
  };

  // Scenario 1: a foreground command running (terminal shows the interrupt /
  // run-in-background affordance) → In flight, not Needs input.
  it('foreground-run busy → working (would otherwise be waiting)', () => {
    const runtime = runtimeOf(busyNow());
    const [row] = buildRoster({}, [normalWs], runtime, now);
    expect(row.status).toBe('working');
    expect(needsAttention(row)).toBe(false);
  });

  // Scenario 3: the main turn returned but a dynamic workflow / another agent is
  // still running. Same channel (terminalBusyAt fresh) → In flight. (The distinction
  // between the two affordances lives in detectTerminalBusy; here the override is
  // the same: a busy live pane stays working.)
  it('background-workflow busy → working even when an event status says waiting', () => {
    const runtime = runtimeOf(busyNow());
    const [row] = buildRoster({}, [normalWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: { status: 'waiting', currentAction: null, question: null, questions: null }
    });
    expect(row.status).toBe('working');
  });

  // HYSTERESIS (fix-needs-you-bounce): a momentary missed detection does not bounce.
  // The affordance was last seen part-way through the grace window (this tick's scrape
  // missed it), but the timestamp is still within BUSY_GRACE_MS → held In flight.
  it('a momentary missed detection does not bounce the agent', () => {
    // Last positive detection was BUSY_GRACE_MS - 1 ms ago: still within the window,
    // even though `now` did not refresh it (the current scrape missed the affordance).
    const runtime = runtimeOf(quiet({ terminalBusyAt: now - (BUSY_GRACE_MS - 1) }));
    const [row] = buildRoster({}, [normalWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: { status: 'waiting', currentAction: null, question: null, questions: null }
    });
    expect(row.status).toBe('working');
  });

  // HYSTERESIS lapse: once the affordance has been absent for the whole grace window
  // (timestamp older than BUSY_GRACE_MS), the override releases and the row returns to
  // its normally-derived status (here the stale event `waiting`).
  it('status returns to normal a grace window after the command ends', () => {
    const runtime = runtimeOf(quiet({ terminalBusyAt: now - (BUSY_GRACE_MS + 1) }));
    const [row] = buildRoster({}, [normalWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: { status: 'waiting', currentAction: null, question: null, questions: null }
    });
    expect(row.status).toBe('waiting');
  });

  // Scenario 4: a pending AskUserQuestion → Needs input REGARDLESS of any
  // active-work indicator. The override must not apply when a question is pending.
  it('pending question → still waiting despite terminalBusy', () => {
    const runtime = runtimeOf(busyNow());
    const [row] = buildRoster({}, [normalWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: { status: 'waiting', currentAction: null, question: 'pick one?', questions: null }
    });
    expect(row.status).toBe('waiting');
    expect(needsAttention(row)).toBe(true);
  });

  it('pending structured questions → still waiting despite terminalBusy', () => {
    const runtime = runtimeOf(busyNow());
    const [row] = buildRoster({}, [normalWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: {
        status: 'waiting',
        currentAction: null,
        question: null,
        questions: [{ header: '', question: 'q?', multiSelect: false, options: [] }]
      }
    });
    expect(row.status).toBe('waiting');
  });

  // Scenario 5: no indicator present → status derived EXACTLY as before. A quiet
  // pane with terminalBusyAt absent stays `waiting`.
  it('no indicator (terminalBusyAt absent) → unchanged (waiting)', () => {
    const runtime = runtimeOf(quiet());
    const [row] = buildRoster({}, [normalWs], runtime, now);
    expect(row.status).toBe('waiting');
  });

  // The override is gated on a LIVE process: an exited pane is never re-flagged
  // working (a dead process is never working — mirrors the exit rule).
  it('exited pane is finished even if terminalBusy lingers', () => {
    const runtime = runtimeOf(rt('p', { exited: true, exitCode: 0, terminalBusyAt: now }));
    const [row] = buildRoster({}, [normalWs], runtime, now);
    expect(row.status).toBe('finished');
  });

  // The GENERAL terminal-busy override does NOT reach the coordinator path: the
  // coordinator decides its own status (its needs-you suppression + its own activity
  // sensing). With a fresh busy affordance and no question/flag it reads Working via
  // the coordinator's own activity check; a pending question stays Waiting (Needs
  // you) regardless of any busy affordance.
  it('coordinator: a fresh busy affordance reads Working, but a pending question stays Waiting', () => {
    const coordWs: RosterWorkspace = {
      id: 'wc',
      name: 'C',
      panes: [{ paneId: 'p', cwd: '/x', isApp: true, role: 'coordinator', projectId: 'A' }]
    };
    const runtime = runtimeOf(busyNow());
    const [working] = buildRoster({}, [coordWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: { status: 'waiting', currentAction: null, question: null, questions: null, everPrompted: true }
    });
    expect(working.status).toBe('working');
    expect(needsAttention(working)).toBe(false);

    // A pending AskUserQuestion → Needs you, even though the busy affordance is fresh.
    const [asking] = buildRoster({}, [coordWs], runtime, now, {}, WORKING_WINDOW_MS, {
      p: { status: 'waiting', currentAction: null, question: 'pick one?', questions: null, everPrompted: true }
    });
    expect(asking.status).toBe('waiting');
    expect(needsAttention(asking)).toBe(true);
  });
});

// Task 15.1 — roster carries modelId
describe('roster — modelId from snapshot', () => {
  const now = 1_000_000;
  const normalWs: RosterWorkspace = {
    id: 'w1',
    name: 'WS',
    panes: [{ paneId: 'p', cwd: '/x', isApp: true }]
  };

  it('modelId is populated from snapshot.model_id', () => {
    const map = mapOf(snap('p', { model_id: 'claude-opus-4-8' }));
    const [row] = buildRoster(map, [normalWs], {}, now);
    expect(row.modelId).toBe('claude-opus-4-8');
  });

  it('modelId is null when snapshot.model_id is null', () => {
    const map = mapOf(snap('p', { model_id: null }));
    const [row] = buildRoster(map, [normalWs], {}, now);
    expect(row.modelId).toBeNull();
  });

  it('modelId is null when no snapshot exists', () => {
    const [row] = buildRoster({}, [normalWs], {}, now);
    expect(row.modelId).toBeNull();
  });

  it('modelId and model are both populated from snapshot', () => {
    const map = mapOf(snap('p', { model: 'Claude Opus', model_id: 'claude-opus-4-8' }));
    const [row] = buildRoster(map, [normalWs], {}, now);
    expect(row.model).toBe('Claude Opus');
    expect(row.modelId).toBe('claude-opus-4-8');
  });
});

// Task 10.1 — coordinator-task attribution on the roster row. Each worker pane's
// current Task (goal + lifecycle state) is surfaced from the pane_id -> Task[] map
// (grouped by assigneePaneId), selecting the most-recent non-terminal Task and
// falling back to the most-recent terminal one. No dedicated board panel.
describe('roster — coordinator-task attribution', () => {
  const now = 1_000_000;
  const wsX = ws('w1', 'W', [{ paneId: 'pane-x', cwd: '/x' }]);

  /** Build a Task literal with sensible defaults; override any field. */
  function task(over: Partial<Task> & { id: string }): Task {
    return {
      id: over.id,
      goal: over.goal ?? `goal ${over.id}`,
      projectId: over.projectId ?? 'A',
      assigneePaneId: over.assigneePaneId ?? 'pane-x',
      specialist: over.specialist ?? null,
      state: over.state ?? 'assigned',
      result: over.result ?? null,
      artifacts: over.artifacts ?? [],
      parentTaskId: over.parentTaskId ?? null,
      createdAt: over.createdAt ?? 0,
      updatedAt: over.updatedAt ?? 0,
      notes: over.notes ?? [],
      question: over.question ?? null,
      blockedReason: over.blockedReason ?? null
    };
  }

  /** buildRoster with the task map threaded into the 9th positional slot. */
  function rosterWithTasks(tasksByPane: TaskMap): AgentRow[] {
    return buildRoster({}, [wsX], {}, now, {}, WORKING_WINDOW_MS, {}, new Set(), tasksByPane);
  }

  it('A pane with an assigned non-terminal Task gets the task attribution fields', () => {
    const t = task({ id: 'T1', goal: 'Refactor the parser', state: 'working', updatedAt: 5 });
    const [row] = rosterWithTasks({ 'pane-x': [t] });
    expect(row.taskId).toBe('T1');
    expect(row.taskGoal).toBe('Refactor the parser');
    expect(row.taskState).toBe('working');
  });

  it('Among several Tasks it prefers the most-recent NON-TERMINAL one', () => {
    // A finished task is newer (updatedAt 20) than the live one (updatedAt 10), but the
    // live non-terminal task wins — that is what the worker is currently doing.
    const done = task({ id: 'T1', goal: 'old done', state: 'done', updatedAt: 20 });
    const live = task({ id: 'T2', goal: 'in progress', state: 'blocked', updatedAt: 10 });
    const [row] = rosterWithTasks({ 'pane-x': [done, live] });
    expect(row.taskId).toBe('T2');
    expect(row.taskState).toBe('blocked');
    // Among two non-terminal tasks, the most-recently-updated wins.
    const older = task({ id: 'T3', goal: 'older', state: 'assigned', updatedAt: 1 });
    const newer = task({ id: 'T4', goal: 'newer', state: 'working', updatedAt: 9 });
    const [row2] = rosterWithTasks({ 'pane-x': [older, newer] });
    expect(row2.taskId).toBe('T4');
  });

  it('A pane with only terminal Tasks falls back to the most-recent terminal one', () => {
    const failed = task({ id: 'T1', goal: 'crashed', state: 'failed', updatedAt: 3 });
    const done = task({ id: 'T2', goal: 'shipped', state: 'done', updatedAt: 7 });
    const [row] = rosterWithTasks({ 'pane-x': [failed, done] });
    expect(row.taskId).toBe('T2');
    expect(row.taskGoal).toBe('shipped');
    expect(row.taskState).toBe('done');
  });

  it('A pane with no assigned Task carries null task fields (row unchanged)', () => {
    // No entry in the map at all.
    const [none] = rosterWithTasks({});
    expect(none.taskId).toBeNull();
    expect(none.taskGoal).toBeNull();
    expect(none.taskState).toBeNull();
    // An explicit empty list behaves the same.
    const [empty] = rosterWithTasks({ 'pane-x': [] });
    expect(empty.taskId).toBeNull();
    expect(empty.taskGoal).toBeNull();
    expect(empty.taskState).toBeNull();
    // Tasks assigned to a DIFFERENT pane never leak onto this row.
    const other = task({ id: 'T9', assigneePaneId: 'pane-other', state: 'working' });
    const [isolated] = rosterWithTasks({ 'pane-other': [other] });
    expect(isolated.taskId).toBeNull();
  });

  it('selectCurrentTask pure helper: null for empty, recency + non-terminal preference', () => {
    expect(selectCurrentTask(undefined)).toBeNull();
    expect(selectCurrentTask([])).toBeNull();
    // Non-terminal preferred over a newer terminal.
    const done = task({ id: 'T1', state: 'done', updatedAt: 100 });
    const live = task({ id: 'T2', state: 'working', updatedAt: 5 });
    expect(selectCurrentTask([done, live])?.id).toBe('T2');
    // Recency tie on updatedAt broken by createdAt, then id.
    const a = task({ id: 'T3', state: 'assigned', updatedAt: 5, createdAt: 1 });
    const b = task({ id: 'T4', state: 'assigned', updatedAt: 5, createdAt: 2 });
    expect(selectCurrentTask([a, b])?.id).toBe('T4');
  });
});
