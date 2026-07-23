// PURE view-model for the project panel (projects capability): given the agent
// roster rows + the project list, compute each project's live agent COUNT,
// whether it NEEDS ATTENTION (any of its agents is waiting/errored), and whether
// it is WORKING (any of its agents is actively running), plus the filter that
// the panel's selection applies to the roster. Framework-free and unit-tested;
// the ProjectPanel component is the thin reactive shell.

import { needsAttention, isWorking, type AgentRow } from '../overview/roster';
import type { Project } from './projects';

/** The special filter value meaning "every agent, regardless of project". */
export const ALL = 'all' as const;
/** The special filter value meaning "agents with no project assigned". */
export const UNASSIGNED = '__unassigned__' as const;

/** A project filter selection: ALL, UNASSIGNED, or a concrete project id. */
export type ProjectFilter = typeof ALL | typeof UNASSIGNED | string;

/**
 * PURE: whether a row counts as a LIVE agent for the project counters — neither
 * archived (`closed`) nor previewing an archived session (`preview`). The panel's
 * per-project / unassigned / all-agents tallies count only these, so archiving an
 * agent decrements its project's counter and restoring it increments again.
 */
function isLiveAgent(row: AgentRow): boolean {
  return !row.closed && !row.preview;
}

/** One project's live rollup, as the panel renders it. */
export interface ProjectCount {
  project: Project;
  /** Number of agents currently assigned to this project. */
  count: number;
  /**
   * How many of this project's agents are WAITING on you (waiting / errored —
   * `needsAttention`). The panel shows this as the amber count; zero hides it.
   */
  waiting: number;
  /**
   * How many of this project's agents are actively WORKING (status `working`).
   * Independent of `waiting` (the two statuses are mutually exclusive); the panel
   * shows this as the blue count alongside the amber one. Zero hides it.
   */
  working: number;
}

/**
 * Per-project counts, in the given project order: the total live agents plus the
 * WAITING (needs-you) and WORKING breakdown the panel renders as two colored
 * counts. Agents whose `projectId` doesn't match any known project are ignored
 * here (they surface via the UNASSIGNED bucket / count instead).
 */
export function projectCounts(
  rows: ReadonlyArray<AgentRow>,
  projects: ReadonlyArray<Project>
): ProjectCount[] {
  return projects.map((project) => {
    const mine = rows.filter((r) => r.projectId === project.id && isLiveAgent(r));
    return {
      project,
      count: mine.length,
      waiting: mine.filter(needsAttention).length,
      working: mine.filter(isWorking).length
    };
  });
}

/**
 * How many LIVE agents there are in total (the panel's "All agents" tally),
 * excluding archived (`closed`) and previewed agents — the same non-archived
 * predicate the per-project and unassigned counts use, so all three agree.
 */
export function allAgentsCount(rows: ReadonlyArray<AgentRow>): number {
  return rows.filter(isLiveAgent).length;
}

/** How many agents have no project assigned (registry entry without a projectId). */
export function unassignedCount(rows: ReadonlyArray<AgentRow>): number {
  return rows.filter((r) => r.projectId === null && isLiveAgent(r)).length;
}

/**
 * Apply a panel selection to the roster:
 *  - ALL         -> every row
 *  - UNASSIGNED  -> rows with no project
 *  - <projectId> -> rows assigned to that project
 *
 * Pure: returns a new array, never mutates the input.
 */
export function filterRowsByProject(
  rows: ReadonlyArray<AgentRow>,
  selected: ProjectFilter
): AgentRow[] {
  if (selected === ALL) return [...rows];
  if (selected === UNASSIGNED) return rows.filter((r) => r.projectId === null);
  return rows.filter((r) => r.projectId === selected);
}

/**
 * The panel's filter options, top-to-bottom, for keyboard nav: ALL, then each
 * project (in list order), then UNASSIGNED iff any agent is unassigned. Matches
 * the panel's render order so `⌘⇧↑`/`⌘⇧↓` walks exactly what's on screen.
 */
export function filterOrder(
  projects: ReadonlyArray<Project>,
  hasUnassigned: boolean
): ProjectFilter[] {
  const order: ProjectFilter[] = [ALL, ...projects.map((p) => p.id)];
  if (hasUnassigned) order.push(UNASSIGNED);
  return order;
}

/**
 * Step from `current` by `dir` (+1 next / -1 previous) through `order`, clamped
 * at both ends (no wrap — mirrors the agent nav). If `current` isn't in `order`,
 * forward starts at the first entry and backward at the last.
 */
export function stepFilter(
  order: ReadonlyArray<ProjectFilter>,
  current: ProjectFilter,
  dir: 1 | -1
): ProjectFilter {
  if (order.length === 0) return current;
  const i = order.indexOf(current);
  if (i < 0) return dir === 1 ? order[0] : order[order.length - 1];
  const next = Math.min(order.length - 1, Math.max(0, i + dir));
  return order[next];
}
