// Durable UI-LAYOUT preferences — the "remembered" window-chrome choices that are
// neither agent state nor a regenerable cache: whether the project pane is
// collapsed, the terminals-panel width, the tasks-launcher split fraction, the
// selected project filter, and the manual order of the draggable lanes.
//
// WHY a settings slice and not localStorage: WKWebView (the Tauri webview on
// macOS) buffers localStorage in memory and only flushes it lazily, so an abrupt
// exit — `Ctrl-C` on `tauri dev`, a hot-reload, a crash, a force-quit — drops the
// un-flushed writes and the layout "forgets" on the next launch. `settings.json`
// is written through the Rust side atomically (temp file + rename) the moment a
// pref changes, so it survives. These all live as ONE `ui` slice with this store
// as the slice's sole writer (no read-modify-write race within the slice).
//
// localStorage stays reserved for genuinely regenerable session caches (titles,
// summaries, costs) — see `tools/check-localstorage.mjs`, which fails the build
// if a new non-cache store reaches for localStorage.

import { loadSettings, saveSettingsSlice } from './persist';
import { Debouncer } from '../layout/persistence';

/** The settings.json top-level key these preferences occupy. */
const SLICE_KEY = 'ui';

/** Terminals docked-panel width bounds (px). Owned here now that this store
 *  persists the width; `tasks/panel.svelte.ts` delegates clamping to us. */
export const TERMINALS_WIDTH_MIN = 260;
export const TERMINALS_WIDTH_MAX = 1000;
const TERMINALS_WIDTH_DEFAULT = 380;

/** Tasks-launcher bottom-region fraction bounds (of the sessions column). */
export const TASKS_FRAC_MIN = 0.15;
export const TASKS_FRAC_MAX = 0.6;
const TASKS_FRAC_DEFAULT = 0.33;

/** Default project filter: the `all` sentinel (mirrors `projectRollup.ALL`; kept
 *  as a literal so this settings module stays free of a projects dependency). */
const PROJECT_FILTER_DEFAULT = 'all';

/** Persisted order of the two manually-reorderable lanes. The non-draggable
 *  lanes (flight/done) re-derive newest-first each session and are never stored. */
export interface LaneOrderPrefs {
  attn: string[];
  paused: string[];
}

/** The durable UI-layout preferences. */
export interface UiPrefs {
  projectPaneCollapsed: boolean;
  terminalsWidth: number;
  tasksLauncherFrac: number;
  projectFilter: string;
  laneOrder: LaneOrderPrefs;
  /** The most-recently-active session per project — a map of project id → the
   *  session's STABLE registry sessionId (survives restart / `--resume`, unlike a
   *  paneId). Lets opening a project restore where the user left off (default-select
   *  the last used session). A project absent from the map has no recorded session. */
  lastSessionByProject: Record<string, string>;
}

/** Defaults for a fresh install. */
export const DEFAULT_UI_PREFS: UiPrefs = {
  projectPaneCollapsed: false,
  terminalsWidth: TERMINALS_WIDTH_DEFAULT,
  tasksLauncherFrac: TASKS_FRAC_DEFAULT,
  projectFilter: PROJECT_FILTER_DEFAULT,
  laneOrder: { attn: [], paused: [] },
  lastSessionByProject: {}
};

/** Clamp a terminals-panel width into [MIN, MAX] (rounded). */
export function clampTerminalsWidth(px: number): number {
  return Math.max(TERMINALS_WIDTH_MIN, Math.min(TERMINALS_WIDTH_MAX, Math.round(px)));
}

/** Clamp a tasks-launcher fraction into [MIN, MAX]. */
export function clampTasksFrac(f: number): number {
  return Math.max(TASKS_FRAC_MIN, Math.min(TASKS_FRAC_MAX, f));
}

/** PURE: keep only the string entries of an arbitrary value (else []). */
function stringIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** PURE: keep only the string→NON-EMPTY-string entries of an arbitrary value (else
 *  {}). Used to normalize the persisted `lastSessionByProject` map — a non-object,
 *  an array, or a non-string / empty value is dropped per key. */
function stringStringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && val !== '') out[key] = val;
  }
  return out;
}

/**
 * PURE: validate/normalize the persisted `ui` slice into a fully-defaulted
 * `UiPrefs`. Tolerates any shape — a non-object, missing fields, or wrong types
 * fall back to `DEFAULT_UI_PREFS` per field; out-of-range numbers are clamped;
 * non-string lane ids are dropped.
 */
export function parseUiPrefs(raw: unknown): UiPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return structuredClone(DEFAULT_UI_PREFS);
  }
  const o = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number, clamp: (n: number) => number): number =>
    typeof v === 'number' && Number.isFinite(v) ? clamp(v) : fallback;
  const laneRaw =
    o.laneOrder && typeof o.laneOrder === 'object' && !Array.isArray(o.laneOrder)
      ? (o.laneOrder as Record<string, unknown>)
      : {};
  return {
    projectPaneCollapsed:
      typeof o.projectPaneCollapsed === 'boolean'
        ? o.projectPaneCollapsed
        : DEFAULT_UI_PREFS.projectPaneCollapsed,
    terminalsWidth: num(o.terminalsWidth, TERMINALS_WIDTH_DEFAULT, clampTerminalsWidth),
    tasksLauncherFrac: num(o.tasksLauncherFrac, TASKS_FRAC_DEFAULT, clampTasksFrac),
    // Empty string is treated as the default: it is neither ALL nor UNASSIGNED nor
    // a real project id (ids are guaranteed non-empty), so it would otherwise
    // filter the roster to nothing with no matching chip (only reachable via a
    // hand-edited settings.json).
    projectFilter:
      typeof o.projectFilter === 'string' && o.projectFilter !== ''
        ? o.projectFilter
        : PROJECT_FILTER_DEFAULT,
    laneOrder: { attn: stringIds(laneRaw.attn), paused: stringIds(laneRaw.paused) },
    lastSessionByProject: stringStringRecord(o.lastSessionByProject)
  };
}

/**
 * Reactive durable UI-preferences store. Singleton, the sole writer of the `ui`
 * settings slice. Seeded with defaults so the UI renders immediately; `hydrate()`
 * (called once on app mount) loads the persisted values and reactively corrects
 * them, mirroring the voice/open-with stores.
 */
export class UiPrefsStore {
  /** The live preferences (deep-reactive via the runes proxy). */
  data = $state<UiPrefs>(structuredClone(DEFAULT_UI_PREFS));

  /** True once `hydrate()` has resolved (consumers gate one-time seeding on it). */
  loaded = $state(false);

  // The drag-driven setters (width, tasks-fraction) fire on every pointermove, so
  // their persistence is trailing-debounced into a single write per gesture: the
  // reactive value updates live for the UI, but we don't hammer the async settings
  // round-trip (and don't widen the read-modify-write window against sibling slices)
  // on every move. Discrete setters (collapse, filter, lane order) persist at once.
  #persistDebouncer = new Debouncer(() => void this.save(), 200);

  /** Load the persisted `ui` slice. Defaults apply on a fresh install. Never
   *  throws. Call once on mount. */
  async hydrate(): Promise<void> {
    const settings = await loadSettings();
    this.data = parseUiPrefs(settings[SLICE_KEY]);
    this.loaded = true;
  }

  /** Collapse/expand the left project pane and persist (best-effort). */
  setProjectPaneCollapsed(collapsed: boolean): void {
    this.data = { ...this.data, projectPaneCollapsed: collapsed };
    void this.save();
  }

  /** Set the terminals-panel width (clamped). Fired on every drag tick, so the
   *  write is trailing-debounced into one persist per gesture. */
  setTerminalsWidth(px: number): void {
    this.data = { ...this.data, terminalsWidth: clampTerminalsWidth(px) };
    this.#persistDebouncer.schedule();
  }

  /** Set the tasks-launcher fraction (clamped). Fired on every drag tick, so the
   *  write is trailing-debounced into one persist per gesture. */
  setTasksLauncherFrac(frac: number): void {
    this.data = { ...this.data, tasksLauncherFrac: clampTasksFrac(frac) };
    this.#persistDebouncer.schedule();
  }

  /** Set the selected project filter and persist (best-effort). */
  setProjectFilter(value: string): void {
    this.data = { ...this.data, projectFilter: value };
    void this.save();
  }

  /** Set the manual lane order (attn + paused) and persist (best-effort). */
  setLaneOrder(order: LaneOrderPrefs): void {
    this.data = { ...this.data, laneOrder: { attn: [...order.attn], paused: [...order.paused] } };
    void this.save();
  }

  /** Record `sessionId` as the most-recently-active session for `projectId` and
   *  persist (best-effort). A NO-OP (no state change, no write) when it already
   *  matches or when either id is blank — so this can be called from a reactive
   *  effect on every focus tick without thrashing the `settings.json` write. */
  setLastSessionForProject(projectId: string, sessionId: string): void {
    if (!projectId || !sessionId) return;
    if (this.data.lastSessionByProject[projectId] === sessionId) return;
    this.data = {
      ...this.data,
      lastSessionByProject: { ...this.data.lastSessionByProject, [projectId]: sessionId }
    };
    void this.save();
  }

  /** Persist the current prefs as the `ui` slice, merging into the shared
   *  settings blob so sibling slices (voice, openWith, …) are preserved. */
  private async save(): Promise<void> {
    await saveSettingsSlice(SLICE_KEY, this.data);
  }
}

/** The singleton durable UI-preferences store. */
export const uiPrefs = new UiPrefsStore();
