// Back-channel MCP adapter tests (add-coordinator-task-backchannel, task 3.2).
//
// Two layers, mirroring the sibling sidecar tests:
//  - PURE core (encodeRequest / decodeResponse / stampScope / hasResolvableTaskId /
//    TOOLS) required directly from the production .cjs and asserted in-process — the
//    same style as `orchestration-mcp.test.ts`.
//  - INTEGRATION: the real adapter run as a subprocess over its JSON-RPC stdio loop,
//    forwarding tool calls over a REAL mock control socket, exercising (a) tools/list,
//    (b) each tool's correctly-stamped request + reply, and (c) the fail-closed path
//    when AGENT_DESKTOP_TASK_ID is absent — the same subprocess+socket harness as
//    `event-hook.test.ts`.
//
// Test titles map to the `#### Scenario:` names in
// openspec/changes/add-coordinator-task-backchannel/specs/agent-back-channel/spec.md
// (the coverage gate normalizes both to snake_case).

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, 'back-channel-mcp.cjs');
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./back-channel-mcp.cjs') as typeof import('./back-channel-mcp.cjs');

const TASK_ID = 'task-bc-0001';
const PROJECT_ID = 'proj-bc-A';
const PANE_ID = 'pane-bc-0001';

// A platform-appropriate IPC endpoint for the mock control socket. The adapter
// transport is path-opaque (`net.createConnection({ path })`), but the SERVER side
// differs by OS: Windows cannot bind a Unix-domain socket to a filesystem path, so it
// requires a named pipe `\\.\pipe\<name>`. Names are unique per call (pid + seq).
let pipeSeq = 0;
function ipcEndpoint(name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\agentdesk-bc-${process.pid}-${pipeSeq++}-${name}`;
  }
  // A short unix-socket path under the OS tmp; kept short to stay under the sun_path cap.
  return join(process.env.TMPDIR || '/tmp', `agentdesk-bc-${process.pid}-${pipeSeq++}-${name}.sock`);
}

// Track servers so each test tears its listener down.
const openServers: Server[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/**
 * Stand up a mock control socket. Captures the ONE request line each connection sends
 * and replies with `{ id: 1, result: reply }`. Returns the endpoint and the array of
 * received (parsed) request payloads so a test can assert what was forwarded.
 */
async function mockControlSocket(reply: unknown): Promise<{ socketPath: string; received: any[] }> {
  const socketPath = ipcEndpoint('control');
  const received: any[] = [];
  const server = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        try {
          received.push(JSON.parse(buf.slice(0, nl)));
        } catch {
          received.push({ __unparsed: buf.slice(0, nl) });
        }
        conn.write(`${JSON.stringify({ id: 1, result: reply })}\n`);
      }
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { socketPath, received };
}

/**
 * Drive the real adapter as a subprocess: send each JSON-RPC request line on stdin and
 * resolve the FIRST response whose id matches `waitForId`. Ends stdin and kills the
 * child on resolution so nothing lingers.
 */
function rpcRoundTrip(
  env: NodeJS.ProcessEnv,
  requests: unknown[],
  waitForId: number,
  timeoutMs = 8000
): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env } });
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`timed out waiting for response id=${waitForId}; stdout so far: ${out}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d.toString();
      let nl: number;
      while ((nl = out.indexOf('\n')) !== -1) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && msg.id === waitForId) {
          clearTimeout(timer);
          try {
            child.stdin.end();
            child.kill();
          } catch {
            /* ignore */
          }
          resolve(msg);
          return;
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
  });
}

describe('back-channel-mcp pure core', () => {
  it('encodes a tool call into one {op,args} request line (no id)', () => {
    const line = mcp.encodeRequest('report_progress', { taskId: 't1', note: 'did a thing' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ op: 'report_progress', args: { taskId: 't1', note: 'did a thing' } });
    expect('id' in parsed).toBe(false);
  });

  it('defaults missing/invalid args to an empty object', () => {
    expect(JSON.parse(mcp.encodeRequest('report_done'))).toEqual({ op: 'report_done', args: {} });
    expect(JSON.parse(mcp.encodeRequest('report_done', null))).toEqual({ op: 'report_done', args: {} });
  });

  it('stamps taskId/projectId/paneId into args (caller cannot override)', () => {
    // The worker's own scope is stamped into every tool call's args; the injected ids
    // ALWAYS win so a caller can never spoof another Task/project/pane.
    expect(mcp.stampScope({ note: 'x' }, { taskId: 't1', projectId: 'p1', paneId: 'pane1' })).toEqual({
      note: 'x',
      taskId: 't1',
      projectId: 'p1',
      paneId: 'pane1'
    });
    expect(
      mcp.stampScope(
        { taskId: 'SPOOF', projectId: 'OTHER', paneId: 'OTHER', result: 'r' },
        { taskId: 't1', projectId: 'p1', paneId: 'pane1' }
      )
    ).toEqual({ result: 'r', taskId: 't1', projectId: 'p1', paneId: 'pane1' });
    // Blank/missing scope fields are left off (executor rejects an under-scoped op).
    expect(mcp.stampScope({ note: 'x' }, { taskId: 't1', projectId: '', paneId: '   ' })).toEqual({
      note: 'x',
      taskId: 't1'
    });
    // Non-object args (null/array) default to a fresh object carrying just the scope.
    expect(mcp.stampScope(null, { taskId: 't1' })).toEqual({ taskId: 't1' });
    // Never mutates the input args.
    const input = { note: 'x' };
    mcp.stampScope(input, { taskId: 't1' });
    expect(input).toEqual({ note: 'x' });
  });

  it('resolves the Task id only when it is a non-blank string', () => {
    expect(mcp.hasResolvableTaskId({ taskId: 't1' })).toBe(true);
    expect(mcp.hasResolvableTaskId({ taskId: '' })).toBe(false);
    expect(mcp.hasResolvableTaskId({ taskId: '   ' })).toBe(false);
    expect(mcp.hasResolvableTaskId({})).toBe(false);
    expect(mcp.hasResolvableTaskId(undefined as any)).toBe(false);
  });

  it('decodes success / error / malformed response lines (never throws)', () => {
    expect(mcp.decodeResponse(JSON.stringify({ id: 1, result: { ok: 1 } }))).toEqual({
      ok: true,
      result: { ok: 1 }
    });
    expect(mcp.decodeResponse(JSON.stringify({ id: 2, error: 'nope' }))).toEqual({
      ok: false,
      error: 'nope'
    });
    expect(mcp.decodeResponse('not json').ok).toBe(false);
    expect(mcp.decodeResponse('').ok).toBe(false);
  });

  it('exposes exactly the four back-channel tools with object arg schemas', () => {
    const names = mcp.TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['ask_coordinator', 'report_blocked', 'report_done', 'report_progress']);
    // No orchestration/coordinator tool leaks into the worker toolkit.
    expect(names).not.toContain('spawn_agent');
    expect(names).not.toContain('message_agent');
    for (const t of mcp.TOOLS) {
      expect(t.inputSchema.type).toBe('object');
    }
    // report_done takes result (required) + optional artifacts array.
    const done = mcp.TOOLS.find((t) => t.name === 'report_done')!;
    expect(done.inputSchema.required).toContain('result');
    expect(done.inputSchema.properties).toHaveProperty('artifacts');
    expect((done.inputSchema.required ?? []) as string[]).not.toContain('artifacts');
  });
});

describe('back-channel-mcp stdio + control socket', () => {
  const baseEnv = (socketPath: string) => ({
    AGENT_DESKTOP_CONTROL_SOCKET: socketPath,
    AGENT_DESKTOP_TASK_ID: TASK_ID,
    AGENT_DESKTOP_PROJECT_ID: PROJECT_ID,
    AGENT_DESKTOP_PANE: PANE_ID
  });

  it('tools/list returns the four back-channel tools', async () => {
    // No socket needed for a list; point at an unused endpoint.
    const res = await rpcRoundTrip(
      { AGENT_DESKTOP_TASK_ID: TASK_ID } as NodeJS.ProcessEnv,
      [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      1
    );
    const names = (res.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(['ask_coordinator', 'report_blocked', 'report_done', 'report_progress']);
  });

  it('Call is stamped with its Task — each tool forwards a scoped request and returns its reply', async () => {
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'report_progress', args: { note: 'halfway there' } },
      { tool: 'report_done', args: { result: 'shipped', artifacts: ['a/b.md'] } },
      { tool: 'report_blocked', args: { reason: 'need creds' } },
      { tool: 'ask_coordinator', args: { question: 'which branch?' } }
    ];
    for (const { tool, args } of cases) {
      const { socketPath, received } = await mockControlSocket({ applied: tool });
      const res = await rpcRoundTrip(
        baseEnv(socketPath) as NodeJS.ProcessEnv,
        [{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: tool, arguments: args } }],
        5
      );
      // The forwarded op + stamped args reached the control socket.
      expect(received).toHaveLength(1);
      expect(received[0].op).toBe(tool);
      expect(received[0].args).toEqual({
        ...args,
        taskId: TASK_ID,
        projectId: PROJECT_ID,
        paneId: PANE_ID
      });
      // The socket reply is surfaced as MCP tool content, not an error.
      expect(res.result.isError).toBeFalsy();
      expect(JSON.parse(res.result.content[0].text)).toEqual({ applied: tool });
    }
  });

  it("caller-supplied scope ids cannot override the worker's own", async () => {
    const { socketPath, received } = await mockControlSocket({ ok: true });
    await rpcRoundTrip(
      baseEnv(socketPath) as NodeJS.ProcessEnv,
      [
        {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: {
            name: 'report_done',
            arguments: { result: 'r', taskId: 'SPOOF', projectId: 'SPOOF', paneId: 'SPOOF' }
          }
        }
      ],
      9
    );
    expect(received[0].args).toEqual({
      result: 'r',
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      paneId: PANE_ID
    });
  });

  it('Unresolvable Task id is rejected — fail closed, no socket mutation', async () => {
    const { socketPath, received } = await mockControlSocket({ ok: true });
    // AGENT_DESKTOP_TASK_ID intentionally absent.
    const env = {
      AGENT_DESKTOP_CONTROL_SOCKET: socketPath,
      AGENT_DESKTOP_TASK_ID: '',
      AGENT_DESKTOP_PROJECT_ID: PROJECT_ID,
      AGENT_DESKTOP_PANE: PANE_ID
    };
    const res = await rpcRoundTrip(
      env as NodeJS.ProcessEnv,
      [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_done', arguments: { result: 'r' } } }],
      3
    );
    // Structured MCP tool error, and NOTHING was sent over the control socket.
    expect(res.result.isError).toBe(true);
    const payload = JSON.parse(res.result.content[0].text);
    expect(payload.error).toBe('missing_task_id');
    expect(received).toHaveLength(0);
  });
});
