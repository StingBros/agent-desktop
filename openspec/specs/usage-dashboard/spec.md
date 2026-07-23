# usage-dashboard Specification

## Purpose
TBD - created by archiving change add-agent-desktop. Update Purpose after archive.
## Requirements
### Requirement: Per-Session Statusline Override Without Touching Global Config

The system SHALL launch every Claude session with `claude --settings '{"statusLine":{"type":"command","command":"<abs>/statusline-wrapper.js"}}'` plus `AGENT_DESKTOP_PANE=<uuid>` and `AGENT_DESKTOP_SNAPSHOT_DIR=<app-support>/snapshots` in the process environment, and SHALL NEVER read, write, or modify the user's global `~/.claude/settings.json` or config dir.

#### Scenario: Inline settings override merges per-key

- **WHEN** a session is spawned with the inline `--settings` JSON overriding only `statusLine.command`
- **THEN** the session uses the wrapper as its statusline command
- **AND** all other keys from the user's `~/.claude/settings.json` (e.g. `permissions.allow`) remain in effect for that session because `--settings` merges per-key rather than replacing the file

#### Scenario: Global config left byte-identical

- **WHEN** any number of sessions are launched and exit
- **THEN** the user's `~/.claude/settings.json` is byte-for-byte unchanged
- **AND** no `CLAUDE_CONFIG_DIR` override is set, so `transcript_path` stays under the user's normal config dir

#### Scenario: Pane id passed into the spawned process env

- **WHEN** a session is spawned for pane `<uuid>`
- **THEN** the spawned process environment contains `AGENT_DESKTOP_PANE=<uuid>` and `AGENT_DESKTOP_SNAPSHOT_DIR` pointing at the app-support snapshots dir, both of which reach the `statusLine.command`

### Requirement: Statusline Wrapper Dual Behavior

The wrapper `statusline-wrapper.js`, installed to the app-support `bin/` dir, SHALL on each render both (a) delegate to the user's real `~/.claude/hooks/statusline.js` with the same stdin and pass its stdout through verbatim, and (b) write a per-pane snapshot derived from the same stdin.

#### Scenario: In-pane bar unchanged via delegation

- **WHEN** the wrapper receives statusline stdin from Claude
- **THEN** it invokes `~/.claude/hooks/statusline.js` with that identical stdin and emits the user's statusline.js stdout verbatim to its own stdout, so the in-pane status bar is visually unchanged

#### Scenario: Snapshot side effect never breaks the in-pane bar

- **WHEN** the snapshot-writing step fails (e.g. unparseable stdin or unwritable snapshot dir)
- **THEN** the wrapper still passes the delegated statusline stdout through, so the in-pane bar continues to render

#### Scenario: Missing user statusline.js degrades gracefully

- **WHEN** `~/.claude/hooks/statusline.js` does not exist
- **THEN** the wrapper still completes the snapshot write and exits without crashing the session

### Requirement: Atomic Per-Pane Snapshot Write

The wrapper SHALL write each snapshot to `<AGENT_DESKTOP_SNAPSHOT_DIR>/<AGENT_DESKTOP_PANE>.json`, keyed on the pane id (not `session_id`), using a temp-file-plus-`rename` so the watcher never observes a partial file, with the JSON object `{pane_id, session_id, model, model_id, effort, task, context_pct, rate_limits, cost, git, ts}`.

#### Scenario: File keyed on pane id

- **WHEN** the wrapper writes a snapshot for pane `<uuid>`
- **THEN** the target filename is `<uuid>.json`, so a session that resumes or forks (changing `session_id`) does not orphan or duplicate the pane's card

#### Scenario: Atomic tmp+rename

- **WHEN** the wrapper writes a snapshot
- **THEN** it first writes to a temp file in the same dir and then `rename`s it into place, so any reader either sees the previous complete file or the new complete file, never a truncated one

#### Scenario: Snapshot field shape

- **WHEN** a snapshot is written
- **THEN** it contains `pane_id`, `session_id` (or null), `model` (the model display name, or null), `model_id` (the model id, or null), `effort` (the reasoning effort level, or null when the model reports none), `task` (or null), `context_pct` (0-100 or null), `rate_limits` (object or null), `cost` (usd or null), `git`, and `ts` (unix timestamp)

### Requirement: Snapshot Directory Watching and Push

A Rust `SnapshotWatcher` (using `notify`) SHALL watch the snapshot dir and push each snapshot change to the frontend, and the frontend SHALL skip malformed snapshots rather than failing.

#### Scenario: Change pushed to frontend

- **WHEN** a snapshot file in the watched dir is created or modified
- **THEN** the watcher reads it and emits its contents to the frontend, updating that pane's card

#### Scenario: Malformed snapshot skipped

- **WHEN** a snapshot file cannot be parsed as the expected JSON
- **THEN** that snapshot is skipped and the dashboard continues rendering the last valid state for every other pane

### Requirement: Two-Row Dashboard Content

The UI SHALL render a two-row usage dashboard where the top row contains one card per session (model, context bar, detected task, and a live/idle dot driven by the snapshot `ts` heartbeat) and the bottom row contains account-wide 5h/7d rate limits, summed cost across panes, and the focused pane's git status (branch, status, PR#, ahead/behind).

#### Scenario: Top-row session cards

- **WHEN** snapshots exist for multiple panes
- **THEN** the top row shows one card per pane displaying that pane's `model`, a context bar from `context_pct`, the detected `task`, and a live/idle dot computed from the snapshot `ts` heartbeat

#### Scenario: Bottom-row account summary

- **WHEN** the dashboard renders the bottom row
- **THEN** it shows account-wide 5h/7d rate limits, a summed cost figure across panes, and the git branch/status/PR#/ahead-behind of the currently focused pane

### Requirement: Account-Wide Rollup Math

The system SHALL compute the account-wide rate limits from the single newest snapshot's `rate_limits` (which is account-global) and SHALL compute account cost as the sum of `cost` across all current per-pane snapshots.

#### Scenario: Rate limits from newest snapshot

- **WHEN** several panes have snapshots with differing `ts` values
- **THEN** the displayed 5h/7d rate limits come from the snapshot with the newest `ts`, because `rate_limits` is account-global rather than per-session

#### Scenario: Cost summed across panes

- **WHEN** three panes report `cost` values of 0.50, 1.25, and null
- **THEN** the account cost is the sum of the present numeric values (1.75), treating null as a missing contribution rather than zero-breaking the sum

### Requirement: Graceful Handling of Missing Rate Limits and Context

The system SHALL derive context from `used_percentage`/`remaining_percentage`/`context_window_size` (there is no `total_tokens` field), SHALL emit `null` for `rate_limits` when absent, and the UI SHALL render both missing `rate_limits` and missing `context_pct` gracefully.

#### Scenario: Context from the correct fields

- **WHEN** the wrapper computes `context_pct`
- **THEN** it uses `used_percentage`/`remaining_percentage`/`context_window_size` from the statusline stdin and never reads a `total_tokens` field, which does not exist

#### Scenario: Absent rate limits render as null

- **WHEN** a session has no `rate_limits` in its statusline stdin (e.g. a non-Pro/Max plan, or before the first API response)
- **THEN** the snapshot's `rate_limits` is `null` and the bottom row renders the rate-limit area in an empty/unavailable state rather than erroring

#### Scenario: Missing context renders gracefully

- **WHEN** a pane's snapshot has `context_pct` of null
- **THEN** that pane's card renders its context bar in an empty/unknown state rather than throwing or showing a misleading 0%

### Requirement: Footer context bar escalates color earlier than the limit bars

The footer CONTEXT bar (its percent text and fill) SHALL escalate color on more
aggressive thresholds than the account rate-limit bars, so a filling context window
warns early: GREEN below 25% used, YELLOW at/above 25%, and RED at/above 30%. These
thresholds apply ONLY to the context bar; the 5-hour / 7-day limit bars SHALL keep
their own thresholds (yellow at 50%, red at 80%). An unknown context renders the
neutral/unknown state, not a color.

#### Scenario: Context bar colors on the 25 / 30 thresholds
- **WHEN** the focused pane's context used is 24%, 27%, and 35%
- **THEN** the context bar reads green, yellow, and red respectively
- **AND** a limit bar at the same 27% still reads green (its yellow threshold is 50%)

### Requirement: Footer shows the focused session's model and effort

The footer SHALL display the focused session's MODEL and reasoning EFFORT as two
NON-INTERACTIVE pills on its right side, derived from that session's latest snapshot.
The model pill SHALL show a human-readable, VERSIONED model label (e.g. "Opus 4.6")
derived from the snapshot model id, falling back to the snapshot's model display name.
The effort pill SHALL show the effort level (e.g. "High"); WHEN the snapshot reports no
effort (the model does not support it), the effort pill SHALL be OMITTED. Neither pill
SHALL be clickable.

#### Scenario: Model and effort pills shown for the focused session
- **WHEN** the focused session's latest snapshot has a model and an effort level
- **THEN** the footer shows a non-clickable model pill (versioned label) and a non-clickable effort pill

#### Scenario: Effort pill omitted when unavailable
- **WHEN** the focused session's latest snapshot reports no effort level
- **THEN** the footer shows the model pill and omits the effort pill

#### Scenario: Pills are display-only
- **WHEN** the user clicks a footer model or effort pill
- **THEN** nothing happens (the pills are not interactive)

### Requirement: Footer usage tooltips show when each window resets

Each footer rate-limit bar (the 5-hour and 7-day windows) SHALL expose a tooltip that
states the percent used AND WHEN that window resets, given as an ABSOLUTE local time:
just the time-of-day (e.g. "resets at 3:45 PM") when the reset falls later on the same
calendar day, or the date and time (e.g. "resets Jun 12 at 3:45 PM") when it falls on a
different day. WHEN the reset time is unknown, the tooltip SHALL omit the reset clause
and show only the percent used. The reset time SHALL be rendered in the user's local
timezone and locale.

#### Scenario: Tooltip shows a same-day reset as a time
- **WHEN** a rate-limit window resets later on the same calendar day and its tooltip is shown
- **THEN** the tooltip includes the percent used and the absolute reset time (e.g. "resets at 3:45 PM")

#### Scenario: Tooltip shows a different-day reset as date and time
- **WHEN** a rate-limit window resets on a different calendar day and its tooltip is shown
- **THEN** the tooltip includes the reset date and time (e.g. "resets Jun 12 at 3:45 PM")

#### Scenario: Tooltip omits an unknown reset
- **WHEN** a rate-limit window's reset time is unknown
- **THEN** its tooltip shows only the percent used, with no reset clause

