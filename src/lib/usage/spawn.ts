// PURE helper: build the per-pane PTY spawn parameters so a `claude` pane is
// launched THROUGH the app-managed statusline wrapper, while every other
// program (the login shell) spawns completely unchanged.
//
// Kept framework-free (no Svelte/Tauri imports) so it is trivially unit-tested.
// `TerminalPane.svelte` calls `buildSpawnOverride(...)` right before `pty_spawn`
// to obtain the final `{ args, env }` it forwards to the backend.
//
// Why an inline `--settings` override (design D3 / usage-dashboard spec): it
// merges per-key over the user's `~/.claude/settings.json` for THIS session
// only — overriding just `statusLine.command` — and NEVER reads, writes, or
// relocates the global config. The wrapper then (a) delegates to the user's real
// `~/.claude/hooks/statusline.js` for an unchanged in-pane bar and (b) writes a
// per-pane snapshot the dashboard watches. The two env vars
// (`AGENT_DESKTOP_PANE`, `AGENT_DESKTOP_SNAPSHOT_DIR`) reach the
// `statusLine.command` (verified, appendix A.1) so the wrapper knows which
// snapshot file to write and where.

/** Absolute paths resolved once from the `usage_paths` Tauri command. */
export interface UsagePaths {
  /** Absolute path to the installed `statusline-wrapper.js`. */
  wrapperPath: string;
  /** Absolute path to the snapshots dir. */
  snapshotDir: string;
  /**
   * Absolute path to the installed `event-hook.js` — the single hook wired into
   * every app-launched session that feeds the overview's event pipeline.
   */
  eventHookPath: string;
  /**
   * ADDRESS of the app-hosted local socket the event hook delivers to (passed to
   * the spawned process as `AGENT_DESKTOP_SOCKET_PATH`). A filesystem path on
   * macOS/Linux, a `\\.\pipe\…` name on Windows — opaque to the hook, which
   * passes it straight to `net.createConnection({ path })`.
   */
  socketPath: string;
  /**
   * Absolute path to the installed orchestration MCP adapter — `node <this>` is the
   * coordinator launch's `--mcp-config` server command (see `buildMcpToolkitConfig`).
   */
  adapterPath: string;
  /**
   * Absolute path to the installed BACK-CHANNEL MCP adapter (`back-channel-mcp.cjs`)
   * — `node <this>` is the `--mcp-config` server command for a Task-dispatched WORKER
   * (see `buildBackChannelMcpConfig`). Sibling of `adapterPath`, sharing the same
   * control socket (`controlSocketPath`). Only referenced when a worker is dispatched
   * with a Task; plain sessions and the coordinator never attach it.
   */
  backChannelAdapterPath: string;
  /**
   * Absolute path to the Rust orchestration CONTROL socket (sibling of `socketPath`)
   * — goes into the coordinator's `--mcp-config` server env as
   * `AGENT_DESKTOP_CONTROL_SOCKET` so the adapter can reach the executor.
   */
  controlSocketPath: string;
}

/** Inputs for building a pane's spawn override. */
export interface SpawnOverrideInput {
  /** The program the pane will run (`claude` is the only one we wrap). */
  program: string;
  /** The pane's existing args (preserved verbatim after any injected ones). */
  args: string[];
  /** The stable frontend pane id; becomes `AGENT_DESKTOP_PANE` + the snapshot filename key. */
  paneId: string;
  /**
   * The APP-OWNED Claude session id for this pane (a uuid generated at launch).
   * Injected as `--session-id <id>` (fresh pane) or `--resume <id>` (restored
   * pane with resume:true) so the overview can locate THIS agent's exact
   * transcript (`~/.claude/projects/<cwd>/<id>.jsonl`) — matching by cwd alone is
   * ambiguous when several sessions share a folder. Absent for non-claude panes.
   */
  sessionId?: string;
  /**
   * When `true` AND `sessionId` is set: inject `--resume <sessionId>` so the
   * restored pane continues from its prior transcript instead of starting fresh.
   * Mutually exclusive with `--session-id` — only one flag is emitted.
   * Falsey (default) keeps the existing `--session-id <sessionId>` behaviour.
   */
  resume?: boolean;
  /**
   * Resolved usage paths, or `null` if they could not be fetched. When null we
   * still inject `--session-id` / `--resume` (so activity works) but skip the
   * statusline wrapper override — a missing wrapper must never break launching a
   * session.
   */
  usagePaths: UsagePaths | null;
}

/**
 * The spawn parameters forwarded to `pty_spawn`. `env` is the optional extra
 * environment merged (caller-wins) on top of the backend's seeded base. For a
 * shell pane (or `claude` with no resolved usage paths) `env` is `undefined`
 * and `args` is unchanged, so those panes spawn exactly as before.
 */
export interface SpawnOverride {
  args: string[];
  env?: Array<[string, string]>;
}

/** The settings key we override for the per-session statusline. */
const STATUS_LINE_TYPE = 'command';

/**
 * Shell-quote an executable path for use as a claude `statusLine`/hook `command`.
 * Claude runs these commands THROUGH A SHELL, which splits on whitespace — and the
 * app installs the wrapper + hook under `~/Library/Application Support/…` (a path
 * with a SPACE). Unquoted, the shell breaks the path at the space and the script
 * silently never runs (no snapshot, no question sidecar). Wrapping in double quotes
 * (escaping the chars special inside them) makes the spaced path survive.
 */
export function quoteCommand(path: string): string {
  return `"${path.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * Build a claude `command` that runs one of our installed `.cjs` scripts.
 *
 * Explicitly invokes `node` rather than relying on the script's `#!/usr/bin/env
 * node` shebang + executable bit. Windows honors NEITHER, so a bare path there
 * never executes — and because a hook that fails to run is silent, that would
 * disable the whole event pipeline (and with it every agent's derived status)
 * with no visible error.
 *
 * Used on all platforms so there is one code path. This is not a regression on
 * Unix: the shebang was `/usr/bin/env node`, so `node` already had to be on PATH.
 */
export function nodeCommand(scriptPath: string): string {
  return `node ${quoteCommand(toNodePath(scriptPath))}`;
}

/**
 * Normalize a WINDOWS-style path (`C:\…` or a `\\server\share` UNC) to forward
 * slashes. Node accepts `/` on Windows, and this sidesteps a shell-escaping
 * mismatch: `quoteCommand` escapes `\` because that is what POSIX shells require
 * inside double quotes, but `cmd.exe` treats `\` literally — so an escaped
 * Windows path would reach the interpreter with doubled separators. That happens
 * to survive Win32 path normalization (repeated separators are collapsed), but
 * relying on that quirk is needlessly fragile.
 *
 * Only paths that actually LOOK like Windows paths are touched, so a Unix path
 * containing a literal backslash (legal, if pathological) is left alone.
 */
function toNodePath(scriptPath: string): string {
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(scriptPath) || scriptPath.startsWith('\\\\');
  return isWindowsPath ? scriptPath.replace(/\\/g, '/') : scriptPath;
}

/**
 * Build the spawn args/env for a pane.
 *
 *  - `program === 'claude'` →
 *      args = ['--session-id', <id>?,
 *              '--settings', JSON.stringify({ remoteControlAtStartup: false,
 *                disableAgentView: true,
 *                statusLine?: { type: 'command', command: <wrapperPath> } }),
 *              ...existingArgs]
 *      env  = [['AGENT_DESKTOP_PANE', paneId],
 *              ['AGENT_DESKTOP_SNAPSHOT_DIR', snapshotDir],
 *              ['AGENT_DESKTOP_SOCKET_PATH', socketPath]]  // only with usagePaths
 *  - anything else (shell panes) →
 *      args = existingArgs unchanged, env = undefined.
 *
 * The `--settings` override is ALWAYS injected for a claude pane (even with no
 * usage paths) because it carries `remoteControlAtStartup: false` and
 * `disableAgentView: true`. The user's global `remoteControlAtStartup: true`
 * otherwise hands the session to the cloud Remote-Control bridge, which writes only
 * a STUB local transcript (a `bridge-session` marker, no assistant turns /
 * `AskUserQuestion` / token usage) — starving the overview's transcript-derived
 * activity (last message, pending question, context %). Disabling it per-session
 * keeps the full transcript local so [`activity_for_panes`] can read it.
 *
 * `disableAgentView: true` turns off Claude's built-in agent view: `←←` opens it and
 * a single `←` backgrounds/detaches the session, which EXITS the local PTY — and an
 * exited session is auto-archived (deleted when empty). That view duplicates
 * agent-desktop's own agents panel, so disabling it stops an accidental arrow-key
 * keystroke from archiving a live session out from under the user.
 *
 * The override merges per-key over the global config for THIS session only; the
 * global file is never touched.
 *
 * Pure: never mutates the input `args` array.
 */
export function buildSpawnOverride(input: SpawnOverrideInput): SpawnOverride {
  const { program, args, paneId, sessionId, resume, usagePaths } = input;

  // Only `claude` panes are wrapped; everything else spawns verbatim.
  if (program !== 'claude') {
    return { args: [...args] };
  }

  const injected: string[] = [];

  // App-owned session id FIRST, so the overview can locate this exact agent's
  // transcript. Added even when the wrapper is unavailable (activity is decoupled
  // from the statusline snapshot).
  // When `resume` is true, use `--resume <id>` so the restored pane continues
  // from its prior transcript. Otherwise use `--session-id <id>` for fresh panes.
  if (sessionId) {
    if (resume) {
      injected.push('--resume', sessionId);
    } else {
      injected.push('--session-id', sessionId);
    }
  }

  // Per-session settings override. ALWAYS present for a claude pane:
  //  - `remoteControlAtStartup: false` keeps the transcript LOCAL + complete (the
  //    overview's activity reads it); the global default would bridge it to the
  //    cloud and leave only a stub behind.
  //  - `statusLine` points at the app's wrapper for the snapshot pipeline, but
  //    only when the usage paths resolved (a missing wrapper must never break a
  //    launch, so the statusline override is the only optional part).
  const settings: {
    remoteControlAtStartup: boolean;
    disableAgentView: boolean;
    statusLine?: { type: string; command: string };
    hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>;
  } = { remoteControlAtStartup: false, disableAgentView: true };

  let env: Array<[string, string]> | undefined;
  if (usagePaths) {
    // Both commands run through `node` (see nodeCommand) with the script path
    // shell-quoted: the scripts live under a SPACED app-data path, claude runs
    // these through a shell, and Windows honors no shebang.
    settings.statusLine = {
      type: STATUS_LINE_TYPE,
      command: nodeCommand(usagePaths.wrapperPath)
    };
    // The single event hook is wired into the FULL lifecycle event set. Each
    // invocation normalizes its event and delivers one JSON line over the
    // app-hosted local socket (AGENT_DESKTOP_SOCKET_PATH), feeding the overview's
    // event-sourced status + per-tool timeline. Pre/PostToolUse match ALL tools
    // (matcher '*') so every tool call produces a timeline entry; the pending
    // AskUserQuestion payload rides on its PreToolUse event (it is not in the
    // transcript until answered), replacing the old question.json sidecar.
    const hookCmd = { type: 'command', command: nodeCommand(usagePaths.eventHookPath) };
    settings.hooks = {
      SessionStart: [{ hooks: [hookCmd] }],
      UserPromptSubmit: [{ hooks: [hookCmd] }],
      PreToolUse: [{ matcher: '*', hooks: [hookCmd] }],
      PostToolUse: [{ matcher: '*', hooks: [hookCmd] }],
      Notification: [{ hooks: [hookCmd] }],
      Stop: [{ hooks: [hookCmd] }],
      SubagentStop: [{ hooks: [hookCmd] }],
      SessionEnd: [{ hooks: [hookCmd] }]
    };
    env = [
      ['AGENT_DESKTOP_PANE', paneId],
      ['AGENT_DESKTOP_SNAPSHOT_DIR', usagePaths.snapshotDir],
      ['AGENT_DESKTOP_SOCKET_PATH', usagePaths.socketPath]
    ];
  }
  injected.push('--settings', JSON.stringify(settings));

  return { args: [...injected, ...args], env };
}

/**
 * The `--mcp-config` JSON that attaches the bundled orchestration toolkit to a
 * launched coordinator session. A single stdio MCP server (`orchestration`) runs
 * the bundled adapter via `node <adapterPath>` with the control-socket path in its
 * env, so the adapter forwards each tool call to the Rust control socket.
 *
 * Shape matches Claude's `--mcp-config` stdio-server schema:
 *   { "mcpServers": { "<name>": { "command", "args", "env" } } }
 */
export interface McpToolkitConfig {
  mcpServers: {
    orchestration: {
      command: string;
      args: string[];
      env: {
        AGENT_DESKTOP_CONTROL_SOCKET: string;
        /** The COORDINATOR's own project id — the adapter merges it into every
         *  forwarded tool call's `args` so the executor can scope the op (it
         *  rejects ops without `args.projectId`; the coordinator LLM can't be
         *  relied on to pass it). See `orchestration-mcp.cjs` / `PROJECT_ID_ENV`. */
        AGENT_DESKTOP_PROJECT_ID: string;
      };
    };
  };
}

/**
 * The MCP server name the toolkit is registered under. Tools therefore surface to
 * the coordinator as `mcp__orchestration__<tool>` (e.g. `mcp__orchestration__spawn_agent`).
 */
export const ORCHESTRATION_MCP_SERVER = 'orchestration';

/**
 * The env var the bundled adapter reads to find the control socket — must match the
 * Rust `orchestration::CONTROL_SOCKET_ENV` constant.
 */
export const CONTROL_SOCKET_ENV = 'AGENT_DESKTOP_CONTROL_SOCKET';

/**
 * The env var the bundled adapter reads for the COORDINATOR's own project id, which
 * it merges into every forwarded tool call's `args.projectId` — must match the
 * adapter's `PROJECT_ID_ENV` constant. The executor scopes every op on
 * `args.projectId` and rejects ops without it, so this is REQUIRED for the toolkit
 * to work.
 */
export const PROJECT_ID_ENV = 'AGENT_DESKTOP_PROJECT_ID';

/**
 * Build the per-session `--mcp-config` content (task 3.6) that attaches the
 * orchestration toolkit to a coordinator `claude` launch. The coordinator-launch
 * task (6.2) passes the returned object (typically `JSON.stringify`-ed, or written
 * to a temp file) as `--mcp-config`.
 *
 *  - `adapterPath` — absolute path to the installed `orchestration-mcp.cjs`
 *    (resolved the same way as the wrapper / event-hook resources).
 *  - `socketPath`  — absolute path to the Rust control socket
 *    (`orchestration::CONTROL_SOCKET_ENV` value).
 *  - `projectId`   — the COORDINATOR's own project id. Placed in the server `env`
 *    as `AGENT_DESKTOP_PROJECT_ID` so the adapter merges it into every forwarded
 *    tool call's `args.projectId`; the executor scopes every op on it and rejects
 *    ops without it (the coordinator LLM can't be relied on to pass it).
 *
 * Pure: depends only on its inputs.
 */
export function buildMcpToolkitConfig(
  adapterPath: string,
  socketPath: string,
  projectId: string
): McpToolkitConfig {
  return {
    mcpServers: {
      [ORCHESTRATION_MCP_SERVER]: {
        command: 'node',
        args: [adapterPath],
        env: { [CONTROL_SOCKET_ENV]: socketPath, [PROJECT_ID_ENV]: projectId }
      }
    }
  } as McpToolkitConfig;
}

// ── Worker back-channel (add-coordinator-task-backchannel, D2/D3) ────────────────
//
// The back-channel is a SECOND child-side MCP adapter (`back-channel-mcp.cjs`),
// attached to a `claude` WORKER **only** when that worker is dispatched with a Task —
// exactly as `orchestration-mcp.cjs` is attached to the coordinator. It exposes the
// four worker tools (`report_progress`/`report_done`/`report_blocked`/`ask_coordinator`)
// and forwards each call over the SAME Rust control socket the orchestration adapter
// uses. Plain user sessions and the coordinator never get it.

/**
 * The MCP server name the back-channel toolset is registered under. Its tools surface
 * to the worker as `mcp__backchannel__<tool>` (e.g. `mcp__backchannel__report_done`).
 */
export const BACK_CHANNEL_MCP_SERVER = 'backchannel';

/**
 * The env var the back-channel adapter reads for the worker's own Task id — must match
 * the sidecar's `TASK_ID_ENV` (`back-channel-mcp.cjs`). Placed in the back-channel
 * `--mcp-config` server env so the adapter stamps it onto every forwarded call's
 * `args.taskId`; the executor scopes every back-channel op on it and FAILS CLOSED when
 * it is absent (the worker LLM can't be relied on to pass its own Task id).
 */
export const TASK_ID_ENV = 'AGENT_DESKTOP_TASK_ID';

/**
 * The `--mcp-config` JSON that attaches the worker back-channel toolset to a
 * Task-dispatched `claude` worker. Mirrors {@link McpToolkitConfig}: a single stdio
 * MCP server (`backchannel`) runs the bundled back-channel adapter via
 * `node <backChannelAdapterPath>` with the control-socket path AND the worker's Task/
 * project scope in its env, so the adapter forwards each call to the Rust control
 * socket already scoped to the worker's Task.
 */
export interface BackChannelMcpConfig {
  mcpServers: {
    backchannel: {
      command: string;
      args: string[];
      env: {
        /** The Rust control socket the adapter forwards to (same one the orchestration
         *  adapter uses). */
        AGENT_DESKTOP_CONTROL_SOCKET: string;
        /** The worker's Task id — the adapter stamps it onto every forwarded call so the
         *  executor can scope the op; REQUIRED (fail-closed without it). */
        AGENT_DESKTOP_TASK_ID: string;
        /** The worker's project id — merged into every forwarded call so the executor can
         *  reject a Task in another project. */
        AGENT_DESKTOP_PROJECT_ID: string;
      };
    };
  };
}

/**
 * The Task-contract instruction appended to a Task-dispatched worker's system prompt
 * (design D3). Teaches the worker to drive its own lifecycle through the back-channel
 * tools rather than going idle. The REAL Task id is interpolated so the worker knows
 * which Task it is reporting on.
 *
 * NOTE: the worker's PANE env already carries `AGENT_DESKTOP_PANE` (from
 * `buildSpawnOverride`), which the back-channel adapter inherits — so only the Task/
 * project scope needs stamping into the back-channel `--mcp-config` env.
 *
 * Pure: depends only on `taskId`.
 */
export function taskContractPrompt(taskId: string): string {
  return `You were dispatched to work on Task ${taskId}. When you finish, call report_done with a short result summary (and any artifact file paths). If you get stuck, call report_blocked. If you need a decision, call ask_coordinator. Do not wait idle — always report.`;
}

/**
 * Build the per-worker `--mcp-config` content (task 7.1) that attaches the back-channel
 * toolset to a Task-dispatched `claude` worker. The dispatch path (task 7.2 /
 * `taskWorkerLaunchArgs`, consumed by the coordinator-tools group) passes the returned
 * object `JSON.stringify`-ed as `--mcp-config`.
 *
 *  - `adapterPath` — absolute path to the installed `back-channel-mcp.cjs`
 *    (`UsagePaths.backChannelAdapterPath`).
 *  - `socketPath`  — absolute path to the Rust control socket
 *    (`UsagePaths.controlSocketPath`; the SAME socket the orchestration adapter uses).
 *  - `taskId`      — the worker's Task id. Placed in the server `env` as
 *    `AGENT_DESKTOP_TASK_ID` so the adapter stamps it onto every forwarded call; the
 *    executor scopes every back-channel op on it and fails closed without it.
 *  - `projectId`   — the worker's project id. Placed in the server `env` as
 *    `AGENT_DESKTOP_PROJECT_ID` so the executor can reject a cross-project Task.
 *
 * `AGENT_DESKTOP_PANE` is intentionally NOT set here: the pane id is generated inside
 * `workspace.launch` (not known when these args are built), and the adapter already
 * inherits the worker pane's own `AGENT_DESKTOP_PANE` env (stamped by
 * `buildSpawnOverride`). Scope stamping needs only Task + project.
 *
 * Pure: depends only on its inputs.
 */
export function buildBackChannelMcpConfig(
  adapterPath: string,
  socketPath: string,
  taskId: string,
  projectId: string
): BackChannelMcpConfig {
  return {
    mcpServers: {
      [BACK_CHANNEL_MCP_SERVER]: {
        command: 'node',
        args: [adapterPath],
        env: {
          [CONTROL_SOCKET_ENV]: socketPath,
          [TASK_ID_ENV]: taskId,
          [PROJECT_ID_ENV]: projectId
        }
      }
    }
  } as BackChannelMcpConfig;
}
