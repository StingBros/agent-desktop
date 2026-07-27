import { beforeEach, describe, expect, it, vi } from 'vitest';

// Executor tests. Named `*.svelte.test.ts` so vitest compiles the module's runes
// (the singleton at the bottom touches `$state` stores on import). We exercise the
// dispatcher + handlers through INJECTED fakes — no live workspace / PTY / Tauri.
// Scenario coverage mirrors the agent-orchestration-runtime spec.

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => '') }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import {
  OrchestrationExecutor,
  type ExecutorDeps
} from './executor.svelte';
import type { Specialist } from '../specialists/specialists';
import { taskBoard } from './taskBoard.svelte';
import { newTask, resetTaskIds, type Task } from './tasks';

const PROJ = 'proj-1';

/** A minimal located-pane fake. */
function pane(paneId: string, over: Partial<{ projectId: string | null; closed: boolean; specialist: string | null; cwd: string | null; program: string; role: 'coordinator' }> = {}) {
  return {
    workspaceId: 'ws-1',
    paneId,
    session: {
      program: over.program ?? 'claude',
      cwd: over.cwd ?? '/repo',
      projectId: over.projectId === undefined ? PROJ : over.projectId,
      closed: over.closed ?? false,
      specialist: over.specialist ?? undefined,
      role: over.role
    } as any
  };
}

/** Build deps with sensible defaults; override per test. A `replies` array captures
 *  every reply so each test asserts the outcome. */
function makeDeps(over: Partial<ExecutorDeps> = {}) {
  const replies: Array<{ id: number; outcome: any }> = [];
  const launched: any[] = [];
  const sent: Array<{ paneId: string; text: string }> = [];
  const archived: string[] = [];
  const unarchived: string[] = [];
  const coordNeeds: Array<{ paneId: string; message: string | null }> = [];
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
    projectPath: (id) => (id === PROJ ? '/repo' : null),
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
    archive: (paneId) => archived.push(paneId),
    unarchive: (paneId) => unarchived.push(paneId),
    schedule: (run) => run(), // run synchronously for deterministic tests
    setCoordinatorNeedsInput: (paneId, message) => coordNeeds.push({ paneId, message }),
    titleOf: () => null,
    // Task-board deps delegate to the REAL singleton store so report handling is
    // exercised against genuine lifecycle transitions + persistence-facing mutators
    // (existing tests create no Tasks, so getTask→null / listTasks→[] leave them
    // untouched). Report tests seed the board and assert via `taskBoard.getTask`.
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
  return { deps, replies, launched, sent, archived, unarchived, coordNeeds, written };
}

describe('OrchestrationExecutor — scoping & safety (4.6)', () => {
  it('rejects an op with no orchestrator projectId in args', async () => {
    const { deps, replies } = makeDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'list_agents', args: {} });
    expect(replies[0].outcome.error).toMatch(/projectId/);
  });

  it('rejects a cross-project target (no action)', async () => {
    const { deps, replies, archived } = makeDeps({
      locate: () => pane('p1', { projectId: 'other' })
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 2, op: 'archive_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(replies[0].outcome.error).toMatch(/outside/);
    expect(archived).toEqual([]);
  });

  it('rejects a nonexistent target', async () => {
    const { deps, replies } = makeDeps({ locate: () => null });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 3, op: 'inspect_agent', args: { projectId: PROJ, paneId: 'gone' } });
    expect(replies[0].outcome.error).toMatch(/no such agent/);
  });

  it('rejects a closed target', async () => {
    const { deps, replies } = makeDeps({ locate: () => pane('p1', { closed: true }) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 4, op: 'message_agent', args: { projectId: PROJ, paneId: 'p1', text: 'hi' } });
    expect(replies[0].outcome.error).toMatch(/closed/);
  });

  it('rejects an unknown op', async () => {
    const { deps, replies } = makeDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 5, op: 'frobnicate', args: { projectId: PROJ } });
    expect(replies[0].outcome.error).toMatch(/unknown op/);
  });

  it('rejects message_agent targeting a coordinator pane (self/other coordinator)', async () => {
    const { deps, replies, sent } = makeDeps({
      locate: () => pane('coord', { role: 'coordinator' }),
      statusOf: () => 'waiting'
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 6, op: 'message_agent', args: { projectId: PROJ, paneId: 'coord', text: 'loop?' } });
    expect(replies[0].outcome.error).toMatch(/coordinator/);
    expect(sent).toEqual([]);
  });

  it('rejects archive_agent targeting a coordinator pane (would close the coordinator)', async () => {
    const { deps, replies, archived } = makeDeps({
      locate: () => pane('coord', { role: 'coordinator' })
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 7, op: 'archive_agent', args: { projectId: PROJ, paneId: 'coord' } });
    expect(replies[0].outcome.error).toMatch(/coordinator/);
    expect(archived).toEqual([]);
  });

  it('rejects unarchive_agent targeting a coordinator pane', async () => {
    const { deps, replies, unarchived } = makeDeps({
      locate: () => pane('coord', { role: 'coordinator', closed: true })
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 8, op: 'unarchive_agent', args: { projectId: PROJ, paneId: 'coord' } });
    expect(replies[0].outcome.error).toMatch(/coordinator/);
    expect(unarchived).toEqual([]);
  });
});

describe('OrchestrationExecutor — message_agent (4.3 / 4.6 idle gating)', () => {
  it('delivers text to an idle target', async () => {
    const { deps, replies, sent } = makeDeps({
      locate: () => pane('p1'),
      statusOf: () => 'waiting'
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'message_agent', args: { projectId: PROJ, paneId: 'p1', text: 'go' } });
    expect(sent).toEqual([{ paneId: 'p1', text: 'go' }]);
    expect(replies[0].outcome.result.delivered).toBe(true);
  });

  it('defers a busy target then delivers once it goes idle', async () => {
    let calls = 0;
    const { deps, replies, sent } = makeDeps({
      locate: () => pane('p1'),
      statusOf: () => (++calls < 3 ? 'working' : 'waiting') // busy twice, then idle
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'message_agent', args: { projectId: PROJ, paneId: 'p1', text: 'go' } });
    expect(sent).toEqual([{ paneId: 'p1', text: 'go' }]);
    expect(replies[0].outcome.result.delivered).toBe(true);
  });

  it('errors when the target stays busy past the bounded wait', async () => {
    // schedule that advances "time" by jumping straight to the deadline via Date.now stub.
    const realNow = Date.now;
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const { deps, replies, sent } = makeDeps({
      locate: () => pane('p1'),
      statusOf: () => 'working',
      schedule: (run) => {
        t += 1000; // advance past BUSY_WAIT_MS over several retries
        run();
      }
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'message_agent', args: { projectId: PROJ, paneId: 'p1', text: 'go' } });
    expect(sent).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/busy/);
    Date.now = realNow;
  });

  it('refuses to deliver to a target awaiting a question (no garbled menu)', async () => {
    // An AskUserQuestion/permission menu derives status `waiting`, which passes the
    // busy-gate — but writing free text + Enter would select a garbage menu option and
    // corrupt the transcript. The op must refuse, not deliver.
    const { deps, replies, sent } = makeDeps({
      locate: () => pane('p1'),
      statusOf: () => 'waiting',
      readActivity: () => ({ summary: null, messages: [], question: 'Pick one?', contextPct: null })
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'message_agent', args: { projectId: PROJ, paneId: 'p1', text: 'use A' } });
    expect(sent).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/question/i);
  });
});

describe('OrchestrationExecutor — read/list/inspect (4.3/4.4)', () => {
  it('read_agent returns recent activity', async () => {
    const { deps, replies } = makeDeps({
      locate: () => pane('p1'),
      statusOf: () => 'waiting',
      readActivity: () => ({ summary: 'did a thing', messages: ['m1', 'm2'], question: 'q?', contextPct: 42 })
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'read_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(replies[0].outcome.result).toMatchObject({
      paneId: 'p1',
      summary: 'did a thing',
      messages: ['m1', 'm2'],
      question: 'q?',
      contextPct: 42
    });
  });

  it('list_agents returns every project pane incl. user-started + archived', async () => {
    const { deps, replies } = makeDeps({
      panesInProject: () => [pane('p1'), pane('p2', { specialist: 'reviewer' }), pane('p3', { closed: true })]
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'list_agents', args: { projectId: PROJ } });
    const agents = replies[0].outcome.result.agents;
    expect(agents.map((a: any) => a.paneId)).toEqual(['p1', 'p2', 'p3']);
    expect(agents[1].specialist).toBe('reviewer');
    expect(agents[2].archived).toBe(true);
  });

  it('list_agents omits coordinator panes (a coordinator does not list itself/other coordinators)', async () => {
    const { deps, replies } = makeDeps({
      panesInProject: () => [pane('p1'), pane('coord', { role: 'coordinator' }), pane('p2')]
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'list_agents', args: { projectId: PROJ } });
    const agents = replies[0].outcome.result.agents;
    expect(agents.map((a: any) => a.paneId)).toEqual(['p1', 'p2']);
  });

  it('Agent identified by its generated title', async () => {
    // list_agents + inspect_agent report the generated session title (via titleOf)
    // as the agent's name, not its raw "Session N" workspace name.
    const { deps, replies } = makeDeps({
      panesInProject: () => [pane('p1'), pane('p2')],
      locate: () => pane('p1'),
      titleOf: (paneId) => (paneId === 'p1' ? 'Fix login dialog' : null)
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'list_agents', args: { projectId: PROJ } });
    const agents = replies[0].outcome.result.agents;
    expect(agents.find((a: any) => a.paneId === 'p1').name).toBe('Fix login dialog');
    await ex.onRequest({ id: 2, op: 'inspect_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(replies[1].outcome.result.name).toBe('Fix login dialog');
  });

  it('Falls back to the workspace name when untitled', async () => {
    // With no generated title (titleOf → null), the name falls back to nameFor's
    // workspace/cwd resolution (the cwd leaf "repo" here, since there's no live
    // workspace registry in the test).
    const { deps, replies } = makeDeps({
      panesInProject: () => [pane('p2')],
      titleOf: () => null
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'list_agents', args: { projectId: PROJ } });
    expect(replies[0].outcome.result.agents[0].name).toBe('repo');
  });

  it('inspect_agent returns a single agent identity + state', async () => {
    const { deps, replies } = makeDeps({
      locate: () => pane('p1', { specialist: 'tester' }),
      statusOf: () => 'working'
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'inspect_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(replies[0].outcome.result).toMatchObject({
      paneId: 'p1',
      status: 'working',
      specialist: 'tester',
      projectId: PROJ
    });
  });
});

describe('OrchestrationExecutor — spawn_agent (4.2)', () => {
  it('launches a plain agent with the prompt and returns its id', async () => {
    const { deps, replies, launched } = makeDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'spawn_agent', args: { projectId: PROJ, prompt: 'build it' } });
    expect(launched[0]).toMatchObject({ program: 'claude', cwd: '/repo', initialInput: 'build it', projectId: PROJ });
    expect(launched[0].specialist).toBeUndefined();
    // No coordinator for the project → no attribution back-reference.
    expect(launched[0].coordinatorPaneId).toBeUndefined();
    expect(replies[0].outcome.result).toEqual({ paneId: 'pane-new', specialist: null });
  });

  it('attributes the spawned agent to the project coordinator (task 6.5)', async () => {
    const { deps, launched } = makeDeps({ coordinatorFor: () => 'coord-pane' });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'spawn_agent', args: { projectId: PROJ, prompt: 'go' } });
    expect(launched[0].coordinatorPaneId).toBe('coord-pane');
  });

  it('composes a specialist launch and records the specialist on the pane', async () => {
    const { deps, replies, launched } = makeDeps({
      loadSpecialist: async () => ({ name: 'reviewer', description: 'd', prompt: 'You review.', model: 'claude-sonnet-4-6', tools: ['Read', 'Grep'] }) as Specialist
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'spawn_agent', args: { projectId: PROJ, prompt: 'review', specialist: 'reviewer' } });
    expect(launched[0].specialist).toBe('reviewer');
    expect(launched[0].extraArgs).toEqual([
      '--append-system-prompt',
      'You review.',
      '--model',
      'claude-sonnet-4-6',
      '--allowedTools',
      'Read',
      'Grep'
    ]);
    expect(replies[0].outcome.result).toEqual({ paneId: 'pane-new', specialist: 'reviewer' });
  });

  it('errors when the specialist cannot be loaded (no launch)', async () => {
    const { deps, replies, launched } = makeDeps({
      loadSpecialist: async () => {
        throw new Error('not found');
      }
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'spawn_agent', args: { projectId: PROJ, prompt: 'x', specialist: 'ghost' } });
    expect(launched).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/could not load specialist/);
  });
});

describe('OrchestrationExecutor — archive / unarchive (4.5)', () => {
  it('archive_agent archives an in-project pane', async () => {
    const { deps, replies, archived } = makeDeps({ locate: () => pane('p1') });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'archive_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(archived).toEqual(['p1']);
    expect(replies[0].outcome.result.archived).toBe(true);
  });

  it('unarchive_agent restores a CLOSED in-project pane', async () => {
    const { deps, replies, unarchived } = makeDeps({ locate: () => pane('p1', { closed: true }) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'unarchive_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(unarchived).toEqual(['p1']);
    expect(replies[0].outcome.result.unarchived).toBe(true);
  });

  it('unarchive_agent rejects a cross-project pane', async () => {
    const { deps, replies, unarchived } = makeDeps({ locate: () => pane('p1', { projectId: 'other', closed: true }) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'unarchive_agent', args: { projectId: PROJ, paneId: 'p1' } });
    expect(unarchived).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/outside/);
  });
});

describe('OrchestrationExecutor — request_user_input (tasks 10.11–10.12)', () => {
  it('sets the project coordinator needs-input flag with the message and replies ok', async () => {
    const { deps, replies, coordNeeds } = makeDeps({ coordinatorFor: () => 'coord-pane' });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'request_user_input',
      args: { projectId: PROJ, message: 'need a decision' }
    });
    expect(coordNeeds).toEqual([{ paneId: 'coord-pane', message: 'need a decision' }]);
    expect(replies[0].outcome.result).toMatchObject({ notified: true, paneId: 'coord-pane' });
  });

  it('sets the flag with a null message when none is given', async () => {
    const { deps, coordNeeds } = makeDeps({ coordinatorFor: () => 'coord-pane' });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'request_user_input', args: { projectId: PROJ } });
    expect(coordNeeds).toEqual([{ paneId: 'coord-pane', message: null }]);
  });

  it('errors (no flag) when the project has no live coordinator pane', async () => {
    const { deps, replies, coordNeeds } = makeDeps({ coordinatorFor: () => null });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'request_user_input', args: { projectId: PROJ } });
    expect(coordNeeds).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/no live coordinator/);
  });

  it('rejects with no orchestrator projectId in args', async () => {
    const { deps, replies, coordNeeds } = makeDeps({ coordinatorFor: () => 'coord-pane' });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'request_user_input', args: {} });
    expect(coordNeeds).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/projectId/);
  });
});

describe('OrchestrationExecutor — back-channel reports (tasks 5.1–5.4)', () => {
  // The task board is a process singleton with no clear(), so each test uses a
  // DISTINCT projectId to stay isolated (mirroring taskBoard.svelte.test.ts).
  let projCounter = 0;
  function freshProject(): string {
    projCounter += 1;
    return `bc-proj-${projCounter}`;
  }
  function seedTask(projectId: string, over: Partial<Task> = {}): Task {
    const t: Task = { ...newTask({ goal: 'g', projectId, now: 1000 }), ...over };
    taskBoard.upsert(t);
    return t;
  }
  /** Build deps (projectPath resolvable so the by-reference path works), an executor,
   *  and a spy on the group-8 `notifyCoordinator` stub. */
  function setup(over: Partial<ExecutorDeps> = {}) {
    const ctx = makeDeps({ projectPath: () => '/repo', ...over });
    const ex = new OrchestrationExecutor(ctx.deps);
    const notify = vi.spyOn(ex as unknown as { notifyCoordinator: () => void }, 'notifyCoordinator');
    return { ...ctx, ex, notify };
  }

  beforeEach(() => resetTaskIds());

  it('report_progress records a note, stays working, and does NOT notify', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { ex, replies, notify } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_progress',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', note: 'halfway' }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.state).toBe('working');
    expect(after.notes.map((n) => n.text)).toEqual(['halfway']);
    expect(replies[0].outcome.result).toMatchObject({ ok: true, state: 'working' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('report_progress normalizes an `assigned` Task to `working` first', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'assigned' }); // not yet started
    const { ex } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_progress',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', note: 'started' }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.state).toBe('working');
    expect(after.notes.map((n) => n.text)).toEqual(['started']);
  });

  it('report_done (small result) completes the Task inline and notifies done', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { ex, replies, notify, written } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: 'all green' }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.state).toBe('done');
    expect(after.result).toBe('all green');
    expect(written).toEqual([]); // small → no by-reference write
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'done');
    expect(replies[0].outcome.result).toMatchObject({ ok: true, state: 'done' });
  });

  it('report_done (large result) stores by reference + keeps a short inline summary', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const big = 'x'.repeat(2001); // > RESULT_INLINE_MAX (2000)
    const { ex, notify, written } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: big }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.state).toBe('done');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ projectPath: '/repo', taskId: t.id, name: 'result.md' });
    const rel = `.agent-desktop/artifacts/${t.id}/result.md`;
    expect(after.artifacts).toContain(rel);
    expect(after.result).toContain(rel); // inline summary references the artifact
    expect((after.result ?? '').length).toBeLessThan(big.length);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'done');
  });

  it('report_done merges caller-supplied artifacts references', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { ex } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: 'done', artifacts: ['docs/out.md'] }
    });
    expect(taskBoard.getTask(proj, t.id)!.artifacts).toContain('docs/out.md');
  });

  it('report_blocked transitions to blocked with the reason and notifies', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { ex, notify } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_blocked',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', reason: 'needs API key' }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.state).toBe('blocked');
    expect(after.blockedReason).toBe('needs API key');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'blocked');
  });

  it('ask_coordinator moves to input-required with the question and notifies', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { ex, notify } = setup();
    await ex.onRequest({
      id: 1,
      op: 'ask_coordinator',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', question: 'which db?' }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.state).toBe('input-required');
    expect(after.question).toBe('which db?');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'ask');
  });

  // ── Scope rejection (fail closed; task 5.1) ──────────────────────────────────

  it('rejects a report with no orchestrator projectId (mutates nothing)', async () => {
    const { ex, replies, notify } = setup();
    await ex.onRequest({ id: 1, op: 'report_done', args: { taskId: 'T1', paneId: 'w1', result: 'x' } });
    expect(replies[0].outcome.error).toMatch(/projectId/);
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects a report for an unknown taskId (mutates nothing)', async () => {
    const proj = freshProject();
    const { ex, replies, notify } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_progress',
      args: { projectId: proj, taskId: 'nope', paneId: 'w1', note: 'x' }
    });
    expect(replies[0].outcome.error).toMatch(/no such task/);
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects a cross-project report (Task lives in another project)', async () => {
    const home = freshProject();
    const other = freshProject();
    const t = seedTask(home, { state: 'working' });
    const { ex, replies } = setup();
    // Same taskId, but scoped to `other` — getTask(other, id) is null → fail closed.
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: other, taskId: t.id, paneId: 'w1', result: 'x' }
    });
    expect(replies[0].outcome.error).toMatch(/no such task/);
    expect(taskBoard.getTask(home, t.id)!.state).toBe('working'); // untouched
  });

  it('rejects a report on an already-terminal Task', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'done', result: 'r' });
    const { ex, replies, notify } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_blocked',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', reason: 'late' }
    });
    expect(replies[0].outcome.error).toMatch(/terminal/);
    expect(taskBoard.getTask(proj, t.id)!.state).toBe('done'); // untouched
    expect(notify).not.toHaveBeenCalled();
  });

  // ── report_done authoritative vs Stop/idle/exit (tasks 5.2 / 5.3) ────────────

  it('only report_done reaches `done`; a lost assignee (exit/Stop) reconciles to `failed`', async () => {
    const proj = freshProject();
    // A worker whose pane exits while working: reconcile → failed, NEVER done.
    const lost = seedTask(proj, { state: 'working', assigneePaneId: 'w1' });
    const { ex } = setup({ locate: () => pane('w1', { projectId: proj }) });
    ex.reconcileOnPaneExit('w1');
    const failed = taskBoard.getTask(proj, lost.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.blockedReason).toMatch(/assignee/i);

    // A separate worker that actually reports done DOES complete.
    const finished = seedTask(proj, { state: 'working', assigneePaneId: 'w2' });
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: finished.id, paneId: 'w2', result: 'ok' }
    });
    expect(taskBoard.getTask(proj, finished.id)!.state).toBe('done');
  });

  it('reconcile-on-exit fails only non-terminal Tasks assigned to the exited pane', async () => {
    const proj = freshProject();
    const mine = seedTask(proj, { state: 'working', assigneePaneId: 'w1' });
    const otherPane = seedTask(proj, { state: 'working', assigneePaneId: 'w2' });
    const alreadyDone = seedTask(proj, { state: 'done', assigneePaneId: 'w1', result: 'r' });
    const { ex } = setup({ locate: () => pane('w1', { projectId: proj }) });
    ex.reconcileOnPaneExit('w1', 'assignee pane exited');
    expect(taskBoard.getTask(proj, mine.id)!.state).toBe('failed');
    expect(taskBoard.getTask(proj, otherPane.id)!.state).toBe('working'); // different pane
    expect(taskBoard.getTask(proj, alreadyDone.id)!.state).toBe('done'); // terminal, untouched
  });

  it('reconcile-on-exit is a no-op when the pane cannot be located', () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working', assigneePaneId: 'w1' });
    const { ex } = setup({ locate: () => null });
    ex.reconcileOnPaneExit('w1');
    expect(taskBoard.getTask(proj, t.id)!.state).toBe('working');
  });

  // ── Single-writer serialization (task 5.4) ───────────────────────────────────

  it('applies two reports to the same Task in order (single writer)', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'assigned' });
    const { ex } = setup();
    await ex.onRequest({
      id: 1,
      op: 'report_progress',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', note: 'A' }
    });
    await ex.onRequest({
      id: 2,
      op: 'report_progress',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', note: 'B' }
    });
    await ex.onRequest({
      id: 3,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: 'fin' }
    });
    const after = taskBoard.getTask(proj, t.id)!;
    expect(after.notes.map((n) => n.text)).toEqual(['A', 'B']); // ordered
    expect(after.state).toBe('done');
    expect(after.result).toBe('fin');
  });
});

describe('OrchestrationExecutor — push-when-idle coordinator notification (task group 8)', () => {
  // Distinct projectId per test (the board singleton has no clear()), mirroring the
  // back-channel block.
  let n = 0;
  const freshProject = () => `notify-proj-${++n}`;
  function seedTask(projectId: string, over: Partial<Task> = {}): Task {
    const t: Task = { ...newTask({ goal: 'g', projectId, now: 1000 }), ...over };
    taskBoard.upsert(t);
    return t;
  }
  /** Deps with a LIVE, IDLE coordinator pane wired for `projectPath('/repo')`. */
  function idleCoordDeps(over: Partial<ExecutorDeps> = {}) {
    return makeDeps({
      projectPath: () => '/repo',
      coordinatorFor: () => 'coord',
      locate: (id) => (id === 'coord' ? (pane('coord', { role: 'coordinator' }) as any) : null),
      statusOf: () => 'waiting', // idle → accepts the push
      ...over
    });
  }

  beforeEach(() => resetTaskIds());

  it('injects a DONE line into an idle coordinator', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent } = idleCoordDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: 'all green' }
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].paneId).toBe('coord');
    expect(sent[0].text).toContain(t.id);
    expect(sent[0].text).toContain('DONE');
    expect(sent[0].text).toContain('all green');
  });

  it('injects a BLOCKED line into an idle coordinator', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent } = idleCoordDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'report_blocked',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', reason: 'needs API key' }
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].paneId).toBe('coord');
    expect(sent[0].text).toContain(t.id);
    expect(sent[0].text).toContain('BLOCKED');
    expect(sent[0].text).toContain('needs API key');
  });

  it('injects a QUESTION line into an idle coordinator', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent } = idleCoordDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'ask_coordinator',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', question: 'which db?' }
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].paneId).toBe('coord');
    expect(sent[0].text).toContain(t.id);
    expect(sent[0].text).toContain('QUESTION');
    expect(sent[0].text).toContain('which db?');
  });

  it('busy coordinator → injection skipped, no throw, Task state still applied (board authoritative)', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent, replies } = idleCoordDeps({ statusOf: () => 'working' });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: 'done' }
    });
    expect(sent).toEqual([]); // deferred — coordinator is mid-turn
    expect(taskBoard.getTask(proj, t.id)!.state).toBe('done'); // board still updated
    expect(replies[0].outcome.result).toMatchObject({ ok: true, state: 'done' });
  });

  it('coordinator sitting on a live question menu → injection skipped (no garble)', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent } = idleCoordDeps({
      readActivity: () => ({ summary: null, messages: [], question: 'Pick one?', contextPct: null })
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'report_blocked',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', reason: 'x' }
    });
    expect(sent).toEqual([]);
    expect(taskBoard.getTask(proj, t.id)!.state).toBe('blocked');
  });

  it('no coordinator pane → no throw, no injection, Task state still applied', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent, replies } = idleCoordDeps({ coordinatorFor: () => null });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'report_done',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', result: 'ok' }
    });
    expect(sent).toEqual([]);
    expect(taskBoard.getTask(proj, t.id)!.state).toBe('done');
    expect(replies[0].outcome.error).toBeUndefined();
  });

  it('report_progress does NOT inject (progress is board-only) even with an idle coordinator', async () => {
    const proj = freshProject();
    const t = seedTask(proj, { state: 'working' });
    const { deps, sent } = idleCoordDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({
      id: 1,
      op: 'report_progress',
      args: { projectId: proj, taskId: t.id, paneId: 'w1', note: 'halfway' }
    });
    expect(sent).toEqual([]);
    expect(taskBoard.getTask(proj, t.id)!.state).toBe('working');
  });
});

describe('OrchestrationExecutor — coordinator task tools & spawn goal (tasks 6.1-6.3)', () => {
  // Distinct projectId per test — the board singleton has no clear() (mirrors the
  // back-channel block).
  let n = 0;
  const proj = () => `task-proj-${++n}`;
  /** Pull the JSON blob that follows `--mcp-config` in a launch plan's extraArgs. */
  function mcpConfigArg(extra: string[] | undefined): string | undefined {
    if (!extra) return undefined;
    const i = extra.indexOf('--mcp-config');
    return i >= 0 ? extra[i + 1] : undefined;
  }

  it('assign_task creates+binds a Task and dispatches a back-channel worker', async () => {
    const p = proj();
    const { deps, replies, launched } = makeDeps({ projectPath: (id) => (id === p ? '/repo' : null) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'assign_task', args: { projectId: p, goal: 'ship the thing' } });

    const result = replies[0].outcome.result;
    expect(result.paneId).toBe('pane-new');
    expect(result.taskId).toMatch(/^T\d+$/);

    // The Task is on the board, bound to the launched pane, carrying the goal.
    const task = taskBoard.getTask(p, result.taskId)!;
    expect(task).toBeTruthy();
    expect(task.goal).toBe('ship the thing');
    expect(task.assigneePaneId).toBe('pane-new');
    expect(task.projectId).toBe(p);

    // Dispatched with the back-channel: the plan carries the Task id, and extraArgs
    // carry a --mcp-config whose JSON references the back-channel adapter + this Task id.
    const plan = launched[0];
    expect(plan.taskId).toBe(result.taskId);
    expect(plan.initialInput).toBe('ship the thing'); // assign_task: goal is the input
    const cfg = mcpConfigArg(plan.extraArgs);
    expect(cfg).toBeDefined();
    expect(cfg).toContain('back-channel-mcp.cjs');
    expect(cfg).toContain(result.taskId); // AGENT_DESKTOP_TASK_ID stamped
    expect(plan.extraArgs).toContain('--append-system-prompt'); // prompt contract
  });

  it('assign_task with a specialist composes the worker from that specialist', async () => {
    const p = proj();
    const { deps, replies, launched } = makeDeps({
      projectPath: (id) => (id === p ? '/repo' : null),
      loadSpecialist: async () =>
        ({ name: 'reviewer', description: 'd', prompt: 'You review.', model: 'claude-sonnet-4-6', tools: ['Read'] }) as Specialist
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'assign_task', args: { projectId: p, goal: 'review it', specialist: 'reviewer' } });

    const result = replies[0].outcome.result;
    // Specialist recorded on the pane AND the Task.
    expect(launched[0].specialist).toBe('reviewer');
    expect(taskBoard.getTask(p, result.taskId)!.specialist).toBe('reviewer');
    // Specialist model/tools compose into extraArgs, and the system prompt carries BOTH
    // the specialist body and the Task contract.
    const extra: string[] = launched[0].extraArgs;
    expect(extra).toContain('--model');
    expect(extra).toContain('claude-sonnet-4-6');
    expect(extra).toContain('--allowedTools');
    const sp = extra[extra.indexOf('--append-system-prompt') + 1];
    expect(sp).toContain('You review.');
    expect(sp).toContain(result.taskId);
  });

  it('assign_task errors (no Task, no launch) when the specialist cannot be loaded', async () => {
    const p = proj();
    const { deps, replies, launched } = makeDeps({
      projectPath: (id) => (id === p ? '/repo' : null),
      loadSpecialist: async () => {
        throw new Error('not found');
      }
    });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'assign_task', args: { projectId: p, goal: 'x', specialist: 'ghost' } });
    expect(launched).toEqual([]);
    expect(replies[0].outcome.error).toMatch(/could not load specialist/);
    expect(taskBoard.listTasks(p)).toEqual([]); // no orphan Task
  });

  it('assign_task rejects a missing goal / missing projectId (no launch)', async () => {
    const p = proj();
    const { deps, replies, launched } = makeDeps({ projectPath: (id) => (id === p ? '/repo' : null) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'assign_task', args: { projectId: p } });
    expect(replies[0].outcome.error).toMatch(/goal/);
    await ex.onRequest({ id: 2, op: 'assign_task', args: { goal: 'x' } });
    expect(replies[1].outcome.error).toMatch(/projectId/);
    expect(launched).toEqual([]);
  });

  it('list_tasks is project-scoped and filters by state', async () => {
    const home = proj();
    const other = proj();
    const a = newTask({ goal: 'a', projectId: home, now: 1 });
    const b = { ...newTask({ goal: 'b', projectId: home, now: 2 }), state: 'done' as const };
    const c = newTask({ goal: 'c', projectId: other, now: 3 });
    taskBoard.upsert(a);
    taskBoard.upsert(b);
    taskBoard.upsert(c);

    const { deps, replies } = makeDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'list_tasks', args: { projectId: home } });
    const all = replies[0].outcome.result.tasks as Task[];
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(all.map((t) => t.id)).not.toContain(c.id); // other project excluded

    await ex.onRequest({ id: 2, op: 'list_tasks', args: { projectId: home, state: 'done' } });
    expect((replies[1].outcome.result.tasks as Task[]).map((t) => t.id)).toEqual([b.id]);
  });

  it('get_task returns an in-project Task and errors for one in another project', async () => {
    const home = proj();
    const other = proj();
    const t = newTask({ goal: 'g', projectId: home, now: 1 });
    taskBoard.upsert(t);
    const { deps, replies } = makeDeps();
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'get_task', args: { projectId: home, id: t.id } });
    expect(replies[0].outcome.result.id).toBe(t.id);
    // Same id, wrong project → structured error (project scoping).
    await ex.onRequest({ id: 2, op: 'get_task', args: { projectId: other, id: t.id } });
    expect(replies[1].outcome.error).toMatch(/no such task/);
  });

  it('spawn_agent(goal) shortcut creates a Task and dispatches the back-channel worker', async () => {
    const p = proj();
    const { deps, replies, launched } = makeDeps({ projectPath: (id) => (id === p ? '/repo' : null) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'spawn_agent', args: { projectId: p, prompt: 'go build', goal: 'build feature' } });

    const result = replies[0].outcome.result;
    expect(result.paneId).toBe('pane-new');
    expect(result.taskId).toMatch(/^T\d+$/);
    // The Task carries the goal (distinct from the pane's initial input = prompt).
    const task = taskBoard.getTask(p, result.taskId)!;
    expect(task.goal).toBe('build feature');
    expect(task.assigneePaneId).toBe('pane-new');
    // Back-channel dispatch: plan carries the Task id + prompt as initial input.
    const plan = launched[0];
    expect(plan.initialInput).toBe('go build');
    expect(plan.taskId).toBe(result.taskId);
    expect(mcpConfigArg(plan.extraArgs)).toContain(result.taskId);
  });

  it('spawn_agent WITHOUT a goal is unchanged: no Task, no back-channel args', async () => {
    const p = proj();
    const { deps, replies, launched } = makeDeps({ projectPath: (id) => (id === p ? '/repo' : null) });
    const ex = new OrchestrationExecutor(deps);
    await ex.onRequest({ id: 1, op: 'spawn_agent', args: { projectId: p, prompt: 'just run' } });
    // Exact legacy return shape.
    expect(replies[0].outcome.result).toEqual({ paneId: 'pane-new', specialist: null });
    // No Task created for this project.
    expect(taskBoard.listTasks(p)).toEqual([]);
    // No back-channel wiring on the plan.
    const plan = launched[0];
    expect(plan.taskId).toBeUndefined();
    expect(mcpConfigArg(plan.extraArgs)).toBeUndefined();
  });
});
