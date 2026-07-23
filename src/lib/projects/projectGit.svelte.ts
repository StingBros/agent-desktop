// Runes store for per-PROJECT git status, surfaced under each project row in the
// project pane. Unlike the footer's git (which rides the statusline snapshot of a
// RUNNING agent's pane), this is computed directly from each project's FOLDER by
// the Rust `git_status_for(paths)` command, so a project shows its current branch
// + ahead/behind/dirty even when no agent is running in it.
//
// The store is POLLED (the route re-seeds on a slow clock from the projects list),
// mirroring the transcript-activity store. Keyed by the project's absolute PATH so
// a row resolves its git directly. The pure `normalizeGitMap` reducer is unit-
// tested in projectGit.test.ts; this reactive class is the thin wrapper.

import { invoke } from '@tauri-apps/api/core';
import type { GitStatus } from '../usage/snapshots.svelte';

/** A path -> git-status map (the store's whole state). */
export type GitMap = Record<string, GitStatus>;

/** Finite number, else null (guards NaN/Infinity/strings). */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A real boolean, else null (guards a missing field / non-boolean). */
function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** A clean `string[]` of the changed paths: an array of strings, else `[]`
 *  (guards a missing field / non-array / non-string entries). */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * PURE: normalize a raw `path -> git` payload into a clean `GitMap`, coercing each
 * entry's fields to the stable `GitStatus` shape and dropping any non-object value.
 * A non-object payload yields an empty map. Unit-tested core of the store.
 */
export function normalizeGitMap(payload: unknown): GitMap {
  const out: GitMap = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const [path, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const g = value as Record<string, unknown>;
    out[path] = {
      branch: typeof g.branch === 'string' && g.branch.length > 0 ? g.branch : null,
      dirty: typeof g.dirty === 'boolean' ? g.dirty : null,
      modified: finiteOrNull(g.modified),
      ahead: finiteOrNull(g.ahead),
      behind: finiteOrNull(g.behind),
      upstream: boolOrNull(g.upstream),
      files: stringArray(g.files)
    };
  }
  return out;
}

/**
 * Reactive project-git store. Holds the `path -> GitStatus` map in `$state`,
 * refreshed by polling the `git_status_for` command for the current project paths.
 */
export class ProjectGitStore {
  /** The live path -> git-status map. Deep-reactive via the runes proxy. */
  byPath = $state<GitMap>({});

  /** Paths whose most recent background fetch FAILED — the folder HAS a remote but
   *  couldn't be fetched (offline / missing credentials). Drives the git pill's ⚠
   *  indicator so a silently-stale ahead/behind count is visible. A path with no
   *  remote (or a clean fetch) is absent/false — no indicator. */
  fetchFailed = $state<Record<string, boolean>>({});

  /** The git status for a project path, or null when none has arrived yet. */
  forPath(path: string | null | undefined): GitStatus | null {
    if (!path) return null;
    return this.byPath[path] ?? null;
  }

  /** Whether the last background fetch for a project path failed (has a remote but
   *  couldn't fetch). False for a null path, a no-remote folder, or a clean fetch. */
  fetchFailedFor(path: string | null | undefined): boolean {
    if (!path) return false;
    return this.fetchFailed[path] ?? false;
  }

  /**
   * Refresh from `git_status_for(paths)` for the given project folders and store
   * the result. Called on mount and on the route's slow poll. On failure (e.g.
   * outside Tauri) it logs once and leaves the map untouched.
   */
  async refresh(paths: string[]): Promise<number> {
    if (paths.length === 0) {
      if (Object.keys(this.byPath).length > 0) this.byPath = {};
      return 0;
    }
    try {
      const map = await invoke<unknown>('git_status_for', { paths });
      this.byPath = normalizeGitMap(map);
      return Object.keys(this.byPath).length;
    } catch (err) {
      console.warn('git_status_for failed; no project git:', err);
      return 0;
    }
  }

  /**
   * Refresh a SINGLE folder's status and MERGE it into the map, leaving every
   * other entry intact — unlike `refresh`, which replaces the whole map. Used to
   * update the footer immediately after a branch switch without waiting for (or
   * clobbering) the slow full poll. A null/empty path or a failed fetch is a
   * no-op that leaves the existing entry untouched.
   */
  async refreshOne(path: string | null | undefined): Promise<void> {
    if (!path) return;
    try {
      const map = await invoke<unknown>('git_status_for', { paths: [path] });
      const entry = normalizeGitMap(map)[path];
      if (entry) this.byPath[path] = entry;
    } catch (err) {
      console.warn('git_status_for (refreshOne) failed:', err);
    }
  }

  /**
   * Fetch each folder's remote-tracking refs in the background (the Rust
   * `git_fetch_for` command, parallel + best-effort) so a later `refresh` reports
   * an accurate ahead/behind count without a manual `git fetch`. This does NOT
   * mutate the store — call `refresh` after it resolves to surface the advanced
   * refs. Unlike the fast local status poll, this performs network I/O, so it is
   * driven on a slow clock. An empty list is a no-op; a failure (e.g. outside
   * Tauri) is logged once and swallowed (the next status poll simply stays stale).
   */
  async fetchRemotes(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    try {
      const outcomes = await invoke<unknown>('git_fetch_for', { paths });
      this.applyFetchOutcomes(outcomes);
    } catch (err) {
      console.warn('git_fetch_for failed; remote-tracking refs not refreshed:', err);
    }
  }

  /**
   * Replace `fetchFailed` from a `git_fetch_for` outcome map (path -> 'skipped' |
   * 'ok' | 'failed'). A path is flagged (true) ONLY when its outcome is 'failed'
   * — a folder with a remote it couldn't reach; 'ok'/'skipped'/anything-else
   * clears it. Replacing wholesale (the fetch always covers the full current path
   * set) self-prunes stale entries for removed projects. A non-object payload is
   * ignored, leaving the previous flags intact.
   */
  private applyFetchOutcomes(outcomes: unknown): void {
    if (!outcomes || typeof outcomes !== 'object') return;
    const next: Record<string, boolean> = {};
    for (const [path, status] of Object.entries(outcomes as Record<string, unknown>)) {
      next[path] = status === 'failed';
    }
    this.fetchFailed = next;
  }
}

/** Singleton store, imported by the project pane + the route. */
export const projectGit = new ProjectGitStore();
