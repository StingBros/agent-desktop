import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the durable UI-preferences store. These remembered layout choices
// (project-pane collapse, terminals width, tasks-launcher fraction, project
// filter, draggable lane order) live in the `ui` slice of `settings.json` — NOT
// localStorage, which WKWebView does not reliably flush on an abrupt restart.
// The pure `parseUiPrefs` validator and the store's hydrate/persist wiring are
// asserted here with the Tauri `invoke` mocked.

const invokeMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  DEFAULT_UI_PREFS,
  TERMINALS_WIDTH_MAX,
  TERMINALS_WIDTH_MIN,
  UiPrefsStore,
  parseUiPrefs
} from './uiPrefs.svelte';
import { ALL } from '../projects/projectRollup';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
});

describe('parseUiPrefs', () => {
  it('returns the defaults for null / non-object / array', () => {
    expect(parseUiPrefs(null)).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs('nope')).toEqual(DEFAULT_UI_PREFS);
    expect(parseUiPrefs([1, 2])).toEqual(DEFAULT_UI_PREFS);
  });

  it('parses a fully-specified, in-range object verbatim', () => {
    const raw = {
      projectPaneCollapsed: true,
      terminalsWidth: 500,
      tasksLauncherFrac: 0.4,
      projectFilter: 'proj-123',
      laneOrder: { attn: ['a', 'b'], paused: ['c'] },
      lastSessionByProject: { 'proj-123': 'sess-abc' }
    };
    expect(parseUiPrefs(raw)).toEqual(raw);
  });

  it('clamps an out-of-range terminals width and tasks fraction', () => {
    expect(parseUiPrefs({ terminalsWidth: 5 }).terminalsWidth).toBe(TERMINALS_WIDTH_MIN);
    expect(parseUiPrefs({ terminalsWidth: 99999 }).terminalsWidth).toBe(TERMINALS_WIDTH_MAX);
    expect(parseUiPrefs({ tasksLauncherFrac: 0 }).tasksLauncherFrac).toBe(0.15);
    expect(parseUiPrefs({ tasksLauncherFrac: 9 }).tasksLauncherFrac).toBe(0.6);
  });

  it('default project filter stays in sync with the ALL sentinel', () => {
    // uiPrefs hardcodes 'all' to avoid a projects import; this guards against the
    // sentinel drifting out from under that literal.
    expect(DEFAULT_UI_PREFS.projectFilter).toBe(ALL);
  });

  it('treats an empty-string project filter as the default', () => {
    expect(parseUiPrefs({ projectFilter: '' }).projectFilter).toBe(DEFAULT_UI_PREFS.projectFilter);
  });

  it('falls back per-field on wrong types and drops non-string lane ids', () => {
    const parsed = parseUiPrefs({
      projectPaneCollapsed: 'yes',
      terminalsWidth: 'wide',
      tasksLauncherFrac: NaN,
      projectFilter: 42,
      laneOrder: { attn: ['ok', 7, null, 'fine'], paused: 'bad' }
    });
    expect(parsed.projectPaneCollapsed).toBe(DEFAULT_UI_PREFS.projectPaneCollapsed);
    expect(parsed.terminalsWidth).toBe(DEFAULT_UI_PREFS.terminalsWidth);
    expect(parsed.tasksLauncherFrac).toBe(DEFAULT_UI_PREFS.tasksLauncherFrac);
    expect(parsed.projectFilter).toBe(DEFAULT_UI_PREFS.projectFilter);
    expect(parsed.laneOrder).toEqual({ attn: ['ok', 'fine'], paused: [] });
  });

  it('defaults lastSessionByProject to an empty map', () => {
    expect(parseUiPrefs({}).lastSessionByProject).toEqual({});
    expect(DEFAULT_UI_PREFS.lastSessionByProject).toEqual({});
  });

  it('keeps only string→non-empty-string entries of lastSessionByProject', () => {
    const parsed = parseUiPrefs({
      lastSessionByProject: { a: 'sess-a', b: 42, c: '', d: null, e: 'sess-e' }
    });
    expect(parsed.lastSessionByProject).toEqual({ a: 'sess-a', e: 'sess-e' });
  });

  it('drops a non-object / array lastSessionByProject', () => {
    expect(parseUiPrefs({ lastSessionByProject: 'nope' }).lastSessionByProject).toEqual({});
    expect(parseUiPrefs({ lastSessionByProject: ['a', 'b'] }).lastSessionByProject).toEqual({});
  });
});

describe('UiPrefsStore', () => {
  it('hydrates from the `ui` slice of settings.json', async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({ ui: { projectPaneCollapsed: true, terminalsWidth: 420 } })
    );
    const store = new UiPrefsStore();
    expect(store.loaded).toBe(false);
    await store.hydrate();
    expect(store.loaded).toBe(true);
    expect(store.data.projectPaneCollapsed).toBe(true);
    expect(store.data.terminalsWidth).toBe(420);
  });

  it('hydrate falls back to defaults on a fresh install (no settings file)', async () => {
    invokeMock.mockResolvedValueOnce(null);
    const store = new UiPrefsStore();
    await store.hydrate();
    expect(store.data).toEqual(DEFAULT_UI_PREFS);
  });

  it('persists a changed pref as the `ui` slice via settings_save', async () => {
    const store = new UiPrefsStore();
    // settings_load (RMW read) → empty; settings_save → ok
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    store.setProjectPaneCollapsed(true);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const saveCall = invokeMock.mock.calls.find((c) => c[0] === 'settings_save');
    expect(saveCall).toBeTruthy();
    const saved = JSON.parse((saveCall![1] as { json: string }).json);
    expect(saved.ui.projectPaneCollapsed).toBe(true);
  });

  it('clamps width through the setter before persisting', async () => {
    const store = new UiPrefsStore();
    store.setTerminalsWidth(100000);
    expect(store.data.terminalsWidth).toBe(TERMINALS_WIDTH_MAX);
  });

  it('records the last session for a project and persists it', async () => {
    const store = new UiPrefsStore();
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(undefined);
    store.setLastSessionForProject('proj-1', 'sess-1');
    expect(store.data.lastSessionByProject).toEqual({ 'proj-1': 'sess-1' });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const saveCall = invokeMock.mock.calls.find((c) => c[0] === 'settings_save');
    expect(saveCall).toBeTruthy();
    const saved = JSON.parse((saveCall![1] as { json: string }).json);
    expect(saved.ui.lastSessionByProject).toEqual({ 'proj-1': 'sess-1' });
  });

  it('setLastSessionForProject is a no-op (no write) when unchanged or blank', async () => {
    const store = new UiPrefsStore();
    store.setLastSessionForProject('proj-1', 'sess-1');
    // Let the first (legitimate) save fully settle so its async invoke can't land
    // after mockClear and pollute the no-op assertion below.
    await new Promise((r) => setTimeout(r, 0));
    const before = store.data;
    invokeMock.mockClear();
    // Same value → no state change, no save.
    store.setLastSessionForProject('proj-1', 'sess-1');
    expect(store.data).toBe(before);
    // Blank ids → ignored.
    store.setLastSessionForProject('', 'sess-x');
    store.setLastSessionForProject('proj-2', '');
    expect(store.data).toBe(before);
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock.mock.calls.some((c) => c[0] === 'settings_save')).toBe(false);
  });

  it('keeps prior projects when recording another (per-project map)', () => {
    const store = new UiPrefsStore();
    store.setLastSessionForProject('proj-1', 'sess-1');
    store.setLastSessionForProject('proj-2', 'sess-2');
    store.setLastSessionForProject('proj-1', 'sess-1b');
    expect(store.data.lastSessionByProject).toEqual({
      'proj-1': 'sess-1b',
      'proj-2': 'sess-2'
    });
  });
});
