#!/usr/bin/env node
// Agent-desktop BACK-CHANNEL MCP ADAPTER — the bundled, dependency-free stdio MCP
// server attached to a launched WORKER `claude` session THAT WAS DISPATCHED WITH A
// TASK. It exposes the four worker back-channel tools (report_progress / report_done
// / report_blocked / ask_coordinator) as MCP tools and forwards each tool call over
// the Rust CONTROL SOCKET to the frontend executor (the single writer of the task
// board), returning the socket result as the MCP tool result (and surfacing a socket
// error as an MCP tool error).
//
// Same family/style as `resources/orchestration-mcp.cjs` / `resources/event-hook.cjs`:
// a self-contained CommonJS `.cjs` run by the host `node` with NO external
// dependencies. We do NOT pull in `@modelcontextprotocol/sdk`; we implement just
// enough of the MCP stdio protocol by hand: JSON-RPC 2.0 over stdio — `initialize`,
// `tools/list`, `tools/call`, and the `notifications/initialized` notification.
//
// Transport contract with Rust (see `src-tauri/src/orchestration.rs`), IDENTICAL to
// the orchestration adapter:
//   - Socket path arrives in env `AGENT_DESKTOP_CONTROL_SOCKET`.
//   - Framing: newline-delimited JSON, ONE request + ONE response per connection.
//   - Send (us → Rust): `{"op": string, "args": object}\n` (no id — Rust assigns it).
//   - Receive (Rust → us): one line — success `{"id", "result": <JSON>}`,
//     failure `{"id", "error": string}`, timeout `{"id", "error": "timeout"}`.
//
// TASK-SCOPING (add-coordinator-task-backchannel, D3/D7): the frontend executor scopes
// EVERY back-channel op on the worker's Task id and REJECTS any op that lacks it (the
// singleton executor may face several workers across projects, so it never guesses).
// The worker LLM cannot be relied on to pass its own Task id, so the WORKER DISPATCH
// stamps it into this adapter's env as `AGENT_DESKTOP_TASK_ID` (reusing the existing
// `AGENT_DESKTOP_PROJECT_ID` / `AGENT_DESKTOP_PANE` env), and we MERGE those ids into
// the args of every forwarded tool call here. The injected ids ALWAYS win — a caller
// can never override the worker's own Task/project scope.
//
// FAIL-CLOSED (D7): if `AGENT_DESKTOP_TASK_ID` is missing/unresolvable, a tool call is
// rejected with a structured MCP tool error and NO mutation is sent over the socket.
// (In practice this adapter is only attached to Task-dispatched workers, so the env is
// present; the guard makes a misconfiguration a clear error rather than a silent
// unscoped mutation.)

'use strict';

const net = require('node:net');

/** Max ms to wait for the control socket connect+round-trip before giving up. */
const REQUEST_TIMEOUT_MS = 35000;

/** MCP protocol version we advertise in `initialize`. */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Env vars carrying the worker's own scope into this adapter (stamped by the worker
 * dispatch). Merged into every forwarded tool call's args so the frontend executor
 * can scope the op. `AGENT_DESKTOP_TASK_ID` is REQUIRED (fail-closed without it);
 * project/pane reuse the existing orchestration env names.
 */
const TASK_ID_ENV = 'AGENT_DESKTOP_TASK_ID';
const PROJECT_ID_ENV = 'AGENT_DESKTOP_PROJECT_ID';
const PANE_ENV = 'AGENT_DESKTOP_PANE';

/**
 * The four back-channel tools, each with the MCP input schema for the args its op
 * needs. Descriptions are short and action-oriented so a worker LLM uses them
 * correctly. The scope ids (taskId/projectId/paneId) are NOT tool args — they are
 * stamped from env; args here are only the worker-supplied payload, forwarded to the
 * control socket where the executor (and the spec) own validation/scoping.
 */
const TOOLS = [
  {
    name: 'report_progress',
    description:
      'Call to record progress on your assigned task without ending it; pass a short note describing what you just did. Updates the task board only — it does not end the task or interrupt the coordinator.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Short progress note (what you just did / are doing).' }
      },
      required: ['note']
    }
  },
  {
    name: 'report_done',
    description:
      'Call when your assigned task is complete; pass a short result summary and any artifact file paths. This is the authoritative completion signal — the task is only marked done when you call this.',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'string', description: 'Short summary of the completed result.' },
        artifacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of artifact file paths produced by the task.'
        }
      },
      required: ['result']
    }
  },
  {
    name: 'report_blocked',
    description:
      'Call when you are stuck and cannot proceed; pass a short reason. Marks your task blocked and notifies the coordinator so it can act.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason describing why you are blocked.' }
      },
      required: ['reason']
    }
  },
  {
    name: 'ask_coordinator',
    description:
      'Call to ask the coordinator a question about your assigned task; pass the question. The coordinator will reply — do NOT use this to ask the user.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question for the coordinator.' }
      },
      required: ['question']
    }
  }
];

/** Set of valid tool/op names, derived from TOOLS (single source of truth). */
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * PURE: encode a back-channel tool call into the exact newline-terminated request
 * line the control socket expects. `args` is forwarded verbatim (defaulting to `{}`).
 * No id is included — Rust assigns it. Exported for unit-testing without a socket.
 */
function encodeRequest(op, args) {
  const payload = { op, args: args && typeof args === 'object' ? args : {} };
  return `${JSON.stringify(payload)}\n`;
}

/**
 * PURE: merge the worker's scope ids (`taskId`, `projectId`, `paneId`) into a tool
 * call's `args` so the frontend executor can scope the op. Each injected id ALWAYS
 * wins (spread LAST) — a caller can never override the worker's own scope. A
 * blank/missing id for a given field is left off (the executor rejects an op missing
 * its required scope, surfacing a clear error rather than silently running unscoped).
 * Never mutates the input args. Exported for unit-testing.
 */
function stampScope(args, scope) {
  const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const out = { ...base };
  const s = scope || {};
  if (typeof s.taskId === 'string' && s.taskId.trim() !== '') out.taskId = s.taskId;
  if (typeof s.projectId === 'string' && s.projectId.trim() !== '') out.projectId = s.projectId;
  if (typeof s.paneId === 'string' && s.paneId.trim() !== '') out.paneId = s.paneId;
  return out;
}

/**
 * PURE: is the worker's Task id resolvable? Back-channel calls fail closed (D7) when
 * it is not — a missing/blank Task id means the executor cannot scope the mutation, so
 * we reject BEFORE touching the socket. Exported for unit-testing.
 */
function hasResolvableTaskId(scope) {
  return !!(scope && typeof scope.taskId === 'string' && scope.taskId.trim() !== '');
}

/**
 * PURE: parse a single control-socket response LINE into a normalized outcome:
 *   - `{ ok: true, result }` on success (`{ id, result }`)
 *   - `{ ok: false, error }` on failure/timeout (`{ id, error }`)
 *   - `{ ok: false, error }` on a malformed/empty/unrecognized line.
 * Never throws — a garbled response becomes an error outcome. Exported for tests.
 */
function decodeResponse(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return { ok: false, error: 'malformed response from control socket' };
  }
  if (!msg || typeof msg !== 'object') {
    return { ok: false, error: 'malformed response from control socket' };
  }
  if (typeof msg.error === 'string') {
    return { ok: false, error: msg.error };
  }
  if ('result' in msg) {
    return { ok: true, result: msg.result };
  }
  return { ok: false, error: 'control socket response missing result/error' };
}

/**
 * Round-trip one back-channel op over the control socket: connect, write the encoded
 * request line, read the single response line, and resolve a decoded outcome.
 * Resolves (never rejects) — connect/timeout/socket errors become an error outcome so
 * `tools/call` can surface them as a normal MCP tool error.
 */
function callControlSocket(socketPath, op, args) {
  return new Promise((resolve) => {
    if (!socketPath) {
      return resolve({ ok: false, error: 'AGENT_DESKTOP_CONTROL_SOCKET not set' });
    }
    let settled = false;
    let buf = '';
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch (_) {
        /* ignore */
      }
      resolve(outcome);
    };

    let sock;
    try {
      sock = net.createConnection({ path: socketPath });
    } catch (e) {
      return resolve({ ok: false, error: `control socket connect failed: ${e && e.message}` });
    }
    sock.setTimeout(REQUEST_TIMEOUT_MS);
    sock.on('connect', () => sock.write(encodeRequest(op, args)));
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        finish(decodeResponse(buf.slice(0, nl)));
      }
    });
    sock.on('end', () => {
      // Server closed without a newline: decode whatever we have (handles a response
      // written without a trailing newline before close).
      finish(buf ? decodeResponse(buf) : { ok: false, error: 'control socket closed without a response' });
    });
    sock.on('error', (e) => finish({ ok: false, error: `control socket error: ${e && e.message}` }));
    sock.on('timeout', () => finish({ ok: false, error: 'timeout' }));
  });
}

// ── Minimal JSON-RPC 2.0 stdio loop ────────────────────────────────────────────

/** Serialize and write one JSON-RPC message as a single line on stdout. */
function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** A JSON-RPC success response for `id`. */
function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** A JSON-RPC error response for `id`. */
function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** An MCP tool-result payload carrying a JSON-serialized error (isError: true). */
function toolError(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: true };
}

/**
 * Handle one parsed JSON-RPC request and return the response message to send, or
 * `null` for notifications (which get no response). `tools/call` fails closed when the
 * worker's Task id is unresolvable (no socket mutation), otherwise forwards to the
 * control socket and shapes the outcome into MCP `content` (success) or `isError: true`
 * (failure), per the MCP tool-result convention.
 */
async function handle(req, socketPath, scope) {
  const { id, method, params } = req || {};

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-desktop-back-channel', version: '0.1.0' }
      });

    // Notifications carry no id and expect no response.
    case 'notifications/initialized':
    case 'initialized':
      return null;

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      if (!TOOL_NAMES.has(name)) {
        return rpcError(id, -32602, `unknown tool: ${name}`);
      }
      // FAIL CLOSED (D7): without a resolvable Task id the executor cannot scope this
      // mutation, so reject BEFORE touching the socket — no Task is mutated.
      if (!hasResolvableTaskId(scope)) {
        return rpcResult(
          id,
          toolError({
            error: 'missing_task_id',
            message: `back-channel call rejected: ${TASK_ID_ENV} is not set/resolvable, so this worker has no Task to report on`
          })
        );
      }
      // Stamp the worker's own scope ids into the args (caller can't override) so the
      // executor can scope this op to the worker's Task/project.
      const scopedArgs = stampScope(args, scope);
      const outcome = await callControlSocket(socketPath, name, scopedArgs);
      if (outcome.ok) {
        // Surface the socket result as MCP tool content (JSON text block).
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.result) }]
        });
      }
      // Surface a socket error as an MCP tool error (isError, not a transport error).
      return rpcResult(id, toolError({ error: 'control_socket', message: outcome.error }));
    }

    default:
      // Unknown method. Notifications (no id) are ignored; requests get an error.
      if (id === undefined || id === null) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  // The Rust control-socket path (orchestration::CONTROL_SOCKET_ENV). Stamped into the
  // session env by the worker dispatch via the --mcp-config server's env.
  const socketPath = process.env.AGENT_DESKTOP_CONTROL_SOCKET || '';
  // The worker's own scope (stamped by the worker dispatch). Merged into every tool
  // call's args so the executor can scope the op to this Task/project.
  const scope = {
    taskId: process.env[TASK_ID_ENV] || '',
    projectId: process.env[PROJECT_ID_ENV] || '',
    paneId: process.env[PANE_ENV] || ''
  };
  let buf = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch (_) {
        // Parse error: per JSON-RPC, respond with a null-id error.
        send(rpcError(null, -32700, 'parse error'));
        continue;
      }
      // Serialize handling per line (await) so responses are emitted in order.
      handle(req, socketPath, scope).then((res) => {
        if (res) send(res);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) {
  main();
}

module.exports = { encodeRequest, decodeResponse, stampScope, hasResolvableTaskId, TOOLS };
