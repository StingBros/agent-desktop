// Orchestration MCP adapter tests (add-agent-specialists, task 3.5).
//
// Covers the PURE request encoding / response decoding required directly from the
// production .cjs and asserted in-process — NO live socket needed. (The live
// round-trip + JSON-RPC loop are exercised end-to-end by the executor tasks.)
//
// Mirrors `event-hook.test.ts`: requires the .cjs via createRequire and asserts
// its exported pure core.

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = require('./orchestration-mcp.cjs') as typeof import('./orchestration-mcp.cjs');

describe('orchestration-mcp pure core', () => {
  it('encodes a tool call into one {op,args} request line', () => {
    const line = mcp.encodeRequest('message_agent', { paneId: 'p1', text: 'go' });
    // Exactly one newline-terminated JSON line.
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    // No id is sent — Rust assigns it. Args are forwarded verbatim.
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ op: 'message_agent', args: { paneId: 'p1', text: 'go' } });
    expect('id' in parsed).toBe(false);
  });

  it('defaults missing/invalid args to an empty object', () => {
    expect(JSON.parse(mcp.encodeRequest('list_agents'))).toEqual({ op: 'list_agents', args: {} });
    expect(JSON.parse(mcp.encodeRequest('list_agents', null))).toEqual({
      op: 'list_agents',
      args: {}
    });
  });

  it('decodes a success response line into an ok result', () => {
    const out = mcp.decodeResponse(JSON.stringify({ id: 7, result: { paneId: 'new-1' } }));
    expect(out).toEqual({ ok: true, result: { paneId: 'new-1' } });
    // A null result is still a success (distinct from an error).
    expect(mcp.decodeResponse(JSON.stringify({ id: 1, result: null }))).toEqual({
      ok: true,
      result: null
    });
  });

  it('decodes an error / timeout response line into an error outcome', () => {
    expect(mcp.decodeResponse(JSON.stringify({ id: 7, error: 'no such pane' }))).toEqual({
      ok: false,
      error: 'no such pane'
    });
    expect(mcp.decodeResponse(JSON.stringify({ id: 8, error: 'timeout' }))).toEqual({
      ok: false,
      error: 'timeout'
    });
  });

  it('decodes a malformed or incomplete line into an error outcome (never throws)', () => {
    expect(mcp.decodeResponse('not json').ok).toBe(false);
    expect(mcp.decodeResponse('').ok).toBe(false);
    expect(mcp.decodeResponse(JSON.stringify({ id: 1 })).ok).toBe(false);
  });

  it('merges the coordinator projectId into args (caller cannot override)', () => {
    // The coordinator's own projectId is stamped into every tool call's args so the
    // executor can scope the op. The injected id ALWAYS wins.
    expect(mcp.mergeProjectId({ paneId: 'p1', text: 'go' }, 'proj-A')).toEqual({
      paneId: 'p1',
      text: 'go',
      projectId: 'proj-A'
    });
    // A caller-supplied projectId is OVERRIDDEN by the coordinator's own (no escape).
    expect(mcp.mergeProjectId({ projectId: 'proj-OTHER', x: 1 }, 'proj-A')).toEqual({
      projectId: 'proj-A',
      x: 1
    });
    // Missing/blank projectId leaves args untouched (executor will reject the op).
    expect(mcp.mergeProjectId({ paneId: 'p1' }, '')).toEqual({ paneId: 'p1' });
    expect(mcp.mergeProjectId({ paneId: 'p1' }, '   ')).toEqual({ paneId: 'p1' });
    // Non-object args (null/array) default to a fresh object carrying just the id.
    expect(mcp.mergeProjectId(null, 'proj-A')).toEqual({ projectId: 'proj-A' });
    expect(mcp.mergeProjectId(undefined, 'proj-A')).toEqual({ projectId: 'proj-A' });
    // Never mutates the input args object.
    const input = { paneId: 'p1' };
    mcp.mergeProjectId(input, 'proj-A');
    expect(input).toEqual({ paneId: 'p1' });
  });

  it('exposes the toolkit tools (incl. request_user_input + task tools) with arg schemas', () => {
    const names = mcp.TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'archive_agent',
        'assign_task',
        'get_task',
        'inspect_agent',
        'list_agents',
        'list_tasks',
        'message_agent',
        'read_agent',
        'request_user_input',
        'spawn_agent',
        'unarchive_agent'
      ].sort()
    );
    // No governance tool leaks into the runtime toolkit.
    expect(names).not.toContain('answer_question');
    // Each tool advertises an object input schema.
    for (const t of mcp.TOOLS) {
      expect(t.inputSchema.type).toBe('object');
    }
  });

  it('exposes the coordinator task tools with their arg schemas', () => {
    const assign = mcp.TOOLS.find((t) => t.name === 'assign_task');
    expect(assign).toBeDefined();
    expect(assign!.inputSchema.properties).toHaveProperty('goal');
    expect(assign!.inputSchema.properties).toHaveProperty('specialist');
    // goal is required; specialist is optional.
    expect(assign!.inputSchema.required ?? []).toContain('goal');
    expect(assign!.inputSchema.required ?? []).not.toContain('specialist');

    const list = mcp.TOOLS.find((t) => t.name === 'list_tasks');
    expect(list).toBeDefined();
    expect(list!.inputSchema.properties).toHaveProperty('state');
    // state is an optional filter.
    expect(list!.inputSchema.required ?? []).not.toContain('state');

    const get = mcp.TOOLS.find((t) => t.name === 'get_task');
    expect(get).toBeDefined();
    expect(get!.inputSchema.properties).toHaveProperty('id');
    expect(get!.inputSchema.required ?? []).toContain('id');
  });

  it('spawn_agent advertises an optional goal (Task shortcut) alongside prompt', () => {
    const spawn = mcp.TOOLS.find((t) => t.name === 'spawn_agent');
    expect(spawn).toBeDefined();
    expect(spawn!.inputSchema.properties).toHaveProperty('goal');
    // prompt stays required; goal is optional (no-goal spawn is unchanged).
    expect(spawn!.inputSchema.required ?? []).toContain('prompt');
    expect(spawn!.inputSchema.required ?? []).not.toContain('goal');
  });

  it('stamps the coordinator projectId into a task-tool call and encodes it verbatim', () => {
    // assign_task forwards { goal, specialist } + the merged projectId as one {op,args} line.
    const scoped = mcp.mergeProjectId({ goal: 'ship it', specialist: 'reviewer' }, 'proj-A');
    const line = mcp.encodeRequest('assign_task', scoped);
    expect(JSON.parse(line)).toEqual({
      op: 'assign_task',
      args: { goal: 'ship it', specialist: 'reviewer', projectId: 'proj-A' }
    });
  });

  it('exposes request_user_input with an optional message arg', () => {
    const tool = mcp.TOOLS.find((t) => t.name === 'request_user_input');
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.properties).toHaveProperty('message');
    // `message` is optional — the coordinator may notify with no reason text.
    expect(tool!.inputSchema.required ?? []).not.toContain('message');
  });

  it('encodes request_user_input into one {op,args} request line', () => {
    const line = mcp.encodeRequest('request_user_input', { message: 'need a decision' });
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({ op: 'request_user_input', args: { message: 'need a decision' } });
    expect(line.endsWith('\n')).toBe(true);
  });
});
