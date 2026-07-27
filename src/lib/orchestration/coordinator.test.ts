import { describe, expect, it } from 'vitest';
import {
  ORCHESTRATOR_SYSTEM_PROMPT,
  archivedCoordinatorPane,
  coordinatorLaunchArgs,
  findCoordinatorPane,
  type CoordinatorPaneView
} from './coordinator';
import { buildMcpToolkitConfig } from '../usage/spawn';

describe('findCoordinatorPane (single-coordinator reuse, task 6.3)', () => {
  const panes: CoordinatorPaneView[] = [
    { paneId: 'shell-1', program: '/bin/zsh', projectId: 'A', role: 'coordinator' },
    { paneId: 'agent-1', program: 'claude', projectId: 'A' },
    { paneId: 'coord-A', program: 'claude', projectId: 'A', role: 'coordinator' },
    { paneId: 'coord-B', program: 'claude', projectId: 'B', role: 'coordinator' }
  ];

  it('finds the live coordinator for a project', () => {
    expect(findCoordinatorPane(panes, 'A')?.paneId).toBe('coord-A');
    expect(findCoordinatorPane(panes, 'B')?.paneId).toBe('coord-B');
  });

  it('returns null when a project has no coordinator', () => {
    expect(findCoordinatorPane(panes, 'C')).toBeNull();
  });

  it('ignores a non-claude pane even if marked coordinator', () => {
    // The shell pane in project A is role:coordinator but not claude — never matched.
    expect(findCoordinatorPane([panes[0]], 'A')).toBeNull();
  });

  it('ignores a closed (archived) coordinator', () => {
    const closed: CoordinatorPaneView[] = [
      { paneId: 'coord-A', program: 'claude', projectId: 'A', role: 'coordinator', closed: true }
    ];
    expect(findCoordinatorPane(closed, 'A')).toBeNull();
  });

  it('ignores a plain (non-coordinator) claude pane', () => {
    expect(findCoordinatorPane([panes[1]], 'A')).toBeNull();
  });

  it('returns null for a blank projectId', () => {
    expect(findCoordinatorPane(panes, '')).toBeNull();
    expect(findCoordinatorPane(panes, '   ')).toBeNull();
  });
});

describe('archivedCoordinatorPane / findCoordinatorPane are complementary (coordinator-lifecycle)', () => {
  it('finds an ARCHIVED coordinator that findCoordinatorPane ignores, and vice versa', () => {
    const live: CoordinatorPaneView = {
      paneId: 'coord-live',
      program: 'claude',
      projectId: 'A',
      role: 'coordinator'
    };
    const archived: CoordinatorPaneView = {
      paneId: 'coord-archived',
      program: 'claude',
      projectId: 'A',
      role: 'coordinator',
      closed: true
    };

    // A LIVE coordinator: found by findCoordinatorPane, NOT by archivedCoordinatorPane.
    expect(findCoordinatorPane([live], 'A')?.paneId).toBe('coord-live');
    expect(archivedCoordinatorPane([live], 'A')).toBeNull();

    // An ARCHIVED coordinator: found by archivedCoordinatorPane, NOT by findCoordinatorPane.
    expect(archivedCoordinatorPane([archived], 'A')?.paneId).toBe('coord-archived');
    expect(findCoordinatorPane([archived], 'A')).toBeNull();
  });

  it('mirrors findCoordinatorPane EXACTLY except for the closed flag', () => {
    // Same non-closed predicates: claude program, coordinator role, matching project.
    const shellCoord: CoordinatorPaneView = {
      paneId: 'shell',
      program: '/bin/zsh',
      projectId: 'A',
      role: 'coordinator',
      closed: true
    };
    const plainClaude: CoordinatorPaneView = {
      paneId: 'plain',
      program: 'claude',
      projectId: 'A',
      closed: true
    };
    const otherProject: CoordinatorPaneView = {
      paneId: 'coord-B',
      program: 'claude',
      projectId: 'B',
      role: 'coordinator',
      closed: true
    };
    // None qualify for project A: not claude / not coordinator / wrong project.
    expect(archivedCoordinatorPane([shellCoord, plainClaude, otherProject], 'A')).toBeNull();
    // A blank projectId is rejected, exactly like findCoordinatorPane.
    expect(
      archivedCoordinatorPane(
        [{ paneId: 'x', program: 'claude', projectId: 'A', role: 'coordinator', closed: true }],
        ''
      )
    ).toBeNull();
  });
});

describe('coordinatorLaunchArgs (task 6.2)', () => {
  const cfg = buildMcpToolkitConfig('/bin/orchestration-mcp.js', '/control.sock', 'proj-A');

  it('composes append-system-prompt + inline mcp-config', () => {
    const args = coordinatorLaunchArgs(cfg);
    expect(args[0]).toBe('--append-system-prompt');
    expect(args[1]).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    expect(args[2]).toBe('--mcp-config');
    // The mcp-config is inline JSON that round-trips back to the config object.
    expect(JSON.parse(args[3])).toEqual(cfg);
  });

  it('disallows the work tools + internal Task tool (task 10.1)', () => {
    const args = coordinatorLaunchArgs(cfg);
    const i = args.indexOf('--disallowedTools');
    expect(i).toBeGreaterThanOrEqual(0);
    // Each tool is a separate arg (claude's variadic flag), in this exact order.
    expect(args.slice(i + 1, i + 6)).toEqual(['Edit', 'Write', 'Bash', 'NotebookEdit', 'Task']);
  });

  it('still attaches the orchestration toolkit + orchestrator prompt alongside the deny-list', () => {
    const args = coordinatorLaunchArgs(cfg);
    // append-system-prompt + its value still present.
    const sp = args.indexOf('--append-system-prompt');
    expect(sp).toBeGreaterThanOrEqual(0);
    expect(args[sp + 1]).toBe(ORCHESTRATOR_SYSTEM_PROMPT);
    // mcp-config still present + round-trips to the toolkit config.
    const mc = args.indexOf('--mcp-config');
    expect(mc).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(args[mc + 1])).toEqual(cfg);
    // The deny-list MUST NOT name the orchestration MCP tools or read-only tools.
    expect(args).not.toContain('Read');
    expect(args).not.toContain('Glob');
    expect(args).not.toContain('Grep');
    expect(args.some((a) => a.startsWith('mcp__orchestration__'))).toBe(false);
  });

  it('carries the coordinator projectId in the mcp-config env (project scoping)', () => {
    const args = coordinatorLaunchArgs(cfg);
    const parsed = JSON.parse(args[3]);
    expect(parsed.mcpServers.orchestration.env.AGENT_DESKTOP_PROJECT_ID).toBe('proj-A');
    expect(parsed.mcpServers.orchestration.env.AGENT_DESKTOP_CONTROL_SOCKET).toBe('/control.sock');
  });

  it('accepts a custom system prompt', () => {
    const args = coordinatorLaunchArgs(cfg, 'CUSTOM');
    expect(args[1]).toBe('CUSTOM');
  });
});

describe('ORCHESTRATOR_SYSTEM_PROMPT (task-board driven, tasks 9.1–9.2)', () => {
  it('is a focused orchestrator prompt with NO governance/guardrails', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/coordinat/i);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/spawn_agent/);
    // Explicitly disclaims guardrail/approval responsibilities (separate future change).
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/guardrail|approval/i);
  });

  it('instructs the coordinator to delegate via the task tools and never do work itself (task 10.1)', () => {
    // Must NOT do hands-on work directly.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/do not|don't|never/i);
    // Must delegate via assign_task, with spawn_agent(goal) as the shortcut.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/assign_task/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/spawn_agent/);
    // Must not use the internal Task tool.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/Task tool/);
  });

  it('drives off the Task board and pushed reports, not a poll loop (tasks 9.1, D5)', () => {
    // Breaks a goal into Tasks, one unit of work each.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/Task board/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/one .*unit of work per Task/i);
    // Explicitly NOT a poll loop; reacts to pushed reports instead.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/poll loop/i);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/push/i);
    // Reacts to the three structured report kinds.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/DONE/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/BLOCKED/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/QUESTION/);
    // May reconcile via the board read tools, but need not poll.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/list_tasks/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/get_task/);
    // Answers a worker's question/block via message_agent.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/message_agent/);
  });

  it('treats report_done as authoritative completion and verifies via read_agent (task 9.1, D6)', () => {
    // report_done is the authoritative completion signal.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/report_done/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/authoritative/i);
    // Do NOT infer completion from a worker going quiet/idle.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/quiet|idle/i);
    // Verify a result's detail with read_agent.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/read_agent/);
  });

  it('remains an interactive chat surface for the user (spec: coordinator remains a chat surface)', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/chat surface/i);
  });

  it('archives finished agents it spawned (preserved rule)', () => {
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/archive_agent/);
  });

  it('instructs the coordinator to call request_user_input when it needs you (tasks 10.11–10.12)', () => {
    // Names the explicit needs-input tool + how it surfaces.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/request_user_input/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/mcp__orchestration__request_user_input/);
    // It's a MUST, and references the AskUserQuestion alternative.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/MUST/);
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/AskUserQuestion/);
    // It should not sit idle expecting attention — keep working/delegating.
    expect(ORCHESTRATOR_SYSTEM_PROMPT).toMatch(/idle/i);
  });
});
