import { beforeEach, describe, expect, it, vi } from 'vitest';

// END-TO-END integration test for the coordinator ↔ worker back-channel loop
// (add-coordinator-task-backchannel, task 11.1). Unlike the per-op executor unit
// tests, this drives the FULL PATH through the executor's real request dispatch
// (`onRequest` → `dispatch` → handler → `reply`) with mocked transport/deps, and
// asserts the whole loop end to end:
//
//   coordinator assign_task  → a Task is created + bound, a worker is dispatched
//                              WITH the back-channel MCP (mcp-config + Task id)
//   worker      report_done  → Task → `done`, result recorded, and — because the
//                              coordinator is idle — a one-line DONE notice is
//                              injected into the coordinator pane
//   coordinator list_tasks   → reflects the Task in `done` (project-scoped)
//
// It is deterministic: no real timers/sockets/PTY/Tauri. Named `*.svelte.test.ts`
// (like `executor.svelte.test.ts`) so vitest compiles the runes the imported
// `taskBoard.svelte`/`executor.svelte` singletons touch on import. The task board is
// a process singleton with no clear(), so every test uses a DISTINCT projectId to
// stay isolated (mirroring the existing tests).

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import { OrchestrationExecutor, type ExecutorDeps } from './executor.svelte';
import type { Specialist } from '../specialists/specialists';
import { taskBoard } from './taskBoard.svelte';
import { resetTaskIds, type Task } from './tasks';

/** A minimal located-pane fake — mirrors `pane()` in `executor.svelte.test.ts`. */
function pane(
  paneId: string,
  over: Partial<{
    projectId: string | null;
    closed: boolean;
    specialist: string | null;
    cwd: string | null;
    program: string;
    role: 'coordinator';
  }> = {}
) {
  return {
    workspaceId: 'ws-1',
    paneId,
    session: {
      program: over.program ?? 'claude',
      cwd: over.cwd ?? '/repo',
      projectId: over.projectId === undefined ? 'proj-1' : over.projectId,
      closed: over.closed ?? false,
      specialist: over.specialist ?? undefined,
      role: over.role
    } as any
  };
}

/**
 * Build deps with sensible defaults; override per test — mirrors `makeDeps()` in
 * `executor.svelte.test.ts`. `launch` records the plan + returns a fixed pane id;
 * `sent` captures every coordinator injection; the task-board deps delegate to the
 * REAL singleton store so the loop is exercised against genuine lifecycle
 * transitions (asserted via `taskBoard.getTask`).
 */
function makeDeps(over: Partial<ExecutorDeps> = {}) {
  const replies: Array<{ id: number; outcome: any }> = [];
  const launched: any[] = [];
  const sent: Array<{ paneId: string; text: string }> = [];
  const written: Array<{ projectPath: string; taskId: string; name: string; content: string }> = [];
  const deps: ExecutorDeps = {
    reply: (id, outcome) => {
      replies.push({ id, outcome });
    },
    locate: () => null,
    panesInProject: () => [],
    statusOf: () => 'waiting',
    readActivity: () => ({ summary: null, messages: [], question: null, contextPct: null }),
    sendToPane: (paneId, text) => {
      sent.push({ paneId, text });
      return true;
    },
    projectPath: (id) => (id === 'proj-1' ? '/repo' : null),
    loadSpecialist: async () => ({ name: 's', description: 'd', prompt: 'P' }) as Specialist,
    launch: (plan) => {
      launched.push(plan);
      return 'pane-new';
    },
    coordinatorFor: () => null,
    usagePaths: async () => ({
      wrapperPath: '/install/statusline-wrapper.js',
      snapshotDir: '/install/snapshots',
      eventHookPath: '/install/event-hook.js',
      socketPath: '/install/event.sock',
      adapterPath: '/install/orchestration-mcp.cjs',
      backChannelAdapterPath: '/install/back-channel-mcp.cjs',
      controlSocketPath: '/install/control.sock'
    }),
    archive: () => {},
    unarchive: () => {},
    schedule: (run) => run(), // run synchronously for deterministic tests
    setCoordinatorNeedsInput: () => {},
    titleOf: () => null,
    getTask: (projectId, taskId) => taskBoard.getTask(projectId, taskId),
    listTasks: (projectId, state) => taskBoard.listTasks(projectId, state),
    upsertTask: (task) => taskBoard.upsert(task),
    addNote: (projectId, taskId, text, ts) => taskBoard.addNote(projectId, taskId, text, ts),
    transitionTask: (projectId, taskId, to, patch) =>
      taskBoard.transition(projectId, taskId, to, patch),
    writeArtifact: async (projectPath, taskId, name, content) => {
      written.push({ projectPath, taskId, name, content });
      return `.agent-desktop/artifacts/${taskId}/${name}`;
    },
    ...over
  };
  return { deps, replies, launched, sent, written };
}

/** Pull the JSON blob that follows `--mcp-config` in a launch plan's extraArgs. */
function mcpConfigArg(extra: string[] | undefined): string | undefined {
  if (!extra) return undefined;
  const i = extra.indexOf('--mcp-config');
  return i >= 0 ? extra[i + 1] : undefined;
}

describe('back-channel end-to-end (task 11.1): assign_task → report_done → list_tasks', () => {
  // Distinct projectId per test — the board singleton has no clear().
  let n = 0;
  const freshProject = () => `bc-e2e-${++n}`;
  const COORD = 'coord-pane';

  /**
   * Deps wired with a LIVE coordinator pane for `projectId` (found via `coordinatorFor`
   * + `locate`), a resolvable `projectPath`, and a controllable coordinator status.
   */
  function e2eDeps(projectId: string, over: Partial<ExecutorDeps> = {}) {
    return makeDeps({
      projectPath: (id) => (id === projectId ? '/repo' : null),
      coordinatorFor: () => COORD,
      locate: (id) => (id === COORD ? (pane(COORD, { role: 'coordinator', projectId }) as any) : null),
      statusOf: () => 'waiting', // coordinator idle → accepts the push
      ...over
    });
  }

  beforeEach(() => resetTaskIds());

  it('drives the whole loop: dispatch with back-channel, complete, push when idle, list reflects done', async () => {
    const p = freshProject();
    const { deps, replies, launched, sent } = e2eDeps(p);
    const ex = new OrchestrationExecutor(deps);

    // ── 1. Coordinator assigns a Task (with a goal) ───────────────────────────
    await ex.onRequest({ id: 1, op: 'assign_task', args: { projectId: p, goal: 'ship the thing' } });
    const assign = replies[0].outcome.result;
    expect(assign.paneId).toBe('pane-new');
    expect(assign.taskId).toMatch(/^T\d+$/);
    const taskId: string = assign.taskId;

    // A Task exists on the board, bound to the launched worker pane, carrying the goal.
    const created = taskBoard.getTask(p, taskId)!;
    expect(created).toBeTruthy();
    // Freshly minted + bound but not yet reporting → `assigned` (working is also valid
    // per the state machine; accept either so this asserts "dispatched", not internals).
    expect(['assigned', 'working']).toContain(created.state);
    expect(created.goal).toBe('ship the thing');
    expect(created.projectId).toBe(p);
    expect(created.assigneePaneId).toBe('pane-new'); // bound to the launched pane

    // The worker was dispatched WITH the back-channel: the plan carries the Task id, and
    // extraArgs carry a --mcp-config whose JSON references the back-channel adapter + id.
    const plan = launched[0];
    expect(plan.taskId).toBe(taskId);
    expect(plan.initialInput).toBe('ship the thing'); // assign_task: the goal IS the input
    const cfg = mcpConfigArg(plan.extraArgs);
    expect(cfg).toBeDefined();
    expect(cfg).toContain('back-channel-mcp.cjs'); // adapter path
    expect(cfg).toContain(taskId); // AGENT_DESKTOP_TASK_ID stamped
    expect(cfg).toContain(p); // AGENT_DESKTOP_PROJECT_ID stamped (project scope)
    expect(plan.extraArgs).toContain('--append-system-prompt'); // Task-contract prompt

    // No push yet — assignment does not notify the coordinator.
    expect(sent).toEqual([]);

    // ── 2. The dispatched worker reports done (through the SAME dispatch) ──────
    await ex.onRequest({
      id: 2,
      op: 'report_done',
      args: { projectId: p, taskId, paneId: 'pane-new', result: 'all green' }
    });
    const done = taskBoard.getTask(p, taskId)!;
    expect(done.state).toBe('done'); // authoritative completion
    expect(done.result).toBe('all green'); // result recorded (small → inline)
    expect(replies[1].outcome.result).toMatchObject({ ok: true, state: 'done' });

    // Because the coordinator is idle, a one-line DONE notice was injected into it.
    expect(sent).toHaveLength(1);
    expect(sent[0].paneId).toBe(COORD);
    expect(sent[0].text).toContain('DONE');
    expect(sent[0].text).toContain(taskId);
    expect(sent[0].text).toContain('all green');
    // Single-line nudge — no embedded newlines.
    expect(sent[0].text).not.toContain('\n');

    // ── 3. list_tasks (coordinator op) reflects the done state, project-scoped ─
    await ex.onRequest({ id: 3, op: 'list_tasks', args: { projectId: p } });
    const all = replies[2].outcome.result.tasks as Task[];
    expect(all.map((t) => t.id)).toContain(taskId);
    expect(all.find((t) => t.id === taskId)!.state).toBe('done');

    // Filtering by state also surfaces exactly this Task.
    await ex.onRequest({ id: 4, op: 'list_tasks', args: { projectId: p, state: 'done' } });
    expect((replies[3].outcome.result.tasks as Task[]).map((t) => t.id)).toEqual([taskId]);

    // Project scoping: a DIFFERENT project sees none of it.
    await ex.onRequest({ id: 5, op: 'list_tasks', args: { projectId: freshProject() } });
    expect(replies[4].outcome.result.tasks).toEqual([]);
  });

  it('busy coordinator: report_done still completes the Task (board authoritative), no injection, no throw', async () => {
    const p = freshProject();
    // Same wiring, but the coordinator is mid-turn (`working`) → push must be skipped.
    const { deps, replies, sent } = e2eDeps(p, { statusOf: () => 'working' });
    const ex = new OrchestrationExecutor(deps);

    await ex.onRequest({ id: 1, op: 'assign_task', args: { projectId: p, goal: 'do it' } });
    const taskId: string = replies[0].outcome.result.taskId;

    await ex.onRequest({
      id: 2,
      op: 'report_done',
      args: { projectId: p, taskId, paneId: 'pane-new', result: 'done' }
    });

    // The board is authoritative — the Task completes regardless of the coordinator.
    expect(taskBoard.getTask(p, taskId)!.state).toBe('done');
    expect(replies[1].outcome.result).toMatchObject({ ok: true, state: 'done' });
    expect(replies[1].outcome.error).toBeUndefined(); // nothing thrown / no error reply
    // Injection deferred — the coordinator reconciles via list_tasks on its next turn.
    expect(sent).toEqual([]);

    // And it is still visible via list_tasks in `done` (the coordinator's catch-up path).
    await ex.onRequest({ id: 3, op: 'list_tasks', args: { projectId: p, state: 'done' } });
    expect((replies[2].outcome.result.tasks as Task[]).map((t) => t.id)).toEqual([taskId]);
  });
});
