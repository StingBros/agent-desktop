<script lang="ts">
  // The single persistent footer. LEFT (mirrors the rail + agent panes above):
  // the focused agent's project chip + the combined 5h/7d limit bars. RIGHT
  // (mirrors the terminal): the focused agent's git (statusline-style) then its
  // context bar. In grid view the right group's left edge is ALIGNED under the
  // terminal pane (computed from the live split ratios, so it tracks gutter
  // drags); elsewhere it falls back to right-aligned. All math is in the pure,
  // tested `footerView` / `terminalLeftFraction`; this is the thin reactive shell.
  import { snapshots } from './snapshots.svelte';
  import { footerView, footerGitProjectId } from './footerView';
  import { terminalLeftFraction } from './footerGeometry';
  import { workspace } from '$lib/layout/workspace.svelte';
  import { projects } from '$lib/projects/projects.svelte';
  import { projectForId } from '$lib/projects/projects';
  import { projectFilter } from '$lib/projects/projectFilter.svelte';
  import { projectGit } from '$lib/projects/projectGit.svelte';
  import { pushProject, pullProject } from '$lib/projects/projectGitActions';
  import {
    DEFAULT_BASE,
    cachedPrStatus,
    refreshPrStatus,
    onPrButtonClick
  } from '$lib/projects/prActions';
  import { openPrsView, cachedOpenPrs, refreshOpenPrs } from '$lib/projects/openPrsActions';
  import { gitBusy } from '$lib/projects/projectGitBusy.svelte';
  import { view as topView } from '$lib/overview/view.svelte';
  import LimitBars from './LimitBars.svelte';
  import GitInfo from './GitInfo.svelte';
  import BranchPicker from './BranchPicker.svelte';
  import ContextBar from './ContextBar.svelte';
  import { friendlyTime } from '$lib/overview/friendlyTime';
  import { tooltip } from '$lib/ui/tooltip';
  import { modelLabel, effortLabel } from './modelLabel';

  /** Total session cost as "$1.24", or an em dash when unknown. */
  function costLabel(value: number | null): string {
    return value === null ? '—' : `$${value.toFixed(2)}`;
  }

  // The fixed width of the session rail (matches `.body nav.rail` in +page.svelte).
  const RAIL_PX = 200;

  // The focused pane id and the project bound to it (from the active workspace's
  // registry). Reading `workspace.active`/`focusedPaneId` keeps this reactive to
  // focus + workspace switches.
  const focusedPaneId = $derived(workspace.focusedPaneId);
  const projectId = $derived(
    focusedPaneId ? (workspace.active?.registry[focusedPaneId]?.projectId ?? null) : null
  );

  const view = $derived(
    footerView(snapshots.byPane, focusedPaneId, projectId, projects.list)
  );

  // The FOLDER git shown on the left (before the limit bars): the focused pane's
  // project while the agent grid is showing, else the panel's current selection (so
  // selecting a project updates the footer git even in the overview, where the agent
  // panes are hidden but a pane is still focused underneath). Folder-based via
  // `projectGit`, so it shows a project's branch + ahead/behind/modified even with
  // no agent running.
  const gitProject = $derived(
    projectForId(
      projects.list,
      footerGitProjectId(projectId, projectFilter.selected, topView.isGrid)
    )
  );
  const folderGit = $derived(projectGit.forPath(gitProject?.path ?? null));

  // Push/Pull handlers for the footer's git indicators — present only when a real
  // project with a folder backs the footer git, so the ↑/↓ pills become Push/Pull
  // buttons with the SAME behavior as the project pane's context-menu actions
  // (success toast; interactive terminal in the folder on failure).
  const onPush = $derived(
    gitProject?.path ? () => void pushProject(gitProject.path, gitProject.name, gitProject.id) : undefined
  );
  const onPull = $derived(
    gitProject?.path ? () => void pullProject(gitProject.path, gitProject.name, gitProject.id) : undefined
  );

  // True while a push/pull is in flight for the footer's project — disables both
  // git buttons so the sync can't be re-triggered.
  const gitSyncing = $derived(gitBusy.isBusy(gitProject?.path));

  // The branch picker: the footer's branch pill becomes a button that opens an
  // upward dropdown to switch / create branches for `gitProject`'s folder. Only
  // wired when a real project folder with a branch backs the footer git (so the
  // project pane's GitInfo, which gets no `onPickBranch`, stays read-only).
  let branchOpen = $state(false);
  let branchAnchorEl = $state<HTMLDivElement | null>(null);
  const canPickBranch = $derived(!!gitProject?.path && !!folderGit?.branch);
  const onPickBranch = $derived(canPickBranch ? () => (branchOpen = !branchOpen) : undefined);
  // Close the picker if the footer's project changes out from under it.
  $effect(() => {
    void gitProject?.path;
    branchOpen = false;
  });

  // PR button (footer only): an open PR from the current branch into `main`?
  // `prStatus` is a reactive snapshot of the per-branch cache; the effect below
  // refreshes it alongside git status (best-effort) and re-reads after a click.
  // The bubble is HIDDEN on the base branch (PR status is never queried there, so it
  // stays `unknown`), on a non-GitHub repo, and when there's no branch/project.
  let prStatus = $state<ReturnType<typeof cachedPrStatus>>({ kind: 'unknown' });
  const prBranch = $derived(folderGit?.branch ?? null);
  const prExists = $derived(prStatus.kind === 'exists');
  // The existing PR's number (when one exists), shown as "PR #N".
  const prNumber = $derived(prStatus.kind === 'exists' ? prStatus.number : null);
  // Show the per-branch PR bubble only on a GitHub repo: PR existence is determinable
  // (status `exists`/`none`), not `unknown` (no GitHub remote / gh unavailable).
  const prVisible = $derived(prStatus.kind !== 'unknown');
  // Refresh PR status whenever the footer's project/branch (or the polled git
  // status) changes: query gh in the background, then re-read the cache snapshot.
  $effect(() => {
    void folderGit; // re-run when git status is re-polled
    const path = gitProject?.path ?? null;
    const branch = prBranch;
    prStatus = cachedPrStatus(branch); // show the last-known intent immediately
    if (!path || !branch) return;
    void refreshPrStatus(path, branch, DEFAULT_BASE).then(() => {
      prStatus = cachedPrStatus(branch);
    });
  });
  // Click: open the existing PR, else open the create-confirm. `onPr` is wired
  // whenever there's a repo+branch; the bubble's own `prVisible` gate hides it when PR
  // status is `unknown` (the base branch — never queried — or a non-GitHub repo).
  const onPr = $derived(
    gitProject?.path && prBranch
      ? () =>
          void onPrButtonClick(
            { id: gitProject.id, path: gitProject.path, name: gitProject.name },
            prBranch,
            DEFAULT_BASE,
            prStatus
          )
      : undefined
  );

  // Open-PRs-awaiting-review button (footer only): how many OPEN PRs into `main`
  // are still awaiting review? `openPrs` is a reactive snapshot of the per-path
  // cache (count + pulls URL); the effect below refreshes it alongside git status
  // (best-effort). The button shows for any project folder (it's per-repo, not
  // per-branch) and degrades to the neutral checkmark/`0` when gh is unavailable.
  let openPrs = $state<ReturnType<typeof cachedOpenPrs>>(null);
  const openPrsView_ = $derived(openPrsView(openPrs));
  $effect(() => {
    void folderGit; // re-run when git status is re-polled
    const path = gitProject?.path ?? null;
    openPrs = cachedOpenPrs(path); // show the last-known state immediately
    if (!path) return;
    void refreshOpenPrs(path, DEFAULT_BASE).then(() => {
      openPrs = cachedOpenPrs(path);
    });
  });
  // The open-PRs result is passed as `openPrsResult` to GitInfo so the pill opens
  // an in-component popover (non-draft first, drafts last) instead of navigating
  // directly to the pulls page. Only wire it when we have a real project path.
  const openPrsResult = $derived(
    gitProject?.path ? openPrs : null
  );

  // Commit popover (footer only): GitInfo opens a popover listing the changed files
  // and a "Commit now" button that spawns the agent directly (no confirm dialog).
  // `onCommit` is the presence signal — when set, GitInfo makes the pill clickable.
  // `commitProject` carries the project info needed to spawn the agent. Only wired
  // when a real project folder backs the footer git.
  const onCommit = $derived(gitProject?.path ? (() => {}) : undefined);
  const commitProject = $derived(
    gitProject?.path
      ? { id: gitProject.id, path: gitProject.path, name: gitProject.name }
      : null
  );

  // Push popover (footer only): GitInfo opens a popover listing the commits that
  // would be sent, with a "Push now" action. `pushProject` carries the project info
  // (path/name/id) needed to call pushProject() from inside the popover. Only wired
  // when a real project folder backs the footer git (mirrors commitProject).
  const pushProjectInfo = $derived(
    gitProject?.path
      ? { id: gitProject.id, path: gitProject.path, name: gitProject.name }
      : null
  );

  // The terminal area's left edge as a fraction [0,1] of the surface, or null when
  // there's no terminal pane / not in grid view. A "terminal" pane is a non-claude
  // (shell) pane; agents are claude panes. Reading the active tree + registry keeps
  // this reactive to gutter drags (a resize commits a new tree).
  const termFrac = $derived.by(() => {
    if (!topView.isGrid) return null;
    const entry = workspace.active;
    if (!entry) return null;
    const reg = entry.registry;
    return terminalLeftFraction(
      entry.ws.root,
      (pid) => reg[pid]?.program !== undefined && reg[pid].program !== 'claude'
    );
  });

  // A 1-second heartbeat clock (unix SECONDS) so the limit bars' time-remaining
  // shorthand counts down on its own without needing a new snapshot.
  let now = $state(Math.floor(Date.now() / 1000));
  $effect(() => {
    const id = setInterval(() => {
      now = Math.floor(Date.now() / 1000);
    }, 1000);
    return () => clearInterval(id);
  });
</script>

<footer
  class="app-footer"
  class:aligned={termFrac !== null}
  style:--term-left={termFrac ?? 0}
  style:--rail-px={`${RAIL_PX}px`}
  aria-label="Status footer"
>
  <div class="zone left">
    <div class="left-git">
      <div class="branch-anchor" bind:this={branchAnchorEl}>
        <GitInfo git={folderGit} always {onPush} {onPull} busy={gitSyncing} {onPickBranch} {onPr} {prExists} {prNumber} {prVisible} openPrs={openPrsView_} {openPrsResult} {onCommit} {commitProject} pushProject={pushProjectInfo} fetchFailed={projectGit.fetchFailedFor(gitProject?.path)} />
      </div>
      <BranchPicker
        open={branchOpen}
        path={gitProject?.path ?? null}
        name={gitProject?.name ?? ''}
        projectId={gitProject?.id ?? null}
        current={folderGit?.branch ?? null}
        anchor={branchAnchorEl}
        onClose={() => (branchOpen = false)}
        onDone={() => void projectGit.refreshOne(gitProject?.path)}
      />
    </div>
    <span class="sep" aria-hidden="true"></span>
    <LimitBars fiveHour={view.fiveHour} sevenDay={view.sevenDay} {now} />
  </div>

  <div class="zone right">
    <ContextBar pct={view.context} />
    <span class="sep" aria-hidden="true"></span>
    {#if view.model !== null || view.model_id !== null}
      <span class="pill model-pill" use:tooltip={'Model of the focused session'}>{modelLabel(view.model_id, view.model)}</span>
      {#if effortLabel(view.effort) !== null}
        <span class="pill effort-pill" use:tooltip={'Reasoning effort of the focused session'}>{effortLabel(view.effort)}</span>
      {/if}
    {/if}
    <span class="metric" use:tooltip={'Total cost of the focused session'}>{costLabel(view.cost)}</span>
    <span class="metric dim" use:tooltip={'Time since the last message in the focused session'}>{friendlyTime(view.lastTs, now * 1000)}</span>
  </div>
</footer>

<style>
  .app-footer {
    flex: 0 0 auto;
    /* Own stacking context above the body so the (full-height) collapsed Workspace
       selector never paints over the footer. */
    position: relative;
    z-index: 5;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    /* No horizontal padding so `100%`/`200px` in the alignment calc map to true
       window x-coords; the zones carry their own edge padding instead. */
    padding: 6px 0;
    background: var(--space-900);
    border-top: 1px solid var(--line-subtle);
    user-select: none;
    -webkit-user-select: none;
    font-family: var(--font-sans);
  }
  .zone {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .zone.left {
    padding-left: 14px;
    overflow: hidden;
  }
  /* The left zone is overflow-hidden with a fixed flex-basis in aligned mode, so a
     long branch name must not push the (rigid) limit bars out of view: let the git
     shrink and ellipsize first, and never shrink the bars. */
  .left-git {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
  }
  /* Wraps GitInfo so the branch picker can measure a stable anchor rect; keeps
     min-width:0 so a long branch name still shrinks + ellipsizes as before. */
  .branch-anchor {
    display: flex;
    min-width: 0;
  }
  .zone.left :global(.limits) {
    flex: none;
  }
  /* The divider between the agents (left) and terminal (right) zones. */
  .zone.right {
    padding-left: 16px;
    padding-right: 14px;
    border-left: 1px solid var(--line-subtle);
  }
  /* Aligned mode: the left zone spans rail + agents so the divider (and right
     group) sits exactly at the terminal pane's left edge. `100%` is the footer
     width (== window width, since the footer has no horizontal padding). */
  .app-footer.aligned {
    justify-content: flex-start;
  }
  .app-footer.aligned .zone.left {
    flex: 0 0 calc(var(--rail-px) + var(--term-left) * (100% - var(--rail-px)));
  }
  .app-footer.aligned .zone.right {
    flex: 1 1 auto;
  }
  .sep {
    width: 1px;
    height: 14px;
    background: var(--line-subtle);
  }
  /* Cost + time-since-last-message metrics on the right zone. */
  .metric {
    flex: none;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-1);
    white-space: nowrap;
  }
  .metric.dim {
    color: var(--fg-4);
    font-weight: 500;
  }
  /* Non-interactive model + effort pills — small rounded chips matching GitInfo pill style. */
  .pill {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--r-full);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    background: var(--space-750);
    color: var(--fg-2);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .effort-pill {
    color: var(--fg-3);
  }
</style>
