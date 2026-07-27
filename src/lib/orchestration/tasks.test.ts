import { beforeEach, describe, expect, it } from 'vitest';
import {
  RESULT_INLINE_MAX,
  TERMINAL_STATES,
  applyTransition,
  artifactRelPath,
  canTransition,
  needsArtifact,
  newTask,
  nextTaskId,
  resetTaskIds,
  type Task,
  type TaskState
} from './tasks';

/** A fresh `assigned` Task with deterministic timestamps for transition tests. */
function make(over: Partial<Task> = {}): Task {
  return { ...newTask({ goal: 'g', projectId: 'A', now: 1000, id: 'T1' }), ...over };
}

describe('newTask (creation + id generation, task 1.1/1.3)', () => {
  beforeEach(() => resetTaskIds());

  it('creates an assigned Task with its identifying fields', () => {
    const t = newTask({ goal: 'do the thing', projectId: 'A', now: 500 });
    expect(t.goal).toBe('do the thing');
    expect(t.projectId).toBe('A');
    expect(t.state).toBe('assigned');
    expect(t.createdAt).toBe(500);
    expect(t.updatedAt).toBe(500);
    expect(t.notes).toEqual([]);
    expect(t.artifacts).toEqual([]);
    expect(t.result).toBeNull();
    expect(t.assigneePaneId).toBeNull();
    expect(t.specialist).toBeNull();
    expect(t.parentTaskId).toBeNull();
    expect(t.question).toBeNull();
    expect(t.blockedReason).toBeNull();
  });

  it('generates stable, monotonic, deterministic ids from the counter', () => {
    expect(nextTaskId()).toBe('T1');
    expect(nextTaskId()).toBe('T2');
    resetTaskIds();
    expect(newTask({ goal: 'g', projectId: 'A', now: 0 }).id).toBe('T1');
    expect(newTask({ goal: 'g', projectId: 'A', now: 0 }).id).toBe('T2');
  });

  it('honors an explicit id (reload path) and optional assignment/parent', () => {
    const t = newTask({
      goal: 'g',
      projectId: 'A',
      now: 1,
      id: 'T99',
      assigneePaneId: 'pane-1',
      specialist: 'researcher',
      parentTaskId: 'T1'
    });
    expect(t.id).toBe('T99');
    expect(t.assigneePaneId).toBe('pane-1');
    expect(t.specialist).toBe('researcher');
    expect(t.parentTaskId).toBe('T1');
  });
});

describe('canTransition — lifecycle state machine (task 1.1)', () => {
  it('allows the happy path assigned → working → done', () => {
    expect(canTransition('assigned', 'working')).toBe(true);
    expect(canTransition('working', 'done')).toBe(true);
  });

  it('allows the blocked / input-required detours off working, resuming via working', () => {
    expect(canTransition('working', 'blocked')).toBe(true);
    expect(canTransition('working', 'input-required')).toBe(true);
    expect(canTransition('blocked', 'working')).toBe(true);
    expect(canTransition('input-required', 'working')).toBe(true);
  });

  it('allows every non-terminal state to reconcile to failed (lost assignee, D7)', () => {
    for (const s of ['assigned', 'working', 'blocked', 'input-required'] as TaskState[]) {
      expect(canTransition(s, 'failed')).toBe(true);
    }
  });

  it('forbids transitions OUT of terminal states (done/failed are terminal)', () => {
    for (const to of ['assigned', 'working', 'blocked', 'input-required', 'done', 'failed'] as TaskState[]) {
      expect(canTransition('done', to)).toBe(false);
      expect(canTransition('failed', to)).toBe(false);
    }
    expect(TERMINAL_STATES.has('done')).toBe(true);
    expect(TERMINAL_STATES.has('failed')).toBe(true);
  });

  it('does NOT allow reaching done except from working (idle ≠ done, D6)', () => {
    expect(canTransition('assigned', 'done')).toBe(false);
    expect(canTransition('blocked', 'done')).toBe(false);
    expect(canTransition('input-required', 'done')).toBe(false);
    // Only working → done.
    expect(canTransition('working', 'done')).toBe(true);
  });

  it('forbids self-loops', () => {
    for (const s of ['assigned', 'working', 'blocked', 'input-required', 'done', 'failed'] as TaskState[]) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

describe('applyTransition (task 1.1)', () => {
  it('returns a NEW Task with the new state + patch applied, without mutating input', () => {
    const t = make();
    const working = applyTransition(t, 'working', { assigneePaneId: 'pane-1', updatedAt: 2000 });
    expect(working).not.toBe(t);
    expect(t.state).toBe('assigned'); // input untouched
    expect(working.state).toBe('working');
    expect(working.assigneePaneId).toBe('pane-1');
    expect(working.updatedAt).toBe(2000);
  });

  it('records result + artifacts on done', () => {
    const working = applyTransition(make(), 'working', { updatedAt: 2000 });
    const done = applyTransition(working, 'done', {
      result: 'summary',
      artifacts: ['.agent-desktop/artifacts/T1/result.md'],
      updatedAt: 3000
    });
    expect(done.state).toBe('done');
    expect(done.result).toBe('summary');
    expect(done.artifacts).toEqual(['.agent-desktop/artifacts/T1/result.md']);
  });

  it('preserves updatedAt when the patch omits it', () => {
    const t = make({ updatedAt: 1234 });
    expect(applyTransition(t, 'working').updatedAt).toBe(1234);
  });

  it('throws on an illegal transition and leaves nothing to apply', () => {
    const done = applyTransition(applyTransition(make(), 'working'), 'done');
    expect(() => applyTransition(done, 'working')).toThrow(/illegal task transition/);
    expect(() => applyTransition(make(), 'done')).toThrow(/illegal task transition/);
  });
});

describe('result inline / by-reference boundary (task 1.3)', () => {
  it('keeps a result at or under the cap inline', () => {
    expect(needsArtifact('')).toBe(false);
    expect(needsArtifact('x'.repeat(RESULT_INLINE_MAX))).toBe(false);
  });

  it('requires an artifact for a result over the cap', () => {
    expect(needsArtifact('x'.repeat(RESULT_INLINE_MAX + 1))).toBe(true);
  });

  it('builds a POSIX relative artifact path, defaulting the file to result.md', () => {
    expect(artifactRelPath('T3')).toBe('.agent-desktop/artifacts/T3/result.md');
    expect(artifactRelPath('T3', 'summary.md')).toBe('.agent-desktop/artifacts/T3/summary.md');
    expect(artifactRelPath('T3', '  ')).toBe('.agent-desktop/artifacts/T3/result.md');
    // Always forward slashes (a stored reference, not an OS path).
    expect(artifactRelPath('T3')).not.toContain('\\');
  });
});
