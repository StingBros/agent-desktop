// PURE, framework-free building blocks for the COORDINATOR TASK BOARD (add-
// coordinator-task-backchannel, task group 1). No Svelte/Tauri/DOM/fs imports, so
// the load-bearing bits — the Task shape, its lifecycle state machine, id
// generation, and the result-inline/by-reference boundary — are unit-tested
// without a live workspace, PTY, or disk.
//
// A Task is the first-class unit of coordination (design D1–D8): a project-scoped
// record the coordinator plans off of, DISTINCT from the pane that executes it (a
// pane may outlive its Task; a Task's lifecycle is tracked independently of pane
// liveness). Mutations flow through a single writer (the executor); this module
// only DESCRIBES tasks and the legal transitions between their states — it never
// touches state, storage, or the clock (timestamps are passed in, so the module
// stays deterministic and testable, matching how `coordinator.ts` stays pure).

/**
 * A Task's lifecycle state. `done` and `failed` are terminal (no transitions out).
 * Note there is deliberately no `idle` state: a worker going idle is NOT completion
 * (design D6 — `Stop` is a hint, `report_done` is authoritative), so nothing ever
 * infers `done` from idleness.
 */
export type TaskState =
  | 'assigned'
  | 'working'
  | 'blocked'
  | 'input-required'
  | 'done'
  | 'failed';

/** One timestamped progress note appended by a worker's `report_progress`. */
export interface TaskNote {
  /** When the note was recorded (ms epoch), passed in by the caller. */
  ts: number;
  /** The note text. */
  text: string;
}

/**
 * A first-class, project-scoped unit of coordinator work. Carries its identifying
 * fields (id/goal/project/timestamps), its assignment (assignee pane + specialist,
 * null until dispatched), its lifecycle `state`, a short inline `result` pointer
 * plus `artifacts` references (large output lives on disk by reference — see
 * {@link needsArtifact}/{@link artifactRelPath}), a `parentTaskId` link, and the
 * fields later groups drive: `notes` (progress), `question` (ask_coordinator), and
 * `blockedReason` (report_blocked).
 */
export interface Task {
  /** Stable id, unique within the process (e.g. `T1`, `T2`). */
  id: string;
  /** What the Task is to accomplish. */
  goal: string;
  /** The project this Task belongs to. */
  projectId: string;
  /** The worker pane executing it, or null before dispatch / after the pane is gone. */
  assigneePaneId: string | null;
  /** The specialist persona the worker was composed from, or null. */
  specialist: string | null;
  /** Current lifecycle state. */
  state: TaskState;
  /** Short inline result summary, or a path reference for large output; null until done. */
  result: string | null;
  /** POSIX-style references to on-disk artifacts under `.agent-desktop/artifacts/<id>/`. */
  artifacts: string[];
  /** Parent Task id when this was spawned as a sub-task, else null. */
  parentTaskId: string | null;
  /** Creation timestamp (ms epoch), passed in by the caller. */
  createdAt: number;
  /** Last-mutation timestamp (ms epoch), passed in by the caller. */
  updatedAt: number;
  /** Timestamped progress notes (oldest first). */
  notes: TaskNote[];
  /** The question a worker asked the coordinator (ask_coordinator), or null. */
  question: string | null;
  /** Why the Task is blocked (report_blocked) or was reconciled to failed, or null. */
  blockedReason: string | null;
}

/** The terminal states — no transition leaves them. */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['done', 'failed']);

/**
 * The lifecycle state machine — the legal edges out of each state.
 *
 *   assigned        → working | failed
 *   working         → blocked | input-required | done | failed
 *   blocked         → working | failed
 *   input-required  → working | failed
 *   done            → (terminal)
 *   failed          → (terminal)
 *
 * The happy path is `assigned → working → done`. `blocked`/`input-required` are
 * detours off `working` that resume via `working`. Every non-terminal state can go
 * to `failed`: that is the lost-assignee RECONCILE edge (design D7 / spec "Lost
 * assignee reconciles to failed"), driven by the executor on pane exit, never by a
 * worker report. `done` is only reachable from `working` — a worker reports progress
 * (→ working) before it reports done — so idleness alone can never yield `done`.
 */
const ALLOWED: Readonly<Record<TaskState, ReadonlyArray<TaskState>>> = {
  assigned: ['working', 'failed'],
  working: ['blocked', 'input-required', 'done', 'failed'],
  blocked: ['working', 'failed'],
  'input-required': ['working', 'failed'],
  done: [],
  failed: []
};

/**
 * PURE: whether a Task may transition from `from` to `to`. False out of a terminal
 * state, false for a self-loop (a state never lists itself), and false for any edge
 * not in {@link ALLOWED}.
 */
export function canTransition(from: TaskState, to: TaskState): boolean {
  return ALLOWED[from]?.includes(to) ?? false;
}

/**
 * Fields a transition may also patch onto the Task alongside its new state — e.g.
 * the `result`/`artifacts` recorded on `done`, the `blockedReason` on `blocked`, the
 * `question` on `input-required`, or a re-assignment. `updatedAt` is passed in (the
 * module never reads the clock); when omitted the Task's `updatedAt` is preserved.
 */
export interface TaskPatch {
  result?: string | null;
  artifacts?: string[];
  question?: string | null;
  blockedReason?: string | null;
  assigneePaneId?: string | null;
  specialist?: string | null;
  updatedAt?: number;
}

/**
 * PURE: return a NEW Task in state `to`, with `patch` applied. Throws when the
 * transition is illegal (see {@link canTransition}) — callers (the executor / board
 * store) surface that as a structured error rather than corrupting the board. Never
 * mutates the input Task.
 */
export function applyTransition(task: Task, to: TaskState, patch: TaskPatch = {}): Task {
  if (!canTransition(task.state, to)) {
    throw new Error(`illegal task transition: ${task.state} → ${to} (task ${task.id})`);
  }
  return {
    ...task,
    state: to,
    result: patch.result !== undefined ? patch.result : task.result,
    artifacts: patch.artifacts !== undefined ? patch.artifacts : task.artifacts,
    question: patch.question !== undefined ? patch.question : task.question,
    blockedReason: patch.blockedReason !== undefined ? patch.blockedReason : task.blockedReason,
    assigneePaneId:
      patch.assigneePaneId !== undefined ? patch.assigneePaneId : task.assigneePaneId,
    specialist: patch.specialist !== undefined ? patch.specialist : task.specialist,
    updatedAt: patch.updatedAt !== undefined ? patch.updatedAt : task.updatedAt
  };
}

// ── Id generation ────────────────────────────────────────────────────────────
//
// Stable, human-readable ids from a monotonic in-process counter (`T1`, `T2`, …) —
// crypto-free and deterministic, so tests get predictable ids (vs. the pane
// registry's `crypto.randomUUID()`, which suits opaque pane ids but not the compact
// `[task T3]` references the coordinator push uses). `newTask` also accepts an
// explicit `id` for the persistence-reload path (task group 2) where ids already
// exist. `resetTaskIds()` is a TEST hook to make counter-derived ids deterministic.

let taskIdCounter = 0;

/** The Task-id prefix (kept short for the coordinator's `[task T3] …` push line). */
export const TASK_ID_PREFIX = 'T';

/** Next stable in-process Task id (`T1`, `T2`, …). */
export function nextTaskId(): string {
  taskIdCounter += 1;
  return `${TASK_ID_PREFIX}${taskIdCounter}`;
}

/** TEST HOOK: reset the id counter (optionally to a specific value) for deterministic ids. */
export function resetTaskIds(to = 0): void {
  taskIdCounter = to;
}

/** Parse the numeric suffix of a `T<n>` id, or null when it isn't one (e.g. `T` or `Tx`). */
export function taskIdNumber(id: string): number | null {
  if (!id.startsWith(TASK_ID_PREFIX)) return null;
  const n = Number(id.slice(TASK_ID_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Seed the id counter so subsequent {@link nextTaskId} calls will NOT collide with
 * ids already in existence — used on the persistence-reload path (task group 2)
 * after hydrating a board from disk. Advances the counter to `maxSeen` (the highest
 * numeric suffix among loaded ids); never lowers it, so seeding from several projects
 * is safe. Non-`T<n>` ids should be pre-filtered via {@link taskIdNumber}.
 */
export function seedTaskIds(maxSeen: number): void {
  if (Number.isInteger(maxSeen) && maxSeen > taskIdCounter) {
    taskIdCounter = maxSeen;
  }
}

/** Fields {@link newTask} needs; `now` is passed in (the module never reads the clock). */
export interface NewTaskFields {
  goal: string;
  projectId: string;
  /** Creation timestamp (ms epoch) — used for both `createdAt` and `updatedAt`. */
  now: number;
  /** Explicit id (e.g. reloaded from storage); a fresh `nextTaskId()` when omitted. */
  id?: string;
  assigneePaneId?: string | null;
  specialist?: string | null;
  parentTaskId?: string | null;
}

/**
 * PURE (modulo the id counter): build a fresh Task in the initial `assigned` state.
 * Optional assignment/parent fields default to null; `notes`/`artifacts` start empty.
 */
export function newTask(fields: NewTaskFields): Task {
  return {
    id: fields.id ?? nextTaskId(),
    goal: fields.goal,
    projectId: fields.projectId,
    assigneePaneId: fields.assigneePaneId ?? null,
    specialist: fields.specialist ?? null,
    state: 'assigned',
    result: null,
    artifacts: [],
    parentTaskId: fields.parentTaskId ?? null,
    createdAt: fields.now,
    updatedAt: fields.now,
    notes: [],
    question: null,
    blockedReason: null
  };
}

// ── Result inline / by-reference boundary ────────────────────────────────────
//
// A Task's inline `result` is a SHORT summary; anything larger is stored on disk
// under `.agent-desktop/artifacts/<taskId>/` and referenced by path, keeping Task
// records and back-channel MCP payloads small (design D7, "Results and artifacts
// are stored by reference"). These compute the boundary + path only — no fs; the
// Rust artifacts writer (task group 2) does the actual write.

/** Max chars a `result` may hold inline before it must go to an artifact by reference. */
export const RESULT_INLINE_MAX = 2000;

/**
 * PURE: whether `result` exceeds the inline cap and must be stored as an artifact.
 * A result of exactly {@link RESULT_INLINE_MAX} chars stays inline; one longer does not.
 */
export function needsArtifact(result: string): boolean {
  return result.length > RESULT_INLINE_MAX;
}

/**
 * PURE: the POSIX-style RELATIVE path (project-root-relative) for a Task's artifact —
 * `.agent-desktop/artifacts/<taskId>/<name|result.md>`. Forward slashes always (it's
 * a stored reference, not an OS path); defaults the file name to `result.md`. Computes
 * a path only — it never touches disk.
 */
export function artifactRelPath(taskId: string, name?: string): string {
  const file = name && name.trim() !== '' ? name.trim() : 'result.md';
  return `.agent-desktop/artifacts/${taskId}/${file}`;
}
