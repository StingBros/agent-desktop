// SHARED reactive store for the per-project COORDINATOR TASK BOARD (add-coordinator-
// task-backchannel, task 1.2). The single in-memory source of truth for Tasks,
// keyed by project. The executor is the ONLY mutator (design D1 / spec "Single-
// writer authority"): coordinator task ops and worker back-channel reports are
// routed to the executor, which computes the next board state and calls the
// mutators here — nothing else writes Tasks. The roster/overview READ selectors.
//
// The pure Task shape + lifecycle state machine live in `tasks.ts` (unit-tested
// without runes); this store only holds state reactively and delegates every
// transition to `applyTransition`. Framework-coupled (`$state`), hence `.svelte.ts`.
//
// PERSISTENCE (task group 2) is intentionally NOT here yet: this store is purely
// in-memory. A clearly-marked `markDirty()` hook fires after every mutation and is
// where the debounced Rust `coordinator_tasks_save` call will be wired.

import {
  applyTransition,
  type Task,
  type TaskPatch,
  type TaskState
} from './tasks';

/** Reactive `projectId → Task[]` board. */
class TaskBoardStore {
  private board = $state<Record<string, Task[]>>({});

  // ── Selectors ──────────────────────────────────────────────────────────────

  /**
   * Tasks for a project (empty when none), optionally filtered to a single `state`.
   * Returns a fresh array; callers must not mutate the board through it.
   */
  listTasks(projectId: string, state?: TaskState): Task[] {
    const tasks = this.board[projectId] ?? [];
    return state ? tasks.filter((t) => t.state === state) : tasks.slice();
  }

  /** A single Task by id within a project, or null when absent. */
  getTask(projectId: string, id: string): Task | null {
    return (this.board[projectId] ?? []).find((t) => t.id === id) ?? null;
  }

  // ── Mutators (executor-only; single writer) ─────────────────────────────────

  /**
   * Insert a Task, or REPLACE the existing one with the same id in place (preserving
   * order). The Task carries its own `projectId`, so this is the create-or-update
   * entry point the executor uses for `assign_task` / reload.
   */
  upsert(task: Task): void {
    const existing = this.board[task.projectId] ?? [];
    const idx = existing.findIndex((t) => t.id === task.id);
    const next = existing.slice();
    if (idx >= 0) next[idx] = task;
    else next.push(task);
    this.board = { ...this.board, [task.projectId]: next };
    this.markDirty(task.projectId);
  }

  /**
   * Transition a Task to a new `state`, applying `patch`, via the pure
   * {@link applyTransition} (which throws on an illegal edge). Returns the updated
   * Task. Throws when the Task is unknown — the executor surfaces both as structured
   * errors rather than silently no-op'ing.
   */
  transition(projectId: string, id: string, to: TaskState, patch?: TaskPatch): Task {
    const tasks = this.board[projectId] ?? [];
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`no such task: ${id} (project ${projectId})`);
    const updated = applyTransition(tasks[idx], to, patch);
    const next = tasks.slice();
    next[idx] = updated;
    this.board = { ...this.board, [projectId]: next };
    this.markDirty(projectId);
    return updated;
  }

  /**
   * Append a timestamped progress note to a Task and bump its `updatedAt` to `ts`.
   * Returns the updated Task. Throws when the Task is unknown.
   */
  addNote(projectId: string, id: string, text: string, ts: number): Task {
    const tasks = this.board[projectId] ?? [];
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx < 0) throw new Error(`no such task: ${id} (project ${projectId})`);
    const cur = tasks[idx];
    const updated: Task = { ...cur, notes: [...cur.notes, { ts, text }], updatedAt: ts };
    const next = tasks.slice();
    next[idx] = updated;
    this.board = { ...this.board, [projectId]: next };
    this.markDirty(projectId);
    return updated;
  }

  /**
   * TODO (task group 2 — per-project JSON persistence): debounce and call the Rust
   * `coordinator_tasks_save(projectPath, json)` command here so each mutation is
   * flushed to `.agent-desktop/coordinator-tasks.json`. Intentionally a no-op for
   * now — this store is the in-memory source of truth only.
   */
  private markDirty(_projectId: string): void {
    // no-op until task group 2 wires persistence
  }
}

/** The singleton coordinator task-board store. */
export const taskBoard = new TaskBoardStore();
