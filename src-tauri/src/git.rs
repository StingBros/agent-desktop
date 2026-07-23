//! Per-PROJECT git status for the project pane.
//!
//! The footer's git pills ride the statusline snapshot of a RUNNING agent's pane.
//! The project pane, by contrast, wants each project's branch/ahead/behind/dirty
//! even when no agent is running in it — so this module shells out to `git`
//! directly against each project FOLDER. It mirrors the statusline wrapper's git
//! logic (`resources/statusline-wrapper.cjs`): branch via `rev-parse`, dirty via
//! `status --porcelain`, `ahead`/`behind` vs the branch's own upstream.
//! Every field is null when git can't answer (off-repo / no remote / no upstream),
//! so the shape is always stable and the call never fails the UI.
//!
//! Each requested path is probed on its own thread so total latency tracks the
//! slowest single repo rather than their sum; the frontend POLLS the
//! [`git_status_for`] command on a slow clock.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::no_window::NoConsoleWindow;

use serde::Serialize;

/// The most paths we surface for the uncommitted-files hover list. The UI only
/// shows the first 10 (plus an "and N more" hint), so we cap collection at a sane
/// bound — enough to drive an accurate overflow indicator without shipping a giant
/// list when a tree has thousands of changes.
const MAX_CHANGED_PATHS: usize = 50;

/// Git status for one project folder — the frontend `GitStatus` contract. Every
/// field is `Option` (null when git couldn't answer) so the shape is stable.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct GitStatus {
    pub branch: Option<String>,
    pub dirty: Option<bool>,
    /// Number of changed paths in the worktree (porcelain line count), or `null`
    /// when git couldn't answer. `dirty` is just `modified > 0`.
    pub modified: Option<i64>,
    pub ahead: Option<i64>,
    /// Commits a pull would bring INTO the current branch, measured against its
    /// OWN upstream (`HEAD..@{upstream}`) — NOT the distance to origin/main. `null`
    /// when the branch has no upstream (nothing to pull) or off-repo / detached.
    pub behind: Option<i64>,
    /// Whether the current branch tracks an UPSTREAM (i.e. has been published to a
    /// remote). `Some(true)` when a tracking branch exists, `Some(false)` for a
    /// local-only branch that was never pushed, `None` off-repo / detached (no
    /// branch). The footer's ↑ pill uses this to offer a first-time *publish* for a
    /// `Some(false)` branch even when `ahead` is 0.
    pub upstream: Option<bool>,
    /// The changed file PATHS (capped at [`MAX_CHANGED_PATHS`]) for the
    /// uncommitted-files hover list. Empty when the tree is clean; left empty
    /// (not null) when git couldn't answer — the count (`modified`) carries the
    /// "couldn't answer" signal, this is only the optional path detail.
    pub files: Vec<String>,
}

/// Parse the changed file PATHS out of `git status --porcelain` output. Each line
/// is `XY <path>` — a two-column status code, a single separating space, then the
/// path — so the path begins at byte offset 3. For a rename the path is
/// `old -> new`, and we keep the NEW path (where the content now lives). Capped at
/// [`MAX_CHANGED_PATHS`] so a huge dirty tree can't balloon the payload.
///
/// IMPORTANT: pass the RAW (un-trimmed) porcelain. The first status column is a
/// SPACE for any worktree-only change (e.g. ` M file` for an unstaged
/// modification), so a leading `trim()` would shift that line and corrupt its
/// path. Offsets are byte indices; porcelain path bytes are ASCII (git quotes
/// non-ASCII names), so byte slicing never splits a char.
///
/// Quoted paths (git quotes names with special/non-ASCII bytes, wrapping them in
/// `"…"` with C-style escapes) are passed through verbatim, including the quotes —
/// the hover list is a best-effort hint, so an exact unescape isn't worth the
/// complexity; the path still reads recognizably.
pub fn parse_porcelain_paths(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            // Path starts after the 2-col status + 1 separating space (offset 3).
            // A shorter line (no path) is skipped.
            let rest = line.get(3..)?;
            if rest.is_empty() {
                return None;
            }
            // Rename / copy: `old -> new` — keep the destination path.
            let path = match rest.rsplit_once(" -> ") {
                Some((_old, new)) => new,
                None => rest,
            };
            Some(path.to_string())
        })
        .take(MAX_CHANGED_PATHS)
        .collect()
}

/// Run `git -C <dir> <args...>`, returning trimmed stdout on a clean exit, else
/// `None` (non-zero exit, spawn error, or non-UTF8 output). Fully guarded.
fn run_git(dir: &str, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .no_console_window()
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(text.trim().to_string())
}

/// Run `git -C <dir> <args...>`, returning RAW (un-trimmed) stdout on a clean exit,
/// else `None`. Used for `status --porcelain`, whose first status column can be a
/// SPACE (` M file`) that a leading trim would eat — corrupting the path parse.
fn run_git_raw(dir: &str, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .no_console_window()
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// Whether the repo at `dir` has at least one configured remote. `git remote`
/// prints one remote name per line; empty (or a git error) means none. Used to
/// decide whether an unpublished branch has anywhere to push.
fn has_remote(dir: &str) -> bool {
    run_git(dir, &["remote"]).map(|s| !s.is_empty()).unwrap_or(false)
}

/// Whether HEAD is on a real branch (not a DETACHED or unborn HEAD).
/// `git symbolic-ref -q HEAD` succeeds only when HEAD points at a branch ref.
/// A detached HEAD is not publishable, so the ↑ pill must treat it as "no branch"
/// (note `rev-parse --abbrev-ref HEAD` reports the literal `"HEAD"` when detached —
/// it does NOT return None — so the branch name alone can't distinguish the case).
fn on_branch(dir: &str) -> bool {
    run_git(dir, &["symbolic-ref", "-q", "HEAD"]).is_some()
}

/// Compute the git status for a single folder. Mirrors the statusline wrapper:
/// each field is left null when its git query fails.
pub fn status_for_dir(dir: &str) -> GitStatus {
    let mut out = GitStatus::default();
    if dir.is_empty() {
        return out;
    }

    if let Some(branch) = run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        out.branch = if branch.is_empty() { None } else { Some(branch) };
    }
    // `--porcelain` prints one line per change; empty stdout => clean tree. The
    // line count is the number of modified paths (`dirty` is just `count > 0`).
    // Read RAW (un-trimmed): the first status column is a SPACE for worktree-only
    // changes, so a trim would shift those lines and corrupt the path parse below.
    if let Some(porcelain) = run_git_raw(dir, &["status", "--porcelain"]) {
        let count = porcelain.lines().filter(|l| !l.is_empty()).count() as i64;
        out.dirty = Some(count > 0);
        out.modified = Some(count);
        // Also collect the changed file PATHS (capped) for the hover list.
        out.files = parse_porcelain_paths(&porcelain);
    }
    // Upstream, ahead, and behind. `upstream` records whether the branch is
    // published (tracks a remote); it is left null off-repo, on an unborn branch,
    // or on a DETACHED HEAD (none of which is a publishable branch — and `rev-parse
    // --abbrev-ref HEAD` reports the literal "HEAD" when detached, so we gate on
    // `on_branch`, not just `branch.is_some()`).
    //
    // `ahead` is the number of commits the next push would send: against the
    // upstream when one exists, else (an unpublished branch) the commits not yet on
    // ANY remote — i.e. what publishing the branch would upload. With no remote at
    // all there is nowhere to push, so `ahead` stays null.
    //
    // `behind` is the number of commits a pull would bring INTO this branch —
    // measured against the branch's OWN upstream (`HEAD..@{upstream}`), NOT the
    // distance to origin/main. A branch with no upstream has nothing to pull, so
    // `behind` stays null (the ↓ pill reads as the neutral zero state).
    if out.branch.is_some() && on_branch(dir) {
        let has_upstream = run_git(dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_some();
        out.upstream = Some(has_upstream);
        if has_upstream {
            out.ahead = run_git(dir, &["rev-list", "@{upstream}..HEAD", "--count"])
                .and_then(|s| s.parse::<i64>().ok());
            out.behind = run_git(dir, &["rev-list", "HEAD..@{upstream}", "--count"])
                .and_then(|s| s.parse::<i64>().ok());
        } else if has_remote(dir) {
            out.ahead = run_git(dir, &["rev-list", "--count", "HEAD", "--not", "--remotes"])
                .and_then(|s| s.parse::<i64>().ok());
        }
    }
    out
}

/// Compute git status for every `path` in parallel, keyed by the path verbatim
/// (so the frontend resolves each project's row directly). A blank/duplicate path
/// still maps to a stable (all-null) entry. Never fails: a probe that errors out
/// yields an all-null status.
pub fn status_for_paths(paths: &[String]) -> HashMap<String, GitStatus> {
    let handles: Vec<_> = paths
        .iter()
        .cloned()
        .map(|path| thread::spawn(move || (path.clone(), status_for_dir(&path))))
        .collect();

    let mut map = HashMap::new();
    for handle in handles {
        if let Ok((path, status)) = handle.join() {
            map.insert(path, status);
        }
    }
    map
}

// ───────────────────────── push / pull ─────────────────────────
//
// User-initiated sync actions for a project, fired from the project row's
// context menu. Unlike the silent `run_git` status probes, these surface git's
// own message on BOTH success and failure (a push/pull is an explicit action the
// user wants feedback on), so the frontend can show it in a toast.

/// Make a network git `Command` fully NON-INTERACTIVE — suppressing not just
/// git's built-in TERMINAL prompt but also any GUI credential helper (notably
/// Windows' Git Credential Manager, `credential.helper=manager`) and an ssh
/// passphrase / host-key prompt. Cached credentials still resolve silently; only
/// the interactive UI is disabled, so an authenticated remote keeps working while
/// an unauthenticated one fails fast.
///
/// Why this matters beyond `GIT_TERMINAL_PROMPT`: on an HTTPS remote with no
/// cached credential, GCM is a SEPARATE GUI process that pops its own sign-in
/// WINDOW — `GIT_TERMINAL_PROMPT=0` (git's terminal prompt) and `CREATE_NO_WINDOW`
/// (git's console flash) do NOT stop it. Left interactive, the automatic
/// background fetch spawns a storm of auth windows (one per repo, every poll) that
/// reads as malware to endpoint protection. `credential.interactive=false` is the
/// config key GCM honors; `GCM_INTERACTIVE=never` is the belt-and-suspenders env
/// for older GCM builds. The `-c` MUST precede the subcommand, so callers apply
/// this BEFORE adding `-C <dir>` / the subcommand args.
fn no_credential_prompt(cmd: &mut Command) -> &mut Command {
    cmd.arg("-c")
        .arg("credential.interactive=false")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never")
        .env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o ConnectTimeout=10")
}

/// Run `git -C <dir> <args...>` as a user-initiated action, returning git's own
/// message either way: `Ok(message)` on a clean exit, `Err(message)` otherwise.
/// Push/pull write their progress to stderr, so the message prefers stderr when
/// stdout is empty (and vice-versa on failure). Never panics.
///
/// Runs git NON-INTERACTIVELY (see [`no_credential_prompt`]) so a network sync can
/// never hang waiting on a prompt: git's terminal prompt, a GUI credential helper
/// (Git Credential Manager), and an ssh passphrase / host-key prompt are all
/// suppressed. A sync that would otherwise prompt fails fast with a clean `Err`
/// the frontend can toast, instead of blocking (or popping an auth window).
fn run_git_action(dir: &str, args: &[&str]) -> Result<String, String> {
    if dir.is_empty() {
        return Err("no project folder".to_string());
    }
    let mut cmd = Command::new("git");
    cmd.no_console_window();
    no_credential_prompt(&mut cmd);
    let output = cmd
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // git push/pull report status on stderr; pick whichever stream spoke.
    let message = |primary: String, fallback: String| {
        if !primary.is_empty() {
            primary
        } else {
            fallback
        }
    };
    if output.status.success() {
        Ok(message(stderr, stdout))
    } else {
        let msg = message(stderr, stdout);
        Err(if msg.is_empty() {
            "git command failed".to_string()
        } else {
            msg
        })
    }
}

/// Push the project's current branch to its remote. A PUBLISHED branch (one that
/// tracks an upstream) pushes straight to it with `git push`. An UNPUBLISHED branch
/// (no upstream — never uploaded) is PUBLISHED with `git push -u <remote> HEAD`,
/// which creates the remote branch and records tracking so later pushes are a plain
/// `git push`; the remote defaults to `origin`, else the first configured one.
/// Returns git's message on success, an error message (rejected / offline / no
/// remote at all) on failure.
pub fn push(dir: &str) -> Result<String, String> {
    if run_git(dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_some() {
        run_git_action(dir, &["push"])
    } else {
        let remote = default_push_remote(dir);
        run_git_action(dir, &["push", "-u", &remote, "HEAD"])
    }
}

/// The remote to publish an unpushed branch to: `origin` when present, else the
/// first configured remote, else `origin` (which then errors cleanly when there is
/// no remote at all). `git remote` lists one remote name per line.
fn default_push_remote(dir: &str) -> String {
    let remotes = run_git(dir, &["remote"]).unwrap_or_default();
    let names: Vec<&str> = remotes.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if names.iter().any(|&n| n == "origin") {
        "origin".to_string()
    } else {
        names.first().map(|s| s.to_string()).unwrap_or_else(|| "origin".to_string())
    }
}

/// Pull the project's current branch from its remote, fast-forward ONLY
/// (`git pull --ff-only`). A clean fast-forward succeeds; a divergent branch
/// fails cleanly WITHOUT starting a merge, so a user-triggered Pull can never
/// leave the project's worktree in a half-merged, conflict-marked state. Returns
/// git's message on success, an error message (diverged / no upstream / offline)
/// on failure.
pub fn pull(dir: &str) -> Result<String, String> {
    run_git_action(dir, &["pull", "--ff-only"])
}

// ───────────────────────── background fetch ─────────────────────────
//
// The ahead/behind counts in `status_for_dir` are measured against the LOCAL
// remote-tracking ref (`@{upstream}`), which only advances on `git fetch`. The
// status probe is deliberately local-only and fast, so it never fetches — which
// leaves the "commits to pull" count frozen at the last fetch. A separate,
// SLOWER background fetch refreshes those refs so the unchanged probe then
// reports an accurate count, with no manual `git fetch`.

/// The overall wall-clock cap on a single background `git fetch`. The
/// non-interactive guards stop a *prompt* hang, and the ssh `ConnectTimeout`
/// bounds an *ssh* connect — but an `https://` (or other non-ssh) remote, or a
/// black-hole host, has NO git-level overall timeout, so a fetch could otherwise
/// block for the OS TCP timeout (~75-130s) and pile up a stuck thread on every
/// poll. This cap guarantees each background fetch thread is short-lived
/// regardless of transport, so they can never accumulate.
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// The outcome of a background fetch for one folder, surfaced to the frontend so a
/// SILENT background-fetch failure can drive a subtle UI indicator instead of just
/// leaving the ahead/behind count quietly stale.
///
/// `Skipped` (no remote / blank path) draws NO indicator — there is nothing to
/// fetch. `Ok` is a clean fetch. `Failed` means the folder HAS a remote but the
/// fetch did not complete (offline / missing credentials / timeout) — the ONE case
/// the UI flags, so the user knows the count may be stale and can act on it.
/// Serialized lowercase (`"skipped"` / `"ok"` / `"failed"`) for the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FetchStatus {
    Skipped,
    Ok,
    Failed,
}

/// Fetch the project's remote-tracking refs so the local ahead/behind probe
/// (which reads `@{upstream}`, advanced only by a fetch) reflects new remote
/// commits. Returns a [`FetchStatus`]: `Skipped` (no remote / blank path — nothing
/// to fetch), `Ok` (clean fetch), or `Failed` (has a remote but the fetch did not
/// complete).
///
/// The fetch runs NON-INTERACTIVELY (see [`no_credential_prompt`]: no terminal
/// prompt, no GUI credential-helper window, ssh `BatchMode` + connect timeout) so
/// a background thread can never hang on a prompt, and under an OVERALL
/// [`FETCH_TIMEOUT`] so it can never hang on the network either (offline /
/// credential-less / unreachable → killed → `Failed`).
///
/// Worktree-safe: a fetch updates only refs (remote-tracking refs, `FETCH_HEAD`,
/// and — under a non-default fetch refspec — at most other NON-checked-out branch
/// refs); it never touches the index, the worktree, or the checked-out branch
/// (git refuses to fetch into the checked-out branch), so it is safe to run while
/// the user works in the repo.
pub fn fetch_dir(dir: &str) -> FetchStatus {
    if dir.is_empty() || !has_remote(dir) {
        return FetchStatus::Skipped;
    }
    if run_git_fetch(dir, FETCH_TIMEOUT) {
        FetchStatus::Ok
    } else {
        FetchStatus::Failed
    }
}

/// Run a bounded, non-interactive `git -C <dir> fetch`. Mirrors
/// [`run_git_action`]'s guards via [`no_credential_prompt`] (no terminal prompt,
/// no GUI credential-helper window, ssh `BatchMode` + connect timeout) but adds an
/// OVERALL wall-clock `timeout`: a stalled fetch is killed once the deadline
/// passes so a background thread can never block indefinitely or accumulate across
/// polls. stdio is nulled (the background path never reads fetch's output).
/// Returns `true` only on a clean, in-time exit.
///
/// The credential-prompt suppression is load-bearing here: this is the AUTOMATIC
/// fetch, fired on launch (every project, in parallel) and on a recurring poll, so
/// an interactive credential helper would pop an auth window for every
/// unauthenticated HTTPS remote on every cycle — an endless window storm rather
/// than a one-off. Suppressed, an unauthenticated remote simply fails fast (the
/// ahead/behind count stays at its last-fetched value) with no UI.
fn run_git_fetch(dir: &str, timeout: Duration) -> bool {
    let mut cmd = Command::new("git");
    cmd.no_console_window();
    no_credential_prompt(&mut cmd);
    let spawned = cmd
        .arg("-C")
        .arg(dir)
        .arg("fetch")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Past the deadline: kill the stalled fetch and reap it so the
                    // thread (and the git child) cannot outlive the poll cycle.
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// Fetch remote-tracking refs for every `path` in PARALLEL, best-effort, returning
/// each path's [`FetchStatus`] keyed by the path verbatim (so the frontend resolves
/// each project's row directly). Each folder is fetched on its own thread
/// (mirroring [`status_for_paths`]) so total latency tracks the slowest single
/// repo, and a folder that can't fetch (no remote / offline / off-repo) never
/// blocks the others. Never fails: a thread that somehow panics simply omits its
/// entry, which the UI treats as "no indicator".
pub fn fetch_remotes(paths: &[String]) -> HashMap<String, FetchStatus> {
    let handles: Vec<_> = paths
        .iter()
        .cloned()
        .map(|path| thread::spawn(move || (path.clone(), fetch_dir(&path))))
        .collect();
    let mut map = HashMap::new();
    for handle in handles {
        if let Ok((path, status)) = handle.join() {
            map.insert(path, status);
        }
    }
    map
}

// ───────────────────────── branch operations ─────────────────────────
//
// Listing, checking out, and creating local branches for the footer branch-
// switcher UI.  All operations are best-effort and mirror the null-on-failure
// contract of `status_for_dir`: failures return empty / Err rather than panic.

/// Snapshot of the branches known to a repo, returned by [`list_branches`].
/// JS sees `current/local/remotes` (camelCase not needed — all single words —
/// but kept consistent with `WorktreeCreated`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    /// The currently checked-out branch, or `None` when HEAD is detached or the
    /// query failed.
    pub current: Option<String>,
    /// Short names of every local branch (`refs/heads/**`).
    pub local: Vec<String>,
    /// Short names of every remote-tracking branch (`refs/remotes/**`), with
    /// symbolic `*/HEAD` entries (e.g. `origin/HEAD`) removed.
    pub remotes: Vec<String>,
}

/// List the branches for a repo at `dir`.  Never fails: any git error yields an
/// all-empty `BranchList`.
pub fn list_branches(dir: &str) -> BranchList {
    if dir.is_empty() {
        return BranchList::default();
    }

    // Current branch: "HEAD" means detached; empty/missing means treat as None.
    let current = run_git(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).and_then(|s| {
        if s.is_empty() || s == "HEAD" {
            None
        } else {
            Some(s)
        }
    });

    // Local branches.
    let local = run_git(dir, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .map(|out| out.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default();

    // Remote-tracking branches as `<remote>/<branch>`. We read the FULL refname
    // (not `%(refname:short)`) because git's short form renders a remote's
    // symbolic HEAD `refs/remotes/origin/HEAD` as the bare remote name `origin` —
    // which is NOT a checkout-able branch. Reading the full ref lets us drop every
    // `*/HEAD` deterministically, then strip the `refs/remotes/` prefix, so the
    // list only ever contains real `<remote>/<branch>` names.
    let remotes = run_git(dir, &["for-each-ref", "--format=%(refname)", "refs/remotes"])
        .map(|out| {
            out.lines()
                .filter(|l| !l.is_empty())
                // Drop the remote's symbolic HEAD (e.g. refs/remotes/origin/HEAD).
                .filter(|l| !l.ends_with("/HEAD"))
                // refs/remotes/origin/main -> origin/main
                .filter_map(|l| l.strip_prefix("refs/remotes/").map(str::to_string))
                .collect()
        })
        .unwrap_or_default();

    BranchList { current, local, remotes }
}

/// Check out an existing branch (or a remote-tracking branch via git's DWIM).
/// Returns git's message on success, an error string on failure.
///
/// `--end-of-options` forces `branch` to be parsed as a REF, never a flag. Without
/// it, a branch whose name begins with `-` (a ref like `refs/remotes/origin/-f`
/// is creatable and would surface here as `-f`) would be read as a git option —
/// e.g. `git checkout -f` force-resets the working tree, silently discarding
/// uncommitted changes. With the guard, `-f` is treated as a ref name (and errors
/// cleanly when no such ref exists), so a malicious/odd branch name can never
/// trigger an option.
pub fn checkout(dir: &str, branch: &str) -> Result<String, String> {
    run_git_action(dir, &["checkout", "--end-of-options", branch])
}

/// Create and check out a new branch off the current HEAD (`git checkout -b`).
/// Returns git's message on success, an error string on failure.
pub fn create_branch(dir: &str, name: &str) -> Result<String, String> {
    run_git_action(dir, &["checkout", "-b", name])
}

// ───────────────────────── git worktrees ─────────────────────────
//
// Auto-worktree projects launch each agent session into an isolated git
// worktree under `<repo>/.worktrees/<branch>`, branched off HEAD, so concurrent
// sessions never clobber one another's working tree. A session's worktree is
// pruned on close when it left nothing behind (clean tree, no commits past the
// base it forked from); otherwise it's kept for the user to reconcile. The
// management UI can list and explicitly prune accumulated worktrees.

/// Result of creating a fresh session worktree. JS sees `path/branch/base`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreated {
    /// Absolute path of the new worktree (`<repo>/.worktrees/<branch>`).
    pub path: String,
    /// The fresh `session/<ts>-<id>` branch the worktree is checked out on.
    pub branch: String,
    /// The base commit SHA (HEAD at creation) the branch forked from.
    pub base: String,
}

/// Outcome of a clean-only worktree removal. JS sees `removed/reason`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoval {
    /// True when the worktree (and its branch) were removed.
    pub removed: bool,
    /// Short why-kept reason when `removed` is false (`"dirty"` / `"has commits"`).
    pub reason: Option<String>,
}

/// One accumulated session worktree, for the management UI. JS sees
/// `path/branch/clean`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub clean: bool,
}

/// Process-local counter, mixed into the branch name so rapid successive calls
/// within the same second/nanosecond tick still get distinct branches.
static WORKTREE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Generate a unique `session/<unix-seconds>-<seq><nanos-suffix>` branch name.
fn unique_branch_name() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let seq = WORKTREE_SEQ.fetch_add(1, Ordering::Relaxed);
    // seq guarantees process-local uniqueness; nanos disambiguates across runs.
    format!("session/{}-{}{:09}", now.as_secs(), seq, now.subsec_nanos())
}

/// Ensure the repo-root `.gitignore` ignores `.worktrees`. Idempotent: appends a
/// `.worktrees` line only if no line exactly equal to `.worktrees` (or
/// `.worktrees/`) already exists; creates the file if missing.
fn ensure_worktrees_ignored(repo_path: &str) -> Result<(), String> {
    let gitignore = std::path::Path::new(repo_path).join(".gitignore");
    let existing = std::fs::read_to_string(&gitignore).unwrap_or_default();
    let already = existing
        .lines()
        .any(|l| matches!(l.trim(), ".worktrees" | ".worktrees/"));
    if already {
        return Ok(());
    }
    // Preserve existing content; ensure we start on a fresh line.
    let mut body = existing;
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(".worktrees\n");
    std::fs::write(&gitignore, body).map_err(|e| format!("writing .gitignore failed: {e}"))
}

/// Create a fresh session worktree off `repo_path`'s HEAD. Returns the worktree
/// path, the new branch, and the base SHA. `Err` on any failure (not a repo, git
/// error) — never panics.
pub fn worktree_create(repo_path: &str) -> Result<WorktreeCreated, String> {
    // Base SHA = HEAD. Also validates that this is a git repo with a commit.
    let base = run_git(repo_path, &["rev-parse", "HEAD"])
        .ok_or_else(|| format!("{repo_path} is not a git repo (or has no commits)"))?;

    ensure_worktrees_ignored(repo_path)?;

    let branch = unique_branch_name();
    let wt_path = std::path::Path::new(repo_path)
        .join(".worktrees")
        .join(&branch);
    let wt_str = wt_path.to_str().ok_or("worktree path is not valid UTF-8")?;

    run_git(
        repo_path,
        &["worktree", "add", "-b", &branch, wt_str, "HEAD"],
    )
    .ok_or_else(|| format!("git worktree add failed for {wt_str}"))?;

    // Return the CANONICAL path (matching what `git worktree list` reports), so
    // callers can compare/round-trip it against the listing without symlink skew.
    let path = std::fs::canonicalize(&wt_path)
        .ok()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| wt_str.to_string());

    Ok(WorktreeCreated { path, branch, base })
}

/// Remove a session worktree only if it's "clean": its `status --porcelain` is
/// empty AND it has zero commits past `base`. When clean, the worktree is removed
/// and its branch deleted (`removed=true`). When not clean, it's left intact
/// (`removed=false`, with a short reason). Only `Err`s on unexpected git failures.
pub fn worktree_remove_if_clean(worktree_path: &str, base: &str) -> Result<WorktreeRemoval, String> {
    // Resolve the branch and owning repo BEFORE removing, so we can delete the
    // branch from the main repo afterwards (the worktree dir is gone by then).
    let branch = run_git(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"])
        .ok_or_else(|| format!("{worktree_path} is not a git worktree"))?;
    let main_repo = main_repo_dir(worktree_path);

    let porcelain = run_git(worktree_path, &["status", "--porcelain"])
        .ok_or_else(|| format!("git status failed in {worktree_path}"))?;
    if !porcelain.is_empty() {
        return Ok(WorktreeRemoval {
            removed: false,
            reason: Some("dirty".to_string()),
        });
    }

    let count = run_git(
        worktree_path,
        &["rev-list", &format!("{base}..HEAD"), "--count"],
    )
    .ok_or_else(|| format!("git rev-list failed in {worktree_path}"))?;
    if count.trim() != "0" {
        return Ok(WorktreeRemoval {
            removed: false,
            reason: Some("has commits".to_string()),
        });
    }

    // Clean: prune the worktree, then delete the now-unused branch from the main
    // repo (the worktree dir no longer exists after removal).
    remove_worktree(worktree_path, false)?;
    if let Some(repo) = main_repo.as_deref() {
        delete_branch(repo, &branch);
    }
    Ok(WorktreeRemoval {
        removed: true,
        reason: None,
    })
}

/// Resolve the MAIN repository working dir that owns `worktree_path`, so a branch
/// delete can run there AFTER the worktree dir is gone. Uses
/// `git rev-parse --path-format=absolute --git-common-dir`, whose parent is the
/// main worktree root. Falls back to `<repo>/.worktrees` parent inference when git
/// can't answer. `None` only if neither works.
fn main_repo_dir(worktree_path: &str) -> Option<String> {
    if let Some(common) = run_git(
        worktree_path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ) {
        // `--git-common-dir` points at the main repo's `.git`; its parent is the
        // main worktree root.
        let p = std::path::Path::new(common.trim());
        if let Some(parent) = p.parent() {
            return parent.to_str().map(|s| s.to_string());
        }
    }
    // Fallback: <repo>/.worktrees/<branch...> → climb to the dir holding
    // `.worktrees`.
    let path = std::path::Path::new(worktree_path);
    for anc in path.ancestors() {
        if anc.file_name().and_then(|n| n.to_str()) == Some(".worktrees") {
            return anc.parent().and_then(|p| p.to_str()).map(|s| s.to_string());
        }
    }
    None
}

/// List the session worktrees under `<repo>/.worktrees/`, with each one's branch
/// and clean flag. Off-repo / git failure yields an empty list.
pub fn worktree_list(repo_path: &str) -> Vec<WorktreeInfo> {
    let Some(porcelain) = run_git(repo_path, &["worktree", "list", "--porcelain"]) else {
        return Vec::new();
    };
    let raw_prefix = std::path::Path::new(repo_path).join(".worktrees");
    // Git reports CANONICALIZED paths (e.g. /private/var on macOS) while the repo
    // path the caller passed may be symlinked (/var). Canonicalize the prefix so
    // the `starts_with` filter matches regardless; fall back to the raw prefix.
    let prefix = std::fs::canonicalize(&raw_prefix).unwrap_or(raw_prefix);

    let mut out = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;

    // The porcelain output is record-per-worktree, blank-line separated; a record
    // starts with `worktree <abs-path>` and may carry a `branch refs/heads/<name>`.
    let flush = |path: &mut Option<String>, branch: &mut Option<String>, out: &mut Vec<WorktreeInfo>| {
        if let Some(p) = path.take() {
            if std::path::Path::new(&p).starts_with(&prefix) {
                let clean = run_git(&p, &["status", "--porcelain"])
                    .map(|s| s.is_empty())
                    .unwrap_or(false);
                out.push(WorktreeInfo {
                    path: p,
                    branch: branch.clone(),
                    clean,
                });
            }
        }
        *branch = None;
    };

    for line in porcelain.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // New record begins — flush the previous one.
            flush(&mut cur_path, &mut cur_branch, &mut out);
            cur_path = Some(p.trim().to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.trim().trim_start_matches("refs/heads/").to_string());
        }
    }
    flush(&mut cur_path, &mut cur_branch, &mut out);
    out
}

/// Explicitly remove a worktree (management UI prune). `force` passes `--force`
/// to git (drops uncommitted changes). The worktree's branch is also deleted.
pub fn worktree_remove(worktree_path: &str, force: bool) -> Result<(), String> {
    // Resolve the branch and owning repo before removal so we can delete the
    // branch from the main repo afterwards (the worktree dir is gone by then).
    let main_repo = main_repo_dir(worktree_path);
    // Prefer a direct query; if the worktree dir was already deleted out-of-band,
    // `git -C <gone>` fails, so fall back to the main repo's worktree listing.
    let branch = run_git(worktree_path, &["rev-parse", "--abbrev-ref", "HEAD"]).or_else(|| {
        main_repo
            .as_deref()
            .and_then(|repo| branch_for_worktree(repo, worktree_path))
    });
    remove_worktree(worktree_path, force)?;
    if let (Some(b), Some(repo)) = (branch, main_repo.as_deref()) {
        delete_branch(repo, &b);
    }
    Ok(())
}

/// Run `git worktree remove [--force] <path>`. Spawns from the worktree itself so
/// git resolves the owning repo; the explicit path arg keeps the target
/// unambiguous. `Err` on git failure.
fn remove_worktree(worktree_path: &str, force: bool) -> Result<(), String> {
    // Run from the MAIN repo, not the worktree itself: a `git -C <worktree>` call
    // fails outright once the worktree dir is gone (removed underneath us), which
    // would make the prune fallback below unreachable. `main_repo_dir` has a
    // pure-path fallback, so it resolves even for an already-missing worktree dir.
    let main = main_repo_dir(worktree_path);
    let run_dir = main.as_deref().unwrap_or(worktree_path);

    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(worktree_path);
    // Try a clean removal; if it fails, prune stale admin entries (covers a worktree
    // dir deleted out-of-band). Both run from the main repo.
    let _ = run_git(run_dir, &args).or_else(|| run_git(run_dir, &["worktree", "prune"]));

    // Only report success when the worktree is ACTUALLY gone. `git worktree prune`
    // exits 0 without removing a still-present-but-unremovable worktree, so trusting
    // its exit code would falsely claim removal — and the caller would then delete
    // the branch out from under a worktree still on disk.
    if std::path::Path::new(worktree_path).exists() {
        return Err(format!("git worktree remove failed for {worktree_path}"));
    }
    Ok(())
}

/// Resolve a worktree's branch from the MAIN repo's listing. Works even when the
/// worktree dir is already gone (git keeps the admin entry until pruned), so it
/// backstops a direct `rev-parse` that can't run against a missing dir.
fn branch_for_worktree(main_repo: &str, worktree_path: &str) -> Option<String> {
    let target = std::fs::canonicalize(worktree_path)
        .ok()
        .and_then(|p| p.to_str().map(str::to_string));
    worktree_list(main_repo)
        .into_iter()
        .find(|w| w.path == worktree_path || target.as_deref() == Some(w.path.as_str()))
        .and_then(|w| w.branch)
}

/// Best-effort delete of a now-unused branch. `dir` MUST be the main repo dir
/// (callers resolve it via `main_repo_dir` BEFORE removal, since the worktree dir
/// is gone by the time this runs). Failure is swallowed: a leftover branch is
/// harmless and must not fail close.
fn delete_branch(dir: &str, branch: &str) {
    let _ = run_git(dir, &["branch", "-D", branch]);
}

// ───────────────────────── commits-to-push ─────────────────────────
//
// Lists the commits that a `git push` would send — i.e. commits on HEAD that
// are NOT yet on the upstream tracking branch. Used by the footer's push pill
// popover to show the user exactly what they are about to push.
//
// Best-effort: no upstream / not a repo / git error → empty vec, never an error.
// The output is parsed from `git log @{u}..HEAD --format=%H%x1f%s`, splitting
// each line on the ASCII unit-separator (0x1f) to separate the full hash from
// the commit subject. The 0x1f byte never appears in commit subjects, so the
// parse is robust against colons, slashes, parens, etc.

/// One commit record returned by [`commits_to_push`]: full hash + one-line subject.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PushCommit {
    pub hash: String,
    pub subject: String,
}

/// Parse the output of `git log @{u}..HEAD --format=%H%x1f%s` into a vec of
/// [`PushCommit`]. Each non-empty line must contain a 0x1f separator; lines
/// without one are silently skipped (malformed or blank). Pure function so it
/// can be unit-tested without a real repo.
pub fn parse_push_commits(stdout: &str) -> Vec<PushCommit> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let (hash, subject) = line.split_once('\x1f')?;
            if hash.is_empty() {
                return None;
            }
            Some(PushCommit {
                hash: hash.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect()
}

/// List the commits that would be sent by a `git push` — commits on HEAD not yet
/// on the upstream tracking branch. Runs `git log @{u}..HEAD --format=%H%x1f%s`
/// and parses the output. Best-effort: no upstream / off-repo / git failure →
/// empty vec, never an error. Mirrors the null-on-failure style of the other
/// best-effort git helpers in this module.
pub fn commits_to_push_for(dir: &str) -> Vec<PushCommit> {
    if dir.is_empty() {
        return vec![];
    }
    // Mirror status_for_dir's "commits to push" definition so the popover list
    // matches the ↑ count exactly: against the upstream when the branch is
    // published, else (an unpublished branch with a remote) the commits not yet on
    // ANY remote — what publishing the branch would upload. No upstream and no
    // remote → nothing to list.
    //
    // run_git_raw preserves the newlines BETWEEN records (each commit is its own
    // line); trimming the whole output would coalesce them into one unparseable
    // blob. There is no leading-space significance here (unlike porcelain status).
    let stdout = if run_git(dir, &["rev-parse", "--abbrev-ref", "@{upstream}"]).is_some() {
        run_git_raw(dir, &["log", "--format=%H\x1f%s", "@{u}..HEAD"])
    } else if on_branch(dir) && has_remote(dir) {
        // Unpublished branch: list what publishing would upload. Gated on `on_branch`
        // so a DETACHED HEAD (not publishable) lists nothing — matching the null
        // `ahead` count above, so the pill count and popover list never disagree.
        run_git_raw(dir, &["log", "--format=%H\x1f%s", "HEAD", "--not", "--remotes"])
    } else {
        None
    };
    let stdout = match stdout {
        Some(s) => s,
        None => return vec![],
    };
    parse_push_commits(&stdout)
}

/// Tauri command: list the commits that a push would send for the repo at
/// `repo_path`. Best-effort — no upstream / off-repo / git failure → `[]`.
/// Never returns an error; the frontend treats `[]` as "nothing to push" or
/// "couldn't determine".
#[tauri::command(async)]
pub fn commits_to_push(repo_path: String) -> Vec<PushCommit> {
    commits_to_push_for(&repo_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// A throwaway temp dir, removed on drop.
    struct TempRepo(PathBuf);
    impl TempRepo {
        /// `git init` a fresh repo under the system temp dir with an identity and
        /// one initial commit, so HEAD resolves.
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("agentdesk-git-{tag}-{nanos}"));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.to_str().unwrap();
            run(path, &["init", "-q"]);
            run(path, &["config", "user.email", "t@example.com"]);
            run(path, &["config", "user.name", "Test"]);
            // Keep default branch deterministic across git versions.
            run(path, &["checkout", "-q", "-b", "main"]);
            fs::write(dir.join("README.md"), "hello\n").unwrap();
            run(path, &["add", "."]);
            run(path, &["commit", "-q", "-m", "init"]);
            TempRepo(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn str(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Run a git command in `dir`, asserting success (test setup helper).
    fn run(dir: &str, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn launching_an_auto_worktree_project() {
        let repo = TempRepo::new("create");
        let info = worktree_create(repo.str()).expect("create should succeed");
        // Path is under <repo>/.worktrees/ (canonicalize to absorb macOS's
        // /var -> /private/var symlink, since the returned path is canonical).
        let wt_dir = fs::canonicalize(repo.path()).unwrap().join(".worktrees");
        assert!(
            Path::new(&info.path).starts_with(&wt_dir),
            "{} should be under {:?}",
            info.path,
            wt_dir
        );
        // Branch is a fresh session/... branch.
        assert!(info.branch.starts_with("session/"), "branch was {}", info.branch);
        // Base SHA is a 40-char-ish hex commit.
        assert!(info.base.len() >= 7 && info.base.chars().all(|c| c.is_ascii_hexdigit()));
        // The worktree directory exists on disk.
        assert!(Path::new(&info.path).is_dir(), "worktree dir should exist");
    }

    #[test]
    fn worktree_create_errors_on_non_git_dir() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentdesk-git-nonrepo-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let res = worktree_create(dir.to_str().unwrap());
        let _ = fs::remove_dir_all(&dir);
        assert!(res.is_err(), "non-git dir should Err, got {:?}", res);
    }

    #[test]
    fn first_worktree_updates_gitignore() {
        let repo = TempRepo::new("gitignore");
        worktree_create(repo.str()).unwrap();
        let gi = repo.path().join(".gitignore");
        let body = fs::read_to_string(&gi).expect(".gitignore should exist");
        let count = body.lines().filter(|l| l.trim() == ".worktrees").count();
        assert_eq!(count, 1, ".worktrees should appear exactly once: {:?}", body);
        // A second create must NOT duplicate the ignore line.
        worktree_create(repo.str()).unwrap();
        let body2 = fs::read_to_string(&gi).unwrap();
        let count2 = body2.lines().filter(|l| l.trim() == ".worktrees").count();
        assert_eq!(count2, 1, "second create should not duplicate: {:?}", body2);
    }

    #[test]
    fn concurrent_launches_get_distinct_worktrees() {
        let repo = TempRepo::new("distinct");
        let a = worktree_create(repo.str()).unwrap();
        let b = worktree_create(repo.str()).unwrap();
        assert_ne!(a.branch, b.branch, "branches must differ");
        assert_ne!(a.path, b.path, "paths must differ");
    }

    #[test]
    fn clean_worktree_is_removed_on_close() {
        let repo = TempRepo::new("clean");
        let info = worktree_create(repo.str()).unwrap();
        let res = worktree_remove_if_clean(&info.path, &info.base).unwrap();
        assert!(res.removed, "clean worktree should be removed: {:?}", res);
        assert!(!Path::new(&info.path).is_dir(), "worktree dir should be gone");
    }

    #[test]
    fn dirty_worktree_is_kept_on_close() {
        let repo = TempRepo::new("dirty");
        let info = worktree_create(repo.str()).unwrap();
        // Make the worktree dirty with an uncommitted file.
        fs::write(Path::new(&info.path).join("scratch.txt"), "wip\n").unwrap();
        let res = worktree_remove_if_clean(&info.path, &info.base).unwrap();
        assert!(!res.removed, "dirty worktree should be kept: {:?}", res);
        assert!(Path::new(&info.path).is_dir(), "worktree dir should remain");
    }

    #[test]
    fn listing_accumulated_worktrees() {
        let repo = TempRepo::new("list");
        let info = worktree_create(repo.str()).unwrap();
        let list = worktree_list(repo.str());
        let found = list
            .iter()
            .find(|w| w.path == info.path)
            .expect("created worktree should be listed");
        assert_eq!(found.branch.as_deref(), Some(info.branch.as_str()));
        assert!(found.clean, "fresh worktree should be clean");
    }

    #[test]
    fn pruning_a_worktree() {
        let repo = TempRepo::new("prune");
        let info = worktree_create(repo.str()).unwrap();
        // Dirty it so a non-force remove would refuse; force should still prune.
        fs::write(Path::new(&info.path).join("scratch.txt"), "wip\n").unwrap();
        worktree_remove(&info.path, true).expect("force remove should succeed");
        assert!(!Path::new(&info.path).is_dir(), "worktree dir should be gone");
    }

    #[test]
    fn pruning_a_worktree_whose_dir_was_deleted_out_of_band() {
        // Regression: prune must run from the MAIN repo, not the (now-missing)
        // worktree dir, and the branch must still be deleted afterwards.
        let repo = TempRepo::new("prune-gone");
        let info = worktree_create(repo.str()).unwrap();
        // Simulate the user deleting the worktree folder directly.
        fs::remove_dir_all(&info.path).unwrap();
        assert!(!Path::new(&info.path).is_dir());

        worktree_remove(&info.path, false).expect("remove of an already-gone dir should succeed");

        // Admin metadata pruned: the worktree no longer appears in the listing...
        let listed = worktree_list(repo.str());
        assert!(
            !listed.iter().any(|w| w.path == info.path),
            "stale worktree should be pruned from the listing"
        );
        // ...and its branch is gone (deleted from the main repo).
        let branches = run_git(repo.str(), &["branch", "--list", &info.branch]).unwrap_or_default();
        assert!(branches.trim().is_empty(), "session branch should be deleted");
    }

    /// `git init --bare` a throwaway remote under the temp dir. Returns its path
    /// holder (removed on drop) — a stand-in `origin` for push/pull tests.
    fn bare_remote(tag: &str) -> TempRepo {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentdesk-bare-{tag}-{nanos}.git"));
        fs::create_dir_all(&dir).unwrap();
        run(dir.to_str().unwrap(), &["init", "--bare", "-q"]);
        TempRepo(dir)
    }

    #[test]
    fn push_sends_commits_to_a_configured_remote() {
        let repo = TempRepo::new("push");
        let remote = bare_remote("push");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // A new local commit not yet on the remote.
        fs::write(repo.path().join("more.md"), "more\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "more"]);

        push(repo.str()).expect("push to a configured remote should succeed");

        // The remote now has 2 commits on main.
        let count = run_git(remote.str(), &["rev-list", "main", "--count"]).unwrap();
        assert_eq!(count, "2", "remote should have received the pushed commit");
    }

    #[test]
    fn push_without_a_remote_errors() {
        let repo = TempRepo::new("pushnorem");
        let res = push(repo.str());
        assert!(res.is_err(), "push with no remote should Err, got {:?}", res);
    }

    #[test]
    fn push_publishes_an_unpushed_branch_and_sets_its_upstream() {
        let repo = TempRepo::new("push-publish");
        let remote = bare_remote("push-publish");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // A new branch with a commit, never published (no upstream).
        run(repo.str(), &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.path().join("c.md"), "c\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "c"]);

        push(repo.str()).expect("publishing an unpushed branch should succeed");

        // The remote received the branch (the main commit + the new one).
        let count = run_git(remote.str(), &["rev-list", "feature", "--count"]).unwrap();
        assert_eq!(count, "2", "remote should have the published branch's commits");
        // The local branch now tracks origin/feature (later pushes are plain).
        let up = run_git(repo.str(), &["rev-parse", "--abbrev-ref", "@{upstream}"]);
        assert_eq!(up.as_deref(), Some("origin/feature"), "publishing sets the upstream");
    }

    #[test]
    fn status_reports_upstream_and_counts_ahead_vs_upstream() {
        let repo = TempRepo::new("upstream-true");
        let remote = bare_remote("upstream-true");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // Two local commits not yet pushed.
        fs::write(repo.path().join("a.md"), "a\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "a"]);
        fs::write(repo.path().join("b.md"), "b\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "b"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.upstream, Some(true), "a tracked branch reports upstream=true");
        assert_eq!(s.ahead, Some(2), "two commits ahead of the upstream");
    }

    #[test]
    fn status_counts_publishable_commits_for_an_unpushed_branch() {
        let repo = TempRepo::new("upstream-false");
        let remote = bare_remote("upstream-false");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // A new branch that is never pushed (no upstream), with two commits.
        run(repo.str(), &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.path().join("c.md"), "c\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "c"]);
        fs::write(repo.path().join("d.md"), "d\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "d"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.upstream, Some(false), "an unpushed branch reports upstream=false");
        assert_eq!(
            s.ahead,
            Some(2),
            "ahead counts the commits not on any remote (what publishing sends)"
        );
    }

    #[test]
    fn status_reports_zero_publishable_commits_for_a_fresh_unpushed_branch() {
        let repo = TempRepo::new("upstream-zero");
        let remote = bare_remote("upstream-zero");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // A fresh branch off the pushed main with NO new commits.
        run(repo.str(), &["checkout", "-q", "-b", "fresh"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.upstream, Some(false), "an unpushed branch reports upstream=false");
        assert_eq!(
            s.ahead,
            Some(0),
            "no commits beyond the remote yet, but the branch is still publishable"
        );
    }

    #[test]
    fn status_leaves_upstream_and_ahead_null_on_a_detached_head() {
        // Regression: a DETACHED HEAD reports the literal branch "HEAD" from
        // `rev-parse --abbrev-ref`, so it must NOT be treated as a publishable
        // branch — upstream/ahead stay null (neutral, non-actionable ↑ pill) rather
        // than offering a publish that `git push -u origin HEAD` can't perform.
        let repo = TempRepo::new("detached");
        let remote = bare_remote("detached");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // A second commit, then detach onto it.
        fs::write(repo.path().join("x.md"), "x\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "x"]);
        run(repo.str(), &["checkout", "-q", "--detach", "HEAD"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.upstream, None, "a detached HEAD is not a publishable branch");
        assert_eq!(s.ahead, None, "a detached HEAD reports no ahead count");
        // The commit list must agree with the (null) count — empty, not the
        // unpushed-commit list, so the pill and popover never disagree.
        assert!(
            commits_to_push_for(repo.str()).is_empty(),
            "a detached HEAD lists no commits to push"
        );
    }

    #[test]
    fn status_leaves_ahead_null_when_there_is_no_remote() {
        let repo = TempRepo::new("no-remote-ahead");
        let s = status_for_dir(repo.str());
        assert_eq!(s.upstream, Some(false), "a branch with no upstream reports upstream=false");
        assert_eq!(s.ahead, None, "no remote means nowhere to push, so ahead stays null");
    }

    /// Clone `remote`, add `n` commits on `branch`, and push them — advancing
    /// that branch on the remote so a fetching repo sees its upstream move ahead.
    /// Sets up "behind" scenarios: commits land on the remote that a local branch
    /// has not pulled yet.
    fn advance_remote_branch(remote: &str, branch: &str, tag: &str, n: usize) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("agentdesk-adv-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.to_str().unwrap();
        run(p, &["clone", "-q", remote, "."]);
        run(p, &["config", "user.email", "t@example.com"]);
        run(p, &["config", "user.name", "Test"]);
        run(p, &["checkout", "-q", branch]);
        for i in 0..n {
            fs::write(dir.join(format!("adv-{branch}-{i}.md")), "x\n").unwrap();
            run(p, &["add", "."]);
            run(p, &["commit", "-q", "-m", &format!("adv {branch} {i}")]);
        }
        run(p, &["push", "-q", "origin", branch]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_counts_behind_against_the_branch_upstream() {
        let repo = TempRepo::new("behind-upstream");
        let remote = bare_remote("behind-upstream");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // The remote's main moves two commits ahead; the local branch fetches but
        // does not pull, so those two commits are waiting to be pulled.
        advance_remote_branch(remote.str(), "main", "behind-upstream", 2);
        run(repo.str(), &["fetch", "-q", "origin"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.behind, Some(2), "two upstream commits are waiting to be pulled");
    }

    #[test]
    fn status_behind_uses_the_branchs_own_upstream_not_main() {
        // The crux: a feature branch's pull count must reflect commits to pull on
        // THAT branch (vs origin/feature), never the distance to origin/main.
        let repo = TempRepo::new("behind-not-main");
        let remote = bare_remote("behind-not-main");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // Publish a feature branch so it tracks origin/feature.
        run(repo.str(), &["checkout", "-q", "-b", "feature"]);
        run(repo.str(), &["push", "-u", "origin", "feature"]);
        // origin/main races three commits ahead; origin/feature gains just one.
        advance_remote_branch(remote.str(), "main", "behind-not-main-m", 3);
        advance_remote_branch(remote.str(), "feature", "behind-not-main-f", 1);
        run(repo.str(), &["fetch", "-q", "origin"]);

        let s = status_for_dir(repo.str());
        assert_eq!(
            s.behind,
            Some(1),
            "behind counts commits to pull on the branch's own upstream, not the 3 on main"
        );
    }

    #[test]
    fn status_leaves_behind_null_for_a_branch_with_no_upstream() {
        // An unpublished branch has nowhere to pull from — even sitting behind
        // origin/main, there is nothing to pull INTO this branch.
        let repo = TempRepo::new("behind-no-upstream");
        let remote = bare_remote("behind-no-upstream");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // Remote main advances; the local cuts a fresh feature branch that is never
        // published (no upstream) and so trails origin/main.
        advance_remote_branch(remote.str(), "main", "behind-no-upstream", 2);
        run(repo.str(), &["fetch", "-q", "origin"]);
        run(repo.str(), &["checkout", "-q", "-b", "feature"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.upstream, Some(false), "the feature branch is unpublished");
        assert_eq!(s.behind, None, "no upstream means nothing to pull, so behind stays null");
    }

    #[test]
    fn status_reports_zero_behind_when_in_sync_with_upstream() {
        let repo = TempRepo::new("behind-zero");
        let remote = bare_remote("behind-zero");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);

        let s = status_for_dir(repo.str());
        assert_eq!(s.behind, Some(0), "in sync with the upstream — nothing to pull");
    }

    #[test]
    fn new_remote_commit_becomes_visible_without_a_manual_fetch() {
        // The crux of the change: the local status probe never fetches, so a behind
        // count is stale until something advances the remote-tracking ref. The
        // background fetch must do exactly that, so the SAME probe then reports the
        // pullable commits — with no manual `git fetch`.
        let repo = TempRepo::new("bgfetch-behind");
        let remote = bare_remote("bgfetch-behind");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        // The remote's main moves two commits ahead; the local repo has NOT fetched.
        advance_remote_branch(remote.str(), "main", "bgfetch-behind", 2);
        // The background fetch advances the remote-tracking ref...
        fetch_remotes(&[repo.str().to_string()]);
        // ...so the SAME local status probe now reports the two pullable commits.
        assert_eq!(
            status_for_dir(repo.str()).behind,
            Some(2),
            "after the background fetch the upstream ref is current and behind reflects it"
        );
    }

    #[test]
    fn the_fast_status_probe_stays_local_only() {
        // status_for_dir must NOT itself fetch: with the remote advanced but no
        // fetch run, the probe still reads the STALE upstream ref (behind 0). The
        // separate background fetch is what advances it (asserted above).
        let repo = TempRepo::new("bgfetch-local-only");
        let remote = bare_remote("bgfetch-local-only");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        advance_remote_branch(remote.str(), "main", "bgfetch-local-only", 2);
        assert_eq!(
            status_for_dir(repo.str()).behind,
            Some(0),
            "the local-only probe does not fetch, so it sees nothing to pull yet"
        );
    }

    #[test]
    fn background_fetch_is_parallel_and_best_effort() {
        // fetch_remotes fans out over many folders: a folder that CAN fetch is
        // advanced, while a no-remote repo and a bogus path are silently skipped —
        // one bad folder never blocks or fails the batch.
        let repo = TempRepo::new("bgfetch-batch-ok");
        let remote = bare_remote("bgfetch-batch-ok");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        advance_remote_branch(remote.str(), "main", "bgfetch-batch-ok", 1);
        let norem = TempRepo::new("bgfetch-batch-norem");

        // A mix of: a fetchable repo, a remoteless repo, and an off-repo path.
        let outcomes = fetch_remotes(&[
            repo.str().to_string(),
            norem.str().to_string(),
            "/definitely/not/a/repo/anywhere".to_string(),
        ]);

        // Each path reports its own outcome: the fetchable repo Ok, the remoteless
        // repo and the off-repo path Skipped (nothing to fetch — no indicator).
        assert_eq!(outcomes.get(repo.str()), Some(&FetchStatus::Ok));
        assert_eq!(outcomes.get(norem.str()), Some(&FetchStatus::Skipped));
        assert_eq!(
            outcomes.get("/definitely/not/a/repo/anywhere"),
            Some(&FetchStatus::Skipped)
        );

        // The good repo was fetched (behind now reflects the remote)...
        assert_eq!(
            status_for_dir(repo.str()).behind,
            Some(1),
            "the fetchable repo in the batch was advanced"
        );
        // ...and the bad folders were harmless no-ops (the remoteless repo has no
        // upstream to pull), proving the batch neither blocked nor errored.
        assert_eq!(
            status_for_dir(norem.str()).behind,
            None,
            "the remoteless repo has no upstream and was skipped without error"
        );
    }

    #[test]
    fn fetch_dir_is_a_safe_no_op_for_a_remoteless_or_bogus_folder() {
        // fetch_dir directly: a repo with no remote has nothing to fetch, and an
        // off-repo / blank path is a safe no-op (Skipped) — never a panic/error,
        // and never Failed (Skipped draws no UI indicator).
        let repo = TempRepo::new("bgfetch-norem");
        assert_eq!(fetch_dir(repo.str()), FetchStatus::Skipped, "no remote → Skipped");
        assert_eq!(
            fetch_dir("/definitely/not/a/repo/anywhere"),
            FetchStatus::Skipped,
            "off-repo → Skipped"
        );
        assert_eq!(fetch_dir(""), FetchStatus::Skipped, "blank dir → Skipped");
    }

    #[test]
    fn fetch_dir_reports_failed_when_a_configured_remote_cannot_be_reached() {
        // A repo that HAS a remote but cannot reach it fails fast (the local path
        // remote does not exist) — the one case surfaced to the UI as Failed, so a
        // stale ahead/behind count becomes visible rather than silent.
        let repo = TempRepo::new("bgfetch-failed");
        run(repo.str(), &["remote", "add", "origin", "/nonexistent/bare/repo.git"]);
        assert_eq!(
            fetch_dir(repo.str()),
            FetchStatus::Failed,
            "a configured-but-unreachable remote reports Failed"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_git_fetch_abandons_a_stalled_transport_at_the_deadline() {
        // The ssh ConnectTimeout does NOT bound a non-ssh / black-hole transport, so
        // the OVERALL wall-clock timeout must kill a stalled fetch rather than block
        // the thread for the OS network timeout. Use an `ext::` transport that hangs
        // (a no-output `sleep`) so the fetch can never complete on its own.
        let repo = TempRepo::new("bgfetch-timeout");
        // The ext:: transport is restricted by default; allow it for THIS repo only.
        run(repo.str(), &["config", "protocol.ext.allow", "always"]);
        run(repo.str(), &["remote", "add", "origin", "ext::sh -c \"sleep 30\""]);

        let start = Instant::now();
        let ok = run_git_fetch(repo.str(), Duration::from_millis(500));
        let elapsed = start.elapsed();

        assert!(!ok, "a stalled fetch must report failure");
        // Proves the kill path fired: without the timeout this would block ~30s.
        assert!(
            elapsed < Duration::from_secs(10),
            "the timeout must abandon the stalled fetch promptly, took {:?}",
            elapsed
        );
    }

    #[test]
    fn fetch_never_alters_the_working_tree() {
        // A fetch only writes remote-tracking refs; it must never touch the index,
        // the worktree, or the checked-out branch — safe to run mid-work.
        let repo = TempRepo::new("bgfetch-worktree");
        let remote = bare_remote("bgfetch-worktree");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        advance_remote_branch(remote.str(), "main", "bgfetch-worktree", 1);
        // Dirty the worktree with an uncommitted change before fetching.
        fs::write(repo.path().join("README.md"), "locally edited\n").unwrap();
        let before = status_for_dir(repo.str());

        fetch_remotes(&[repo.str().to_string()]);

        let after = status_for_dir(repo.str());
        assert_eq!(after.dirty, before.dirty, "fetch must not change the dirty flag");
        assert_eq!(after.modified, before.modified, "fetch must not touch the worktree");
        assert_eq!(after.files, before.files, "fetch must not change the changed-paths list");
        assert_eq!(after.branch, before.branch, "fetch must not switch branches");
        assert_eq!(after.behind, Some(1), "the fetch advanced the upstream ref");
    }

    #[test]
    fn commits_to_push_lists_an_unpushed_branchs_commits() {
        let repo = TempRepo::new("ctp-unpushed");
        let remote = bare_remote("ctp-unpushed");
        run(repo.str(), &["remote", "add", "origin", remote.str()]);
        run(repo.str(), &["push", "-u", "origin", "main"]);
        run(repo.str(), &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.path().join("c.md"), "c\n").unwrap();
        run(repo.str(), &["add", "."]);
        run(repo.str(), &["commit", "-q", "-m", "feat c"]);

        let commits = commits_to_push_for(repo.str());
        assert_eq!(commits.len(), 1, "one unpushed commit, got {:?}", commits);
        assert_eq!(commits[0].subject, "feat c");
    }

    #[test]
    fn pull_on_a_divergent_branch_fails_without_a_mid_merge_worktree() {
        // A clone and its origin each commit a DIFFERENT file on main → the
        // branches diverge. A plain `git pull` would try to merge (and could leave
        // a conflicted, mid-merge worktree); `--ff-only` must instead refuse
        // cleanly, leaving the clone's worktree untouched (no MERGE_HEAD).
        let origin = TempRepo::new("divorigin");
        let remote = bare_remote("div");
        run(origin.str(), &["remote", "add", "origin", remote.str()]);
        run(origin.str(), &["push", "-u", "origin", "main"]);

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let clone_dir = std::env::temp_dir().join(format!("agentdesk-divclone-{nanos}"));
        run(
            std::env::temp_dir().to_str().unwrap(),
            &["clone", "-q", remote.str(), clone_dir.to_str().unwrap()],
        );
        run(clone_dir.to_str().unwrap(), &["config", "user.email", "t@example.com"]);
        run(clone_dir.to_str().unwrap(), &["config", "user.name", "Test"]);
        let clone = TempRepo(clone_dir);

        // Origin advances main and pushes.
        fs::write(origin.path().join("o.md"), "origin\n").unwrap();
        run(origin.str(), &["add", "."]);
        run(origin.str(), &["commit", "-q", "-m", "origin-side"]);
        run(origin.str(), &["push", "origin", "main"]);

        // The clone makes its OWN divergent commit (not on the remote).
        fs::write(clone.path().join("c.md"), "clone\n").unwrap();
        run(clone.str(), &["add", "."]);
        run(clone.str(), &["commit", "-q", "-m", "clone-side"]);

        let res = pull(clone.str());
        assert!(res.is_err(), "divergent ff-only pull should fail, got {:?}", res);
        // The worktree must NOT be left mid-merge.
        assert!(
            !clone.path().join(".git").join("MERGE_HEAD").exists(),
            "ff-only pull must not start a merge"
        );
    }

    #[test]
    fn pull_fast_forwards_from_the_remote() {
        // A bare remote seeded from one clone; a second clone pulls the new commit.
        let origin = TempRepo::new("pullorigin");
        let remote = bare_remote("pull");
        run(origin.str(), &["remote", "add", "origin", remote.str()]);
        run(origin.str(), &["push", "-u", "origin", "main"]);

        // Clone the remote into a fresh working dir.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let clone_dir = std::env::temp_dir().join(format!("agentdesk-clone-{nanos}"));
        run(
            std::env::temp_dir().to_str().unwrap(),
            &["clone", "-q", remote.str(), clone_dir.to_str().unwrap()],
        );
        let clone = TempRepo(clone_dir);

        // Origin commits + pushes a new file; the clone should pull it.
        fs::write(origin.path().join("fresh.md"), "fresh\n").unwrap();
        run(origin.str(), &["add", "."]);
        run(origin.str(), &["commit", "-q", "-m", "fresh"]);
        run(origin.str(), &["push", "origin", "main"]);

        pull(clone.str()).expect("pull from the remote should succeed");

        assert!(
            clone.path().join("fresh.md").exists(),
            "pull should have brought the new file into the clone"
        );
    }

    #[test]
    fn blank_or_off_repo_dir_is_all_null() {
        assert_eq!(status_for_dir(""), GitStatus::default());
        let off_repo = status_for_dir("/definitely/not/a/repo/anywhere");
        assert_eq!(off_repo, GitStatus::default());
    }

    #[test]
    fn inside_a_repo_reports_a_branch_and_clean_flag() {
        // The crate itself lives in a git checkout, so its manifest dir is a repo.
        let dir = env!("CARGO_MANIFEST_DIR");
        let status = status_for_dir(dir);
        assert!(status.branch.is_some(), "expected a branch inside the repo");
        // `dirty` resolves to a concrete bool (clean or not), never null, in a repo.
        assert!(status.dirty.is_some(), "expected a dirty flag inside the repo");
        // `modified` resolves to a concrete count (>= 0) inside a repo.
        assert!(status.modified.is_some(), "expected a modified count inside the repo");
        assert!(status.modified.unwrap() >= 0);
    }

    #[test]
    fn parse_porcelain_paths_strips_status_prefix_and_handles_renames() {
        // A representative porcelain blob: modified, added, staged-add, untracked,
        // a partially-staged file, and a rename (`old -> new`).
        let porcelain = " M src/a.rs\nA  src/b.rs\n?? scratch.txt\nMM src/c.rs\nR  old/name.rs -> new/name.rs\n";
        let paths = parse_porcelain_paths(porcelain);
        assert_eq!(
            paths,
            vec![
                "src/a.rs".to_string(),
                "src/b.rs".to_string(),
                "scratch.txt".to_string(),
                "src/c.rs".to_string(),
                // Rename keeps the NEW (destination) path.
                "new/name.rs".to_string(),
            ]
        );
    }

    #[test]
    fn parse_porcelain_paths_is_empty_for_a_clean_tree() {
        assert!(parse_porcelain_paths("").is_empty());
    }

    #[test]
    fn parse_porcelain_paths_caps_at_the_max() {
        // Build a porcelain blob with more than the cap of changed files.
        let body: String = (0..(MAX_CHANGED_PATHS + 20))
            .map(|i| format!(" M f{i}.txt\n"))
            .collect();
        let paths = parse_porcelain_paths(&body);
        assert_eq!(paths.len(), MAX_CHANGED_PATHS, "should cap at MAX_CHANGED_PATHS");
        assert_eq!(paths[0], "f0.txt");
    }

    #[test]
    fn status_for_dir_collects_changed_paths() {
        let repo = TempRepo::new("paths");
        // Add a tracked-but-modified file and an untracked one.
        fs::write(repo.path().join("README.md"), "changed\n").unwrap();
        fs::write(repo.path().join("new.txt"), "fresh\n").unwrap();
        let status = status_for_dir(repo.str());
        assert!(status.files.contains(&"README.md".to_string()), "files: {:?}", status.files);
        assert!(status.files.contains(&"new.txt".to_string()), "files: {:?}", status.files);
        assert_eq!(status.modified, Some(2));
    }

    #[test]
    fn status_for_paths_keys_by_path_and_covers_every_input() {
        let dir = env!("CARGO_MANIFEST_DIR").to_string();
        let paths = vec![dir.clone(), "/definitely/not/a/repo".to_string()];
        let map = status_for_paths(&paths);
        assert_eq!(map.len(), 2);
        assert!(map[&dir].branch.is_some());
        assert_eq!(map["/definitely/not/a/repo"], GitStatus::default());
    }

    // ─────────────────── list_branches tests ───────────────────

    #[test]
    fn branches_are_listed_with_the_current_branch_marked() {
        let repo = TempRepo::new("listbranch");
        let path = repo.str();
        // Create a second local branch.
        run(path, &["branch", "feature"]);
        // Simulate a remote-tracking ref without a real remote.
        run(path, &["update-ref", "refs/remotes/origin/feature", "HEAD"]);
        // Create the symbolic origin/HEAD ref (the one that must be filtered out).
        run(path, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature"]);

        let bl = list_branches(path);
        assert_eq!(bl.current, Some("main".to_string()), "current should be main");
        assert!(bl.local.contains(&"main".to_string()), "local should contain main");
        assert!(bl.local.contains(&"feature".to_string()), "local should contain feature");
        assert!(
            bl.remotes.contains(&"origin/feature".to_string()),
            "remotes should contain origin/feature, got {:?}",
            bl.remotes
        );
        assert!(
            !bl.remotes.contains(&"origin/HEAD".to_string()),
            "remotes must NOT contain origin/HEAD, got {:?}",
            bl.remotes
        );
        // Regression: git's short form renders refs/remotes/origin/HEAD as the
        // BARE remote name `origin`, which is not a checkout-able branch. Reading
        // the full refname + stripping the prefix must exclude it — every remote
        // entry is a real `<remote>/<branch>` (always contains a slash).
        assert!(
            !bl.remotes.contains(&"origin".to_string()),
            "remotes must NOT contain the bare remote name 'origin', got {:?}",
            bl.remotes
        );
        assert!(
            bl.remotes.iter().all(|r| r.contains('/')),
            "every remote must be <remote>/<branch>, got {:?}",
            bl.remotes
        );
    }

    #[test]
    fn repository_with_no_remote() {
        let repo = TempRepo::new("noremote");
        let bl = list_branches(repo.str());
        assert!(bl.remotes.is_empty(), "no remotes expected, got {:?}", bl.remotes);
        assert!(
            bl.local.contains(&"main".to_string()),
            "local should contain main, got {:?}",
            bl.local
        );
    }

    #[test]
    fn detached_head() {
        let repo = TempRepo::new("detached");
        let path = repo.str();
        // Get the current HEAD sha to detach to.
        let sha = run_git(path, &["rev-parse", "HEAD"]).expect("rev-parse should succeed");
        run(path, &["checkout", "-q", &sha]);
        let bl = list_branches(path);
        assert_eq!(bl.current, None, "detached HEAD should yield current == None");
        assert!(
            bl.local.contains(&"main".to_string()),
            "local should still contain main, got {:?}",
            bl.local
        );
    }

    #[test]
    fn list_branches_off_repo_is_empty() {
        let bad = list_branches("/definitely/not/a/repo");
        assert!(bad.current.is_none(), "current should be None for non-repo");
        assert!(bad.local.is_empty(), "local should be empty for non-repo");
        assert!(bad.remotes.is_empty(), "remotes should be empty for non-repo");

        let empty = list_branches("");
        assert!(empty.current.is_none(), "current should be None for empty path");
        assert!(empty.local.is_empty(), "local should be empty for empty path");
        assert!(empty.remotes.is_empty(), "remotes should be empty for empty path");
    }

    #[test]
    fn a_branch_name_starting_with_a_dash_is_treated_as_a_ref_not_a_flag() {
        // Security regression: a branch whose name begins with `-` must be parsed
        // as a REF, never a git flag. Without `--end-of-options`, `checkout(_, "-f")`
        // runs `git checkout -f`, which force-resets the working tree and silently
        // discards the dirty file written below.
        let repo = TempRepo::new("dashref");
        let path = repo.str();
        // Dirty the working tree with an uncommitted edit.
        fs::write(repo.path().join("README.md"), "uncommitted edit\n").unwrap();
        // `-f` is not a real ref, so the checkout must fail — and, crucially, must
        // NOT have force-reset the working tree away from the edit.
        let res = checkout(path, "-f");
        assert!(res.is_err(), "checkout of a nonexistent '-f' ref should Err, got {:?}", res);
        let body = fs::read_to_string(repo.path().join("README.md")).unwrap();
        assert_eq!(
            body, "uncommitted edit\n",
            "the dirty working tree must be preserved — '-f' must not be read as the force flag"
        );
    }

    // ── parse_push_commits unit tests (task 17.4) ─────────────────────────

    #[test]
    fn parse_push_commits_multiple() {
        // Two commits: hash\x1fsubject, one per line.
        let stdout = "abc123\x1ffirst commit\ndef456\x1fsecond commit\n";
        let commits = parse_push_commits(stdout);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "abc123");
        assert_eq!(commits[0].subject, "first commit");
        assert_eq!(commits[1].hash, "def456");
        assert_eq!(commits[1].subject, "second commit");
    }

    #[test]
    fn parse_push_commits_empty_stdout() {
        // Empty stdout → empty vec (no upstream or nothing to push).
        let commits = parse_push_commits("");
        assert!(commits.is_empty(), "empty stdout should yield empty vec");
    }

    #[test]
    fn parse_push_commits_subject_with_special_chars() {
        // Subject with spaces, colons, slashes — 0x1f separator never appears in
        // commit subjects so the parse is robust.
        let stdout = "ff00aa\x1ffeat(footer): push pill opens popover / lists commits-to-push\n";
        let commits = parse_push_commits(stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "ff00aa");
        assert_eq!(commits[0].subject, "feat(footer): push pill opens popover / lists commits-to-push");
    }

    #[test]
    fn parse_push_commits_whitespace_only_lines_skipped() {
        // Lines that are blank or only whitespace (e.g. trailing newline) are ignored.
        let stdout = "\nabc123\x1fsome commit\n\n";
        let commits = parse_push_commits(stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].subject, "some commit");
    }

    #[test]
    fn parse_push_commits_missing_separator_skipped() {
        // A malformed line (no 0x1f separator) is silently skipped.
        let stdout = "badhash nousep\nabc123\x1fgood commit\n";
        let commits = parse_push_commits(stdout);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc123");
    }
}
