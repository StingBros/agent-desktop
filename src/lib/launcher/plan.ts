// PURE, framework-free launch-plan builder for the session launcher (Milestone 5
// / session-launcher spec: Placement As New Tab Or Split Of Focused Pane,
// Optional Initial Prompt, No Auto-Run Of Slash Commands). Given the launcher's
// raw form inputs ({folder, prompt, placement}) it produces a normalized,
// JSON-able plan that the runes-side `workspace.launch(plan)` consumes. No
// Svelte/Tauri/DOM imports, so the load-bearing guarantees — program is ALWAYS
// `claude`, the initial input is EXACTLY the user's text (never an app-fabricated
// slash command), and the placement is normalized — are unit-tested without a DOM
// or a live PTY.

/** Where the launched session is placed relative to the current layout. */
export type Placement = 'tab' | 'split-right' | 'split-down';

/** The set of split placements (a session that splits the focused pane). */
const SPLIT_PLACEMENTS: ReadonlySet<Placement> = new Set<Placement>([
  'split-right',
  'split-down'
]);

/** Raw launcher form inputs, before normalization. */
export interface LaunchRequest {
  /** Absolute path of the chosen folder (picker or recents). */
  folder: string;
  /** OPTIONAL initial prompt the user typed (may be blank / multi-line). */
  prompt?: string | null;
  /** The chosen placement. */
  placement: Placement;
  /** OPTIONAL id of the project this session is launched under. */
  projectId?: string | null;
  /**
   * OPTIONAL id of the Task this session is dispatched for (add-coordinator-task-
   * backchannel, task 7.2). Present ONLY when the coordinator-tools group dispatches a
   * worker for a Task (via `assign_task` / `spawn_agent(goal)`); absent for plain user
   * sessions and the coordinator. Carried through verbatim so the pane can record which
   * Task it is the assignee of. The back-channel wiring itself rides in `extraArgs`
   * (built by `taskWorkerLaunchArgs`); this field is the plan-level record of the binding.
   */
  taskId?: string | null;
  /**
   * OPTIONAL absolute path of the git worktree this session runs in (resolved by
   * the caller BEFORE building the plan, so the builder stays pure). Present only
   * when the project had `autoWorktree` and worktree creation succeeded.
   */
  worktreePath?: string | null;
  /** OPTIONAL base commit SHA the worktree's branch forked from (HEAD at creation). */
  worktreeBase?: string | null;
}

/**
 * A normalized, ready-to-execute launch plan. The program is ALWAYS `claude`
 * (the launcher never spawns anything else) and `initialInput` is the user's
 * verbatim prompt or `undefined` — NEVER a synthesized `/command`.
 */
export interface LaunchPlan {
  /** Always `claude` — the launcher only ever spawns claude sessions. */
  program: 'claude';
  /** The chosen folder as the session's working directory (absolute path). */
  cwd: string;
  /** Normalized placement. */
  placement: Placement;
  /**
   * The OPTIONAL initial prompt to deliver to the spawned PTY, VERBATIM. Blank /
   * whitespace-only / missing collapses to `undefined` (nothing sent — claude
   * starts at an idle prompt). A prompt beginning with `/` is preserved
   * byte-for-byte; the launcher never expands or fabricates a slash command.
   */
  initialInput: string | undefined;
  /**
   * The project this session is launched under (its identity becomes the agent's
   * avatar). `undefined` when launched without a project. Recorded verbatim on
   * the pane's registry entry; never inferred.
   */
  projectId: string | undefined;
  /**
   * The Task this session is dispatched for, or `undefined` for a plain session /
   * the coordinator. Recorded verbatim on the pane's registry entry so the executor
   * can bind the worker to its Task (assignee) and reconcile it on exit. Blank/missing
   * collapses to `undefined`. Passthrough only — this builder never invents a Task id.
   */
  taskId: string | undefined;
  /**
   * OPTIONAL absolute path of the git worktree this session runs in (already the
   * `cwd` when present). Recorded verbatim on the pane's registry entry so a later
   * cleanup task can find + remove it. `undefined` when the session launched in the
   * project folder (no `autoWorktree`, or creation failed). Resolved by the caller;
   * the builder only passes it through.
   */
  worktreePath: string | undefined;
  /** OPTIONAL base SHA the worktree's branch forked from. `undefined` without a worktree. */
  worktreeBase: string | undefined;
}

/** Whether a placement splits the focused pane (vs. opening a fresh tab). */
export function isSplitPlacement(placement: Placement): boolean {
  return SPLIT_PLACEMENTS.has(placement);
}

/**
 * Build a normalized launch plan from the launcher's raw inputs.
 *
 *  - `program` is hard-coded to `claude`.
 *  - `cwd` is the chosen folder, trimmed of surrounding whitespace.
 *  - `initialInput` is the user's prompt VERBATIM when non-blank, else
 *    `undefined`. The text is passed through untouched — including a leading `/`
 *    — so the launcher NEVER injects or rewrites a slash command. Only fully
 *    blank (empty / whitespace-only / missing) prompts become `undefined`.
 *  - `placement` is normalized; if a split is requested but `canSplit` is false
 *    (no focused pane / empty workspace), it falls back to a new `tab`.
 *
 * Pure: no side effects, no mutation of the input.
 *
 * @param req      the raw launcher inputs.
 * @param canSplit whether a split placement is currently possible (a pane is
 *                 focused). Defaults to `true`; pass `false` to force the
 *                 new-tab fallback when there is no focused pane.
 */
export function buildLaunchPlan(
  req: LaunchRequest,
  canSplit: boolean = true
): LaunchPlan {
  const cwd = req.folder.trim();

  // A split placement is only kept when a split is actually possible; otherwise
  // the session opens as a new tab (spec: split disabled/absent with no pane).
  const requested = req.placement;
  const placement: Placement =
    isSplitPlacement(requested) && !canSplit ? 'tab' : requested;

  // Deliver the user's prompt VERBATIM. We only DISTINGUISH blank from non-blank
  // (a blank prompt sends nothing); a non-blank prompt is preserved exactly as
  // typed — no trimming of the content, no slash expansion, no fabrication.
  const prompt = req.prompt;
  const initialInput =
    typeof prompt === 'string' && prompt.trim() !== '' ? prompt : undefined;

  // Carry the project binding verbatim (a blank/missing id collapses to undefined).
  const projectId =
    typeof req.projectId === 'string' && req.projectId.trim() !== ''
      ? req.projectId
      : undefined;

  // Carry the Task binding verbatim (blank/missing -> undefined), same passthrough rule
  // as projectId. Set only when a worker is dispatched for a Task; never invented here.
  const taskId =
    typeof req.taskId === 'string' && req.taskId.trim() !== '' ? req.taskId : undefined;

  // Carry the resolved worktree path + base verbatim (blank/missing -> undefined),
  // same passthrough rule as projectId. Resolution happens BEFORE this builder.
  const worktreePath =
    typeof req.worktreePath === 'string' && req.worktreePath.trim() !== ''
      ? req.worktreePath
      : undefined;
  const worktreeBase =
    typeof req.worktreeBase === 'string' && req.worktreeBase.trim() !== ''
      ? req.worktreeBase
      : undefined;

  return {
    program: 'claude',
    cwd,
    placement,
    initialInput,
    projectId,
    taskId,
    worktreePath,
    worktreeBase
  };
}
