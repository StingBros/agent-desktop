import { describe, expect, it } from 'vitest';

// Unit tests for the PURE specialist → claude-CLI-args mapping (design D4). Runs
// under the default node env (no Svelte/Tauri imports in the module under test).

import { specialistLaunchArgs, taskWorkerLaunchArgs } from './launchArgs';
import {
  BACK_CHANNEL_MCP_SERVER,
  buildBackChannelMcpConfig,
  taskContractPrompt
} from '../usage/spawn';
import type { Specialist } from '../specialists/specialists';

function spec(over: Partial<Specialist> = {}): Specialist {
  return { name: 's', description: 'd', prompt: 'You are a tester.', ...over };
}

describe('specialistLaunchArgs', () => {
  it('maps all fields: body → --append-system-prompt, model, allowedTools', () => {
    const s = spec({
      prompt: 'You are a meticulous test author.',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Edit', 'Bash']
    });
    expect(specialistLaunchArgs(s)).toEqual([
      '--append-system-prompt',
      'You are a meticulous test author.',
      '--model',
      'claude-sonnet-4-6',
      '--allowedTools',
      'Read',
      'Edit',
      'Bash'
    ]);
  });

  it('only-required: just the body becomes --append-system-prompt', () => {
    const s = spec({ prompt: 'Persona only.' });
    expect(specialistLaunchArgs(s)).toEqual(['--append-system-prompt', 'Persona only.']);
  });

  it('with-tools but no model: emits each tool as a separate arg, no --model', () => {
    const s = spec({ prompt: 'Body.', tools: ['Read', 'Grep'] });
    expect(specialistLaunchArgs(s)).toEqual([
      '--append-system-prompt',
      'Body.',
      '--allowedTools',
      'Read',
      'Grep'
    ]);
  });

  it('omits the body when blank, and omits empty/blank model + tools', () => {
    const s = spec({ prompt: '   ', model: '  ', tools: ['', '  '] });
    expect(specialistLaunchArgs(s)).toEqual([]);
  });

  it('passes the body VERBATIM (untrimmed) once it is non-blank', () => {
    const s = spec({ prompt: '  leading + trailing spaces kept  ' });
    expect(specialistLaunchArgs(s)).toEqual([
      '--append-system-prompt',
      '  leading + trailing spaces kept  '
    ]);
  });
});

// Task 7.3: the Task-dispatched WORKER launch args (design D3). Attached ONLY when a
// worker is dispatched for a Task (never a plain user session, never the coordinator) —
// so these tests exercise the ADDITIVE, Task-gated behaviour: back-channel MCP attached,
// Task id stamped (into the mcp-config env), the contract appended, and the specialist
// prompt composed alongside the contract when both are present.
describe('taskWorkerLaunchArgs', () => {
  const ADAPTER = '/app/bin/back-channel-mcp.js';
  const SOCKET = '/app/control.sock';

  /** Parse the --mcp-config JSON arg out of a built arg list. */
  function mcpConfigOf(args: string[]): unknown {
    const i = args.indexOf('--mcp-config');
    expect(i).toBeGreaterThanOrEqual(0);
    return JSON.parse(args[i + 1]);
  }
  /** Grab the value that follows a flag. */
  function valueAfter(args: string[], flag: string): string {
    const i = args.indexOf(flag);
    expect(i).toBeGreaterThanOrEqual(0);
    return args[i + 1];
  }

  it('attaches the back-channel MCP, stamps the Task id, and appends the contract (no specialist)', () => {
    const mcpConfig = buildBackChannelMcpConfig(ADAPTER, SOCKET, 'T1', 'proj-1');
    const args = taskWorkerLaunchArgs({ mcpConfig, taskId: 'T1' });

    // Contract appended as the whole system prompt (no specialist body to compose with).
    expect(valueAfter(args, '--append-system-prompt')).toBe(taskContractPrompt('T1'));

    // Back-channel MCP attached with the Task id + project stamped into its server env.
    const cfg = mcpConfigOf(args) as ReturnType<typeof buildBackChannelMcpConfig>;
    expect(Object.keys(cfg.mcpServers)).toEqual([BACK_CHANNEL_MCP_SERVER]);
    expect(cfg.mcpServers.backchannel.args).toEqual([ADAPTER]);
    expect(cfg.mcpServers.backchannel.env.AGENT_DESKTOP_TASK_ID).toBe('T1');
    expect(cfg.mcpServers.backchannel.env.AGENT_DESKTOP_CONTROL_SOCKET).toBe(SOCKET);
    expect(cfg.mcpServers.backchannel.env.AGENT_DESKTOP_PROJECT_ID).toBe('proj-1');

    // No specialist -> no --model / --allowedTools.
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--allowedTools');
  });

  it('composes the specialist system prompt ALONGSIDE the contract when both are present', () => {
    const s = spec({
      prompt: 'You are a meticulous test author.',
      model: 'claude-sonnet-4-6',
      tools: ['Read', 'Edit']
    });
    const mcpConfig = buildBackChannelMcpConfig(ADAPTER, SOCKET, 'T2', 'proj-2');
    const args = taskWorkerLaunchArgs({ mcpConfig, taskId: 'T2', specialist: s });

    // The combined prompt keeps the specialist persona FIRST, then the Task contract —
    // both survive so the worker has its persona AND the reporting instructions.
    const prompt = valueAfter(args, '--append-system-prompt');
    expect(prompt).toBe(`You are a meticulous test author.\n\n${taskContractPrompt('T2')}`);
    expect(prompt).toContain('meticulous test author');
    expect(prompt).toContain('report_done');

    // Specialist model + tools still pass through verbatim.
    expect(valueAfter(args, '--model')).toBe('claude-sonnet-4-6');
    const ti = args.indexOf('--allowedTools');
    expect(args.slice(ti + 1, ti + 3)).toEqual(['Read', 'Edit']);

    // And the back-channel is still attached with this Task's id.
    const cfg = mcpConfigOf(args) as ReturnType<typeof buildBackChannelMcpConfig>;
    expect(cfg.mcpServers.backchannel.env.AGENT_DESKTOP_TASK_ID).toBe('T2');
  });

  it('a blank-body specialist still gets the contract as its system prompt', () => {
    const s = spec({ prompt: '   ', tools: ['Grep'] });
    const mcpConfig = buildBackChannelMcpConfig(ADAPTER, SOCKET, 'T3', 'proj-3');
    const args = taskWorkerLaunchArgs({ mcpConfig, taskId: 'T3', specialist: s });
    // Blank body contributes nothing, so the contract alone is the system prompt.
    expect(valueAfter(args, '--append-system-prompt')).toBe(taskContractPrompt('T3'));
    // Non-empty tool list still passes through.
    expect(args).toContain('--allowedTools');
  });

  it('a plain specialist launch (no Task) carries NONE of the back-channel wiring', () => {
    // The negative case: specialistLaunchArgs is the non-dispatched path — no --mcp-config,
    // no Task id, no contract. This is what a plain user session / undispatched spawn uses.
    const s = spec({ prompt: 'Persona only.', tools: ['Read'] });
    const args = specialistLaunchArgs(s);
    expect(args).not.toContain('--mcp-config');
    expect(args.join('\n')).not.toContain('report_done');
    expect(args.join('\n')).not.toContain('AGENT_DESKTOP_TASK_ID');
    expect(valueAfter(args, '--append-system-prompt')).toBe('Persona only.');
  });
});
