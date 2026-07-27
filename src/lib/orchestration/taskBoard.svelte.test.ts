import { beforeEach, describe, expect, it } from 'vitest';

// Task-board store tests. Named `*.svelte.test.ts` so vitest compiles the module's
// runes (`$state`). We exercise the selectors + executor-facing mutators directly;
// the pure lifecycle rules are covered in `tasks.test.ts`.

import { taskBoard } from './taskBoard.svelte';
import { newTask, resetTaskIds, type Task } from './tasks';

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
