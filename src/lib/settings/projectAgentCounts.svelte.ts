// Project waiting/working breakdown preference: whether the project panel shows the
// per-project WAITING vs WORKING counts (two colored counts) or the older single
// precedence status dot. Stored as the `projectAgentCounts` slice of the shared
// `settings.json` blob; like the other settings stores it loads once on startup and
// saves (best-effort, merge-aware) on every change so it never clobbers sibling
// slices. The pure `parseProjectAgentCountsPrefs` validator is unit-tested. DEFAULTS
// TO ON — out of the box the panel shows the waiting/working breakdown.

import { loadSettings, saveSettingsSlice } from './persist';

/** Project waiting/working breakdown preference. */
export interface ProjectAgentCountsPrefs {
  enabled: boolean;
}

/** Defaults for a fresh install: the waiting/working breakdown is ON. */
export const DEFAULT_PROJECT_AGENT_COUNTS_PREFS: ProjectAgentCountsPrefs = {
  enabled: true
};

/** PURE: validate/normalize the persisted `projectAgentCounts` slice into a fully-
 *  defaulted `ProjectAgentCountsPrefs`. Tolerates any shape — non-objects, missing
 *  fields, and wrong types fall back to `DEFAULT_PROJECT_AGENT_COUNTS_PREFS` (ON). */
export function parseProjectAgentCountsPrefs(raw: unknown): ProjectAgentCountsPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PROJECT_AGENT_COUNTS_PREFS };
  }
  const obj = raw as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback;
  return {
    enabled: bool(obj.enabled, DEFAULT_PROJECT_AGENT_COUNTS_PREFS.enabled)
  };
}

/**
 * Reactive project waiting/working store. Singleton, imported by the settings modal
 * (read/write) and the project panel (read).
 */
export class ProjectAgentCountsStore {
  /** The live preferences (deep-reactive via the runes proxy). */
  prefs = $state<ProjectAgentCountsPrefs>({ ...DEFAULT_PROJECT_AGENT_COUNTS_PREFS });

  /** True once `load()` has resolved. */
  loaded = $state(false);

  /** Load persisted prefs from the shared settings blob's `projectAgentCounts`
   *  slice. On a fresh install the defaults apply (ON). Never throws. Call once on
   *  mount. */
  async load(): Promise<void> {
    const settings = await loadSettings();
    this.prefs = parseProjectAgentCountsPrefs(settings.projectAgentCounts);
    this.loaded = true;
  }

  /** Enable/disable the waiting/working breakdown and persist (best-effort). */
  setEnabled(enabled: boolean): void {
    this.prefs = { ...this.prefs, enabled };
    void this.save();
  }

  /** Persist the current prefs as the `projectAgentCounts` slice, merging into the
   *  shared settings blob so sibling slices are preserved. */
  private async save(): Promise<void> {
    await saveSettingsSlice('projectAgentCounts', this.prefs);
  }
}

/** The singleton project waiting/working store. */
export const projectAgentCounts = new ProjectAgentCountsStore();
