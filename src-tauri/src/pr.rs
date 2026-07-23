//! Pull-request status lookup for the footer PR button.
//!
//! The footer shows a PR button next to the edited-files pill. To decide whether
//! clicking should OPEN an existing PR or open a CREATE-confirm dialog, the
//! frontend asks here: does an OPEN PR from the repo's current branch into `base`
//! already exist? We answer by shelling out to the GitHub CLI:
//!
//! ```text
//! gh pr list --head <branch> --base <base> --state open --json url,number
//! ```
//!
//! Like [`crate::claude_title`], this is split into a PURE, unit-tested argument +
//! output PARSER and a thin async runner. The runner spawns the real `gh` binary,
//! so it only fully RUNS in an authenticated environment (MANUAL); it COMPILES
//! regardless and the arg + parse shapes are exercised headlessly here.
//!
//! Every failure is BEST-EFFORT and degrades to [`PrStatus::Unknown`] — NOT an
//! error. `gh` missing, unauthenticated, offline, or emitting malformed JSON all
//! collapse to `Unknown`, and the spec says the button then falls back to the
//! create-confirm path (never "do nothing"). So `pr_status_for` returns
//! `Ok(PrStatus)` in every case the frontend cares about; the only `Err` is the
//! degenerate "no repo path", which the frontend also treats as unknown.

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;

use crate::no_window::NoConsoleWindow;

/// Hard timeout for the `gh pr list` call so a hung CLI (e.g. a wedged network
/// auth refresh) can never block the PR-status refresh; on timeout the runner
/// degrades to [`PrStatus::Unknown`].
const GH_TIMEOUT: Duration = Duration::from_secs(15);

/// The result of a PR-status lookup for the current branch → base.
///
/// `Exists` carries the PR's web URL + number so the frontend can open it.
/// `None` means we got a clean answer and there is no open PR. `Unknown` means we
/// could NOT determine existence (gh missing / unauthenticated / errored / bad
/// output) — the frontend falls back to the create-confirm path, NOT to nothing.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PrStatus {
    /// An open PR from the current branch into the base exists.
    Exists { url: String, number: i64 },
    /// No open PR exists (clean answer from `gh`).
    None,
    /// PR existence could not be determined; treat as "no PR" for the create path.
    Unknown,
}

// --- Pure helpers: argument builder + output parser -------------------------

/// PURE: build the `gh` argument vector for listing the OPEN PR from `branch`
/// into `base` as JSON. `--head`/`--base` scope the query to exactly this
/// branch→base pair; `--state open` ignores merged/closed PRs; `--json
/// url,number` makes the output structured (an array we parse below).
///
/// `branch` and `base` are passed as the VALUES of `--head`/`--base`, so a name
/// beginning with `-` is consumed as that flag's argument and never parsed as a
/// flag itself.
pub fn gh_pr_list_args(branch: &str, base: &str) -> Vec<String> {
    vec![
        "pr".to_string(),
        "list".to_string(),
        "--head".to_string(),
        branch.to_string(),
        "--base".to_string(),
        base.to_string(),
        "--state".to_string(),
        "open".to_string(),
        "--json".to_string(),
        "url,number".to_string(),
    ]
}

/// PURE: parse `gh pr list --json url,number` stdout into a [`PrStatus`].
///
/// `gh` prints a JSON ARRAY of objects; an empty array `[]` means no matching PR.
/// We take the FIRST entry (the query is already scoped to one branch→base/open,
/// so at most one PR is expected) and read its `url` (string) + `number`
/// (integer). On a clean-but-empty array → [`PrStatus::None`]. On ANYTHING we
/// can't make sense of (not an array, an entry missing url/number, non-JSON) →
/// [`PrStatus::Unknown`] — we'd rather fall back to the create-confirm path than
/// claim a wrong answer.
pub fn parse_pr_list(stdout: &str) -> PrStatus {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return PrStatus::Unknown;
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return PrStatus::Unknown,
    };
    let arr = match value.as_array() {
        Some(a) => a,
        None => return PrStatus::Unknown,
    };
    let first = match arr.first() {
        // A clean, empty array is an authoritative "no open PR".
        None => return PrStatus::None,
        Some(f) => f,
    };
    let url = first.get("url").and_then(|u| u.as_str());
    let number = first.get("number").and_then(|n| n.as_i64());
    match (url, number) {
        (Some(url), Some(number)) if !url.is_empty() => PrStatus::Exists {
            url: url.to_string(),
            number,
        },
        // A present-but-malformed entry: don't guess — fall back to Unknown.
        _ => PrStatus::Unknown,
    }
}

// --- Open-PRs-awaiting-review: result + pure helpers ------------------------

/// A PR's author, mirroring the `author` sub-object of `gh pr list --json author`
/// (`{ "login": …, "name": …, "is_bot": … }`). `name` is `None` when gh reports
/// it empty; `is_bot` distinguishes bot authors so the UI can show a bot glyph.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrAuthor {
    pub login: String,
    /// The author's display name, or `None` when gh reports it empty/absent.
    pub name: Option<String>,
    /// Whether the author is a bot (gh emits this as `is_bot`).
    pub is_bot: bool,
}

/// A single open PR entry returned by `gh pr list`.
///
/// Each field maps to the `--json` fields we request: `number`, `title`, `url`,
/// `isDraft`, `reviewDecision`, `author`, and `updatedAt`. `review_decision` is
/// `None` when `gh` omits the field (no review has been requested on the PR yet);
/// `author` and `updated_at` are `None` when gh omits or empties them (best-effort
/// enrichment for the popover rows).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPr {
    pub number: i64,
    pub title: String,
    pub url: String,
    pub is_draft: bool,
    /// The review decision from GitHub (`APPROVED`, `REVIEW_REQUIRED`,
    /// `CHANGES_REQUESTED`, `""`), or `None` when gh omits the field entirely
    /// (no review requested yet — treated as awaiting review for count purposes).
    pub review_decision: Option<String>,
    /// The PR's author, or `None` when gh omits it / it has no usable login.
    pub author: Option<PrAuthor>,
    /// When the PR was last updated (ISO-8601 string from gh's `updatedAt`), or
    /// `None` when gh omits/empties it.
    pub updated_at: Option<String>,
}

/// The result of an "open PRs awaiting review" lookup for a repo's `base`.
///
/// `count` is the number of OPEN, NON-DRAFT PRs targeting `base` that are still
/// AWAITING REVIEW (`reviewDecision` is anything other than `APPROVED`; drafts are
/// never counted). `pulls_url` is the repo's pull-requests page on GitHub
/// (`<repo url>/pulls`) so the footer button can open it; it is `None` when we
/// couldn't derive it. `prs` is the full list of open PRs (including drafts) so
/// the popover can display them.
///
/// This is BEST-EFFORT: when `gh` is missing / unauthenticated / errors, the
/// runner returns the NEUTRAL unknown result — `count: 0, pulls_url: None, prs:
/// []` — and the footer shows the neutral checkmark/`0` state without an error.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPrs {
    /// Number of open, NON-DRAFT PRs into `base` awaiting review
    /// (reviewDecision != APPROVED AND isDraft == false).
    pub count: i64,
    /// The repo's pull-requests page (`<url>/pulls`), or `None` when unknown.
    /// Serialized as `pullsUrl` for the frontend.
    pub pulls_url: Option<String>,
    /// The full list of open PRs (all, including drafts) for the popover.
    pub prs: Vec<OpenPr>,
}

impl OpenPrs {
    /// The neutral "unknown" result: no count, no URL, empty list. Returned
    /// whenever the lookup can't be completed (gh missing/unauth/errored/malformed).
    fn unknown() -> Self {
        OpenPrs {
            count: 0,
            pulls_url: None,
            prs: vec![],
        }
    }
}

/// PURE: build the `gh` argument vector for listing the OPEN PRs targeting
/// `base`, with each PR's `number`, `title`, `url`, `isDraft`, `reviewDecision`,
/// `author`, and `updatedAt`. `--base` scopes the query to PRs INTO `base`;
/// `--state open` ignores merged/closed; the `--json` field list makes the output
/// the array we parse below.
///
/// `base` is the VALUE of `--base` (argv position after the flag), so a name
/// beginning with `-` is consumed as that flag's argument, never reparsed as a
/// flag.
pub fn gh_open_prs_args(base: &str) -> Vec<String> {
    vec![
        "pr".to_string(),
        "list".to_string(),
        "--base".to_string(),
        base.to_string(),
        "--state".to_string(),
        "open".to_string(),
        "--json".to_string(),
        "number,title,url,isDraft,reviewDecision,author,updatedAt".to_string(),
    ]
}

/// PURE: parse `gh pr list --json number,title,url,isDraft,reviewDecision` stdout
/// into a `Vec<OpenPr>`.
///
/// `gh` prints a JSON ARRAY; each entry must have at minimum `number` (integer),
/// `title` (string), `url` (string), and `isDraft` (bool) — entries missing these
/// required fields are silently skipped. `reviewDecision`, `author`, and
/// `updatedAt` are optional; when absent/empty they are treated as `None`. On
/// ANYTHING we can't parse (non-JSON, non-array, empty input) → empty vec
/// (best-effort, never an error).
pub fn parse_open_pr_list(stdout: &str) -> Vec<OpenPr> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let value: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let arr = match value.as_array() {
        Some(a) => a,
        None => return vec![],
    };
    let mut prs = Vec::with_capacity(arr.len());
    for entry in arr {
        let number = match entry.get("number").and_then(|n| n.as_i64()) {
            Some(n) => n,
            None => continue,
        };
        let title = match entry.get("title").and_then(|t| t.as_str()) {
            Some(t) => t.to_string(),
            None => continue,
        };
        let url = match entry.get("url").and_then(|u| u.as_str()) {
            Some(u) if !u.is_empty() => u.to_string(),
            _ => continue,
        };
        let is_draft = match entry.get("isDraft").and_then(|d| d.as_bool()) {
            Some(d) => d,
            None => continue,
        };
        // reviewDecision is optional: absent or JSON null → None; a JSON string (incl.
        // empty "") → Some. None and Some("") are both treated as "awaiting review"
        // downstream (only Some("APPROVED") is excluded from the count).
        let review_decision = entry
            .get("reviewDecision")
            .and_then(|d| d.as_str())
            .map(|s| s.to_string());
        // author + updatedAt are best-effort enrichment for the popover rows: a
        // missing/empty author or updatedAt simply yields None (the row hides that
        // piece), it never skips the PR.
        let author = entry.get("author").and_then(parse_pr_author);
        let updated_at = entry
            .get("updatedAt")
            .and_then(|u| u.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        prs.push(OpenPr {
            number,
            title,
            url,
            is_draft,
            review_decision,
            author,
            updated_at,
        });
    }
    prs
}

/// PURE: parse a `gh` `author` JSON object into a [`PrAuthor`].
///
/// Returns `None` when there is no usable `login` (the field is absent, null, or
/// an empty string — e.g. a deleted/ghost author), so the row falls back to a
/// neutral placeholder. `name` collapses an empty string to `None`; `is_bot`
/// defaults to `false` (gh emits it as `is_bot`, but we also tolerate `isBot`).
fn parse_pr_author(value: &serde_json::Value) -> Option<PrAuthor> {
    let login = value
        .get("login")
        .and_then(|l| l.as_str())
        .filter(|s| !s.is_empty())?;
    let name = value
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let is_bot = value
        .get("is_bot")
        .or_else(|| value.get("isBot"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    Some(PrAuthor {
        login: login.to_string(),
        name,
        is_bot,
    })
}

/// PURE: count the non-draft, awaiting-review PRs in a `Vec<OpenPr>`.
///
/// A PR is "awaiting review" when its `review_decision` is NOT `Some("APPROVED")`.
/// Draft PRs are never counted, regardless of their decision. This is the
/// canonical count used for the badge and the `OpenPrs.count` field.
pub fn awaiting_review_count_non_draft(prs: &[OpenPr]) -> i64 {
    prs.iter()
        .filter(|pr| {
            !pr.is_draft
                && pr
                    .review_decision
                    .as_deref()
                    .map(|d| d != "APPROVED")
                    .unwrap_or(true) // None → no decision yet → awaiting
        })
        .count() as i64
}

/// PURE: parse `gh repo view --json url` stdout into the repo's BASE web URL
/// (`https://github.com/o/r`, trailing slash stripped). Returns `None` when the
/// output isn't the expected `{"url": "…"}` object (non-JSON, missing/empty url).
/// The shared extractor behind [`parse_pulls_url`] and the commit-link path.
pub fn parse_repo_url(stdout: &str) -> Option<String> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let url = value.get("url").and_then(|u| u.as_str())?;
    if url.is_empty() {
        return None;
    }
    // Strip a trailing slash so callers can append `/pulls`, `/commit/<sha>`, etc.
    Some(url.trim_end_matches('/').to_string())
}

/// PURE: parse `gh repo view --json url` stdout into the repo's pull-requests
/// page URL (`<url>/pulls`). Returns `None` when the output isn't the expected
/// `{"url": "https://github.com/o/r"}` object (non-JSON, missing/empty url).
pub fn parse_pulls_url(stdout: &str) -> Option<String> {
    parse_repo_url(stdout).map(|base| format!("{base}/pulls"))
}

// --- Environment seeding ----------------------------------------------------

/// Seed a minimal environment for the `gh` child so it is discoverable from a
/// sparse GUI process. Uses the resolved login-shell `PATH` (see
/// [`crate::shell_path`]) so a Homebrew-installed `gh` is found even when the app
/// was launched from Finder with a stripped environment. `HOME` is forwarded so
/// `gh` can read its auth/config under `~`.
fn seed_gh_env(cmd: &mut tokio::process::Command) {
    cmd.env("PATH", crate::shell_path::resolved_path());
    let home = crate::shell_path::home_dir();
    if !home.is_empty() {
        cmd.env("HOME", home);
    }
}

// --- Async runner -----------------------------------------------------------

/// Look up the OPEN PR status for `repo_path`'s current branch into `base`.
///
/// Resolves the current branch with `git rev-parse --abbrev-ref HEAD` in
/// `repo_path`, then runs `gh pr list --head <branch> --base <base> --state open
/// --json url,number` (with `repo_path` as the working dir so `gh` targets the
/// right repo) and parses the output.
///
/// BEST-EFFORT, NEVER fails for the frontend's decision: a missing/empty branch,
/// `branch == base` (a base branch has no self-PR), a missing/unauthenticated
/// `gh`, a non-zero exit, a timeout, or malformed output ALL resolve to
/// [`PrStatus::Unknown`] (the create-confirm fallback). Returns `Ok` in every
/// such case; the runner only logs at the seams.
pub async fn pr_status_for(repo_path: &str, base: &str) -> PrStatus {
    let branch = match current_branch(repo_path).await {
        Some(b) if !b.is_empty() && b != "HEAD" => b,
        // No branch / detached HEAD / git failed → can't query → Unknown.
        _ => return PrStatus::Unknown,
    };
    // A base branch has no PR INTO itself; don't even ask gh.
    if branch == base {
        return PrStatus::Unknown;
    }

    let args = gh_pr_list_args(&branch, base);
    let mut cmd = tokio::process::Command::new("gh");
    cmd.no_console_window();
    cmd.args(&args)
        .current_dir(repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // KILL the child if its handle is dropped (timeout branch) so a hung `gh`
        // can't leak across the footer's repeated PR-status polls. Mirrors
        // `claude_title`'s rationale.
        .kill_on_drop(true);
    seed_gh_env(&mut cmd);

    let child = match cmd.spawn() {
        Ok(c) => c,
        // `gh` not installed / not on PATH → Unknown (create-confirm fallback).
        Err(_) => return PrStatus::Unknown,
    };

    let output = match tokio::time::timeout(GH_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        // Timed out, or awaiting the child failed → Unknown.
        _ => return PrStatus::Unknown,
    };
    if !output.status.success() {
        // Unauthenticated / offline / repo not on GitHub → non-zero exit → Unknown.
        return PrStatus::Unknown;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_pr_list(&stdout)
}

/// Look up the OPEN PRs targeting `base` in `repo_path` that are AWAITING REVIEW,
/// plus the repo's pull-requests page URL, for the footer's "open PRs" button.
///
/// Runs `gh pr list --base <base> --state open --json
/// number,title,url,isDraft,reviewDecision` (with `repo_path` as the working dir)
/// and returns the full PR list; the `count` is derived from the non-draft,
/// awaiting-review subset. Separately runs `gh repo view --json url` and appends
/// `/pulls` for the button's link.
///
/// BEST-EFFORT, NEVER fails: a missing/unauthenticated `gh`, a non-zero exit, a
/// timeout, or malformed output collapse to the NEUTRAL unknown result
/// ([`OpenPrs::unknown`] — `count: 0, pulls_url: None, prs: []`). The URL lookup
/// degrades INDEPENDENTLY: a successful PR list keeps its data even when the URL
/// can't be derived (`pulls_url: None`).
pub async fn open_prs_for(repo_path: &str, base: &str) -> OpenPrs {
    let pulls_url = pulls_url_for(repo_path).await;
    match open_pr_list_for(repo_path, base).await {
        Some(prs) => {
            let count = awaiting_review_count_non_draft(&prs);
            OpenPrs {
                count,
                pulls_url,
                prs,
            }
        }
        // Couldn't determine the list → neutral unknown (count 0, empty prs), but
        // keep any URL we did manage to derive so the button can still link.
        None => OpenPrs {
            pulls_url,
            ..OpenPrs::unknown()
        },
    }
}

/// Run `gh pr list … --json number,title,url,isDraft,reviewDecision` in
/// `repo_path` and parse the list, or `None` when the lookup can't be completed
/// (gh missing/unauth/non-zero/timeout/malformed). Split out so `open_prs_for`
/// reads as the orchestration of the two `gh` calls.
async fn open_pr_list_for(repo_path: &str, base: &str) -> Option<Vec<OpenPr>> {
    let args = gh_open_prs_args(base);
    let mut cmd = tokio::process::Command::new("gh");
    cmd.no_console_window();
    cmd.args(&args)
        .current_dir(repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    seed_gh_env(&mut cmd);

    let child = cmd.spawn().ok()?;
    let output = match tokio::time::timeout(GH_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // parse_open_pr_list never errors — it returns an empty vec on bad input.
    // Treat empty output as None (couldn't determine) rather than an empty list,
    // so the badge stays neutral instead of showing 0 when gh said nothing.
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(parse_open_pr_list(trimmed))
}

/// Run `gh repo view --json url` in `repo_path` and parse the repo's BASE web URL
/// (`https://github.com/o/r`), or `None` when the lookup can't be completed (gh
/// missing/unauthenticated/non-zero/timeout/malformed, or the repo isn't on a
/// host gh recognizes). Best-effort; the seam for both the pulls link and the
/// per-commit diff links.
pub async fn repo_url_for(repo_path: &str) -> Option<String> {
    let mut cmd = tokio::process::Command::new("gh");
    cmd.no_console_window();
    cmd.args(["repo", "view", "--json", "url"])
        .current_dir(repo_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    seed_gh_env(&mut cmd);

    let child = cmd.spawn().ok()?;
    let output = match tokio::time::timeout(GH_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        _ => return None,
    };
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_repo_url(&stdout)
}

/// Run `gh repo view --json url` in `repo_path` and derive the pull-requests page
/// URL (`<url>/pulls`), or `None` when the lookup can't be completed. Degrades
/// independently of the count so a failed URL never zeroes a real count.
async fn pulls_url_for(repo_path: &str) -> Option<String> {
    repo_url_for(repo_path).await.map(|base| format!("{base}/pulls"))
}

/// Resolve the current branch name in `dir` via `git rev-parse --abbrev-ref
/// HEAD`. Returns `None` when git can't answer (off-repo / spawn error /
/// non-zero exit / non-UTF8). A detached HEAD yields `Some("HEAD")`, which the
/// caller treats as "no branch".
async fn current_branch(dir: &str) -> Option<String> {
    let output = tokio::process::Command::new("git")
        .no_console_window()
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gh_pr_list_args_scope_head_base_state_and_json() {
        let args = gh_pr_list_args("feature-x", "main");
        assert_eq!(
            args,
            vec![
                "pr",
                "list",
                "--head",
                "feature-x",
                "--base",
                "main",
                "--state",
                "open",
                "--json",
                "url,number",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn gh_pr_list_args_thread_branch_and_base_as_flag_values() {
        // A branch name starting with `-` is the VALUE of `--head` (argv position
        // after the flag), so it can't be reparsed as a flag.
        let args = gh_pr_list_args("--oops", "main");
        let i = args.iter().position(|a| a == "--head").expect("--head present");
        assert_eq!(args[i + 1], "--oops");
    }

    #[test]
    fn parse_pr_list_exists_for_a_single_open_pr() {
        let out = r#"[{"number":42,"url":"https://github.com/o/r/pull/42"}]"#;
        assert_eq!(
            parse_pr_list(out),
            PrStatus::Exists {
                url: "https://github.com/o/r/pull/42".to_string(),
                number: 42,
            }
        );
    }

    #[test]
    fn parse_pr_list_takes_the_first_when_several_are_returned() {
        // Defensive: the query is scoped to one branch→base/open, but if gh ever
        // returns >1 we take the first deterministically rather than erroring.
        let out = r#"[
            {"number":7,"url":"https://github.com/o/r/pull/7"},
            {"number":8,"url":"https://github.com/o/r/pull/8"}
        ]"#;
        assert_eq!(
            parse_pr_list(out),
            PrStatus::Exists {
                url: "https://github.com/o/r/pull/7".to_string(),
                number: 7,
            }
        );
    }

    #[test]
    fn parse_pr_list_none_for_an_empty_array() {
        // gh's authoritative "no matching PR" is an empty JSON array.
        assert_eq!(parse_pr_list("[]"), PrStatus::None);
        assert_eq!(parse_pr_list("  []  \n"), PrStatus::None);
    }

    #[test]
    fn parse_pr_list_unknown_for_empty_output() {
        // No output at all (e.g. gh wrote only to stderr) → can't tell → Unknown.
        assert_eq!(parse_pr_list(""), PrStatus::Unknown);
        assert_eq!(parse_pr_list("   \n  "), PrStatus::Unknown);
    }

    #[test]
    fn parse_pr_list_unknown_for_non_json() {
        // A gh error printed to stdout, or any non-JSON text → Unknown.
        assert_eq!(parse_pr_list("gh: not authenticated"), PrStatus::Unknown);
        assert_eq!(parse_pr_list("{not json"), PrStatus::Unknown);
    }

    #[test]
    fn parse_pr_list_unknown_for_non_array_json() {
        // Valid JSON but not the array gh promises (e.g. an error object) → Unknown.
        assert_eq!(parse_pr_list(r#"{"message":"Bad credentials"}"#), PrStatus::Unknown);
    }

    #[test]
    fn parse_pr_list_unknown_for_an_entry_missing_fields() {
        // A present-but-malformed entry (missing url or number, or empty url): we
        // don't guess a partial answer — fall back to Unknown (create-confirm path).
        assert_eq!(parse_pr_list(r#"[{"number":1}]"#), PrStatus::Unknown);
        assert_eq!(
            parse_pr_list(r#"[{"url":"https://github.com/o/r/pull/1"}]"#),
            PrStatus::Unknown
        );
        assert_eq!(parse_pr_list(r#"[{"url":"","number":1}]"#), PrStatus::Unknown);
    }

    // ── open-PRs-awaiting-review: arg builder + parsers ─────────────────────

    #[test]
    fn gh_open_prs_args_scope_base_state_and_json() {
        let args = gh_open_prs_args("main");
        assert_eq!(
            args,
            vec![
                "pr",
                "list",
                "--base",
                "main",
                "--state",
                "open",
                "--json",
                "number,title,url,isDraft,reviewDecision,author,updatedAt",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn gh_open_prs_args_thread_base_as_a_flag_value() {
        // A base name starting with `-` is the VALUE of `--base`, never reparsed.
        let args = gh_open_prs_args("--oops");
        let i = args.iter().position(|a| a == "--base").expect("--base present");
        assert_eq!(args[i + 1], "--oops");
    }
    #[test]
    fn parse_pulls_url_appends_pulls() {
        assert_eq!(
            parse_pulls_url(r#"{"url":"https://github.com/o/r"}"#),
            Some("https://github.com/o/r/pulls".to_string())
        );
    }

    #[test]
    fn parse_pulls_url_tolerates_trailing_slash() {
        assert_eq!(
            parse_pulls_url(r#"{"url":"https://github.com/o/r/"}"#),
            Some("https://github.com/o/r/pulls".to_string())
        );
    }

    #[test]
    fn parse_pulls_url_none_for_missing_or_bad_output() {
        assert_eq!(parse_pulls_url(""), None);
        assert_eq!(parse_pulls_url("not json"), None);
        assert_eq!(parse_pulls_url("{}"), None);
        assert_eq!(parse_pulls_url(r#"{"url":""}"#), None);
    }

    #[test]
    fn parse_repo_url_returns_the_base_url() {
        assert_eq!(
            parse_repo_url(r#"{"url":"https://github.com/o/r"}"#),
            Some("https://github.com/o/r".to_string())
        );
    }

    #[test]
    fn parse_repo_url_strips_trailing_slash() {
        // A trailing slash is stripped so callers can append `/commit/<sha>` cleanly.
        assert_eq!(
            parse_repo_url(r#"{"url":"https://github.com/o/r/"}"#),
            Some("https://github.com/o/r".to_string())
        );
    }

    #[test]
    fn parse_repo_url_none_for_missing_or_bad_output() {
        assert_eq!(parse_repo_url(""), None);
        assert_eq!(parse_repo_url("not json"), None);
        assert_eq!(parse_repo_url("{}"), None);
        assert_eq!(parse_repo_url(r#"{"url":""}"#), None);
    }

    // ── open-PRs list parser ─────────────────────────────────────────────────

    #[test]
    fn parse_open_pr_list_parses_full_pr_objects() {
        let out = r#"[
            {"number":1,"title":"Add feature","url":"https://github.com/o/r/pull/1","isDraft":false,"reviewDecision":"REVIEW_REQUIRED"},
            {"number":2,"title":"Draft fix","url":"https://github.com/o/r/pull/2","isDraft":true,"reviewDecision":""},
            {"number":3,"title":"No decision yet","url":"https://github.com/o/r/pull/3","isDraft":false}
        ]"#;
        let prs = parse_open_pr_list(out);
        assert_eq!(prs.len(), 3);
        assert_eq!(prs[0].number, 1);
        assert_eq!(prs[0].title, "Add feature");
        assert_eq!(prs[0].url, "https://github.com/o/r/pull/1");
        assert!(!prs[0].is_draft);
        assert_eq!(prs[0].review_decision, Some("REVIEW_REQUIRED".to_string()));
        assert!(prs[1].is_draft);
        assert_eq!(prs[1].review_decision, Some("".to_string()));
        // Missing reviewDecision → None
        assert_eq!(prs[2].review_decision, None);
    }

    #[test]
    fn parse_open_pr_list_empty_array_returns_empty_vec() {
        assert_eq!(parse_open_pr_list("[]"), vec![]);
        assert_eq!(parse_open_pr_list("  []  \n"), vec![]);
    }

    #[test]
    fn parse_open_pr_list_returns_empty_for_bad_input() {
        // Non-JSON, empty, or non-array → empty vec (best-effort, no panic).
        assert_eq!(parse_open_pr_list(""), vec![]);
        assert_eq!(parse_open_pr_list("gh: not authenticated"), vec![]);
        assert_eq!(parse_open_pr_list(r#"{"message":"Bad credentials"}"#), vec![]);
    }

    #[test]
    fn parse_open_pr_list_skips_entries_missing_required_fields() {
        // Entries missing number/title/url/isDraft are silently skipped.
        let out = r#"[
            {"number":1,"title":"Good","url":"https://github.com/o/r/pull/1","isDraft":false},
            {"title":"Missing number","url":"https://github.com/o/r/pull/2","isDraft":false},
            {"number":3}
        ]"#;
        let prs = parse_open_pr_list(out);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 1);
    }

    // ── author + updatedAt enrichment ────────────────────────────────────────

    #[test]
    fn parse_open_pr_list_parses_author_and_updated_at() {
        // gh nests author as { id, is_bot, login, name } and emits updatedAt as an
        // ISO-8601 string; both are captured for the popover rows.
        let out = r#"[
            {"number":1,"title":"Add feature","url":"https://github.com/o/r/pull/1","isDraft":false,"reviewDecision":"REVIEW_REQUIRED","author":{"id":"MDQ6","is_bot":false,"login":"octocat","name":"The Octocat"},"updatedAt":"2026-06-12T14:30:00Z"}
        ]"#;
        let prs = parse_open_pr_list(out);
        assert_eq!(prs.len(), 1);
        assert_eq!(
            prs[0].author,
            Some(PrAuthor {
                login: "octocat".to_string(),
                name: Some("The Octocat".to_string()),
                is_bot: false,
            })
        );
        assert_eq!(prs[0].updated_at, Some("2026-06-12T14:30:00Z".to_string()));
    }

    #[test]
    fn parse_open_pr_list_author_and_updated_at_default_to_none() {
        // Absent author/updatedAt → None (the row hides those pieces); the PR is
        // still parsed. An empty updatedAt string also collapses to None.
        let out = r#"[
            {"number":1,"title":"No enrichment","url":"https://github.com/o/r/pull/1","isDraft":false,"updatedAt":""}
        ]"#;
        let prs = parse_open_pr_list(out);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].author, None);
        assert_eq!(prs[0].updated_at, None);
    }

    #[test]
    fn parse_pr_author_requires_a_non_empty_login() {
        // No usable login (absent, null, or empty) → None, so the row falls back to
        // a neutral placeholder rather than rendering a login-less avatar.
        assert_eq!(parse_pr_author(&serde_json::json!({})), None);
        assert_eq!(parse_pr_author(&serde_json::json!({ "login": "" })), None);
        assert_eq!(parse_pr_author(&serde_json::json!({ "login": null })), None);
    }

    #[test]
    fn parse_pr_author_flags_bots_and_collapses_empty_name() {
        // is_bot is honored (so the UI can show a bot glyph); an empty name → None.
        let bot = parse_pr_author(&serde_json::json!({
            "login": "dependabot",
            "name": "",
            "is_bot": true
        }));
        assert_eq!(
            bot,
            Some(PrAuthor {
                login: "dependabot".to_string(),
                name: None,
                is_bot: true,
            })
        );
    }

    // ── non-draft awaiting-review count derivation ───────────────────────────

    #[test]
    fn non_draft_awaiting_review_count_excludes_drafts_and_approved() {
        let prs = vec![
            OpenPr { number: 1, title: "a".into(), url: "u1".into(), is_draft: false, review_decision: Some("REVIEW_REQUIRED".into()), author: None, updated_at: None },
            OpenPr { number: 2, title: "b".into(), url: "u2".into(), is_draft: true, review_decision: Some("REVIEW_REQUIRED".into()), author: None, updated_at: None },
            OpenPr { number: 3, title: "c".into(), url: "u3".into(), is_draft: false, review_decision: Some("APPROVED".into()), author: None, updated_at: None },
            OpenPr { number: 4, title: "d".into(), url: "u4".into(), is_draft: false, review_decision: None, author: None, updated_at: None },
        ];
        // PR 1: non-draft, not approved → counted.
        // PR 2: draft → excluded even though awaiting review.
        // PR 3: approved → excluded.
        // PR 4: non-draft, no decision (= awaiting) → counted.
        assert_eq!(awaiting_review_count_non_draft(&prs), 2);
    }

    #[test]
    fn non_draft_awaiting_review_count_empty_vec_is_zero() {
        assert_eq!(awaiting_review_count_non_draft(&[]), 0);
    }

    #[test]
    fn non_draft_awaiting_review_count_all_drafts_is_zero() {
        let prs = vec![
            OpenPr { number: 1, title: "a".into(), url: "u1".into(), is_draft: true, review_decision: Some("REVIEW_REQUIRED".into()), author: None, updated_at: None },
        ];
        assert_eq!(awaiting_review_count_non_draft(&prs), 0);
    }

    #[test]
    fn non_draft_awaiting_review_count_all_approved_is_zero() {
        let prs = vec![
            OpenPr { number: 1, title: "a".into(), url: "u1".into(), is_draft: false, review_decision: Some("APPROVED".into()), author: None, updated_at: None },
            OpenPr { number: 2, title: "b".into(), url: "u2".into(), is_draft: false, review_decision: Some("APPROVED".into()), author: None, updated_at: None },
        ];
        assert_eq!(awaiting_review_count_non_draft(&prs), 0);
    }

    #[test]
    fn gh_open_prs_args_includes_new_fields() {
        // The args builder now requests number,title,url,isDraft,reviewDecision.
        let args = gh_open_prs_args("main");
        let json_pos = args.iter().position(|a| a == "--json").expect("--json present");
        let fields = &args[json_pos + 1];
        assert!(fields.contains("title"), "should include title");
        assert!(fields.contains("url"), "should include url");
        assert!(fields.contains("isDraft"), "should include isDraft");
    }
}
