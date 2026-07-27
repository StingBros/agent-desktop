#!/usr/bin/env node
// Agent-desktop ORCHESTRATION MCP ADAPTER — the bundled, dependency-free stdio MCP
// server attached to a launched COORDINATOR `claude` session. It exposes the seven
// project-scoped agent-management toolkit tools as MCP tools and forwards each tool
// call over the Rust CONTROL SOCKET to the frontend executor, returning the socket
// result as the MCP tool result (and surfacing a socket error as an MCP tool error).
//
// Same family/style as `resources/event-hook.cjs`: a self-contained CommonJS `.cjs`
// run by the host `node` with NO external dependencies. We do NOT pull in
// `@modelcontextprotocol/sdk` (it is not a reliable runtime dep for a bundled
// resource), so we implement just enough of the MCP stdio protocol by hand:
// JSON-RPC 2.0 over stdio — `initialize`, `tools/list`, `tools/call`, and the
// `notifications/initialized` notification.
//
// Transport contract with Rust (see `src-tauri/src/orchestration.rs`):
//   - Socket path arrives in env `AGENT_DESKTOP_CONTROL_SOCKET`.
//   - Framing: newline-delimited JSON, ONE request + ONE response per connection.
//   - Send (us → Rust): `{"op": string, "args": object}\n` (no id — Rust assigns it).
//   - Receive (Rust → us): one line — success `{"id", "result": <JSON>}`,
//     failure `{"id", "error": string}`, timeout `{"id", "error": "timeout"}`.
//
// PROJECT-SCOPING (add-agent-specialists, task 6.2): the frontend executor scopes
// EVERY op on `args.projectId` and REJECTS any op whose args lack it (the singleton
// executor may face several coordinators, one per project, so it never guesses). The
// coordinator LLM cannot be relied on to pass its own projectId, so the COORDINATOR
// LAUNCH stamps it into this adapter's env as `AGENT_DESKTOP_PROJECT_ID` and we MERGE
// it into the args of every forwarded tool call here. The injected id ALWAYS wins —
// a caller can never override the coordinator's own project scope.

'use strict';

const net = require('node:net');

/** Max ms to wait for the control socket connect+round-trip before giving up. */
const REQUEST_TIMEOUT_MS = 35000;

/** MCP protocol version we advertise in `initialize`. */
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Env var carrying the COORDINATOR's own project id into this adapter (stamped by
 * the coordinator launch). Merged into every forwarded tool call's args as
 * `projectId` so the frontend executor can scope the op (it rejects ops without it).
 * Must match `buildMcpToolkitConfig` / the executor's `args.projectId` contract.
 */
const PROJECT_ID_ENV = 'AGENT_DESKTOP_PROJECT_ID';

/**
 * The toolkit tools, each with the MCP input schema for the args its op needs. Args
 * are forwarded VERBATIM to the control socket — the executor (and the spec) own
 * validation/scoping; the adapter is a thin translation layer.
 */
const TOOLS = [
  {
    name: 'spawn_agent',
    description:
      "Spawn a new claude agent pane in the coordinator's project. Optionally compose it from a specialist (.claude/agents/<name>.md) and/or a working directory. Pass a goal to also create a tracked Task, bind it to the pane, and dispatch the worker with the back-channel report tools (report_done/report_blocked/ask_coordinator).",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Initial prompt/goal for the new agent.' },
        specialist: {
          type: 'string',
          description: 'Optional specialist name to compose the agent from.'
        },
        cwd: { type: 'string', description: 'Optional working directory for the agent.' },
        goal: {
          type: 'string',
          description:
            'Optional Task goal. When set, a Task is created and bound to the new pane and the worker is dispatched with the back-channel report tools; the Task id is returned alongside the pane id.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'assign_task',
    description:
      "Create a Task for a goal, spawn a worker to do it (optionally composed from a specialist), bind the Task to that worker, and dispatch it with the back-channel report tools. Returns the Task id and the worker's pane id.",
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'What the Task should accomplish.' },
        specialist: {
          type: 'string',
          description: 'Optional specialist name to compose the worker from.'
        }
      },
      required: ['goal']
    }
  },
  {
    name: 'list_tasks',
    description:
      "List the coordinator project's Tasks, optionally filtered by state (assigned|working|blocked|input-required|done|failed).",
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          description:
            'Optional lifecycle state filter: assigned, working, blocked, input-required, done, or failed.'
        }
      }
    }
  },
  {
    name: 'get_task',
    description: 'Get a single Task by id, returning its full details.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The Task id (e.g. T3).' } },
      required: ['id']
    }
  },
  {
    name: 'message_agent',
    description: 'Send a line of input to a running agent pane.',
    inputSchema: {
      type: 'object',
      properties: {
        paneId: { type: 'string', description: 'Target agent pane id.' },
        text: { type: 'string', description: 'Text to send to the agent.' }
      },
      required: ['paneId', 'text']
    }
  },
  {
    name: 'read_agent',
    description: "Read a running agent's recent output / activity.",
    inputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string', description: 'Target agent pane id.' } },
      required: ['paneId']
    }
  },
  {
    name: 'list_agents',
    description:
      "List every claude agent pane in the coordinator's project (coordinator-spawned and user-started).",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'inspect_agent',
    description: "Inspect a project agent pane and return its details.",
    inputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string', description: 'Target agent pane id.' } },
      required: ['paneId']
    }
  },
  {
    name: 'archive_agent',
    description: 'Archive a project agent pane.',
    inputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string', description: 'Target agent pane id.' } },
      required: ['paneId']
    }
  },
  {
    name: 'unarchive_agent',
    description: 'Unarchive a previously archived project agent pane.',
    inputSchema: {
      type: 'object',
      properties: { paneId: { type: 'string', description: 'Target agent pane id.' } },
      required: ['paneId']
    }
  },
  {
    name: 'request_user_input',
    description:
      "Notify the user that you (the coordinator) need their input — call this whenever you need a decision/answer from the user but are NOT asking via the AskUserQuestion tool. Surfaces the coordinator in the user's Needs-you lane. Otherwise keep working and delegating; do not sit idle expecting attention.",
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Optional short reason/prompt describing what you need from the user.'
        }
      }
    }
  }
];

/** Set of valid tool/op names, derived from TOOLS (single source of truth). */
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * PURE: encode a toolkit tool call into the exact newline-terminated request line
 * the control socket expects. `args` is forwarded verbatim (defaulting to `{}`).
 * No id is included — Rust assigns it. Exported for unit-testing without a socket.
 */
function encodeRequest(op, args) {
  const payload = { op, args: args && typeof args === 'object' ? args : {} };
  return `${JSON.stringify(payload)}\n`;
}

/**
 * PURE: merge the coordinator's `projectId` into a tool call's `args` so the
 * frontend executor can scope the op. The injected id ALWAYS wins (spread LAST) —
 * a caller can never override the coordinator's own project scope. A blank/missing
 * `projectId` is left untouched (the executor will reject the op, surfacing a clear
 * "missing projectId" error rather than silently running unscoped). Never mutates
 * the input args. Exported for unit-testing.
 */
function mergeProjectId(args, projectId) {
  const base = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (typeof projectId !== 'string' || projectId.trim() === '') return { ...base };
  return { ...base, projectId };
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
 * Round-trip one toolkit op over the control socket: connect, write the encoded
 * request line, read the single response line, and resolve a decoded outcome.
 * Resolves (never rejects) — connect/timeout/socket errors become an error
 * outcome so `tools/call` can surface them as a normal MCP tool error.
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
      // Server closed without a newline: decode whatever we have (handles a
      // response written without a trailing newline before close).
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

/**
 * Handle one parsed JSON-RPC request and return the response message to send, or
 * `null` for notifications (which get no response). `tools/call` forwards to the
 * control socket and shapes the outcome into MCP `content` (success) or
 * `isError: true` (failure), per the MCP tool-result convention.
 */
async function handle(req, socketPath, projectId) {
  const { id, method, params } = req || {};

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-desktop-orchestration', version: '0.1.0' }
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
      // Stamp the coordinator's own projectId into the args (caller can't override)
      // so the executor can scope this op to the coordinator's project.
      const scopedArgs = mergeProjectId(args, projectId);
      const outcome = await callControlSocket(socketPath, name, scopedArgs);
      if (outcome.ok) {
        // Surface the socket result as MCP tool content (JSON text block).
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(outcome.result) }]
        });
      }
      // Surface a socket error as an MCP tool error (isError, not a transport error).
      return rpcResult(id, {
        content: [{ type: 'text', text: outcome.error }],
        isError: true
      });
    }

    default:
      // Unknown method. Notifications (no id) are ignored; requests get an error.
      if (id === undefined || id === null) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  // The Rust control-socket path (orchestration::CONTROL_SOCKET_ENV). Stamped into
  // the session env by the coordinator launch (task 6.2) via the --mcp-config server's env.
  const socketPath = process.env.AGENT_DESKTOP_CONTROL_SOCKET || '';
  // The coordinator's own project id (stamped by the coordinator launch). Merged
  // into every tool call's args so the executor can scope the op to this project.
  const projectId = process.env[PROJECT_ID_ENV] || '';
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
      handle(req, socketPath, projectId).then((res) => {
        if (res) send(res);
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) {
  main();
}

module.exports = { encodeRequest, decodeResponse, mergeProjectId, TOOLS };
