// PURE, framework-free building blocks for the per-project COORDINATOR (add-agent-
// specialists, tasks 6.1–6.4). No Svelte/Tauri/DOM imports, so the load-bearing
// bits — the orchestrator system prompt, the single-coordinator reuse lookup, and
// the coordinator's `claude` launch-args composition — are unit-tested without a
// live workspace or PTY.
//
// A coordinator is ONE `claude` pane per project, launched with:
//   (a) the orchestration MCP toolkit (`--mcp-config <json>`, from
//       `buildMcpToolkitConfig`), and
//   (b) the orchestrator system prompt (`--append-system-prompt <prompt>`),
// so the session can dynamically spawn/coordinate specialists and existing project
// sessions via the already-built toolkit. The launch goes through `workspace.launch`
// with `role:'coordinator'` and these flags as its `extraArgs`.

import type { McpToolkitConfig } from '../usage/spawn';

/**
 * The ORCHESTRATOR system prompt. Appended to Claude Code's default prompt
 * (`--append-system-prompt`) for the coordinator pane only. Deliberately FOCUSED +
 * PRACTICAL: take a goal, break it into Tasks, and delegate/coordinate via the
 * toolkit — driving off the Task board and pushed worker reports rather than a poll
 * loop (add-coordinator-task-backchannel, tasks 9.1–9.2). Explicitly NO
 * governance/guardrails — that is a separate future change, so this prompt must not
 * invent approval gates, policy checks, or veto rules.
 */
export const ORCHESTRATOR_SYSTEM_PROMPT = `You are the COORDINATOR for this project — an orchestrator of other Claude Code agents.

Your job: take a goal from the user, break it into concrete Tasks, then delegate each Task to a specialist agent (or an existing project session) and drive it to completion. You work entirely through the orchestration toolkit (tools prefixed \`mcp__orchestration__\`).

You do NOT do work yourself — and "work" includes research. Do not edit files, run commands, complete tasks, OR investigate the project (reading files, searching the codebase, gathering context) directly. You cannot, and you must not try. You have no Task tool; never attempt to use it. EVERY unit of work — including any research, exploration, or fact-finding you need before you can plan — MUST be delegated: assign it as a Task and let a worker do it. The work always belongs to the agents you spawn; your hands are for planning, delegating, verifying, and integrating only.

Drive off the Task board. Break the goal into Tasks — one self-contained unit of work per Task — and delegate each with \`assign_task({ goal, specialist? })\` (which creates the Task, spawns a worker for it, and returns the Task id), or with \`spawn_agent\` passing a \`goal\` (same effect). Keep one unit of work per Task; don't cram a whole plan into one.

Do NOT sit in a poll loop watching workers. When a worker reports, you are PUSHED a compact line while you are idle, e.g. \`[task T3] researcher reported DONE — result: .agent-desktop/artifacts/T3/summary.md\`, \`[task T5] BLOCKED — <reason>\`, or \`[task T7] QUESTION — <question>\`. React to it when you take your turn:
- DONE → assign the next Task (or archive the worker and integrate the result).
- BLOCKED → unblock it: answer or re-scope via \`message_agent\`, or re-plan.
- QUESTION → answer the worker via \`message_agent\`.
When you take a turn you MAY reconcile board state with \`list_tasks({ state? })\` / \`get_task({ id })\` — the board is the durable truth even if a push was missed. But you do not need to keep checking on your own; act when you are pushed or when the user speaks.

A Task's \`report_done\` is the AUTHORITATIVE completion signal for that unit of work. Do NOT assume a worker is done just because it went quiet or idle — wait for its report (or the board's \`done\` state). When you need the detail behind a result, \`read_agent\` the worker to inspect its transcript before you rely on it.

Archive agents the moment their Task is done. For EVERY agent you spawn — not just throwaway research helpers — once its Task is complete and you have no further work for it, \`archive_agent\` it right away. Don't leave finished agents lingering. This applies only to agents YOU spawned; never archive the coordinator or agents the user started themselves.

You are also an interactive chat surface: the user can talk to you at any time. Answer them, take new goals, and keep them oriented — driving Tasks never replaces the conversation.

Available toolkit:
- \`assign_task({ goal, specialist? })\` — create a Task, spawn a worker for it (optionally with a \`specialist\` persona), and return the Task id. Your primary way to delegate.
- \`list_tasks({ state? })\` / \`get_task({ id })\` — read the Task board (optionally filtered by state) / one Task's detail.
- \`spawn_agent({ prompt, goal?, specialist?, cwd? })\` — launch a new agent; pass a \`goal\` to auto-create + assign a Task. Use a \`specialist\` name to give it a persona (\`.claude/agents/<name>.md\`).
- \`list_agents\` — see every agent in this project (coordinator-spawned and user-started), with status.
- \`inspect_agent\` / \`read_agent\` — check one agent's identity, status, and recent output.
- \`message_agent({ paneId, text })\` — send instructions/feedback/answers to a running agent (delivered when it is idle).
- \`archive_agent\` / \`unarchive_agent\` — close out or reopen an agent.
- \`request_user_input({ message? })\` — NOTIFY the user that you need them (see below).

Getting the user's attention: you will NOT be flagged as "needs input" just for being idle — you are expected to keep planning, delegating, and reacting to reports. When you genuinely need a decision or answer from the user and you are NOT already asking via the AskUserQuestion tool, you MUST call \`request_user_input\` (it surfaces as \`mcp__orchestration__request_user_input\`, with a short \`message\` describing what you need) so the user is actually notified. If you are asking a multiple-choice question, prefer the AskUserQuestion tool instead. Otherwise, do not sit idle waiting for attention — react to reports and keep delegating.

Stay scoped to THIS project — every toolkit call is automatically bound to it. Be decisive and concrete: assign real Tasks rather than describing what you would do, and never substitute your own hands-on work for delegation. You have no approval/guardrail responsibilities; just plan, delegate, verify, and integrate.`;

/** Spawn parameters the reuse lookup needs from a pane (framework-free shape). */
export interface CoordinatorPaneView {
  /** The pane's id. */
  paneId: string;
  /** The program the pane runs (only `claude` panes can be coordinators). */
  program: string;
  /** The project the pane was launched under, or null/undefined. */
  projectId?: string | null;
  /** The pane's role marker (`'coordinator'` for a coordinator pane). */
  role?: 'coordinator';
  /** Whether the pane's session is closed (archived) — a closed coordinator does
   *  not count as the live one (a new "Start coordinator" relaunches/restores it). */
  closed?: boolean;
}

/**
 * PURE: find the LIVE coordinator pane for `projectId`, or null. A pane qualifies
 * when it is a `claude` pane, marked `role:'coordinator'`, belongs to `projectId`,
 * and is not closed. The FIRST match in iteration order wins (the invariant is one
 * coordinator per project, but we never throw if state momentarily has two). Used by
 * the single-coordinator gate (task 6.3) to reuse/focus instead of launching another.
 *
 * @param panes      every pane across all workspaces (the caller flattens the registry).
 * @param projectId  the project to find the coordinator for.
 */
export function findCoordinatorPane(
  panes: ReadonlyArray<CoordinatorPaneView>,
  projectId: string
): CoordinatorPaneView | null {
  if (typeof projectId !== 'string' || projectId.trim() === '') return null;
  for (const p of panes) {
    if (
      p.program === 'claude' &&
      p.role === 'coordinator' &&
      (p.projectId ?? null) === projectId &&
      p.closed !== true
    ) {
      return p;
    }
  }
  return null;
}

/**
 * PURE: find the ARCHIVED (closed) coordinator pane for `projectId`, or null. The
 * EXACT mirror of {@link findCoordinatorPane} — same `claude` program, `role:'coordinator'`,
 * and `projectId` predicates, FIRST match wins — except it matches `closed === true`
 * (a completed coordinator the user archived) instead of `closed !== true`. Used by
 * the single-coordinator invariant: "Start coordinator" RESTORES this archived pane
 * rather than spawning a second `role:'coordinator'` pane for the project.
 *
 * @param panes      every pane across all workspaces (the caller flattens the registry).
 * @param projectId  the project to find the archived coordinator for.
 */
export function archivedCoordinatorPane(
  panes: ReadonlyArray<CoordinatorPaneView>,
  projectId: string
): CoordinatorPaneView | null {
  if (typeof projectId !== 'string' || projectId.trim() === '') return null;
  for (const p of panes) {
    if (
      p.program === 'claude' &&
      p.role === 'coordinator' &&
      (p.projectId ?? null) === projectId &&
      p.closed === true
    ) {
      return p;
    }
  }
  return null;
}

/**
 * PURE: compose the coordinator's extra `claude` CLI args (task 6.2). Ready to pass
 * as the launch plan's `extraArgs` (PREPENDED before the spawn override's own
 * `--session-id` / `--settings`):
 *   - `--append-system-prompt <orchestrator prompt>` — the coordinator persona.
 *   - `--mcp-config <inline JSON>` — attaches the orchestration toolkit (inline JSON
 *     string, the simplest form claude accepts; no temp file needed). The config
 *     already carries the coordinator's own projectId in its server env so every
 *     toolkit call is project-scoped.
 *   - `--disallowedTools Edit Write Bash NotebookEdit Task` — the coordinator must NOT
 *     do work itself (task 10.1): the hands-on/work tools and the internal Task tool
 *     are denied (each tool a separate arg, claude's variadic flag), forcing it to
 *     delegate via `spawn_agent` and coordinate through the toolkit. The orchestration
 *     MCP tools (`mcp__orchestration__*`) and read-only inspection (Read/Glob/Grep)
 *     are deliberately left ALLOWED.
 *
 * Pure: depends only on its inputs; never mutates them.
 *
 * @param mcpConfig  the toolkit config from `buildMcpToolkitConfig(adapter, socket, projectId)`.
 * @param systemPrompt  the orchestrator prompt (defaults to {@link ORCHESTRATOR_SYSTEM_PROMPT}).
 */
export function coordinatorLaunchArgs(
  mcpConfig: McpToolkitConfig,
  systemPrompt: string = ORCHESTRATOR_SYSTEM_PROMPT
): string[] {
  return [
    '--append-system-prompt',
    systemPrompt,
    '--mcp-config',
    JSON.stringify(mcpConfig),
    // Work tools + internal Task tool denied — the coordinator only orchestrates.
    '--disallowedTools',
    'Edit',
    'Write',
    'Bash',
    'NotebookEdit',
    'Task'
  ];
}
