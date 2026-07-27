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
// PERSISTENCE (task group 2): every mutation fires `markDirty(projectId)`, which
// debounces a Rust `coordinator_tasks_save(projectPath, json)` write to that
// project's `.agent-desktop/coordinator-tasks.json` (design D1 — single writer,
// atomic snapshot). `load(projectId, projectPath)` hydrates the board from that
// file on project activation and seeds the Task-id counter so freshly-minted ids
// never collide with reloaded ones. The executor remains the ONLY mutator.

import { invoke } from '@tauri-apps/api/core';
import {
  applyTransition,
  seedTaskIds,
  taskIdNumber,
  type Task,
  type TaskPatch,
  type TaskState
} from './tasks';

/**
 * The on-disk snapshot shape for `.agent-desktop/coordinator-tasks.json`. Versioned
 * for forward-compat (mirrors the project `tasks.json`/`config.json` convention);
 * the store owns this format since it is the sole reader/writer.
 */
interface BoardSnapshot {
  version: 1;
  tasks: Task[];
}

/** Debounce window for the persist flush — coalesces a burst of mutations into one write. */
const PERSIST_DEBOUNCE_MS = 250;

/** Reactive `projectId → Task[]` board. */
class TaskBoardStore {
  private board = $state<Record<string, Task[]>>({});

  /**
   * `projectId → projectPath`, learned on {@link load}. Persistence needs the
   * project's filesystem path (the board keys only by id), so a project must be
   * loaded before its mutations can be flushed; a mutation to an unknown project
   * is kept in memory and logged (never silently persisted to the wrong place).
   */
  private paths: Record<string, string> = {};

  /** Pending per-project debounce timers for the persist flush. */
  private persistTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  /**
   * When true, {@link markDirty} is suppressed — set while {@link load} hydrates the
   * board from disk so reading the file never immediately rewrites it.
   */
  private hydrating = false;

  // ── Persistence (task group 2) ───────────────────────────────────────────────

  /**
   * Hydrate a project's board from `.agent-desktop/coordinator-tasks.json` and record
   * its `projectPath` for subsequent persistence. Called on project activation. An
   * absent file (Rust returns null) is an EMPTY board (spec: "Absent file is an empty
   * board"). After hydrating, the Task-id counter is seeded above the max numeric
   * suffix among loaded ids so {@link nextTaskId} cannot collide with a reloaded id.
   * IO/parse failures are logged and leave the board empty rather than throwing.
   */
  async load(projectId: string, projectPath: string): Promise<void> {
    this.paths[projectId] = projectPath;
    let raw: string | null = null;
    try {
      raw = await invoke<string | null>('coordinator_tasks_load', { projectPath });
    } catch (err) {
      console.error('coordinator_tasks_load failed', projectId, err);
      return;
    }
    if (!raw) return; // absent file → empty board.

    let tasks: Task[] = [];
    try {
      const parsed = JSON.parse(raw) as Partial<BoardSnapshot>;
      tasks = Array.isArray(parsed?.tasks) ? (parsed.tasks as Task[]) : [];
    } catch (err) {
      console.error('coordinator_tasks_load: malformed JSON', projectId, err);
      return;
    }

    this.hydrating = true;
    try {
      this.board = { ...this.board, [projectId]: tasks };
    } finally {
      this.hydrating = false;
    }

    // Seed the id counter above the highest T<n> suffix so new ids never collide
    // with reloaded ones (seedTaskIds never lowers the counter, so loading several
    // projects is safe).
    let maxSeen = 0;
    for (const t of tasks) {
      const n = taskIdNumber(t.id);
      if (n !== null && n > maxSeen) maxSeen = n;
    }
    seedTaskIds(maxSeen);
  }

  /**
   * Record a project's `projectId → projectPath` mapping WITHOUT a disk read, so a
   * project added mid-session (never {@link load}ed) can still have its mutations
   * flushed to the right place. The in-memory board for that project is left as-is
   * (empty for a brand-new project); this only teaches {@link persistNow} the path.
   * Registering an already-known project again is harmless (it re-records the same
   * path). Unlike {@link load}, this never touches disk and never seeds the id counter.
   */
  register(projectId: string, projectPath: string): void {
    this.paths[projectId] = projectPath;
  }

  /**
   * Flush every project with a PENDING debounced save immediately, cancelling its
   * timer and firing the save synchronously (mirroring the debounced {@link persistNow}
   * call). Called on app quit so a mutation in the last {@link PERSIST_DEBOUNCE_MS}
   * before close — still sitting behind its debounce timer — is not lost.
   */
  flushAll(): void {
    for (const projectId of Object.keys(this.persistTimers)) {
      clearTimeout(this.persistTimers[projectId]);
      delete this.persistTimers[projectId];
      this.persistNow(projectId);
    }
  }

  /**
   * Serialize a project's board and persist it via the Rust `coordinator_tasks_save`
   * command. No-op (with a warning) when the project's path is unknown — a project
   * must be {@link load}ed before its mutations can be flushed.
   */
  private persistNow(projectId: string): void {
    const projectPath = this.paths[projectId];
    if (!projectPath) {
      console.warn('taskBoard: cannot persist unloaded project (no path)', projectId);
      return;
    }
    const snapshot: BoardSnapshot = { version: 1, tasks: this.board[projectId] ?? [] };
    void invoke('coordinator_tasks_save', {
      projectPath,
      json: JSON.stringify(snapshot)
    }).catch((err) => console.error('coordinator_tasks_save failed', projectId, err));
  }

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
   * Fired after every mutation: debounce a `coordinator_tasks_save` flush of the
   * project's board to `.agent-desktop/coordinator-tasks.json` (design D1). A burst
   * of mutations within {@link PERSIST_DEBOUNCE_MS} coalesces into a single write.
   * Suppressed while {@link load} is hydrating (reading the file must not rewrite it).
   */
  private markDirty(projectId: string): void {
    if (this.hydrating) return;
    const existing = this.persistTimers[projectId];
    if (existing) clearTimeout(existing);
    this.persistTimers[projectId] = setTimeout(() => {
      delete this.persistTimers[projectId];
      this.persistNow(projectId);
    }, PERSIST_DEBOUNCE_MS);
  }
}

/** The singleton coordinator task-board store. */
export const taskBoard = new TaskBoardStore();
