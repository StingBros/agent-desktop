// FRONTEND EXECUTOR for the orchestration toolkit (agent-orchestration-runtime,
// tasks 4.1–4.6). The pane registry is FRONTEND-owned, so when a coordinator's
// bundled MCP toolkit calls an op it round-trips Rust → the Tauri
// `orchestration://request` event → THIS executor → the `orchestration_reply`
// command → back over the socket. We perform the op against the existing
// pane/launcher/activity stores and reply with a result or a structured error.
//
// ── ORCHESTRATOR-PROJECT SCOPING (critical; task 6.2 depends on this) ─────────
// Every op is bounded to the orchestrator's `projectId`. The request payload is
// `{ id, op, args }` and — by the existing Rust/adapter contract, which this task
// must NOT change — `projectId` is NOT injected anywhere in transport. So the
// executor reads the orchestrator's project from **`args.projectId`**. The
// coordinator-launch task (6.2) MUST therefore supply the coordinator's own
// `projectId` so it rides in every toolkit call's args (e.g. by stamping it into
// the adapter env and having the adapter merge it into args, OR by the toolkit
// tool schemas carrying it). When `args.projectId` is absent the executor cannot
// safely scope the op and REJECTS it with a clear error rather than guessing —
// the singleton executor may face several coordinators (one per project), so a
// heuristic "the only project" fallback would be wrong. This keeps the contract
// explicit and the executor correct under multiple coordinators.
//
// ── IDLE-GATING for message_agent (task 4.6) ─────────────────────────────────
// Injecting input mid-turn garbles a session, so delivery is gated on the target
// being ready: its effective status (event-sourced when available, PTY-byte
// heuristic otherwise — mirroring the roster) must NOT be `working`. A busy
// target is retried on a short bounded poll; if it never goes idle within the
// window we return a structured `busy` error (Rust already serializes per-target
// round-trips, so two injections to one pane never interleave).

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { workspace, type PaneSession } from '../layout/workspace.svelte';
import { leavesInOrder } from '../layout/tree';
import { getTerminal } from '../layout/terminals';
import { getRuntime } from '../overview/runtime';
import { deriveStatus, type AgentStatus } from '../overview/roster';
import { events } from '../overview/events.svelte';
import { activity } from '../overview/activity.svelte';
import { titles } from '../overview/titles.svelte';
import { projects } from '../projects/projects.svelte';
import { projectForId } from '../projects/projects';
import { specialists } from '../specialists/specialists.svelte';
import { parseSpecialist } from '../specialists/specialists';
import { specialistLaunchArgs, taskWorkerLaunchArgs } from './launchArgs';
import { buildLaunchPlan } from '../launcher/plan';
import { buildBackChannelMcpConfig, type UsagePaths } from '../usage/spawn';
import { getUsagePaths } from '../usage/paths';
import { findCoordinatorPane, type CoordinatorPaneView } from './coordinator';
import { coordinatorNeedsInput } from './coordinatorNeedsInput.svelte';
import { taskBoard } from './taskBoard.svelte';
import {
  needsArtifact,
  newTask,
  RESULT_INLINE_MAX,
  TERMINAL_STATES,
  type Task,
  type TaskPatch,
  type TaskState
} from './tasks';

/** The Tauri event name the Rust control server emits each request on. */
export const REQUEST_EVENT = 'orchestration://request';

/** One inbound orchestration request (Rust payload: `{ id, op, args }`). */
export interface OrchestrationRequest {
  /** Rust-assigned request id; echoed back in the reply. */
  id: number;
  /** The toolkit op name (`spawn_agent`, `message_agent`, …). */
  op: string;
  /** Opaque op args (forwarded verbatim by the adapter + Rust). */
  args: unknown;
}

/** A handler's outcome: a JSON result, or a structured error string. */
type OpResult = { result: unknown } | { error: string };

/**
 * One agent pane as seen by the toolkit: its identity + current state. Returned by
 * `list_agents` (array) and `inspect_agent` (single).
 */
export interface AgentInfo {
  paneId: string;
  /** Display-ish name: the workspace name, else the cwd's leaf, else the pane id. */
  name: string;
  cwd: string | null;
  projectId: string | null;
  /** Effective status (event-sourced, else PTY heuristic): working|waiting|finished|error|idle. */
  status: AgentStatus;
  /** Whether the pane is archived (closed). */
  archived: boolean;
  /** The specialist this pane was spawned as, or null. */
  specialist: string | null;
}

/** A located pane: its workspace id + paneId + session, found across all workspaces. */
interface LocatedPane {
  workspaceId: string;
  paneId: string;
  session: PaneSession;
}

/**
 * Injectable dependencies, so the dispatcher/handlers are unit-testable without a
 * live workspace/PTY/Tauri. The singleton (`executor`) binds these to the real
 * stores; tests pass fakes.
 */
export interface ExecutorDeps {
  /** Reply to a request id with a result XOR an error (the `orchestration_reply` cmd). */
  reply: (id: number, outcome: OpResult) => Promise<void> | void;
  /** Locate a pane by id across all workspaces, or null when unknown. */
  locate: (paneId: string) => LocatedPane | null;
  /** Every `claude` pane in the given project (incl. user-started, excl. archived-only filter is per-caller). */
  panesInProject: (projectId: string) => LocatedPane[];
  /** The effective status for a pane (event-sourced, else PTY heuristic). */
  statusOf: (paneId: string) => AgentStatus;
  /** Recent activity text for a pane (summary + recent messages + question). */
  readActivity: (paneId: string) => { summary: string | null; messages: string[]; question: string | null; contextPct: number | null };
  /** Deliver text to a pane's live PTY; false when there's no live PTY. */
  sendToPane: (paneId: string, text: string) => boolean;
  /** Resolve a project's absolute folder path by id, or null. */
  projectPath: (projectId: string) => string | null;
  /** Load + parse a specialist by name within a project path; throws on failure. */
  loadSpecialist: (projectPath: string, name: string) => Promise<import('../specialists/specialists').Specialist>;
  /** Launch a new claude pane; returns the new pane id. */
  launch: (plan: Parameters<typeof workspace.launch>[0]) => string;
  /** The paneId of the project's live coordinator, or null — so a coordinator-driven
   *  spawn is attributed to it in the roster/overview (task 6.5). */
  coordinatorFor: (projectId: string) => string | null;
  /** Resolve the installed usage/adapter paths (the memoized `usage_paths` round-trip
   *  every claude pane uses) — needed to attach the back-channel MCP to a Task-dispatched
   *  worker (`backChannelAdapterPath` + `controlSocketPath`). Null when unavailable. */
  usagePaths: () => Promise<UsagePaths | null>;
  /** Archive (close) / unarchive (restore) a pane. */
  archive: (paneId: string) => void;
  unarchive: (paneId: string) => void;
  /** Schedule `run` after `ms` (setTimeout in prod; tests inject a controllable one). */
  schedule: (run: () => void, ms: number) => void;
  /** SET the project coordinator's explicit "needs input" flag (tasks 10.11–10.12),
   *  with an optional short reason/prompt — surfaced in the roster so the user is
   *  notified the coordinator needs them (vs. its default keep-working heuristic). */
  setCoordinatorNeedsInput: (paneId: string, message: string | null) => void;
  /** The pane's GENERATED session title (the label shown on its card), or null when
   *  none yet — used to identify an agent by a meaningful name instead of its raw
   *  "Session N" workspace name in `list_agents` / `inspect_agent`. */
  titleOf: (paneId: string) => string | null;

  // ── Task board access (single-writer back-channel; task group 5) ─────────────
  // The executor is the ONLY mutator of Task state (design D1 / D8). These wrap the
  // shared `taskBoard` store so the handlers stay unit-testable with fakes.
  /** A single Task by id within a project, or null when absent (scope check). */
  getTask: (projectId: string, taskId: string) => Task | null;
  /** Every Task in a project (used by lost-assignee reconciliation), optionally filtered
   *  to a single `state` (the `list_tasks` tool). */
  listTasks: (projectId: string, state?: TaskState) => Task[];
  /** Insert or replace a Task on the board (the create-or-bind entry point for
   *  `assign_task` / `spawn_agent(goal)`; single-writer, persisted). */
  upsertTask: (task: Task) => void;
  /** Append a timestamped progress note to a Task (`report_progress`). */
  addNote: (projectId: string, taskId: string, text: string, ts: number) => Task;
  /** Transition a Task to `to`, applying `patch`; throws on an illegal edge/unknown id. */
  transitionTask: (projectId: string, taskId: string, to: TaskState, patch?: TaskPatch) => Task;
  /** Persist a large `report_done` result under `.agent-desktop/artifacts/<taskId>/`,
   *  returning its project-root-relative path (Rust `coordinator_tasks_write_artifact`). */
  writeArtifact: (projectPath: string, taskId: string, name: string, content: string) => Promise<string>;
}

/** How long to keep retrying a busy `message_agent` target before erroring (ms). */
export const BUSY_WAIT_MS = 8000;
/** Poll interval while waiting for a busy target to go idle (ms). */
export const BUSY_POLL_MS = 250;

/**
 * The orchestration executor. Construct with deps (or use the `executor`
 * singleton), call `start()` to subscribe to `orchestration://request`, and
 * `stop()` (via the returned unlisten) on teardown.
 */
export class OrchestrationExecutor {
  private unlisten: UnlistenFn | null = null;

  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Subscribe to `orchestration://request` and dispatch each request, replying
   * with the outcome. Returns an unlisten fn (also stored for `stop()`). Outside
   * Tauri (no backend) it logs once and returns a no-op.
   */
  async start(): Promise<UnlistenFn> {
    try {
      this.unlisten = await listen<OrchestrationRequest>(REQUEST_EVENT, (event) => {
        void this.onRequest(event.payload);
      });
    } catch (err) {
      console.warn('orchestration://request listen failed; executor inactive:', err);
      this.unlisten = () => {};
    }
    return this.unlisten;
  }

  /** Stop listening (idempotent). */
  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  /**
   * Handle ONE request: dispatch to the op handler, then reply. A thrown handler
   * error becomes a structured `{ error }` reply rather than crashing the listener.
   */
  async onRequest(req: OrchestrationRequest): Promise<void> {
    if (!req || typeof req.id !== 'number' || typeof req.op !== 'string') return;
    let outcome: OpResult;
    try {
      outcome = await this.dispatch(req.op, asObject(req.args));
    } catch (err) {
      outcome = { error: err instanceof Error ? err.message : String(err) };
    }
    await this.deps.reply(req.id, outcome);
  }

  /** Route an op name to its handler. Unknown ops return a structured error. */
  private dispatch(op: string, args: Record<string, unknown>): Promise<OpResult> | OpResult {
    switch (op) {
      case 'spawn_agent':
        return this.spawnAgent(args);
      case 'message_agent':
        return this.messageAgent(args);
      case 'read_agent':
        return this.readAgent(args);
      case 'list_agents':
        return this.listAgents(args);
      case 'inspect_agent':
        return this.inspectAgent(args);
      case 'archive_agent':
        return this.archiveAgent(args);
      case 'unarchive_agent':
        return this.unarchiveAgent(args);
      case 'request_user_input':
        return this.requestUserInput(args);
      // ── Coordinator task tools (task group 6) ────────────────────────────────
      case 'assign_task':
        return this.assignTask(args);
      case 'list_tasks':
        return this.listTasksOp(args);
      case 'get_task':
        return this.getTaskOp(args);
      // ── Worker back-channel reports (task group 5) ───────────────────────────
      case 'report_progress':
        return this.reportProgress(args);
      case 'report_done':
        return this.reportDone(args);
      case 'report_blocked':
        return this.reportBlocked(args);
      case 'ask_coordinator':
        return this.askCoordinator(args);
      default:
        return { error: `unknown op: ${op}` };
    }
  }

  // ── Scoping helpers (task 4.6) ─────────────────────────────────────────────

  /** The orchestrator's projectId from args, or null when absent/blank. */
  private orchestratorProject(args: Record<string, unknown>): string | null {
    const id = args.projectId;
    return typeof id === 'string' && id.trim() !== '' ? id : null;
  }

  /**
   * Resolve a TARGET pane for an op, enforcing scope + safety: the pane must
   * exist, not be archived/closed, and belong to the orchestrator's project.
   * Returns the located pane, or a structured-error result to reply with.
   */
  private resolveTarget(
    args: Record<string, unknown>
  ): { pane: LocatedPane } | { error: string } {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const paneId = typeof args.paneId === 'string' ? args.paneId : '';
    if (!paneId) return { error: 'missing paneId' };
    const pane = this.deps.locate(paneId);
    if (!pane) return { error: `no such agent pane: ${paneId}` };
    if (pane.session.program !== 'claude') return { error: `not an agent pane: ${paneId}` };
    if (pane.session.closed === true) return { error: `agent pane is closed: ${paneId}` };
    if (pane.session.role === 'coordinator') {
      return { error: `cannot target a coordinator pane: ${paneId}` };
    }
    if ((pane.session.projectId ?? null) !== projectId) {
      return { error: `agent pane is outside the orchestrator's project: ${paneId}` };
    }
    return { pane };
  }

  // ── Op handlers ────────────────────────────────────────────────────────────

  /**
   * `spawn_agent({ prompt, specialist?, cwd?, goal?, projectId })`: launch a new claude
   * pane in the orchestrator's project with `prompt` as initial input. With a
   * specialist, compose the launch from `.claude/agents/<specialist>.md` (system
   * prompt + model + tools) and record the specialist on the pane.
   *
   * When a `goal` is present (task 6.2), this is the assign-a-Task SHORTCUT: a Task is
   * created for the goal, bound to the launched pane as its assignee, and the worker is
   * dispatched Task-bound (back-channel MCP + Task id stamped + prompt contract) via the
   * same seam as `assign_task`; it returns `{ paneId, taskId }`. When `goal` is ABSENT
   * the behaviour is exactly as before: launch the pane (no Task, no back-channel) and
   * return `{ paneId, specialist }`.
   */
  private async spawnAgent(args: Record<string, unknown>): Promise<OpResult> {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const projPath = this.deps.projectPath(projectId);
    if (!projPath) return { error: `unknown project: ${projectId}` };

    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    const cwdArg = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd : projPath;
    const specialistName =
      typeof args.specialist === 'string' && args.specialist.trim() !== ''
        ? args.specialist.trim()
        : undefined;

    // Task shortcut: when a `goal` is given, create+assign a Task and dispatch the
    // worker Task-bound. The pane's initial input stays `prompt`; the Task carries `goal`.
    const goal =
      typeof args.goal === 'string' && args.goal.trim() !== '' ? args.goal.trim() : undefined;
    if (goal) {
      const dispatched = await this.dispatchTaskWorker({
        projectId,
        projPath,
        goal,
        prompt,
        cwd: cwdArg,
        specialistName
      });
      if ('error' in dispatched) return dispatched;
      return { result: { paneId: dispatched.paneId, taskId: dispatched.taskId } };
    }

    let extraArgs: string[] | undefined;
    if (specialistName) {
      let spec: import('../specialists/specialists').Specialist;
      try {
        spec = await this.deps.loadSpecialist(projPath, specialistName);
      } catch (err) {
        return {
          error: `could not load specialist "${specialistName}": ${err instanceof Error ? err.message : String(err)}`
        };
      }
      extraArgs = specialistLaunchArgs(spec);
    }

    // Attribute the spawned agent to the project's coordinator (task 6.5) when one
    // is driving the orchestration, so the roster shows it belongs to the coordinator.
    const coordinatorPaneId = this.deps.coordinatorFor(projectId) ?? undefined;

    const plan = buildLaunchPlan({ folder: cwdArg, prompt, placement: 'tab', projectId });
    const paneId = this.deps.launch({
      ...plan,
      specialist: specialistName,
      extraArgs,
      coordinatorPaneId
    });
    if (!paneId) return { error: 'failed to launch agent' };
    return { result: { paneId, specialist: specialistName ?? null } };
  }

  // ── Coordinator task tools (task group 6) ──────────────────────────────────
  //
  // A Task is the first-class unit of coordination (design D1/D4), DISTINCT from the
  // pane that runs it. `assign_task` and the `spawn_agent(goal)` shortcut both funnel
  // through `dispatchTaskWorker` — the single seam that creates a Task, dispatches a
  // Task-bound worker (back-channel MCP + Task id stamped + prompt contract), and binds
  // the Task to that pane. `list_tasks`/`get_task` are project-scoped board reads so the
  // coordinator can plan off the board.

  /**
   * `assign_task({ goal, specialist?, projectId })`: create a Task for `goal`, spawn a
   * worker (composed from the specialist when given), bind the Task to that worker as its
   * assignee, dispatch it with the back-channel toolset + Task id, and return
   * `{ taskId, paneId }`. The worker's initial input IS the goal (no separate prompt).
   */
  private async assignTask(args: Record<string, unknown>): Promise<OpResult> {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const projPath = this.deps.projectPath(projectId);
    if (!projPath) return { error: `unknown project: ${projectId}` };
    const goal = typeof args.goal === 'string' && args.goal.trim() !== '' ? args.goal.trim() : '';
    if (!goal) return { error: 'missing goal' };
    const specialistName =
      typeof args.specialist === 'string' && args.specialist.trim() !== ''
        ? args.specialist.trim()
        : undefined;

    const dispatched = await this.dispatchTaskWorker({
      projectId,
      projPath,
      goal,
      // assign_task has no separate prompt — the goal IS the worker's initial input.
      prompt: goal,
      cwd: projPath,
      specialistName
    });
    if ('error' in dispatched) return dispatched;
    return { result: { taskId: dispatched.taskId, paneId: dispatched.paneId } };
  }

  /**
   * `list_tasks({ state?, projectId })`: the project's Tasks (optionally filtered by
   * `state`), so the coordinator can plan off the board. Project-scoped.
   */
  private listTasksOp(args: Record<string, unknown>): OpResult {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const state =
      typeof args.state === 'string' && args.state.trim() !== ''
        ? (args.state.trim() as TaskState)
        : undefined;
    return { result: { tasks: this.deps.listTasks(projectId, state) } };
  }

  /**
   * `get_task({ id, projectId })`: a single Task's details, or a structured error when
   * absent (a Task in another project resolves to null here — project-scoped `getTask`).
   */
  private getTaskOp(args: Record<string, unknown>): OpResult {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const id = typeof args.id === 'string' && args.id.trim() !== '' ? args.id.trim() : '';
    if (!id) return { error: 'missing task id' };
    const task = this.deps.getTask(projectId, id);
    if (!task) return { error: `no such task: ${id} (project ${projectId})` };
    return { result: task };
  }

  /**
   * Shared dispatch seam for `assign_task` + `spawn_agent(goal)`: create a Task, launch a
   * Task-bound worker via the group-7 launch wiring (back-channel MCP attached, Task id
   * stamped into env, prompt contract appended — composed WITH the specialist persona
   * when one is named), and bind the Task to the launched pane as its assignee (persisted
   * via the board). The Task is put on the board ONLY after a successful launch, already
   * bound, so a failed launch never leaves an orphan Task. Returns `{ taskId, paneId }`
   * or a structured error.
   */
  private async dispatchTaskWorker(opts: {
    projectId: string;
    projPath: string;
    goal: string;
    prompt: string;
    cwd: string;
    specialistName?: string;
  }): Promise<{ taskId: string; paneId: string } | { error: string }> {
    const { projectId, projPath, goal, prompt, cwd, specialistName } = opts;

    // Resolve the specialist DEFINITION when one is named — the same load path
    // `spawn_agent` uses (its persona/model/tools compose into the worker launch).
    let spec: import('../specialists/specialists').Specialist | undefined;
    if (specialistName) {
      try {
        spec = await this.deps.loadSpecialist(projPath, specialistName);
      } catch (err) {
        return {
          error: `could not load specialist "${specialistName}": ${err instanceof Error ? err.message : String(err)}`
        };
      }
    }

    // Resolve the installed back-channel adapter + control socket (same memoized
    // round-trip the coordinator launch uses). Without them the back-channel can't attach.
    const paths = await this.deps.usagePaths();
    if (!paths) return { error: 'orchestration toolkit unavailable (could not resolve usage paths)' };

    // Mint the Task (assigned) so its id can be stamped into the worker launch. It is
    // NOT put on the board yet — only after a successful launch, already bound (below).
    const task = newTask({ goal, projectId, now: Date.now(), specialist: specialistName ?? null });

    // Compose the Task-bound worker launch via the group-7 seam: back-channel MCP config
    // (control socket + Task id + project scope), Task id + prompt contract, and the
    // specialist persona/model/tools when given.
    const mcpConfig = buildBackChannelMcpConfig(
      paths.backChannelAdapterPath,
      paths.controlSocketPath,
      task.id,
      projectId
    );
    const extraArgs = taskWorkerLaunchArgs({ mcpConfig, taskId: task.id, specialist: spec ?? null });

    // Attribute the worker to the project's coordinator (task 6.5) when one is driving.
    const coordinatorPaneId = this.deps.coordinatorFor(projectId) ?? undefined;

    const plan = buildLaunchPlan({ folder: cwd, prompt, placement: 'tab', projectId, taskId: task.id });
    const paneId = this.deps.launch({
      ...plan,
      specialist: specialistName,
      extraArgs,
      coordinatorPaneId
    });
    if (!paneId) return { error: 'failed to launch agent' };

    // Bind the Task to its worker pane (assignee) and put it on the board (persisted).
    this.deps.upsertTask({ ...task, assigneePaneId: paneId, updatedAt: Date.now() });

    return { taskId: task.id, paneId };
  }

  /**
   * `message_agent({ paneId, text, projectId })`: deliver `text` to the target
   * pane's PTY, gated on the target being idle (task 4.6). A busy target is
   * retried on a bounded poll; persistent busyness returns a `busy` error.
   */
  private messageAgent(args: Record<string, unknown>): Promise<OpResult> {
    const resolved = this.resolveTarget(args);
    if ('error' in resolved) return Promise.resolve(resolved);
    const paneId = resolved.pane.paneId;
    const text = typeof args.text === 'string' ? args.text : '';

    return new Promise<OpResult>((resolve) => {
      const deadline = Date.now() + BUSY_WAIT_MS;
      const attempt = () => {
        // Re-check existence each attempt — the pane could close while we wait.
        const still = this.deps.locate(paneId);
        if (!still || still.session.closed === true) {
          resolve({ error: `agent pane is no longer available: ${paneId}` });
          return;
        }
        // A pane sitting on an interactive AskUserQuestion/permission menu derives
        // status `waiting` (not `working`), so it would pass the busy-gate below — but
        // writing free text + Enter into that menu selects a garbage option and
        // corrupts the transcript. Refuse rather than deliver into a live menu.
        if (this.deps.readActivity(paneId).question != null) {
          resolve({ error: `agent is awaiting a question; message not delivered: ${paneId}` });
          return;
        }
        if (this.deps.statusOf(paneId) === 'working') {
          if (Date.now() >= deadline) {
            resolve({ error: `agent is busy (mid-turn); message not delivered: ${paneId}` });
            return;
          }
          this.deps.schedule(attempt, BUSY_POLL_MS);
          return;
        }
        const ok = this.deps.sendToPane(paneId, text);
        resolve(ok ? { result: { delivered: true } } : { error: `no live session for agent: ${paneId}` });
      };
      attempt();
    });
  }

  /** `read_agent({ paneId, projectId })`: return the agent's recent output/activity. */
  private readAgent(args: Record<string, unknown>): OpResult {
    const resolved = this.resolveTarget(args);
    if ('error' in resolved) return resolved;
    const paneId = resolved.pane.paneId;
    const act = this.deps.readActivity(paneId);
    return {
      result: {
        paneId,
        status: this.deps.statusOf(paneId),
        summary: act.summary,
        messages: act.messages,
        question: act.question,
        contextPct: act.contextPct
      }
    };
  }

  /** `list_agents({ projectId })`: every claude pane in the project (incl. user-started). */
  private listAgents(args: Record<string, unknown>): OpResult {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    // Exclude coordinator panes: a coordinator orchestrates specialists and normal
    // sessions, never other coordinators or itself.
    const agents = this.deps
      .panesInProject(projectId)
      .filter((p) => p.session.role !== 'coordinator')
      .map((p) => this.infoFor(p));
    return { result: { agents } };
  }

  /** `inspect_agent({ paneId, projectId })`: a single agent's identity + state. */
  private inspectAgent(args: Record<string, unknown>): OpResult {
    const resolved = this.resolveTarget(args);
    if ('error' in resolved) return resolved;
    return { result: this.infoFor(resolved.pane) };
  }

  /** `archive_agent({ paneId, projectId })`: archive the pane (existing close path). */
  private archiveAgent(args: Record<string, unknown>): OpResult {
    const resolved = this.resolveTarget(args);
    if ('error' in resolved) return resolved;
    this.deps.archive(resolved.pane.paneId);
    return { result: { archived: true } };
  }

  /**
   * `unarchive_agent({ paneId, projectId })`: restore an archived pane. Unlike the
   * other ops the target IS expected to be closed, so we scope/exist-check by hand
   * here (resolveTarget rejects closed panes).
   */
  private unarchiveAgent(args: Record<string, unknown>): OpResult {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const paneId = typeof args.paneId === 'string' ? args.paneId : '';
    if (!paneId) return { error: 'missing paneId' };
    const pane = this.deps.locate(paneId);
    if (!pane) return { error: `no such agent pane: ${paneId}` };
    if (pane.session.program !== 'claude') return { error: `not an agent pane: ${paneId}` };
    if (pane.session.role === 'coordinator') {
      return { error: `cannot target a coordinator pane: ${paneId}` };
    }
    if ((pane.session.projectId ?? null) !== projectId) {
      return { error: `agent pane is outside the orchestrator's project: ${paneId}` };
    }
    this.deps.unarchive(paneId);
    return { result: { unarchived: true } };
  }

  /**
   * `request_user_input({ message?, projectId })`: the COORDINATOR explicitly signals
   * it needs the user (tasks 10.11–10.12). Resolve the project's live coordinator pane
   * and SET its reactive "needs input" flag (with the optional `message`) so the
   * roster surfaces it in the Needs-you lane — bypassing the coordinator's default
   * keep-working heuristic. Errors when the project has no live coordinator pane.
   */
  private requestUserInput(args: Record<string, unknown>): OpResult {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const coordinatorPaneId = this.deps.coordinatorFor(projectId);
    if (!coordinatorPaneId) {
      return { error: `no live coordinator pane for project: ${projectId}` };
    }
    const message =
      typeof args.message === 'string' && args.message.trim() !== '' ? args.message.trim() : null;
    this.deps.setCoordinatorNeedsInput(coordinatorPaneId, message);
    return { result: { notified: true, paneId: coordinatorPaneId } };
  }

  // ── Worker back-channel reports (task group 5) ─────────────────────────────
  //
  // The executor is the SINGLE WRITER of Task state (design D1 / D8): every worker
  // report is validated (project + Task scope, fail-closed), applied as a lifecycle
  // transition via the board, and — for done/blocked/ask — surfaced to the
  // coordinator via `notifyCoordinator` (a group-8 stub for now). `report_done` is
  // the ONLY path that reaches the terminal `done` state (design D6): a worker's
  // Stop/idle is never treated as completion, and the only other terminal edge is
  // the lost-assignee reconcile to `failed` (see `reconcileOnPaneExit`).

  /**
   * Validate a back-channel report's scope: the orchestrator `projectId` must be
   * present AND a Task with `args.taskId` must exist IN THAT PROJECT. A Task in
   * another project resolves to null here (getTask is project-scoped), so a
   * cross-project report fails closed — mirroring the pane `projectId` guard.
   */
  private resolveTask(
    args: Record<string, unknown>
  ): { projectId: string; task: Task } | { error: string } {
    const projectId = this.orchestratorProject(args);
    if (!projectId) return { error: 'missing orchestrator projectId in args (scope required)' };
    const taskId =
      typeof args.taskId === 'string' && args.taskId.trim() !== '' ? args.taskId.trim() : '';
    if (!taskId) return { error: 'missing taskId' };
    const task = this.deps.getTask(projectId, taskId);
    if (!task) return { error: `no such task: ${taskId} (project ${projectId})` };
    return { projectId, task };
  }

  /**
   * Move a non-terminal Task to `working` so a subsequent working→X edge is legal.
   * `working` is reachable from every other non-terminal state (assigned / blocked /
   * input-required), so a worker that reports (done/blocked/ask/progress) from any of
   * them is normalized here first. A Task already `working` is returned unchanged.
   * Callers MUST reject terminal Tasks before calling (see the handlers' guards).
   */
  private ensureWorking(projectId: string, task: Task): Task {
    if (task.state === 'working') return task;
    return this.deps.transitionTask(projectId, task.id, 'working', { updatedAt: Date.now() });
  }

  /**
   * `report_progress({ taskId, projectId, note })`: append a progress note and keep
   * the Task `working`. Board-only — it deliberately does NOT notify the coordinator
   * (design "progress is board-only to avoid nagging"; spec agent-back-channel).
   */
  private reportProgress(args: Record<string, unknown>): OpResult {
    const resolved = this.resolveTask(args);
    if ('error' in resolved) return resolved;
    const { projectId, task } = resolved;
    if (TERMINAL_STATES.has(task.state)) {
      return { error: `task ${task.id} is already terminal (${task.state})` };
    }
    const note = typeof args.note === 'string' ? args.note : '';
    this.ensureWorking(projectId, task);
    this.deps.addNote(projectId, task.id, note, Date.now());
    return { result: { ok: true, taskId: task.id, state: 'working' } };
  }

  /**
   * `report_done({ taskId, projectId, result, artifacts? })`: the AUTHORITATIVE
   * completion signal (design D6). Records the result — inline when short, else
   * written by reference to `.agent-desktop/artifacts/<taskId>/` with a short inline
   * summary kept (design D7) — then transitions the Task to the terminal `done`
   * state and notifies the coordinator. This is the ONLY path that sets `done`.
   */
  private async reportDone(args: Record<string, unknown>): Promise<OpResult> {
    const resolved = this.resolveTask(args);
    if ('error' in resolved) return resolved;
    const { projectId, task } = resolved;
    if (TERMINAL_STATES.has(task.state)) {
      return { error: `task ${task.id} is already terminal (${task.state})` };
    }
    const result = typeof args.result === 'string' ? args.result : '';
    const extraArtifacts = Array.isArray(args.artifacts)
      ? args.artifacts.filter((a): a is string => typeof a === 'string')
      : [];

    let inlineResult = result;
    let artifacts = [...task.artifacts, ...extraArtifacts];
    if (needsArtifact(result)) {
      const projPath = this.deps.projectPath(projectId);
      if (projPath) {
        try {
          const rel = await this.deps.writeArtifact(projPath, task.id, 'result.md', result);
          artifacts = [...artifacts, rel];
          inlineResult = summarizeResult(result, rel);
        } catch {
          // Artifact write failed — keep a truncated inline result so completion is
          // never blocked on disk I/O (the board is the durable record either way).
          inlineResult = result.slice(0, RESULT_INLINE_MAX);
        }
      } else {
        inlineResult = result.slice(0, RESULT_INLINE_MAX);
      }
    }

    this.ensureWorking(projectId, task);
    const done = this.deps.transitionTask(projectId, task.id, 'done', {
      result: inlineResult,
      artifacts,
      updatedAt: Date.now()
    });
    this.notifyCoordinator(done, 'done');
    return { result: { ok: true, taskId: task.id, state: 'done', artifacts } };
  }

  /**
   * `report_blocked({ taskId, projectId, reason })`: transition the Task to `blocked`,
   * record the reason, and notify the coordinator so it can act (spec).
   */
  private reportBlocked(args: Record<string, unknown>): OpResult {
    const resolved = this.resolveTask(args);
    if ('error' in resolved) return resolved;
    const { projectId, task } = resolved;
    if (TERMINAL_STATES.has(task.state)) {
      return { error: `task ${task.id} is already terminal (${task.state})` };
    }
    const reason = typeof args.reason === 'string' ? args.reason : '';
    this.ensureWorking(projectId, task);
    const blocked = this.deps.transitionTask(projectId, task.id, 'blocked', {
      blockedReason: reason,
      updatedAt: Date.now()
    });
    this.notifyCoordinator(blocked, 'blocked');
    return { result: { ok: true, taskId: task.id, state: 'blocked' } };
  }

  /**
   * `ask_coordinator({ taskId, projectId, question })`: record the question, move the
   * Task to `input-required`, and notify the coordinator so it can answer via its
   * existing agent-messaging tool. Plumbing only — no user escalation, no
   * `AskUserQuestion` interception (spec; that governance is Phase 2).
   */
  private askCoordinator(args: Record<string, unknown>): OpResult {
    const resolved = this.resolveTask(args);
    if ('error' in resolved) return resolved;
    const { projectId, task } = resolved;
    if (TERMINAL_STATES.has(task.state)) {
      return { error: `task ${task.id} is already terminal (${task.state})` };
    }
    const question = typeof args.question === 'string' ? args.question : '';
    this.ensureWorking(projectId, task);
    const asked = this.deps.transitionTask(projectId, task.id, 'input-required', {
      question,
      updatedAt: Date.now()
    });
    this.notifyCoordinator(asked, 'ask');
    return { result: { ok: true, taskId: task.id, state: 'input-required' } };
  }

  /**
   * LOST-ASSIGNEE RECONCILIATION (task 5.3 / design D7): when a worker pane exits or
   * errors, any non-terminal Task assigned to it is reconciled to `failed` with a
   * reason, rather than being left stuck in a non-terminal state forever. This is the
   * ONLY non-`report_done` terminal edge — a Stop/idle is never completion (D6); a
   * lost assignee is a failure.
   *
   * This is the single-writer seam the app's existing pane-exit signal drives (the
   * PTY-exit path in `TerminalPane.svelte` → `runtime.noteExit`). It resolves the
   * pane's project via the read-only `locate` dep, so it must be called while the
   * pane is still registered. Idempotent: a terminal Task, or a pane with no
   * assigned Task, is a no-op.
   *
   * TODO(wiring): the app should invoke `executor.reconcileOnPaneExit(paneId)` from
   * the pane-exit path (alongside `noteExit`); that one-line wiring lives outside
   * this task's edit scope (executor + its test only).
   */
  reconcileOnPaneExit(paneId: string, reason = 'assignee pane exited'): void {
    const projectId = this.deps.locate(paneId)?.session.projectId ?? null;
    if (!projectId) return;
    for (const task of this.deps.listTasks(projectId)) {
      if (task.assigneePaneId !== paneId) continue;
      if (TERMINAL_STATES.has(task.state)) continue;
      this.deps.transitionTask(projectId, task.id, 'failed', {
        blockedReason: reason,
        updatedAt: Date.now()
      });
    }
  }

  /**
   * PUSH-WHEN-IDLE coordinator notification (task group 8; design D5 / spec "Reports
   * push to the coordinator when it is idle"). On a report warranting action
   * (`done`/`blocked`/`ask`) inject a compact structured line into the project
   * coordinator's pane, reusing the SAME idle gate `message_agent` uses (skip a
   * mid-turn/`working` target; refuse a target sitting on a live AskUserQuestion menu
   * so free text never garbles it).
   *
   * BEST-EFFORT, unlike `message_agent`: this never blocks and never errors. When the
   * project has no live coordinator pane, or the coordinator is busy / can't cleanly
   * accept input right now, the injection is simply SKIPPED — the Task board is the
   * durable record and the coordinator reconciles via `list_tasks`/`get_task` on its
   * next turn (spec "Busy coordinator relies on the durable board"; the Task state
   * change is already applied by the caller and is never lost by a dropped push). Any
   * unexpected error is swallowed so a notification failure can never fail the report.
   *
   * Deliberately NOT called for `report_progress` (progress is board-only, no push).
   */
  private notifyCoordinator(task: Task, kind: 'done' | 'blocked' | 'ask'): void {
    try {
      // Locate the project's LIVE coordinator pane. No coordinator → nothing to notify.
      const coordPaneId = this.deps.coordinatorFor(task.projectId);
      if (!coordPaneId) return;
      const located = this.deps.locate(coordPaneId);
      if (!located || located.session.closed === true) return;
      // Idle gate (mirrors message_agent, best-effort): a coordinator sitting on a live
      // AskUserQuestion/permission menu must not receive free text (it would select a
      // garbage option), and a mid-turn (`working`) coordinator can't cleanly accept
      // input — defer in both cases (the board carries the change).
      if (this.deps.readActivity(coordPaneId).question != null) return;
      if (this.deps.statusOf(coordPaneId) === 'working') return;
      this.deps.sendToPane(coordPaneId, coordinatorNotice(task, kind));
    } catch (err) {
      // Never let a notification failure escape into the report handler.
      console.debug(`[task ${task.id}] notifyCoordinator(${kind}) skipped:`, err);
    }
  }

  /** Build the `AgentInfo` for a located pane. */
  private infoFor(pane: LocatedPane): AgentInfo {
    return {
      paneId: pane.paneId,
      // Prefer the generated session title (the card's label) so the orchestrator
      // refers to "Fix login dialog" rather than "Session 1"; fall back to the
      // workspace/cwd name when the agent has no title yet.
      name: this.deps.titleOf(pane.paneId) ?? nameFor(pane),
      cwd: pane.session.cwd,
      projectId: pane.session.projectId ?? null,
      status: this.deps.statusOf(pane.paneId),
      archived: pane.session.closed === true,
      specialist: pane.session.specialist ?? null
    };
  }
}

/** Max chars of a large `report_done` result kept inline as a preview alongside its
 *  artifact reference (the full text lives on disk — see {@link needsArtifact}). */
const RESULT_SUMMARY_PREVIEW = 200;

/** A short inline summary for a by-reference result: a leading preview + the path. */
function summarizeResult(result: string, relPath: string): string {
  const preview = result.slice(0, RESULT_SUMMARY_PREVIEW).trim();
  return `${preview}… (full result stored at ${relPath})`;
}

/** Max chars of the free-text tail (result/reason/question) kept in a coordinator
 *  push line — the push is a terse nudge; the full detail lives on the Task board. */
const COORD_NOTICE_MAX = 200;

/** Collapse newlines/runs of whitespace to single spaces, trim, and truncate to
 *  `max` (with an ellipsis) so a pushed line stays compact and single-line. */
function compactOneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/**
 * Build the compact, single-line coordinator push for a report (task group 8):
 *   done    → `[task <id>] <specialist|worker> reported DONE — result: <resultRefOrSummary>`
 *   blocked → `[task <id>] BLOCKED — <reason>`
 *   ask     → `[task <id>] QUESTION — <question>`
 * The free-text tail is flattened + truncated (see {@link compactOneLine}); the board
 * holds the full detail. Pure: depends only on its inputs.
 */
function coordinatorNotice(task: Task, kind: 'done' | 'blocked' | 'ask'): string {
  switch (kind) {
    case 'done': {
      const who = task.specialist ?? 'worker';
      const result = compactOneLine(task.result ?? '', COORD_NOTICE_MAX) || '(no result)';
      return `[task ${task.id}] ${who} reported DONE — result: ${result}`;
    }
    case 'blocked':
      return `[task ${task.id}] BLOCKED — ${compactOneLine(task.blockedReason ?? '', COORD_NOTICE_MAX)}`;
    case 'ask':
      return `[task ${task.id}] QUESTION — ${compactOneLine(task.question ?? '', COORD_NOTICE_MAX)}`;
  }
}

/** Coerce an unknown args value into a plain object (null/non-object → {}). */
function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Display name for a located pane: workspace name, else cwd leaf, else paneId. */
function nameFor(pane: LocatedPane): string {
  const entry = workspace.workspaces.find((w) => w.id === pane.workspaceId);
  const wsName = entry?.name?.trim();
  if (wsName) return wsName;
  const cwd = pane.session.cwd;
  if (cwd) {
    const leaf = cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    if (leaf) return leaf;
  }
  return pane.paneId;
}

// ── Real-store dependency bindings ───────────────────────────────────────────

/** Locate a pane by id across all live workspaces. */
function locateReal(paneId: string): LocatedPane | null {
  for (const entry of workspace.workspaces) {
    const session = entry.registry[paneId];
    if (!session) continue;
    if (leavesInOrder(entry.ws.root).some((l) => l.paneId === paneId)) {
      return { workspaceId: entry.id, paneId, session };
    }
  }
  return null;
}

/** Every `claude` pane in `projectId` across all workspaces (incl. archived + user-started). */
function panesInProjectReal(projectId: string): LocatedPane[] {
  const out: LocatedPane[] = [];
  for (const entry of workspace.workspaces) {
    for (const leaf of leavesInOrder(entry.ws.root)) {
      const session = entry.registry[leaf.paneId];
      if (!session || session.program !== 'claude') continue;
      if ((session.projectId ?? null) !== projectId) continue;
      out.push({ workspaceId: entry.id, paneId: leaf.paneId, session });
    }
  }
  return out;
}

/** Effective status: event-sourced when available, PTY heuristic otherwise (mirrors roster). */
function statusOfReal(paneId: string): AgentStatus {
  const session = locateReal(paneId)?.session;
  if (session?.closed === true) return 'finished';
  const runtime = getRuntime(paneId);
  const ptyStatus = deriveStatus(runtime, Date.now());
  if (runtime?.exited) return ptyStatus;
  return events.activityFor(paneId).status ?? ptyStatus;
}

/** Read recent activity (summary + recent messages + pending question) for a pane. */
function readActivityReal(paneId: string) {
  const a = activity.forPane(paneId);
  // The event store knows a pending AskUserQuestion IMMEDIATELY (from the
  // `PreToolUse[AskUserQuestion]` event); the transcript-polled `activity` store can lag
  // ~1-2s. Prefer whichever has it so the `message_agent` question-gate closes the
  // menu-garble window without waiting on the next transcript poll.
  const question = a.question ?? events.activityFor(paneId).question ?? null;
  return {
    summary: a.summary ?? null,
    messages: Array.isArray(a.messages) ? a.messages : [],
    question,
    contextPct: typeof a.contextPct === 'number' ? a.contextPct : null
  };
}

/** Resolve a project's folder path by id. */
function projectPathReal(projectId: string): string | null {
  return projectForId(projects.list, projectId)?.path ?? null;
}

/** The paneId of the project's LIVE coordinator (role:'coordinator', not closed), or
 *  null — so a coordinator-driven spawn is attributed to it in the roster (task 6.5). */
function coordinatorForReal(projectId: string): string | null {
  const panes: CoordinatorPaneView[] = [];
  for (const entry of workspace.workspaces) {
    for (const leaf of leavesInOrder(entry.ws.root)) {
      const s = entry.registry[leaf.paneId];
      if (!s) continue;
      panes.push({
        paneId: leaf.paneId,
        program: s.program,
        projectId: s.projectId ?? null,
        role: s.role,
        closed: s.closed
      });
    }
  }
  return findCoordinatorPane(panes, projectId)?.paneId ?? null;
}

/** Load + parse a specialist `.md` by name within a project path. */
async function loadSpecialistReal(projectPath: string, name: string) {
  const raw = await invoke<string>('specialists_read', { projectPath, name });
  return parseSpecialist(raw);
}

/** The default deps, bound to the real stores + Tauri commands. */
function realDeps(): ExecutorDeps {
  return {
    reply: (id, outcome) => {
      void invoke('orchestration_reply', {
        id,
        result: 'result' in outcome ? outcome.result : undefined,
        error: 'error' in outcome ? outcome.error : undefined
      }).catch((e) => console.warn('orchestration_reply failed:', e));
    },
    locate: locateReal,
    panesInProject: panesInProjectReal,
    statusOf: statusOfReal,
    readActivity: readActivityReal,
    sendToPane: (paneId, text) => getTerminal(paneId)?.send(text) ?? false,
    projectPath: projectPathReal,
    loadSpecialist: loadSpecialistReal,
    launch: (plan) => workspace.launch(plan),
    coordinatorFor: coordinatorForReal,
    usagePaths: () => getUsagePaths(),
    archive: (paneId) => workspace.closeAgent(paneId),
    unarchive: (paneId) => workspace.restoreAgent(paneId),
    schedule: (run, ms) => {
      setTimeout(run, ms);
    },
    setCoordinatorNeedsInput: (paneId, message) => coordinatorNeedsInput.set(paneId, message),
    titleOf: (paneId) => titles.titleFor(paneId),
    getTask: (projectId, taskId) => taskBoard.getTask(projectId, taskId),
    listTasks: (projectId, state) => taskBoard.listTasks(projectId, state),
    upsertTask: (task) => taskBoard.upsert(task),
    addNote: (projectId, taskId, text, ts) => taskBoard.addNote(projectId, taskId, text, ts),
    transitionTask: (projectId, taskId, to, patch) =>
      taskBoard.transition(projectId, taskId, to, patch),
    writeArtifact: (projectPath, taskId, name, content) =>
      invoke<string>('coordinator_tasks_write_artifact', { projectPath, taskId, name, content })
  };
}

// Note `specialists` is imported only so the real-deps wiring shares the same
// store family as the panel; the executor reads specialists via `specialists_read`
// directly (the active-project store may be loaded for a DIFFERENT project than the
// orchestrator's, so we never rely on its in-memory list for scoping).
void specialists;

/** The singleton executor, wired to the real stores. The app starts/stops it. */
export const executor = new OrchestrationExecutor(realDeps());
