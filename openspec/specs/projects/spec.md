# projects Specification

## Purpose

A project is a working folder with a name/color/icon, surfaced as a row in the
project pane and bound to agent sessions. The project pane lets the user filter
the fleet by project and act on a project via its row's right-click context menu;
the focused/selected project's git state is shown in the app footer rather than on
the rows. (Broader project-model requirements are defined by the `add-agent-desktop`
change and fold in when it archives; this spec currently captures the context-menu
git actions and the footer git indicator.)
## Requirements
### Requirement: Push And Pull A Project From Its Context Menu

A project's checkout SHALL be syncable with its git remote via **Push** and
**Pull** actions, exposed in TWO places: the project row's right-click context
menu in the project pane, AND the app footer's git indicators for the project the
footer is showing — the **ahead** (↑) indicator becomes a Push button and the
**behind** (↓) indicator a Pull button. Both surfaces invoke the SAME action
against the project's FOLDER (independent of any running agent session), shelling
out to `git push` / `git pull --ff-only` in that folder, run NON-INTERACTIVELY
(no credential / passphrase / host-key prompt) so a sync that would otherwise
prompt fails fast instead of hanging. Pull is fast-forward only, so a divergent
branch fails cleanly without ever leaving the worktree mid-merge.

A Push of a branch that already tracks an upstream runs `git push`. A Push of an
UNPUBLISHED branch (one with no upstream — never uploaded) instead runs
`git push -u <remote> HEAD`, where `<remote>` is `origin` when present, else the
first configured remote; this PUBLISHES the branch (creates the remote branch and
records tracking), so a later Push is a plain `git push`. "No upstream" is
therefore NOT a push failure.

On SUCCESS, the action shows a non-blocking toast naming the project and echoing
git's message. On FAILURE, the action opens an interactive terminal in the
project's folder that runs the failed git command, so the user sees git's full
output and can act on it (authenticate, resolve a conflict, retry); when no
terminal surface is available it falls back to a non-blocking failure toast
carrying git's own error. The action never blocks the UI and never throws.

While a Push or Pull is IN FLIGHT for a project's folder, that folder's sync is
single-flight: a second Push or Pull on the same folder is ignored, and the
footer's Push/Pull buttons for that project are disabled until the running sync
completes (success or failure), so the operation cannot be re-triggered mid-run.

#### Scenario: Push succeeds

- **WHEN** the user picks **Push** on a project whose folder is a git repo with a
  configured remote and local commits to send
- **THEN** the app runs `git push` in that folder
- **AND** shows a success toast naming the project and echoing git's message.

#### Scenario: Pull succeeds

- **WHEN** the user picks **Pull** on a project whose folder is a git repo with a
  configured upstream that has new commits
- **THEN** the app runs `git pull` in that folder, bringing the new commits in
- **AND** shows a success toast naming the project.

#### Scenario: Push publishes an unpushed branch and sets its upstream

- **WHEN** the user picks **Push** on a project whose current branch has no upstream
  (was never published) and a remote is configured
- **THEN** the app runs `git push -u <remote> HEAD` in that folder, creating the
  branch on the remote and recording tracking
- **AND** a later Push of that branch is a plain `git push`.

#### Scenario: Push or pull failure opens a terminal

- **WHEN** a Push or Pull cannot complete (rejected non-fast-forward, a divergent
  branch on pull, or no network / a remote that would prompt) AND a terminal
  surface is available
- **THEN** the app opens an interactive terminal in the project's folder running
  the failed git command (`git push` / `git pull`)
- **AND** the action does not throw, and a failed pull leaves the worktree
  untouched (no mid-merge state).

#### Scenario: Push or pull fails

- **WHEN** a Push or Pull fails and no terminal surface is wired (or the project
  id is unknown)
- **THEN** the app shows a failure toast naming the project and carrying git's own
  error message
- **AND** the action does not throw.

#### Scenario: Push and pull are available from the footer

- **WHEN** the footer is showing a project's git state and the user clicks the
  ahead (↑) Push button or the behind (↓) Pull button
- **THEN** the app runs the same Push / Pull action against that project's folder
  (success toast; interactive terminal on failure).

#### Scenario: Push and pull are blocked while a sync is in progress

- **WHEN** a Push or Pull for a project's folder is already in flight and the user
  triggers Push or Pull on that same folder again
- **THEN** the second action is ignored (git is not invoked a second time) and the
  footer's Push/Pull buttons for that project are disabled until the running sync
  completes.

#### Scenario: Project has no folder

- **WHEN** the user picks Push or Pull on a project that has no folder set
- **THEN** the app shows a toast warning there is no folder to sync
- **AND** does not invoke git.

### Requirement: Project Git State Is Shown In The Footer

A project's git state SHALL be surfaced in the app footer's left zone, before the
usage-limit bars, as a single always-visible indicator showing the current
branch, commits ahead/behind its upstream, and the count of modified files (each
shown even at zero). The indicator SHALL reflect the FOLDER git of the focused
pane's project WHILE the agent grid (the terminal panes) is showing — i.e. while
that pane is actually visible. When the agent panes are NOT visible (the
overview), the indicator SHALL instead follow the project currently selected in
the project pane — even if a pane remains focused underneath — so that selecting a
project updates the footer git with no agents visible; it SHALL show no project
git when that selection is a non-project bucket (All agents / no project). The git
state SHALL NOT be rendered on the individual project-pane rows, which carry only
the project's icon, name, attention dot, and agent count.

#### Scenario: Footer shows the focused pane's project git

- **WHEN** the agent grid is showing and a pane whose project folder is on branch
  `main`, 2 commits ahead with 3 modified files, is focused
- **THEN** the footer's left zone shows that branch, ahead/behind, and modified
  count before the usage-limit bars.

#### Scenario: Footer follows the panel selection when no agent panes are visible

- **WHEN** the agent panes are not visible (the overview) — even though a pane is
  still focused underneath — and the project pane has a concrete project selected
- **THEN** the footer shows that selected project's folder git, not the focused
  pane's.

#### Scenario: Footer falls back to the panel selection in the overview

- **WHEN** no pane is focused and the project pane has a concrete project selected
- **THEN** the footer shows that selected project's folder git.

#### Scenario: No project git for a non-project selection

- **WHEN** no pane is focused and the project pane's selection is the "All agents"
  or "no project" bucket
- **THEN** the footer shows no project git indicator content for a project.

#### Scenario: Project rows carry no git line

- **WHEN** the project pane renders its project rows
- **THEN** each row shows only the project icon, name, an attention dot when
  applicable, and the agent count — and no git status line.

### Requirement: Project Model And Assignment
The system SHALL model a PROJECT as a working folder with a human-readable name, color, and icon, and SHALL bind an agent to a project EXPLICITLY at launch — recording the chosen project's id on the pane's session registry entry (and persisting it) — never inferring it.

#### Scenario: Project assigned at launch
- **WHEN** a session is launched under a chosen project
- **THEN** the launch plan carries that project's id (verbatim; a blank/missing id is omitted) and the project's folder as the working directory
- **AND** the new pane's registry entry records the project id so the binding survives a restart

#### Scenario: Agent carries its project identity
- **WHEN** the overview roster is built
- **THEN** each agent row carries the project id from its registry entry (or null when the pane was not launched under a project)

### Requirement: Project Creation And Persistence
The system SHALL let the user create a project (name + folder + icon/color), persist the project list independently of the layout (a sibling `projects.json`, atomic tmp+rename), and tolerate a missing/malformed file as an empty list. Re-using a folder updates the existing project in place rather than duplicating it.

#### Scenario: Creating a project adds it to the head, deduped by folder
- **WHEN** a project is created (or re-created for a folder that already has one)
- **THEN** it is placed at the head of the list, an existing project for the same folder is replaced in place (keeping its id so bound agents stay valid), and a blank-path project is ignored

### Requirement: Filter The Fleet By Project
The system SHALL provide a project panel (shared by both overviews) that filters the agent roster by project, showing each project's live agent count and a per-project status indicator, plus an "All agents" option and a bucket for unassigned agents. The status indicator SHALL reflect the project's live agents: a needs-you (attention) indicator when ANY of its agents is waiting/errored, OR — when none need the user but ANY agent is actively working — a distinct working (in-flight) indicator that visually differs from the attention one (e.g. a blue, flashing dot vs. the solid attention dot). The needs-you indicator SHALL take precedence over the working one. When no live agent needs the user AND none is working, the project SHALL show NO status indicator. Paused, archived (closed), and previewed agents SHALL contribute to neither indicator.

#### Scenario: Filter agents by project
- **WHEN** a project (or "All agents", or the unassigned bucket) is selected in the panel
- **THEN** the roster is filtered to the agents bound to that selection
- **AND** the panel shows each project's agent count and flags a project whose agents are waiting/errored

#### Scenario: Project flags a working agent
- **WHEN** a project has at least one live agent that is actively working (status `working`) and none that are waiting/errored
- **THEN** the panel shows that project's working (blue, flashing) indicator and no attention indicator
- **AND** a project whose only working agent is paused, archived, or previewed shows no indicator

#### Scenario: Attention outranks working
- **WHEN** a project has both an agent that needs the user (waiting/errored) and another that is actively working
- **THEN** the panel shows the needs-you (attention) indicator, not the working one

### Requirement: Default-Select The Last Used Session When Opening A Project
When the user OPENS a project (selects a concrete project in the panel — not the
"All agents" or unassigned buckets), the system SHALL restore that project's RECORDED
last-used session in the focus pane, so the user lands back where they left off rather
than on a blank pane or an arbitrary agent. The system SHALL continuously record, per
project, the session shown in the focus pane, keyed by the session's STABLE identifier
(surviving app restart and `--resume`) and persisted in the durable UI preferences.
Restoration is deliberately CONSERVATIVE: the recorded session is restored ONLY when a
LIVE (non-archived) session with that id is still present; if nothing is recorded, the
recorded session is gone, or it is now archived, the system SHALL make NO change and
the normal focus resolution applies (attention agent, else "All clear"). Restoration
SHALL NOT resume or preview an archived session, so opening or cycling through projects
never spawns a session process as a side effect of navigation. Recording SHALL be a
no-op when unchanged (so steady-state polling never writes) and SHALL never store an
entry for a session with no project or no stable id.

#### Scenario: Opening a project restores its recorded last used session
- **WHEN** the user selects a concrete project whose recorded last-used session is
  still present as a live session in the roster
- **THEN** the focus pane shows that session, rather than a blank pane or an agent the
  user did not last use

#### Scenario: A project with no recorded (or a stale) session is unaffected
- **WHEN** the user opens a project that has no recorded last-used session, or whose
  recorded session no longer exists
- **THEN** no default selection is applied and the normal focus resolution stands
  (the first attention agent, else "All clear")

#### Scenario: An archived recorded session is not auto-resumed on open
- **WHEN** the user opens a project whose recorded last-used session is now archived
- **THEN** the archived session is NOT selected or resumed, no session process is
  spawned, and the normal focus resolution stands

#### Scenario: Non-project selections are unaffected
- **WHEN** the user selects "All agents" or the unassigned bucket
- **THEN** no last-used-session default is applied; the existing focus behavior stands

### Requirement: Reorder Projects By Dragging
The system SHALL let the user reorder the project list by dragging a project row
onto another, moving the dragged project to the drop target's slot. The new order
SHALL be persisted with the project list (the sibling `projects.json`) so it
survives a restart, and SHALL drive both the expanded panel and the collapsed icon
rail (which mirror the same list). A drag that resolves to no movement (an unknown
project, or a drop onto itself) SHALL leave the list unchanged.

#### Scenario: Reordering a project by dragging lands it at the drop target
- **WHEN** a project is dragged and dropped onto another project in the list
- **THEN** the dragged project is moved to the drop target's position (the standard array-move keyed by id), the rest keep their relative order, and the new order is persisted
- **AND** a drag with an unknown id, or a drop onto the same project, leaves the order unchanged

### Requirement: Keyboard navigation reveals the selected project filter

When keyboard navigation changes the selected project filter, the system SHALL scroll the active project row into view within the project panel when it is not already fully visible, so the selection never moves out of sight as the user cycles through a panel longer than its scrollport. A selected row that is already fully visible SHALL NOT be scrolled.

#### Scenario: Cycling to an off-screen project scrolls it into view
- **WHEN** the user cycles the project filter with the keyboard to a project whose panel row is below or above the visible portion of the panel
- **THEN** the panel scrolls so the active project row is brought into view

#### Scenario: An already-visible project filter is not scrolled
- **WHEN** keyboard navigation selects a project whose panel row is already fully visible
- **THEN** the panel scroll position is left unchanged

### Requirement: Ahead/Behind Counts Are Refreshed Against The Remote

The app SHALL keep each tracked project's ahead/behind counts current against its
remote by running a periodic, best-effort background `git fetch`, so the footer's
and project pane's "commits to pull" (↓ behind) count reflects new remote commits
WITHOUT any manual fetch. The background fetch SHALL run always-on on a SLOW clock
(on the order of a few minutes), plus an initial fetch shortly after launch, and
SHALL be SEPARATE from the fast local status poll. It SHALL cover all tracked
project folders in parallel, run NON-INTERACTIVELY (so an offline or
credential-less folder fails fast rather than hanging), and be READ-ONLY — it
updates only remote-tracking refs (and, under a non-default fetch refspec, at most
other non-checked-out branch refs) and never modifies the worktree. The fast local
status probe SHALL remain unchanged (it computes ahead/behind from local refs and
does not itself fetch); it reads the freshly-advanced refs on its next poll.

#### Scenario: New remote commit becomes visible without a manual fetch

- **WHEN** a tracked project's branch tracks an upstream and a new commit lands on
  that upstream branch
- **THEN** within one background-fetch interval the app fetches the project's
  remote-tracking refs and the footer's (and project pane's) behind (↓) count for
  that project reflects the new commit, with the user never running `git fetch`.

#### Scenario: Background fetch is parallel and best-effort

- **WHEN** the background fetch runs over the tracked project folders
- **THEN** it fetches them in parallel, and a folder that cannot fetch (no remote,
  offline, or missing credentials) fails fast and is skipped without blocking the
  other folders or surfacing an error to the user.

#### Scenario: Fetch never alters the working tree

- **WHEN** the background fetch runs for a project that has uncommitted changes or
  in-progress work
- **THEN** it only updates that repo's remote-tracking refs (a read-only fetch) and
  does NOT modify, merge, rebase, or check out anything in the worktree.

#### Scenario: The fast status probe stays local-only

- **WHEN** the per-pane / per-project git status is polled on its fast clock
- **THEN** that probe computes ahead/behind from LOCAL refs only and does not
  itself fetch — the separate slow background fetch is what advances the
  remote-tracking refs it reads.

#### Scenario: Initial fetch shortly after launch

- **WHEN** the app starts with one or more tracked projects
- **THEN** an initial background fetch runs shortly after launch (not only after a
  full interval) so the counts become accurate without waiting the full cadence.

