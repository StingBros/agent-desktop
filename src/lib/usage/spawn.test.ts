import { describe, expect, it } from 'vitest';
import {
  BACK_CHANNEL_MCP_SERVER,
  buildBackChannelMcpConfig,
  buildMcpToolkitConfig,
  buildSpawnOverride,
  nodeCommand,
  quoteCommand,
  taskContractPrompt,
  type UsagePaths
} from './spawn';

// Tests for the PURE spawn-override helper that wires `claude` panes THROUGH the
// app-managed statusline wrapper without ever touching the user's global
// ~/.claude/settings.json. The `it(...)` titles are the EXACT `#### Scenario:`
// names from the usage-dashboard spec (Requirement: Per-Session Statusline
// Override Without Touching Global Config) so the coverage gate can match them.

const PATHS: UsagePaths = {
  wrapperPath: '/Users/me/Library/Application Support/agent-desktop/bin/statusline-wrapper.js',
  snapshotDir: '/Users/me/Library/Application Support/agent-desktop/snapshots',
  eventHookPath: '/Users/me/Library/Application Support/agent-desktop/bin/event-hook.js',
  socketPath: '/Users/me/Library/Application Support/agent-desktop/events.sock',
  adapterPath: '/Users/me/Library/Application Support/agent-desktop/bin/orchestration-mcp.js',
  backChannelAdapterPath:
    '/Users/me/Library/Application Support/agent-desktop/bin/back-channel-mcp.js',
  controlSocketPath: '/Users/me/Library/Application Support/agent-desktop/control.sock'
};

/** The full hook event set the event hook is wired into, with Pre/Post matching all tools. */
function expectedHooks(eventHookPath: string) {
  const cmd = { type: 'command', command: `node "${eventHookPath}"` };
  return {
    SessionStart: [{ hooks: [cmd] }],
    UserPromptSubmit: [{ hooks: [cmd] }],
    PreToolUse: [{ matcher: '*', hooks: [cmd] }],
    PostToolUse: [{ matcher: '*', hooks: [cmd] }],
    Notification: [{ hooks: [cmd] }],
    Stop: [{ hooks: [cmd] }],
    SubagentStop: [{ hooks: [cmd] }],
    SessionEnd: [{ hooks: [cmd] }]
  };
}

describe('buildSpawnOverride', () => {
  // The headline scenario: a claude spawn carries the per-session --settings
  // override (statusLine.command = wrapper) + the two env vars, while a shell
  // spawn carries NEITHER — so the per-session override is the ONLY mechanism
  // and the user's global settings.json is never read or written by the app.
  it('Global config left byte-identical', () => {
    // claude: gets the inline --settings override and the env, nothing global.
    const claude = buildSpawnOverride({
      program: 'claude',
      args: ['--resume'],
      paneId: 'pane-xyz',
      usagePaths: PATHS
    });

    expect(claude.args[0]).toBe('--settings');
    const parsed = JSON.parse(claude.args[1]);
    expect(parsed.remoteControlAtStartup).toBe(false);
    // Claude's built-in agent view (←← opens it; ← backgrounds/detaches the session,
    // exiting the local PTY) conflicts with agent-desktop's own agents panel — disable
    // it per-session so an arrow keypress never archives a live session out from under
    // the user.
    expect(parsed.disableAgentView).toBe(true);
    // Command paths are shell-quoted so the spaced app-data path survives claude's
    // shell invocation (the wrapper/hook silently never run otherwise).
    expect(parsed.statusLine).toEqual({ type: 'command', command: `node "${PATHS.wrapperPath}"` });
    // The single event hook is wired into the full lifecycle event set so the
    // overview's status + per-tool timeline are event-sourced.
    expect(parsed.hooks).toEqual(expectedHooks(PATHS.eventHookPath));
    // The override is inline JSON (a per-session merge), never a file write —
    // nothing here points at or mutates ~/.claude/settings.json.
    expect(claude.args[1]).not.toContain('settings.json');
    // Existing args are preserved verbatim after the injected ones.
    expect(claude.args.slice(2)).toEqual(['--resume']);
    // The per-session env reaches the wrapper (statusLine.command) and the event
    // hook (AGENT_DESKTOP_SOCKET_PATH).
    expect(claude.env).toEqual([
      ['AGENT_DESKTOP_PANE', 'pane-xyz'],
      ['AGENT_DESKTOP_SNAPSHOT_DIR', PATHS.snapshotDir],
      ['AGENT_DESKTOP_SOCKET_PATH', PATHS.socketPath]
    ]);

    // shell: no --settings override, no AGENT_DESKTOP_* env — spawns unchanged,
    // so it likewise never involves the global config.
    const shell = buildSpawnOverride({
      program: '/bin/zsh',
      args: ['-l'],
      paneId: 'pane-xyz',
      usagePaths: PATHS
    });
    expect(shell.args).toEqual(['-l']);
    expect(shell.args).not.toContain('--settings');
    expect(shell.env).toBeUndefined();
  });

  it('Inline settings override merges per-key', () => {
    const { args } = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'p1',
      usagePaths: PATHS
    });
    // The override object contains ONLY `remoteControlAtStartup` (keep the transcript
    // local), `disableAgentView` (Claude's arrow-key agent view conflicts with ours),
    // `statusLine.command` (the snapshot wrapper), and `hooks` (the event pipeline) — no
    // other keys — so `claude --settings` merges it per-key over the user's settings.json,
    // leaving every other key (e.g. permissions.allow) in effect.
    const parsed = JSON.parse(args[1]);
    expect(Object.keys(parsed)).toEqual([
      'remoteControlAtStartup',
      'disableAgentView',
      'statusLine',
      'hooks'
    ]);
    expect(parsed.remoteControlAtStartup).toBe(false);
    expect(parsed.statusLine.command).toBe(`node "${PATHS.wrapperPath}"`);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('*');
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe(`node "${PATHS.eventHookPath}"`);
  });

  it('Full event set registered at spawn', () => {
    // The event hook is registered for every lifecycle event, Pre/PostToolUse
    // match ALL tools, and the socket path reaches the spawned process env.
    const { args, env } = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'pane-full',
      sessionId: 'sess-full',
      usagePaths: PATHS
    });
    const parsed = JSON.parse(args[args.indexOf('--settings') + 1]);
    expect(parsed.hooks).toEqual(expectedHooks(PATHS.eventHookPath));
    expect(Object.keys(parsed.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'Stop',
      'SubagentStop',
      'SessionEnd'
    ]);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('*');
    expect(parsed.hooks.PostToolUse[0].matcher).toBe('*');
    const map = new Map(env);
    expect(map.get('AGENT_DESKTOP_SOCKET_PATH')).toBe(PATHS.socketPath);
  });

  it('Pane id passed into the spawned process env', () => {
    const { env } = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'pane-uuid-123',
      usagePaths: PATHS
    });
    const map = new Map(env);
    expect(map.get('AGENT_DESKTOP_PANE')).toBe('pane-uuid-123');
    expect(map.get('AGENT_DESKTOP_SNAPSHOT_DIR')).toBe(PATHS.snapshotDir);
  });

  it('claude spawns unwrapped when usage paths are unavailable', () => {
    // If the wrapper path could not be resolved, claude still launches WITHOUT the
    // statusline wrapper or its env — but it ALWAYS carries the inline `--settings`
    // disabling remote-control, so the transcript stays local + complete for the
    // overview's activity (a missing wrapper must never bridge the session away).
    const { args, env } = buildSpawnOverride({
      program: 'claude',
      args: ['--resume'],
      paneId: 'p1',
      usagePaths: null
    });
    expect(args).toEqual([
      '--settings',
      '{"remoteControlAtStartup":false,"disableAgentView":true}',
      '--resume'
    ]);
    expect(env).toBeUndefined();
  });

  it('Agent launched with an app-owned session id', () => {
    // A claude pane carries `--session-id <uuid>` (BEFORE --settings) so the
    // overview can locate this exact agent's transcript; it is injected even when
    // the wrapper is unavailable (activity is decoupled from the snapshot).
    const wrapped = buildSpawnOverride({
      program: 'claude',
      args: ['--resume'],
      paneId: 'p1',
      sessionId: 'sess-uuid-1',
      usagePaths: PATHS
    });
    expect(wrapped.args.slice(0, 2)).toEqual(['--session-id', 'sess-uuid-1']);
    expect(wrapped.args[2]).toBe('--settings');
    expect(wrapped.args.slice(-1)).toEqual(['--resume']);

    const unwrapped = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'p1',
      sessionId: 'sess-uuid-2',
      usagePaths: null
    });
    // Still carries `--session-id` AND the remote-control-disabling `--settings`,
    // just no statusline wrapper.
    expect(unwrapped.args).toEqual([
      '--session-id',
      'sess-uuid-2',
      '--settings',
      '{"remoteControlAtStartup":false,"disableAgentView":true}'
    ]);
    expect(unwrapped.env).toBeUndefined();

    // A shell pane never gets a session id.
    const shell = buildSpawnOverride({
      program: '/bin/zsh',
      args: [],
      paneId: 'p1',
      sessionId: 'ignored',
      usagePaths: PATHS
    });
    expect(shell.args).toEqual([]);
  });

  it('quoteCommand wraps a spaced app-data path so the shell does not split it', () => {
    // The real install path: `~/Library/Application Support/…` has a space, which
    // breaks claude's shell invocation of the command unless quoted.
    const spaced = '/Users/me/Library/Application Support/agent-desktop/bin/question-hook.js';
    expect(quoteCommand(spaced)).toBe(`"${spaced}"`);
    // Chars special inside double quotes are escaped.
    expect(quoteCommand('/x/$HOME/`b`/"c"/a.js')).toBe('"/x/\\$HOME/\\`b\\`/\\"c\\"/a.js"');
  });

  it('Hooks fire on Windows', () => {
    // Windows honors NEITHER the `#!/usr/bin/env node` shebang nor the executable
    // bit, so a bare script path as the hook command never runs. Because a hook
    // that fails to run is SILENT, that would disable the whole event pipeline —
    // and every agent's derived status with it — showing no error at all.
    // The command must therefore invoke `node` explicitly.
    const winPath = 'C:\\Users\\dev\\AppData\\Roaming\\agent desktop\\bin\\event-hook.cjs';
    const { args } = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'p1',
      usagePaths: { ...PATHS, eventHookPath: winPath, wrapperPath: winPath }
    });
    const parsed = JSON.parse(args[1]);

    for (const [event, entries] of Object.entries(parsed.hooks)) {
      const command = (entries as Array<{ hooks: Array<{ command: string }> }>)[0].hooks[0].command;
      expect(command.startsWith('node '), `${event} does not invoke node: ${command}`).toBe(true);
      // The spaced path stays quoted, so the shell cannot split it, and the
      // separators are forward slashes — `quoteCommand` escapes `\` for POSIX
      // shells, but cmd.exe treats `\` literally, so an escaped Windows path
      // would reach node with doubled separators. Node accepts `/` on Windows.
      expect(command).toBe('node "C:/Users/dev/AppData/Roaming/agent desktop/bin/event-hook.cjs"');
      expect(command).not.toContain('\\\\');
    }
    // The statusline wrapper is invoked the same way.
    expect(parsed.statusLine.command).toBe(
      'node "C:/Users/dev/AppData/Roaming/agent desktop/bin/event-hook.cjs"'
    );
  });

  it('Hooks continue to fire on Unix', () => {
    // The same single code path on macOS/Linux — not a regression, since the
    // shebang was `/usr/bin/env node`, so `node` already had to be on PATH.
    const { args } = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'p1',
      usagePaths: PATHS
    });
    const parsed = JSON.parse(args[1]);
    expect(parsed.hooks).toEqual(expectedHooks(PATHS.eventHookPath));
    expect(parsed.hooks.Stop[0].hooks[0].command).toBe(`node "${PATHS.eventHookPath}"`);
    // Every lifecycle event still registered — none dropped by the change.
    expect(Object.keys(parsed.hooks)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Notification',
      'Stop',
      'SubagentStop',
      'SessionEnd'
    ]);
  });

  it('nodeCommand quotes the script path but not the interpreter', () => {
    expect(nodeCommand('/a b/c.cjs')).toBe('node "/a b/c.cjs"');
    // Shell-special characters inside the path are still escaped.
    expect(nodeCommand('/x/$H/`b`.cjs')).toBe('node "/x/\\$H/\\`b\\`.cjs"');
    // A Windows path is normalized to forward slashes (see toNodePath).
    expect(nodeCommand('C:\\a b\\c.cjs')).toBe('node "C:/a b/c.cjs"');
    // A Unix path containing a literal backslash is NOT treated as a Windows
    // path, so it keeps its escaping.
    expect(nodeCommand('/tmp/od\\d.cjs')).toBe('node "/tmp/od\\\\d.cjs"');
  });

  it('does not mutate the input args array', () => {
    const input = ['--resume'];
    buildSpawnOverride({
      program: 'claude',
      args: input,
      paneId: 'p1',
      usagePaths: PATHS
    });
    expect(input).toEqual(['--resume']);
  });

  it('Resume flag emits --resume instead of --session-id', () => {
    // A restored claude pane with resume:true must use `--resume <id>` so it
    // continues the prior transcript; `--session-id` must NOT appear.
    const resumed = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'pane-r',
      sessionId: 'sess-resume-1',
      resume: true,
      usagePaths: PATHS
    });
    expect(resumed.args.slice(0, 2)).toEqual(['--resume', 'sess-resume-1']);
    expect(resumed.args[2]).toBe('--settings');
    expect(resumed.args).not.toContain('--session-id');

    // Without resume, the existing --session-id behaviour is unchanged.
    const fresh = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'pane-f',
      sessionId: 'sess-fresh-1',
      resume: false,
      usagePaths: PATHS
    });
    expect(fresh.args.slice(0, 2)).toEqual(['--session-id', 'sess-fresh-1']);
    expect(fresh.args[2]).toBe('--settings');
    expect(fresh.args).not.toContain('--resume');

    // resume:true without a sessionId is a no-op (no flag injected).
    const noId = buildSpawnOverride({
      program: 'claude',
      args: [],
      paneId: 'pane-n',
      resume: true,
      usagePaths: null
    });
    expect(noId.args).not.toContain('--resume');
    expect(noId.args).not.toContain('--session-id');
  });
});

describe('buildMcpToolkitConfig', () => {
  // Task 3.6: the per-session --mcp-config the coordinator launch (task 6.2) consumes.
  it('builds an mcp-config naming the bundled adapter run via node with the socket + projectId env', () => {
    const cfg = buildMcpToolkitConfig(
      '/Users/me/Library/Application Support/agent-desktop/bin/orchestration-mcp.js',
      '/Users/me/Library/Application Support/agent-desktop/control.sock',
      'proj-coord-1'
    );
    expect(cfg).toEqual({
      mcpServers: {
        orchestration: {
          command: 'node',
          args: ['/Users/me/Library/Application Support/agent-desktop/bin/orchestration-mcp.js'],
          env: {
            AGENT_DESKTOP_CONTROL_SOCKET:
              '/Users/me/Library/Application Support/agent-desktop/control.sock',
            // The coordinator's own project id rides into the adapter so it can stamp
            // it into every forwarded tool call's args (the executor scopes on it).
            AGENT_DESKTOP_PROJECT_ID: 'proj-coord-1'
          }
        }
      }
    });
    // Round-trips through JSON (it is passed as --mcp-config content).
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg);
  });
});

describe('buildBackChannelMcpConfig', () => {
  // Task 7.1: the per-worker --mcp-config the Task-dispatch path (7.2) consumes. Mirrors
  // buildMcpToolkitConfig but names the back-channel adapter and stamps the worker's
  // Task id + project scope into the server env (so the adapter forwards scoped calls).
  it('names the back-channel adapter run via node with the socket + Task/project env', () => {
    const cfg = buildBackChannelMcpConfig(
      PATHS.backChannelAdapterPath,
      PATHS.controlSocketPath,
      'task-42',
      'proj-1'
    );
    expect(cfg).toEqual({
      mcpServers: {
        backchannel: {
          command: 'node',
          args: [PATHS.backChannelAdapterPath],
          env: {
            AGENT_DESKTOP_CONTROL_SOCKET: PATHS.controlSocketPath,
            // The worker's Task id — the adapter stamps it onto every forwarded call;
            // the executor fails closed without it.
            AGENT_DESKTOP_TASK_ID: 'task-42',
            // The worker's project id — lets the executor reject a cross-project Task.
            AGENT_DESKTOP_PROJECT_ID: 'proj-1'
          }
        }
      }
    });
    // Registered under the documented server name (tools surface as mcp__backchannel__*).
    expect(Object.keys(cfg.mcpServers)).toEqual([BACK_CHANNEL_MCP_SERVER]);
    // No AGENT_DESKTOP_PANE in the config env — the adapter inherits it from the worker
    // pane's own env (buildSpawnOverride stamps it); the pane id isn't known this early.
    expect(cfg.mcpServers.backchannel.env).not.toHaveProperty('AGENT_DESKTOP_PANE');
    // Round-trips through JSON (it is passed as --mcp-config content).
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg);
  });
});

describe('taskContractPrompt', () => {
  it('interpolates the real Task id and names all three back-channel tools', () => {
    const prompt = taskContractPrompt('T7');
    expect(prompt).toContain('Task T7');
    expect(prompt).toContain('report_done');
    expect(prompt).toContain('report_blocked');
    expect(prompt).toContain('ask_coordinator');
    // A different id produces a different string (it really interpolates).
    expect(taskContractPrompt('T8')).not.toEqual(prompt);
  });
});
