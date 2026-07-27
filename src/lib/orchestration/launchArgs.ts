// PURE, framework-free composition of the `claude` CLI args that apply a SPECIALIST
// (a native `.claude/agents/<name>.md` subagent) to a freshly-spawned agent pane —
// design D4 of `add-agent-specialists`. No Svelte/Tauri/DOM imports, so the
// load-bearing flag mapping is unit-tested without a live PTY.
//
// The chosen specialist file → launch-args mapping (design D4, spike-confirmed on
// claude 2.1.168):
//   - the body (system prompt) → `--append-system-prompt <body>` (APPEND the persona
//     to Claude Code's default prompt rather than REPLACE it with `--system-prompt`,
//     so the base tool behaviour is kept).
//   - frontmatter `model` (when present + non-empty) → `--model <model>`.
//   - frontmatter `tools` (when present + non-empty) → `--allowedTools <t1> <t2> …`
//     (each tool a SEPARATE arg, matching claude's variadic `--allowedTools`).
//
// The body is omitted from the args only when it is blank (a specialist with no
// system prompt — unusual but valid); otherwise it is always passed verbatim.

import type { Specialist } from '../specialists/specialists';
import { taskContractPrompt, type BackChannelMcpConfig } from '../usage/spawn';

/**
 * Build the `claude` CLI args that apply specialist `s` to a launch. The returned
 * array is ready to PREPEND to the pane's existing args (it carries only the
 * specialist-derived flags — never `--session-id` / `--settings`, which the spawn
 * override owns). Order: append-system-prompt, then model, then allowedTools.
 *
 * Pure: depends only on `s`; never mutates it.
 */
export function specialistLaunchArgs(s: Specialist): string[] {
  const args: string[] = [];

  // The body IS the system prompt; append it (don't replace claude's default) so
  // base tooling is preserved. A blank body contributes nothing.
  const body = typeof s.prompt === 'string' ? s.prompt.trim() : '';
  if (body !== '') {
    args.push('--append-system-prompt', s.prompt);
  }

  // Optional model override.
  if (typeof s.model === 'string' && s.model.trim() !== '') {
    args.push('--model', s.model);
  }

  // Optional tool allow-list: each tool a separate arg (claude's variadic flag).
  if (Array.isArray(s.tools)) {
    const tools = s.tools.filter((t) => typeof t === 'string' && t.trim() !== '');
    if (tools.length > 0) {
      args.push('--allowedTools', ...tools);
    }
  }

  return args;
}

/**
 * PURE: extract a specialist's system-prompt body (the same rule
 * {@link specialistLaunchArgs} uses) — the trimmed-non-blank body, or `''` when the
 * specialist is absent or has a blank body. Kept private so both the specialist path
 * and the worker path agree on what "has a system prompt" means.
 */
function specialistBody(s: Specialist | null | undefined): string {
  if (!s) return '';
  return typeof s.prompt === 'string' && s.prompt.trim() !== '' ? s.prompt : '';
}

/**
 * PURE: compose the extra `claude` CLI args for a Task-dispatched WORKER (tasks 7.1–7.2).
 * This is the ADDITIVE, Task-gated launch: it is called ONLY when a worker is dispatched
 * for a Task (by the coordinator-tools group via `assign_task` / `spawn_agent(goal)`).
 * A plain user session or the coordinator never goes through here, so neither gets the
 * back-channel.
 *
 * The returned array is ready to pass as the launch plan's `extraArgs` (PREPENDED before
 * the spawn override's own `--session-id` / `--settings`). It wires three things:
 *
 *   1. `--append-system-prompt <combined>` — the Task-contract instruction
 *      ({@link taskContractPrompt}) COMPOSED WITH the specialist's own system prompt when
 *      a specialist is given: the specialist body first, then a blank line, then the
 *      contract. With no specialist (or a blank-body one) it is the contract alone. A
 *      dispatched worker ALWAYS carries the contract.
 *   2. specialist `--model` / `--allowedTools` — passed through verbatim when the
 *      specialist defines them (same mapping as {@link specialistLaunchArgs}).
 *   3. `--mcp-config <json>` — attaches the back-channel toolset (from
 *      {@link buildBackChannelMcpConfig}); its server env already carries the worker's
 *      Task id + project scope, so `AGENT_DESKTOP_TASK_ID` reaches the adapter here.
 *
 * The worker still renders as an ordinary `claude` PTY pane — this only adds flags.
 *
 * Pure: depends only on its inputs; never mutates them.
 *
 * @param opts.mcpConfig  the back-channel config from
 *   `buildBackChannelMcpConfig(backChannelAdapterPath, controlSocketPath, taskId, projectId)`.
 * @param opts.taskId     the worker's Task id (interpolated into the contract prompt).
 * @param opts.specialist optional specialist whose persona composes WITH the contract.
 */
export function taskWorkerLaunchArgs(opts: {
  mcpConfig: BackChannelMcpConfig;
  taskId: string;
  specialist?: Specialist | null;
}): string[] {
  const { mcpConfig, taskId, specialist } = opts;
  const args: string[] = [];

  // 1. Compose the system prompt: specialist body (when present) + the Task contract.
  //    The contract is ALWAYS appended for a dispatched worker; the specialist body is
  //    composed BEFORE it (blank line between) so both personas apply.
  const body = specialistBody(specialist);
  const contract = taskContractPrompt(taskId);
  const combined = body !== '' ? `${body}\n\n${contract}` : contract;
  args.push('--append-system-prompt', combined);

  // 2. Specialist model / tool-allow-list pass-through (same mapping as specialistLaunchArgs).
  if (specialist) {
    if (typeof specialist.model === 'string' && specialist.model.trim() !== '') {
      args.push('--model', specialist.model);
    }
    if (Array.isArray(specialist.tools)) {
      const tools = specialist.tools.filter((t) => typeof t === 'string' && t.trim() !== '');
      if (tools.length > 0) {
        args.push('--allowedTools', ...tools);
      }
    }
  }

  // 3. Attach the back-channel MCP toolset (inline JSON, same form the coordinator uses).
  args.push('--mcp-config', JSON.stringify(mcpConfig));

  return args;
}
