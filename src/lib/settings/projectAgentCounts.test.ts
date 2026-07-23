import { describe, expect, it, vi } from 'vitest';

// Tests for the project waiting/working breakdown settings store. The PURE
// `parseProjectAgentCountsPrefs` validator is the focus (default ON, tolerant of
// any persisted shape). The store's save path is asserted to merge via
// `saveSettingsSlice` so it never clobbers sibling settings slices.

const saveSliceMock = vi.fn(async (..._a: unknown[]): Promise<void> => undefined);
const loadSettingsMock = vi.fn(async (..._a: unknown[]): Promise<Record<string, unknown>> => ({}));
vi.mock('./persist', () => ({
  saveSettingsSlice: (...a: unknown[]) => saveSliceMock(...a),
  loadSettings: (...a: unknown[]) => loadSettingsMock(...a)
}));

import {
  parseProjectAgentCountsPrefs,
  ProjectAgentCountsStore,
  DEFAULT_PROJECT_AGENT_COUNTS_PREFS,
  type ProjectAgentCountsPrefs
} from './projectAgentCounts.svelte';

describe('parseProjectAgentCountsPrefs', () => {
  it('defaults to ON', () => {
    expect(DEFAULT_PROJECT_AGENT_COUNTS_PREFS).toEqual({ enabled: true });
  });

  it('returns the defaults for undefined / null / non-object input', () => {
    expect(parseProjectAgentCountsPrefs(undefined)).toEqual(DEFAULT_PROJECT_AGENT_COUNTS_PREFS);
    expect(parseProjectAgentCountsPrefs(null)).toEqual(DEFAULT_PROJECT_AGENT_COUNTS_PREFS);
    expect(parseProjectAgentCountsPrefs('nope')).toEqual(DEFAULT_PROJECT_AGENT_COUNTS_PREFS);
    expect(parseProjectAgentCountsPrefs([])).toEqual(DEFAULT_PROJECT_AGENT_COUNTS_PREFS);
  });

  it('falls back to the default (ON) for a missing / wrong-typed value', () => {
    expect(parseProjectAgentCountsPrefs({})).toEqual({ enabled: true });
    expect(parseProjectAgentCountsPrefs({ enabled: 'no' })).toEqual({ enabled: true });
    expect(parseProjectAgentCountsPrefs({ enabled: 0 })).toEqual({ enabled: true });
  });

  it('reads an explicit false as OFF', () => {
    expect(parseProjectAgentCountsPrefs({ enabled: false })).toEqual({ enabled: false });
  });
});

describe('ProjectAgentCountsStore', () => {
  it('defaults to ON on a fresh / empty settings blob', async () => {
    loadSettingsMock.mockResolvedValueOnce({});
    const store = new ProjectAgentCountsStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.prefs).toEqual({ enabled: true });
  });

  it('loads via the parser from the projectAgentCounts slice', async () => {
    loadSettingsMock.mockResolvedValueOnce({
      voice: { enabled: false },
      projectAgentCounts: { enabled: false }
    });
    const store = new ProjectAgentCountsStore();
    await store.load();
    expect(store.prefs).toEqual({ enabled: false });
  });

  it('setEnabled updates prefs immutably and saves only the projectAgentCounts slice', () => {
    saveSliceMock.mockClear();
    const store = new ProjectAgentCountsStore();
    const before = store.prefs;
    store.setEnabled(false);
    expect(store.prefs.enabled).toBe(false);
    expect(store.prefs).not.toBe(before);
    for (const call of saveSliceMock.mock.calls) {
      expect(call[0]).toBe('projectAgentCounts');
    }
    const saved = saveSliceMock.mock.calls.at(-1)![1] as ProjectAgentCountsPrefs;
    expect(saved).toEqual(store.prefs);
  });
});
