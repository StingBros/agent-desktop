import { describe, expect, it, vi, beforeEach } from 'vitest';

// `invoke` is mocked so the store's git_status_for fetch can be asserted without a
// live Tauri backend. Mock pattern mirrors projectGitActions / projectGitBusy tests.
const invokeMock = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { ProjectGitStore } from './projectGit.svelte';

beforeEach(() => {
  invokeMock.mockReset();
});

describe('ProjectGitStore.refreshOne', () => {
  it('updates only its own path and preserves other entries', async () => {
    const store = new ProjectGitStore();
    store.byPath = {
      '/a': { branch: 'main', dirty: false, modified: 0, ahead: 0, behind: 0 },
      '/b': { branch: 'dev', dirty: true, modified: 3, ahead: 1, behind: 0 }
    };
    // git_status_for([/a]) reports /a is now on a freshly switched branch.
    invokeMock.mockResolvedValueOnce({
      '/a': { branch: 'feature', dirty: false, modified: 0, ahead: 0, behind: 0 }
    });

    await store.refreshOne('/a');

    // Fetched for exactly the one path…
    expect(invokeMock).toHaveBeenCalledWith('git_status_for', { paths: ['/a'] });
    // …/a is updated to the new branch…
    expect(store.byPath['/a'].branch).toBe('feature');
    // …and /b is preserved untouched (NOT clobbered like a full refresh would).
    expect(store.byPath['/b']).toEqual({
      branch: 'dev',
      dirty: true,
      modified: 3,
      ahead: 1,
      behind: 0
    });
  });

  it('a null/empty path is a no-op and never invokes', async () => {
    const store = new ProjectGitStore();
    await store.refreshOne(null);
    await store.refreshOne('');
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a failed fetch leaves the map untouched', async () => {
    const store = new ProjectGitStore();
    store.byPath = { '/a': { branch: 'main', dirty: false, modified: 0, ahead: 0, behind: 0 } };
    invokeMock.mockRejectedValueOnce('not tauri');
    await store.refreshOne('/a');
    expect(store.byPath['/a'].branch).toBe('main');
  });
});

describe('ProjectGitStore.fetchRemotes', () => {
  it('invokes git_fetch_for with the given paths', async () => {
    const store = new ProjectGitStore();
    await store.fetchRemotes(['/a', '/b']);
    expect(invokeMock).toHaveBeenCalledWith('git_fetch_for', { paths: ['/a', '/b'] });
  });

  it('an empty path list is a no-op and never invokes', async () => {
    const store = new ProjectGitStore();
    await store.fetchRemotes([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('a failed fetch is swallowed (best-effort, never throws)', async () => {
    const store = new ProjectGitStore();
    invokeMock.mockRejectedValueOnce('not tauri');
    await expect(store.fetchRemotes(['/a'])).resolves.toBeUndefined();
  });

  it('flags only paths whose outcome is "failed"', async () => {
    const store = new ProjectGitStore();
    invokeMock.mockResolvedValueOnce({ '/a': 'failed', '/b': 'ok', '/c': 'skipped' });
    await store.fetchRemotes(['/a', '/b', '/c']);
    expect(store.fetchFailedFor('/a')).toBe(true);
    expect(store.fetchFailedFor('/b')).toBe(false);
    expect(store.fetchFailedFor('/c')).toBe(false);
    // A path never reported is not failed.
    expect(store.fetchFailedFor('/never')).toBe(false);
    // A null path is never failed.
    expect(store.fetchFailedFor(null)).toBe(false);
  });

  it('clears a prior failure when a later fetch succeeds', async () => {
    const store = new ProjectGitStore();
    invokeMock.mockResolvedValueOnce({ '/a': 'failed' });
    await store.fetchRemotes(['/a']);
    expect(store.fetchFailedFor('/a')).toBe(true);
    // Next cycle the same repo fetches cleanly — the flag clears (replace-wholesale).
    invokeMock.mockResolvedValueOnce({ '/a': 'ok' });
    await store.fetchRemotes(['/a']);
    expect(store.fetchFailedFor('/a')).toBe(false);
  });

  it('a rejected fetch leaves prior flags intact', async () => {
    const store = new ProjectGitStore();
    invokeMock.mockResolvedValueOnce({ '/a': 'failed' });
    await store.fetchRemotes(['/a']);
    invokeMock.mockRejectedValueOnce('not tauri');
    await store.fetchRemotes(['/a']);
    // The failed flag from the last successful outcome is preserved.
    expect(store.fetchFailedFor('/a')).toBe(true);
  });

  // Spec: projects → "A failed background fetch is surfaced without spamming".
  // The store is the data behind the git pill's ⚠ indicator: a repo WITH a remote
  // that fails to fetch is flagged (drives the ⚠), a no-remote repo (skipped) is
  // NOT, and the flag clears on the next successful fetch — with no popup/toast
  // (the store exposes a passive flag only; it never invokes any alert surface).
  it('A failed background fetch is surfaced without spamming', async () => {
    const store = new ProjectGitStore();
    // One repo has a remote it can't reach (failed), another has no remote (skipped).
    invokeMock.mockResolvedValueOnce({ '/failed': 'failed', '/norem': 'skipped' });
    await store.fetchRemotes(['/failed', '/norem']);
    expect(store.fetchFailedFor('/failed')).toBe(true); // ⚠ shown
    expect(store.fetchFailedFor('/norem')).toBe(false); // no indicator
    // A later successful fetch for the failing repo clears the ⚠.
    invokeMock.mockResolvedValueOnce({ '/failed': 'ok', '/norem': 'skipped' });
    await store.fetchRemotes(['/failed', '/norem']);
    expect(store.fetchFailedFor('/failed')).toBe(false);
  });
});
