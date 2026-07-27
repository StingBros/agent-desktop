import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Task-board store tests. Named `*.svelte.test.ts` so vitest compiles the module's
// runes (`$state`). We exercise the selectors + executor-facing mutators directly;
// the pure lifecycle rules are covered in `tasks.test.ts`. The Tauri `invoke` is
// mocked so the persistence path (task group 2) can be asserted without real I/O.

const invokeMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { taskBoard } from './taskBoard.svelte';
import { newTask, nextTaskId, resetTaskIds, type Task } from './tasks';

/** A fresh Task for a project with a deterministic id + timestamp. */
function make(projectId: string, over: Partial<Task> = {}): Task {
  return { ...newTask({ goal: 'g', projectId, now: 1000 }), ...over };
}

describe('taskBoard store (task 1.2)', () => {
  // The store is a process singleton with no clear() (persistence/reset is task
  // group 2), so each test uses DISTINCT Task ids to stay isolated. resetTaskIds()
  // just keeps any counter-derived ids deterministic across the file.
  beforeEach(() => resetTaskIds());

  it('listTasks/getTask return empty + null for an unknown project', () => {
    expect(taskBoard.listTasks('missing-project')).toEqual([]);
    expect(taskBoard.getTask('missing-project', 'Tx')).toBeNull();
  });

  it('upsert inserts, then getTask/listTasks find it', () => {
    const t = make('A', { id: 'up-1' });
    taskBoard.upsert(t);
    expect(taskBoard.getTask('A', 'up-1')?.goal).toBe('g');
    expect(taskBoard.listTasks('A').some((x) => x.id === 'up-1')).toBe(true);
  });

  it('upsert REPLACES an existing Task in place (same id, preserved order)', () => {
    const a = make('A', { id: 'ord-1', goal: 'first' });
    const b = make('A', { id: 'ord-2', goal: 'second' });
    taskBoard.upsert(a);
    taskBoard.upsert(b);
    const order = () => taskBoard.listTasks('A').filter((t) => t.id.startsWith('ord-')).map((t) => t.id);
    expect(order()).toEqual(['ord-1', 'ord-2']);
    // Replace ord-1's goal; order must be unchanged, not moved to the end.
    taskBoard.upsert({ ...a, goal: 'first-updated' });
    expect(order()).toEqual(['ord-1', 'ord-2']);
    expect(taskBoard.getTask('A', 'ord-1')?.goal).toBe('first-updated');
  });

  it('listTasks filters by state', () => {
    taskBoard.upsert(make('B', { id: 'st-assigned' }));
    taskBoard.upsert(make('B', { id: 'st-working', state: 'working' }));
    const working = taskBoard.listTasks('B', 'working').map((t) => t.id);
    expect(working).toContain('st-working');
    expect(working).not.toContain('st-assigned');
  });

  it('transition applies the lifecycle transition in order via tasks.ts helpers', () => {
    taskBoard.upsert(make('A', { id: 'tr-1' }));
    const working = taskBoard.transition('A', 'tr-1', 'working', { assigneePaneId: 'pane-x', updatedAt: 2000 });
    expect(working.state).toBe('working');
    expect(working.assigneePaneId).toBe('pane-x');
    const done = taskBoard.transition('A', 'tr-1', 'done', { result: 'ok', updatedAt: 3000 });
    expect(done.state).toBe('done');
    expect(taskBoard.getTask('A', 'tr-1')?.state).toBe('done');
  });

  it('transition throws on an illegal edge and on an unknown Task', () => {
    taskBoard.upsert(make('A', { id: 'tr-bad' }));
    // assigned → done is illegal (idle ≠ done).
    expect(() => taskBoard.transition('A', 'tr-bad', 'done')).toThrow(/illegal task transition/);
    expect(() => taskBoard.transition('A', 'nope', 'working')).toThrow(/no such task/);
  });

  it('addNote appends timestamped notes in order and bumps updatedAt', () => {
    taskBoard.upsert(make('A', { id: 'note-1', updatedAt: 1000 }));
    taskBoard.addNote('A', 'note-1', 'first', 1100);
    const after = taskBoard.addNote('A', 'note-1', 'second', 1200);
    expect(after.notes).toEqual([
      { ts: 1100, text: 'first' },
      { ts: 1200, text: 'second' }
    ]);
    expect(after.updatedAt).toBe(1200);
    expect(taskBoard.getTask('A', 'note-1')?.notes.length).toBe(2);
  });

  it('addNote throws on an unknown Task', () => {
    expect(() => taskBoard.addNote('A', 'ghost', 'x', 1)).toThrow(/no such task/);
  });
});

describe('taskBoard persistence (task group 2)', () => {
  // Distinct project ids per test keep the singleton's per-project state isolated.
  beforeEach(() => {
    resetTaskIds();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(null);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('load hydrates the board from coordinator_tasks_load and seeds the id counter', async () => {
    const snapshot = {
      version: 1,
      tasks: [
        { ...newTask({ goal: 'g1', projectId: 'P1', now: 1, id: 'T2' }) },
        { ...newTask({ goal: 'g2', projectId: 'P1', now: 1, id: 'T5' }), state: 'working' }
      ]
    };
    invokeMock.mockResolvedValueOnce(JSON.stringify(snapshot));

    await taskBoard.load('P1', '/proj/one');

    expect(invokeMock).toHaveBeenCalledWith('coordinator_tasks_load', {
      projectPath: '/proj/one'
    });
    expect(taskBoard.getTask('P1', 'T2')?.goal).toBe('g1');
    expect(taskBoard.listTasks('P1', 'working').map((t) => t.id)).toEqual(['T5']);
    // Counter seeded above the max loaded suffix (5), so the next id is T6 (no collision).
    expect(nextTaskId()).toBe('T6');
  });

  it('load treats an absent file (null) as an empty board', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await taskBoard.load('P2', '/proj/two');
    expect(taskBoard.listTasks('P2')).toEqual([]);
  });

  it('load does NOT immediately re-persist the hydrated board', async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({ version: 1, tasks: [newTask({ goal: 'g', projectId: 'P3', now: 1, id: 'T1' })] })
    );
    await taskBoard.load('P3', '/proj/three');
    invokeMock.mockClear();
    vi.runOnlyPendingTimers();
    expect(invokeMock).not.toHaveBeenCalledWith('coordinator_tasks_save', expect.anything());
  });

  it('a mutation on a loaded project debounces a single coordinator_tasks_save', async () => {
    invokeMock.mockResolvedValueOnce(null);
    await taskBoard.load('P4', '/proj/four');
    invokeMock.mockClear();

    // Two rapid mutations within the debounce window → one coalesced save.
    taskBoard.upsert(newTask({ goal: 'a', projectId: 'P4', now: 1, id: 'T1' }));
    taskBoard.transition('P4', 'T1', 'working', { updatedAt: 2 });
    vi.runOnlyPendingTimers();

    const saves = invokeMock.mock.calls.filter((c) => c[0] === 'coordinator_tasks_save');
    expect(saves.length).toBe(1);
    expect(saves[0][1]).toMatchObject({ projectPath: '/proj/four' });
    const written = JSON.parse((saves[0][1] as { json: string }).json);
    expect(written.version).toBe(1);
    expect(written.tasks.find((t: Task) => t.id === 'T1')?.state).toBe('working');
  });

  it('a mutation on an UNLOADED project is not persisted (no path)', async () => {
    invokeMock.mockClear();
    taskBoard.upsert(newTask({ goal: 'x', projectId: 'P-unloaded', now: 1, id: 'T1' }));
    vi.runOnlyPendingTimers();
    const saves = invokeMock.mock.calls.filter((c) => c[0] === 'coordinator_tasks_save');
    expect(saves.length).toBe(0);
  });
});
