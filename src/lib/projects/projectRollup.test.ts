import { describe, expect, it } from 'vitest';
import {
  projectCounts,
  unassignedCount,
  filterRowsByProject,
  filterOrder,
  stepFilter,
  ALL,
  UNASSIGNED
} from './projectRollup';
import type { AgentRow, AgentStatus } from '../overview/roster';
import type { Project } from './projects';

function row(paneId: string, projectId: string | null, status: AgentStatus): AgentRow {
  return {
    paneId,
    workspaceId: 'ws',
    name: paneId,
    cwd: null,
    model: null,
    modelId: null,
    task: null,
    summary: null,
    question: null,
    questions: null,
    currentAction: null,
    contextPct: null,
    cost: null,
    lastTs: null,
    status,
    projectId
  };
}

function proj(id: string): Project {
  return { id, name: id, path: '/' + id, icon: 'box', color: '#4C8DFF' };
}

describe('projectRollup — Filter agents by project', () => {
  const projects = [proj('pay'), proj('web')];
  const rows = [
    row('a', 'pay', 'working'),
    row('b', 'pay', 'waiting'), // attention
    row('c', 'web', 'finished'),
    row('d', null, 'working') // unassigned
  ];

  it('counts agents per project and breaks down waiting + working', () => {
    const counts = projectCounts(rows, projects);
    expect(counts.map((c) => [c.project.id, c.count, c.waiting, c.working])).toEqual([
      ['pay', 2, 1, 1], // b waiting -> waiting:1; a working -> working:1
      ['web', 1, 0, 0] // c finished -> neither
    ]);
    expect(unassignedCount(rows)).toBe(1);
  });

  it('counts multiple waiting and working agents independently', () => {
    const ps = [proj('a')];
    const rs = [
      row('w1', 'a', 'waiting'),
      row('w2', 'a', 'error'), // errored also counts as waiting-on-you
      row('k1', 'a', 'working'),
      row('k2', 'a', 'working'),
      row('k3', 'a', 'working'),
      row('i', 'a', 'idle') // neither waiting nor working
    ];
    const c = projectCounts(rs, ps)[0];
    expect([c.count, c.waiting, c.working]).toEqual([6, 2, 3]);
  });

  it('a paused/archived working agent is not counted as working', () => {
    const ps = [proj('a')];
    expect(
      projectCounts([{ ...row('z', 'a', 'working'), paused: true }], ps).find(
        (c) => c.project.id === 'a'
      )?.working
    ).toBe(0);
  });

  it('waiting and working are counted independently (both non-zero together)', () => {
    const ps = [proj('c')];
    const counts = projectCounts(
      [
        row('x', 'c', 'waiting'), // needs you
        row('y', 'c', 'working') // also working
      ],
      ps
    );
    // Both counts raised; the panel shows the amber AND the blue count side by side.
    expect(counts[0].waiting).toBe(1);
    expect(counts[0].working).toBe(1);
  });

  it('Filter agents by project', () => {
    expect(filterRowsByProject(rows, ALL).map((r) => r.paneId)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterRowsByProject(rows, 'pay').map((r) => r.paneId)).toEqual(['a', 'b']);
    expect(filterRowsByProject(rows, 'web').map((r) => r.paneId)).toEqual(['c']);
    expect(filterRowsByProject(rows, UNASSIGNED).map((r) => r.paneId)).toEqual(['d']);
  });
});

describe('projectRollup — counters exclude archived/preview agents', () => {
  const projects = [proj('pay'), proj('web')];

  it('per-project count excludes archived (closed) agents', () => {
    const rows = [
      row('a', 'pay', 'working'),
      { ...row('b', 'pay', 'finished'), closed: true }, // archived -> excluded
      row('c', 'web', 'working')
    ];
    const counts = projectCounts(rows, projects);
    expect(counts.map((c) => [c.project.id, c.count])).toEqual([
      ['pay', 1], // b is archived, only a counts
      ['web', 1]
    ]);
  });

  it('per-project count excludes previewed agents', () => {
    const rows = [
      row('a', 'pay', 'working'),
      { ...row('b', 'pay', 'working'), preview: true } // preview -> excluded
    ];
    const counts = projectCounts(rows, projects);
    expect(counts.find((c) => c.project.id === 'pay')?.count).toBe(1);
  });

  it('unassigned count excludes archived and previewed agents', () => {
    const rows = [
      row('a', null, 'working'),
      { ...row('b', null, 'finished'), closed: true }, // archived
      { ...row('c', null, 'working'), preview: true } // preview
    ];
    expect(unassignedCount(rows)).toBe(1); // only a
  });

  it('archiving a live agent decrements its project counter; restoring increments again', () => {
    const live = [row('a', 'pay', 'working'), row('b', 'pay', 'working')];
    expect(projectCounts(live, projects).find((c) => c.project.id === 'pay')?.count).toBe(2);

    // Archive b -> counter drops to 1.
    const archived = [live[0], { ...live[1], closed: true }];
    expect(projectCounts(archived, projects).find((c) => c.project.id === 'pay')?.count).toBe(1);

    // Restore b (no longer closed) -> counter back to 2.
    const restored = [live[0], { ...archived[1], closed: false }];
    expect(projectCounts(restored, projects).find((c) => c.project.id === 'pay')?.count).toBe(2);
  });
});

describe('projectRollup — keyboard filter nav', () => {
  const projects = [proj('pay'), proj('web')];

  it('orders ALL, then projects, then UNASSIGNED only when present', () => {
    expect(filterOrder(projects, true)).toEqual([ALL, 'pay', 'web', UNASSIGNED]);
    expect(filterOrder(projects, false)).toEqual([ALL, 'pay', 'web']);
    expect(filterOrder([], false)).toEqual([ALL]);
  });

  it('steps next/previous through the order, clamped at both ends', () => {
    const order = filterOrder(projects, true); // [ALL, pay, web, UNASSIGNED]
    expect(stepFilter(order, ALL, 1)).toBe('pay');
    expect(stepFilter(order, 'web', 1)).toBe(UNASSIGNED);
    expect(stepFilter(order, UNASSIGNED, 1)).toBe(UNASSIGNED); // clamp at end
    expect(stepFilter(order, 'pay', -1)).toBe(ALL);
    expect(stepFilter(order, ALL, -1)).toBe(ALL); // clamp at start
  });

  it('starts from an end when the current selection is not in the order', () => {
    const order = filterOrder(projects, false); // [ALL, pay, web]
    expect(stepFilter(order, 'gone', 1)).toBe(ALL); // forward -> first
    expect(stepFilter(order, 'gone', -1)).toBe('web'); // backward -> last
  });
});
