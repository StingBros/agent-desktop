<script lang="ts">
  // The focused pane's (or a project's) git status as a row of PILLS:
  //   [⎇ branch]  [↓ behind]  [↑ ahead]  [✎ modified]
  // branch is a neutral pill; behind a red pill (dim when 0); ahead a yellow pill;
  // modified a caution pill carrying the COUNT of changed paths with a pencil icon
  // (dim when 0). Counts hide when null (git couldn't answer) UNLESS `always` is
  // set — the project pane forces all three indicators visible even at zero/clean.
  // `stack` splits the branch onto its own line above the indicators (the project
  // pane wants branch on row 2, the three indicators on row 3); the footer leaves
  // it off and everything flows inline. Icons inherit the pill color via currentColor.
  //
  // When `onPush`/`onPull` are provided, the ahead (↑) and behind (↓) indicators
  // become CLICKABLE buttons that push / pull the underlying project (same behavior
  // as the project pane's context-menu Push/Pull); without them the indicators are
  // plain display pills. While `busy` is set (a push/pull is already running for
  // this project) BOTH buttons are disabled so the operation can't be re-triggered.
  //
  // When `onPickBranch` is provided (the footer only), the BRANCH pill becomes a
  // button that opens the branch picker; without it the branch stays a read-only
  // display pill (the project pane keeps it read-only), mirroring the push/pull
  // span↔button switch.
  //
  // When `onPr` is provided AND `prVisible` (the footer, on a GitHub repo), a
  // per-branch PR bubble is shown to the RIGHT of the modified (edited-files) pill,
  // SEPARATE from the open-PRs-awaiting-review button: it shows "PR #N" highlighted
  // when a PR exists (click opens it) or a gray "PR" when none (click → create-PR
  // confirm). Hidden when `prVisible` is false (PR status unknown / non-GitHub) or in
  // the project pane (no `onPr`).
  //
  // When `onOpenPrs` is provided (the footer only), an "open PRs awaiting review"
  // button is shown to the RIGHT of the PR button: it renders `openPrs` (a warning
  // glyph + the count when >0, else a neutral checkmark + `0`) and clicking opens
  // the repo's pull-requests page on GitHub. Without it no button shows.
  //
  // When `onCommit` is provided (the footer only), the MODIFIED (uncommitted-files)
  // pill becomes a BUTTON whenever `modified > 0` — clicking opens the commit
  // popover. It stays INERT (a plain display pill, no action) when `modified` is
  // 0/null, so a clean tree can't be clicked. The hover tooltip shows only the
  // COUNT of changed files (e.g. "3 uncommitted files").
  //
  // When `pushProject` is provided (the footer only), the AHEAD (↑) pill is ALWAYS
  // a BUTTON that opens the push popover — the user takes the secondary "Push now"
  // action there in every case. It reads HIGHLIGHTED whenever there is something to
  // do (commits to push, OR an unpublished branch that pushing would publish — even
  // at zero commits) and falls to a NEUTRAL empty state (mirroring the open-PRs zero
  // state) only when the branch is published and fully in sync. It is disabled ONLY
  // while a push/pull for the project is in flight (`busy`).
  import Icon from '$lib/icons/Icon.svelte';
  import { tooltip } from '$lib/ui/tooltip';
  import type { GitStatus } from './snapshots.svelte';
  import { uncommittedCountTooltip } from './uncommittedTooltip';
  import FooterPopover from './FooterPopover.svelte';
  import type { CommitProject } from './commitPopover';
  import { spawnCommitFromPopover } from './commitPopover';
  import type { PushCommit } from '$lib/projects/projectGitActions';
  import {
    commitsToPush,
    pushProject as doPushProject,
    repoWebUrl,
    commitWebUrl
  } from '$lib/projects/projectGitActions';
  import { pushPopoverOpen as canPushPopover, aheadPillEnabled } from './pushPopover';
  import { invoke } from '@tauri-apps/api/core';
  import {
    sortPrsForPopover,
    reviewStatus,
    prUpdatedSeconds,
    type OpenPr
  } from '$lib/projects/openPrsActions';
  import PrAuthorAvatar from './PrAuthorAvatar.svelte';
  import { friendlyTime } from '$lib/overview/friendlyTime';
  import { openInEditor } from '$lib/overview/editor';

  /** Minimal project info needed to open the push popover and execute a push. */
  export interface PushProject {
    id: string | null;
    path: string | null;
    name: string;
  }

  let {
    git,
    always = false,
    stack = false,
    onPush,
    onPull,
    busy = false,
    onPickBranch,
    onPr,
    prExists = false,
    prNumber = null,
    prVisible = false,
    onOpenPrs,
    openPrs,
    openPrsResult = null,
    onCommit,
    commitProject = null,
    pushProject = null,
    fetchFailed = false
  }: {
    git: GitStatus | null;
    always?: boolean;
    stack?: boolean;
    onPush?: () => void;
    onPull?: () => void;
    busy?: boolean;
    onPickBranch?: () => void;
    onPr?: () => void;
    prExists?: boolean;
    /** The existing PR's number (when `prExists`), rendered as "PR #N". */
    prNumber?: number | null;
    /** Whether to show the per-branch PR bubble at all — true only when the repo is a
     *  GitHub repo (PR existence determinable). Hidden when PR status is unknown. */
    prVisible?: boolean;
    /** When provided (footer only), the open-PRs pill opens a popover. Without it
     *  the pill either calls `onOpenPrs` directly or is inert. */
    onOpenPrs?: () => void;
    openPrs?: { icon: string; label: string; warning: boolean };
    /** The full open-PRs result from the Rust backend, used to populate the
     *  popover body. When provided, clicking the pill opens a popover instead of
     *  calling `onOpenPrs` directly. */
    openPrsResult?: { pullsUrl: string | null; prs: OpenPr[] } | null;
    /** When provided (footer only), the modified pill becomes a button that opens
     *  the commit popover. Without it the pill stays inert (project pane). */
    onCommit?: () => void;
    /** The project to commit to — used by the in-component popover to spawn the
     *  agent. Required whenever `onCommit` is wired; ignored otherwise. */
    commitProject?: CommitProject | null;
    /** When provided (footer only), the ahead pill opens the push popover whenever
     *  `ahead > 0`, listing the commits to push and offering a "Push now" action.
     *  Without it the ahead pill calls `onPush` directly (or is inert). */
    pushProject?: PushProject | null;
    /** True when the last background fetch for this project FAILED — it has a
     *  remote but couldn't be fetched (offline / missing credentials). Shows a ⚠
     *  indicator so a silently-stale ahead/behind (↓) count is visible, with a
     *  tooltip pointing at how to fix it. */
    fetchFailed?: boolean;
  } = $props();

  // The modified (uncommitted-files) pill is a clickable COMMIT button only when
  // the footer wired `onCommit` AND there are actually changes (`modified > 0`).
  // Otherwise it stays an inert display pill — a clean tree must not be clickable.
  const commitable = $derived(!!onCommit && (git?.modified ?? 0) > 0);

  // ── Commit popover state ───────────────────────────────────────────────────
  let commitPopoverOpen = $state(false);
  let commitPillEl = $state<HTMLButtonElement | null>(null);

  function openCommitPopover() {
    if (commitable) commitPopoverOpen = true;
  }

  function closeCommitPopover() {
    commitPopoverOpen = false;
  }

  function handleCommitNow() {
    // Close first so the popover dismisses immediately on click, then act.
    closeCommitPopover();
    if (commitProject) {
      spawnCommitFromPopover(commitProject);
    }
  }

  // Clicking a file row in the commit popover opens that file in the user's
  // configured editor (the open-with preferences, resolved against the project
  // folder since git reports repo-relative paths). The popover stays OPEN so the
  // user can review several files (and still reach "Commit now") without reopening.
  function handleOpenFile(file: string) {
    void openInEditor(commitProject?.path ?? null, file);
  }

  // ── Push popover state ────────────────────────────────────────────────────
  // The ahead (↑) pill opens the push popover whenever `pushProject` is wired — in
  // ALL cases, so the user always takes the secondary action inside the popover.
  // Otherwise the pill calls `onPush` directly (no-popover surface) or is inert.
  // The popover lazily fetches the commit list on open.
  const pushable = $derived(canPushPopover(!!pushProject));

  // Whether the ↑ pill reads HIGHLIGHTED (something to do — commits to push, or an
  // unpublished branch to publish) vs the NEUTRAL empty state (published + in sync,
  // or count unknown). Drives the `.zero` styling that mirrors the open-PRs zero pill.
  const aheadEnabled = $derived(aheadPillEnabled(git?.ahead, git?.upstream));

  // The ↑ pill's hover tooltip, reflecting what a click/push would do: publish an
  // unpublished branch, push pending commits, or (in sync) just review.
  const aheadTooltip = $derived.by(() => {
    const n = git?.ahead ?? 0;
    const commits = `${n} commit${n === 1 ? '' : 's'}`;
    if (git?.upstream === false) {
      return n > 0
        ? `Publish this branch — ${commits} to upload`
        : 'Publish this branch to its remote';
    }
    return n > 0 ? `${commits} to push — click to review` : 'Up to date with the remote';
  });

  // The ↓ pill's hover tooltip. `behind` is measured against the branch's OWN
  // upstream (not origin/main), so the wording reflects what a pull would bring in.
  const behindTooltip = $derived.by(() => {
    const n = git?.behind ?? 0;
    const commits = `${n} commit${n === 1 ? '' : 's'}`;
    return n > 0 ? `${commits} behind the upstream — pull to catch up` : 'Up to date with the upstream';
  });

  let pushPopoverOpenState = $state(false);
  let pushPillEl = $state<HTMLButtonElement | null>(null);
  let pushCommits = $state<PushCommit[]>([]);
  let pushCommitsLoading = $state(false);
  // The repo's GitHub base URL, resolved when the popover opens so each commit
  // row can link to its diff view. Null (non-GitHub / gh unavailable) → rows
  // stay inert display rows, mirroring how the PR bubble hides off GitHub.
  let pushRepoUrl = $state<string | null>(null);

  function openPushPopover() {
    if (!pushable) return;
    pushPopoverOpenState = true;
    pushRepoUrl = null;
    // Lazily fetch the commit list when the popover opens.
    pushCommitsLoading = true;
    void commitsToPush(pushProject?.path).then((commits) => {
      pushCommits = commits;
      pushCommitsLoading = false;
    });
    // Resolve the repo's GitHub base URL in parallel so commit rows become
    // clickable links to each commit's diff view (best-effort; null off GitHub).
    void repoWebUrl(pushProject?.path).then((url) => {
      pushRepoUrl = url;
    });
  }

  function closePushPopover() {
    pushPopoverOpenState = false;
    pushCommits = [];
    pushRepoUrl = null;
  }

  async function handleOpenCommit(hash: string) {
    // Close first so the popover dismisses immediately on click (mirrors the PR
    // rows), then open the commit's diff view on GitHub in the default browser.
    const url = commitWebUrl(pushRepoUrl, hash);
    closePushPopover();
    if (!url) return;
    try {
      await invoke('open_path', { path: url, app: null });
    } catch (err) {
      console.warn('open_path (open commit url) failed', err);
    }
  }

  async function handlePushNow() {
    // Close first so the popover dismisses immediately on click — don't wait for
    // the (network) push to finish.
    closePushPopover();
    if (pushProject) {
      await doPushProject(pushProject.path, pushProject.name, pushProject.id);
    }
  }

  // ── Open-PRs popover state ─────────────────────────────────────────────────
  // The open-PRs pill opens a popover listing awaiting-review PRs (non-draft first,
  // drafts last) when `openPrsResult` is wired. The pinned action opens the pulls
  // page. Falls back to calling `onOpenPrs` directly if only the legacy prop is set.
  let openPrsPopoverOpen = $state(false);
  let openPrsPillEl = $state<HTMLButtonElement | null>(null);
  // Snapshot of "now" (epoch ms) taken when the popover opens, so each row's
  // relative last-updated time ("2h ago") is computed against a stable reference
  // for the life of the popover — a transient view doesn't need per-second ticking.
  let openPrsNowMs = $state(Date.now());

  function handleOpenPrsClick() {
    if (openPrsResult != null) {
      openPrsNowMs = Date.now();
      openPrsPopoverOpen = true;
    } else if (onOpenPrs) {
      onOpenPrs();
    }
  }

  function closeOpenPrsPopover() {
    openPrsPopoverOpen = false;
  }

  async function handleOpenPrsPage() {
    // Close first so the popover dismisses immediately on click, then open the page.
    const url = openPrsResult?.pullsUrl;
    closeOpenPrsPopover();
    if (!url) return;
    try {
      await invoke('open_path', { path: url, app: null });
    } catch (err) {
      console.warn('open_path (open PRs page) failed', err);
    }
  }

  async function handleOpenPrUrl(url: string) {
    // Close first so the popover dismisses immediately on click, then open the PR.
    closeOpenPrsPopover();
    try {
      await invoke('open_path', { path: url, app: null });
    } catch (err) {
      console.warn('open_path (open PR url) failed', err);
    }
  }

  // PRs sorted for the popover: non-draft (awaiting-review shown first) then drafts.
  const sortedPrsForPopover = $derived(
    openPrsResult ? sortPrsForPopover(openPrsResult.prs) : []
  );
</script>

<div class="git" class:stacked={stack}>
  {#if git && git.branch}
    <span class="grp branchgrp">
      {#if onPickBranch}
        <button
          type="button"
          class="pill branch action"
          onclick={onPickBranch}
          use:tooltip={`On branch ${git.branch} — switch branch`}
        >
          <Icon name="git-branch" size={12} />
          <span class="txt">{git.branch}</span>
        </button>
      {:else}
        <span class="pill branch" use:tooltip={`On branch ${git.branch}`}>
          <Icon name="git-branch" size={12} />
          <span class="txt">{git.branch}</span>
        </span>
      {/if}
    </span>
    <span class="grp ind">
      {#if always || git.behind != null}
        {#if onPull}
          <button
            type="button"
            class="pill behind action"
            class:zero={(git.behind ?? 0) === 0}
            onclick={onPull}
            disabled={busy}
            use:tooltip={busy ? 'Sync in progress…' : 'Pull from origin'}
          >
            <Icon name="arrow-down" size={12} />
            <span class="txt">{git.behind ?? 0}</span>
          </button>
        {:else}
          <span
            class="pill behind"
            class:zero={(git.behind ?? 0) === 0}
            use:tooltip={behindTooltip}
          >
            <Icon name="arrow-down" size={12} />
            <span class="txt">{git.behind ?? 0}</span>
          </span>
        {/if}
      {/if}
      {#if always || (git.ahead != null && git.ahead > 0)}
        {#if pushable}
          <!-- Footer wired a pushProject: the ↑ pill is ALWAYS a clickable button
               that opens the push popover (the user pushes/publishes there in every
               case). Highlighted when there's something to do, NEUTRAL (`.zero`,
               mirroring the open-PRs empty pill) when published + in sync. Disabled
               only while a sync is in flight. -->
          <button
            type="button"
            class="pill ahead action"
            class:zero={!aheadEnabled}
            bind:this={pushPillEl}
            onclick={openPushPopover}
            disabled={busy}
            use:tooltip={busy ? 'Sync in progress…' : aheadTooltip}
          >
            <Icon name="arrow-up" size={12} />
            <span class="txt">{git.ahead ?? 0}</span>
          </button>
        {:else if onPush && !pushProject}
          <!-- Direct-push fallback for a surface that wires onPush WITHOUT a
               pushProject (no popover). The footer always wires both, so this never
               fires there. -->
          <button
            type="button"
            class="pill ahead action"
            class:zero={!aheadEnabled}
            onclick={onPush}
            disabled={busy}
            use:tooltip={busy ? 'Sync in progress…' : aheadTooltip}
          >
            <Icon name="arrow-up" size={12} />
            <span class="txt">{git.ahead ?? 0}</span>
          </button>
        {:else}
          <span
            class="pill ahead"
            class:zero={!aheadEnabled}
            use:tooltip={aheadTooltip}
          >
            <Icon name="arrow-up" size={12} />
            <span class="txt">{git.ahead ?? 0}</span>
          </span>
        {/if}
      {/if}
      {#if git.modified != null}
        {#if commitable}
          <!-- Changes present + footer wired a commit action: a clickable COMMIT
               button. Hover shows the count-only tooltip (matching the other
               indicators' count tooltips); clicking opens the commit popover which
               lists the file paths and pins a "Commit now" action. -->
          <button
            type="button"
            class="pill modified action"
            bind:this={commitPillEl}
            onclick={openCommitPopover}
            use:tooltip={uncommittedCountTooltip(git.modified)}
          >
            <Icon name="pencil" size={12} />
            <span class="txt">{git.modified}</span>
          </button>
        {:else}
          <!-- INERT: a clean tree (modified === 0) or no commit action wired. A
               clean tree shows NO tooltip; a non-zero count with no action shows
               the count-only summary. -->
          <span
            class="pill modified"
            class:zero={git.modified === 0}
            use:tooltip={git.modified === 0 ? '' : uncommittedCountTooltip(git.modified)}
          >
            <Icon name="pencil" size={12} />
            <span class="txt">{git.modified}</span>
          </span>
        {/if}
      {:else if always}
        <span class="pill modified zero" use:tooltip={'No uncommitted changes'}>
          <Icon name="pencil" size={12} />
          <span class="txt">0</span>
        </span>
      {:else if git.dirty === true}
        <span class="pill modified" use:tooltip={'Uncommitted changes in the working tree'}>
          <Icon name="pencil" size={12} />
        </span>
      {:else if git.dirty === false}
        <span class="pill clean" use:tooltip={'Working tree clean'}>
          <Icon name="check" size={12} />
        </span>
      {/if}
      {#if onPr && prVisible}
        <!-- Per-branch PR bubble (SEPARATE from the open-PRs-awaiting-review button):
             shown on a GitHub repo. Highlighted "PR #N" when a PR exists (click opens
             it); gray "PR" when none (click → create-PR confirm → agent task). -->
        <button
          type="button"
          class="pill pr action"
          class:exists={prExists}
          onclick={onPr}
          use:tooltip={prExists
            ? 'Open this branch’s pull request on GitHub'
            : 'Create a pull request into main'}
        >
          <Icon name="git-pull-request" size={12} />
          <span class="txt">{prExists && prNumber != null ? `PR #${prNumber}` : 'PR'}</span>
        </button>
      {/if}
      {#if openPrs && (onOpenPrs || openPrsResult != null)}
        <button
          type="button"
          class="pill openprs action"
          class:warn={openPrs.warning}
          bind:this={openPrsPillEl}
          onclick={handleOpenPrsClick}
          use:tooltip={openPrs.warning
            ? `${openPrs.label} open pull request${openPrs.label === '1' ? '' : 's'} awaiting review — click to review`
            : 'No open pull requests awaiting review — click to open'}
        >
          <Icon name={openPrs.icon} size={12} />
          <span class="txt">{openPrs.label}</span>
        </button>
      {/if}
      {#if fetchFailed}
        <!-- Background fetch failed for a repo that HAS a remote (offline /
             missing credentials): the ↓ behind count may be stale. A quiet ⚠
             indicator (no popup) makes that visible; the tooltip says how to fix
             it. It clears itself as soon as a later background fetch succeeds. -->
        <span
          class="pill fetchfail"
          use:tooltip={"Couldn’t fetch from the remote — the ↓ count may be stale. Run `git fetch` once in a terminal (e.g. to sign in); it then refreshes automatically."}
        >
          <Icon name="triangle-alert" size={12} />
        </span>
      {/if}
    </span>
  {:else}
    <span class="pill branch dim" use:tooltip={'No git repository for this pane'}>
      <Icon name="git-branch" size={12} />
      <span class="txt">—</span>
    </span>
  {/if}
</div>

<!-- Push popover: opens above the ahead (↑) pill when it is clicked and there
     are commits to push. Lists the unpushed commit hashes + subjects in a
     scrollable body with a pinned "Push now" action that calls pushProject
     directly (the user already saw the commit list and chose to act). -->
<FooterPopover
  open={pushPopoverOpenState}
  anchor={pushPillEl}
  onClose={closePushPopover}
>
  {#snippet title()}
    Commits to push
  {/snippet}

  {#snippet body()}
    {#if pushCommitsLoading}
      <p class="cp-empty">Loading…</p>
    {:else if pushCommits.length > 0}
      <ul class="cp-file-list">
        {#each pushCommits as commit (commit.hash)}
          {#if pushRepoUrl}
            <!-- Repo is on GitHub: the row links to the commit's diff view.
                 Clicking closes the popover and opens it in the browser. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <li
              class="cp-file pp-commit-row pp-commit-clickable"
              role="button"
              tabindex="0"
              use:tooltip={'Open this commit on GitHub'}
              onclick={() => handleOpenCommit(commit.hash)}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenCommit(commit.hash); } }}
            >
              <span class="pp-hash">{commit.hash.slice(0, 7)}</span>
              <span class="pp-subject">{commit.subject}</span>
            </li>
          {:else}
            <li class="cp-file pp-commit-row">
              <span class="pp-hash">{commit.hash.slice(0, 7)}</span>
              <span class="pp-subject">{commit.subject}</span>
            </li>
          {/if}
        {/each}
      </ul>
    {:else}
      <p class="cp-empty">No commits found</p>
    {/if}
  {/snippet}

  {#snippet action()}
    <button type="button" class="pp-push-btn" onclick={handlePushNow}>
      Push now
    </button>
  {/snippet}
</FooterPopover>

<!-- Commit popover: opens above the modified pill when it is clicked and there
     are uncommitted changes. Lists the changed file paths in a scrollable body
     with a pinned "Commit now" action that spawns the agent directly (no confirm
     dialog — the user already saw the files and chose to act). -->
<FooterPopover
  open={commitPopoverOpen}
  anchor={commitPillEl}
  onClose={closeCommitPopover}
>
  {#snippet title()}
    Uncommitted changes
  {/snippet}

  {#snippet body()}
    {#if git?.files && git.files.length > 0}
      <ul class="cp-file-list">
        {#each git.files as file (file)}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            class="cp-file cp-file-row"
            role="button"
            tabindex="0"
            onclick={() => handleOpenFile(file)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleOpenFile(file); } }}
          >{file}</li>
        {/each}
      </ul>
    {:else}
      <p class="cp-empty">No file paths available</p>
    {/if}
  {/snippet}

  {#snippet action()}
    <button type="button" class="cp-commit-btn" onclick={handleCommitNow}>
      Commit now
    </button>
  {/snippet}
</FooterPopover>

<!-- Open-PRs popover: opens above the open-PRs pill when it is clicked and
     `openPrsResult` is provided. Lists awaiting-review PRs (non-draft first,
     drafts last — drafts marked visually). Each row opens that PR's URL on GitHub.
     The pinned action opens the repo's pull-requests page. -->
<FooterPopover
  open={openPrsPopoverOpen}
  anchor={openPrsPillEl}
  onClose={closeOpenPrsPopover}
>
  {#snippet title()}
    Open pull requests
  {/snippet}

  {#snippet body()}
    {#if sortedPrsForPopover.length > 0}
      <ul class="cp-file-list">
        {#each sortedPrsForPopover as pr (pr.number)}
          {@const status = reviewStatus(pr.reviewDecision)}
          {@const updatedSec = prUpdatedSeconds(pr.updatedAt)}
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <li
            class="cp-file opr-pr-row"
            class:opr-draft={pr.isDraft}
            role="button"
            tabindex="0"
            onclick={() => handleOpenPrUrl(pr.url)}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenPrUrl(pr.url); }}
          >
            <PrAuthorAvatar author={pr.author} size={16} />
            <span class="opr-number">#{pr.number}</span>
            <span class="opr-title">{pr.title}</span>
            {#if pr.isDraft}
              <span class="opr-draft-badge">Draft</span>
            {/if}
            {#if updatedSec != null}
              <!-- Gate on the PARSED value (not raw truthiness) so a malformed
                   updatedAt omits the piece entirely rather than rendering "—"
                   with an "Invalid Date" tooltip. When non-null, Date.parse
                   succeeded, so the tooltip's exact timestamp is always valid. -->
              <span class="opr-updated" use:tooltip={`Updated ${new Date(pr.updatedAt ?? '').toLocaleString()}`}>
                {friendlyTime(updatedSec, openPrsNowMs)}
              </span>
            {/if}
            <span class="opr-status opr-status-{status.tone}" use:tooltip={status.label}>
              <Icon name={status.icon} size={12} />
            </span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="cp-empty">No open pull requests</p>
    {/if}
  {/snippet}

  {#snippet action()}
    <button type="button" class="opr-page-btn" onclick={handleOpenPrsPage}>
      Open PRs page
    </button>
  {/snippet}
</FooterPopover>

<style>
  .git {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  /* Inline (footer): the group wrappers vanish so all pills flow in one row. */
  .grp {
    display: contents;
  }
  /* Stacked (project pane): branch on its own line, indicators wrapping below. */
  .git.stacked {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .git.stacked .grp {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--r-full);
    font-size: 11px;
    font-weight: 600;
    background: var(--space-750);
    color: var(--fg-2);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .pill .txt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A clickable indicator (footer push/pull): reset the button chrome to match the
     display pill, add a pointer + subtle hover lift so it reads as actionable. */
  button.pill {
    /* Inherit only the family (drop the UA button font); keep `.pill`'s 11px /
       600 so a push/pull button matches the display pills exactly. */
    font-family: inherit;
    border: none;
    cursor: pointer;
  }
  button.pill.action:hover {
    filter: brightness(1.15);
  }
  button.pill.action:active {
    transform: translateY(0.5px);
  }
  /* While a sync is in flight both buttons are disabled — dim them and drop the
     hover/active affordances so they read as non-interactive. */
  button.pill.action:disabled {
    cursor: default;
    opacity: 0.5;
    filter: none;
    transform: none;
  }
  .branch {
    max-width: 220px;
  }
  .branch.dim {
    color: var(--fg-4);
  }
  .behind {
    background: var(--abort-tint);
    color: var(--abort-500);
    box-shadow: none;
  }
  .behind.zero {
    background: var(--space-750);
    color: var(--fg-4);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .ahead {
    background: var(--caution-tint);
    color: var(--caution-500);
    box-shadow: none;
  }
  .ahead.zero {
    background: var(--space-750);
    color: var(--fg-4);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .modified {
    background: var(--caution-tint);
    color: var(--caution-500);
    box-shadow: none;
  }
  /* Background-fetch failure: a caution (amber) indicator, matching the other
     caution pills. Non-interactive — a passive status hint, not a button. */
  .fetchfail {
    background: var(--caution-tint);
    color: var(--caution-500);
    box-shadow: none;
    cursor: default;
  }
  .modified.zero {
    background: var(--space-750);
    color: var(--fg-4);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .clean {
    background: var(--nominal-tint);
    color: var(--nominal-500);
    box-shadow: none;
    padding: 0 6px;
  }
  /* The PR button sits immediately right of the modified pill. Neutral by default
     (create intent); a brighter accent tint when an open PR already exists (open
     intent). The shared `button.pill.action` rules above carry hover/active/disabled. */
  .pr {
    background: var(--space-750);
    color: var(--fg-2);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .pr.exists {
    background: var(--blue-tint);
    color: var(--info-500);
    box-shadow: none;
  }
  /* The open-PRs-awaiting-review button sits immediately right of the PR button.
     Neutral (checkmark + `0`) when none await review; a caution tint (warning
     glyph + count) when one or more do. Shares `button.pill.action` hover/active. */
  .openprs {
    background: var(--space-750);
    color: var(--fg-4);
    box-shadow: inset 0 0 0 1px var(--line-subtle);
  }
  .openprs.warn {
    background: var(--caution-tint);
    color: var(--caution-500);
    box-shadow: none;
  }

  /* ── Commit popover content (rendered inside FooterPopover's snippets) ── */

  /* File list inside the scrollable body: no bullet, tight spacing, monospace
     so paths are easy to read. */
  .cp-file-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .cp-file {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--fg-2);
    padding: 5px 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cp-file:hover {
    background: var(--line-faint);
    color: var(--fg-1);
  }

  /* A clickable file row (commit popover): opens the file in the configured editor.
     Pointer + a focus ring so it reads as actionable and is keyboard-reachable. */
  .cp-file-row {
    cursor: pointer;
  }

  .cp-file-row:focus {
    outline: none;
    background: var(--line-faint);
    color: var(--fg-1);
  }

  .cp-empty {
    font-family: var(--font-sans);
    font-size: 12px;
    color: var(--fg-4);
    padding: 10px 12px;
    font-style: italic;
    margin: 0;
  }

  /* Primary action button — "Commit now" — full-width, orange (caution) accent. */
  .cp-commit-btn {
    width: 100%;
    background: var(--caution-tint);
    color: var(--caution-500);
    border: 1px solid color-mix(in srgb, var(--caution-500) 30%, transparent);
    border-radius: var(--r-sm);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    padding: 7px 12px;
    cursor: pointer;
    text-align: center;
  }

  .cp-commit-btn:hover {
    filter: brightness(1.15);
  }

  .cp-commit-btn:active {
    transform: translateY(0.5px);
  }

  /* ── Push popover content (rendered inside FooterPopover's snippets) ── */

  /* Each commit row: short hash (dim monospace) + subject (readable sans). */
  .pp-hash {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--fg-4);
    flex-shrink: 0;
    margin-right: 6px;
  }

  .pp-subject {
    font-family: var(--font-sans);
    font-size: 11.5px;
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Override .cp-file layout to show hash + subject side-by-side. */
  .pp-commit-row {
    display: flex;
    align-items: center;
  }

  /* A clickable commit row (repo on GitHub): opens the commit's diff view.
     Pointer + a focus ring so it reads as actionable and is keyboard-reachable
     (matches the PR-row affordance). */
  .pp-commit-clickable {
    cursor: pointer;
  }

  .pp-commit-clickable:focus {
    outline: none;
    background: var(--line-faint);
    color: var(--fg-1);
  }

  /* Primary action button — "Push now" — full-width, orange (caution) accent (mirrors
     the commit button so the push pill popover is visually consistent). */
  .pp-push-btn {
    width: 100%;
    background: var(--caution-tint);
    color: var(--caution-500);
    border: 1px solid color-mix(in srgb, var(--caution-500) 30%, transparent);
    border-radius: var(--r-sm);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    padding: 7px 12px;
    cursor: pointer;
    text-align: center;
  }

  .pp-push-btn:hover {
    filter: brightness(1.15);
  }

  .pp-push-btn:active {
    transform: translateY(0.5px);
  }

  /* ── Open-PRs popover content (rendered inside FooterPopover's snippets) ── */

  /* Each PR row: number (dim monospace) + title. Clickable — opens the PR on GitHub. */
  .opr-pr-row {
    display: flex;
    align-items: center;
    cursor: pointer;
  }

  .opr-pr-row:focus {
    outline: none;
    background: var(--line-faint);
  }

  .opr-number {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--fg-4);
    flex-shrink: 0;
    margin-right: 6px;
  }

  .opr-title {
    font-family: var(--font-sans);
    font-size: 11.5px;
    color: var(--fg-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 auto;
  }

  /* Author avatar leads each row; space it from the PR number. */
  .opr-pr-row :global(.pr-avatar) {
    margin-right: 6px;
  }

  /* Relative last-updated time, sitting right of the title before the status icon. */
  .opr-updated {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--fg-4);
    flex-shrink: 0;
    margin-left: 8px;
  }

  /* Per-row review-status glyph (rightmost), colored by the review decision. */
  .opr-status {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    margin-left: 6px;
  }
  .opr-status-approved {
    color: var(--nominal-500);
  }
  .opr-status-changes {
    color: var(--abort-500);
  }
  .opr-status-required {
    color: var(--caution-500);
  }
  .opr-status-none {
    color: var(--fg-4);
  }

  /* Draft PRs: dim title + row, showing draft badge. */
  .opr-draft .opr-title {
    color: var(--fg-4);
  }

  .opr-draft-badge {
    font-family: var(--font-sans);
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--fg-4);
    background: var(--space-750);
    border: 1px solid var(--line-subtle);
    border-radius: var(--r-full);
    padding: 1px 5px;
    flex-shrink: 0;
    margin-left: 6px;
  }

  /* Primary action button — "Open PRs page" — full-width, orange (caution) accent
     (matches "Push now" / "Commit now" so all popover actions are visually consistent). */
  .opr-page-btn {
    width: 100%;
    background: var(--caution-tint);
    color: var(--caution-500);
    border: 1px solid color-mix(in srgb, var(--caution-500) 30%, transparent);
    border-radius: var(--r-sm);
    font-family: var(--font-sans);
    font-size: 13px;
    font-weight: 600;
    padding: 7px 12px;
    cursor: pointer;
    text-align: center;
  }

  .opr-page-btn:hover {
    filter: brightness(1.15);
  }

  .opr-page-btn:active {
    transform: translateY(0.5px);
  }
</style>
