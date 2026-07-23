pub mod activity;
pub mod claude_title;
pub mod events;
pub mod git;
pub mod ipc;
pub mod models;
pub mod no_window;
pub mod notify_click;
pub mod orchestration;
pub mod polish;
pub mod pr;
pub mod project_store;
pub mod pty;
pub mod shell_path;
pub mod specialists;
pub mod subagents;
pub mod task;
pub mod transcribe;
pub mod usage;
pub mod vad;
pub mod voice_activation;
pub mod whisper_server;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use activity::{Activity, PaneRef};
use events::{AgentEvent, EventState, EVENT_EVENT};
use pty::{PaneId, PtyEvent, PtyManager, SpawnConfig};
use subagents::{SessionRef, Subagent, SubagentsWatcher, SUBAGENTS_EVENT};
use usage::{Snapshot, SnapshotWatcher, SNAPSHOT_EVENT};

use std::collections::HashMap;

/// Basename of the persisted layout file under the app-data directory.
const LAYOUT_FILE: &str = "layout.json";

/// Basename of the persisted recent-folders file (sibling of `layout.json`).
const RECENTS_FILE: &str = "recents.json";

/// Basename of the persisted projects file (sibling of `layout.json`).
const PROJECTS_FILE: &str = "projects.json";

/// Basename of the persisted user-settings file (sibling of `layout.json`),
/// holding the open-with preferences (which app opens code/html/other files).
const SETTINGS_FILE: &str = "settings.json";

/// Basename of the persisted project-terminals file (sibling of `layout.json`),
/// holding each project's user-created terminal definitions (the Terminals panel).
const TERMINALS_FILE: &str = "terminals.json";

/// Basename of the persisted project-tasks file (sibling of `layout.json`),
/// holding each project's user-created task definitions (the Tasks panel).
const TASKS_FILE: &str = "tasks.json";

/// The statusline wrapper source, version-controlled under `src-tauri/resources`
/// and baked into the binary. Installed verbatim to `<app_data_dir>/bin/` on
/// setup so a session can be launched with
/// `claude --settings '{"statusLine":{"command":"<that-path>"}}'`. It is authored
/// as CommonJS so it runs standalone (no sibling package.json) under the `node`
/// shebang regardless of the host project's module type.
const STATUSLINE_WRAPPER_SRC: &str = include_str!("../resources/statusline-wrapper.cjs");

/// The baked event-hook source (installed beside the wrapper). It is wired into
/// the FULL hook lifecycle event set and delivers each normalized event over the
/// app-hosted Unix socket, feeding the overview's event-sourced status + per-tool
/// timeline (see `events.rs`).
const EVENT_HOOK_SRC: &str = include_str!("../resources/event-hook.cjs");

/// The baked orchestration MCP ADAPTER source (installed beside the wrapper). It is
/// the dependency-free stdio MCP server attached to a launched COORDINATOR session
/// (`--mcp-config`); it forwards each toolkit tool call over the Rust control socket
/// to the frontend executor. Authored as CommonJS so it runs standalone under the
/// `node` shebang. See `resources/orchestration-mcp.cjs`.
const ORCHESTRATION_MCP_SRC: &str = include_str!("../resources/orchestration-mcp.cjs");

/// Subdir (under app-data) holding the installed wrapper executable.
const BIN_DIR: &str = "bin";
/// Installed wrapper basename. Kept as `.js` (the name the spec/`--settings`
/// command reference); standalone with no sibling package.json `node` treats a
/// `.js` file as CommonJS, so the CommonJS source runs correctly.
const WRAPPER_FILE: &str = "statusline-wrapper.js";
/// Installed event-hook basename (a standalone `.js`, run via its shebang).
const EVENT_HOOK_FILE: &str = "event-hook.js";
/// Installed orchestration MCP adapter basename (a standalone `.js`, run via `node`
/// in the coordinator's `--mcp-config` server).
const ORCHESTRATION_MCP_FILE: &str = "orchestration-mcp.js";
/// Subdir (under app-data) the wrapper writes per-pane snapshots into and the
/// `SnapshotWatcher` watches.
const SNAPSHOT_DIR: &str = "snapshots";
/// Subdir (under app-data) holding the durable per-session event logs the event
/// pipeline appends to (`events/<sessionId>.jsonl`).
const EVENTS_DIR: &str = "events";

/// Absolute paths the frontend needs to launch sessions wired into the usage
/// dashboard. Serialized camelCase for the JS side.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePaths {
    /// Absolute path to the installed `statusline-wrapper.js` — goes verbatim
    /// into the `--settings` `statusLine.command` of every spawned session.
    pub wrapper_path: String,
    /// Absolute path to the snapshots dir — passed as `AGENT_DESKTOP_SNAPSHOT_DIR`
    /// in the spawned process env and watched by the `SnapshotWatcher`.
    pub snapshot_dir: String,
    /// Absolute path to the installed `event-hook.js` — goes verbatim into the
    /// `--settings` `hooks` config (the full lifecycle event set) of every spawned
    /// session so the overview's status + per-tool timeline are event-sourced.
    pub event_hook_path: String,
    /// ADDRESS of the app-hosted local socket the event hook delivers to — a
    /// filesystem path on Unix, a `\\.\pipe\…` name on Windows (see
    /// [`crate::ipc::socket_address`]). Passed as `AGENT_DESKTOP_SOCKET_PATH` in
    /// the spawned process env. MUST equal what `events::start_event_server`
    /// binds, or the hook connects to nothing and silently drops every event.
    pub socket_path: String,
    /// Absolute path to the installed orchestration MCP adapter — `node <this>` is
    /// the coordinator launch's `--mcp-config` server command (`buildMcpToolkitConfig`).
    pub adapter_path: String,
    /// ADDRESS of the Rust orchestration CONTROL socket (sibling of
    /// `socket_path`, same path-vs-pipe-name rule) — goes into the coordinator's
    /// `--mcp-config` server env as `AGENT_DESKTOP_CONTROL_SOCKET` so the adapter
    /// can reach the executor. MUST equal what `orchestration::start_control_server`
    /// binds.
    pub control_socket_path: String,
}

/// Spawn a PTY-backed process for a pane. Output is streamed to the frontend
/// over the per-pane `on_event` channel as `PtyEvent`s; returns the new pane id.
///
/// `env` is an OPTIONAL list of extra `(key, value)` environment entries merged
/// into the child env after the seeded base (caller wins). It defaults to empty
/// when the frontend omits it, so shell panes spawn with no extra env; `claude`
/// panes pass `AGENT_DESKTOP_PANE`/`AGENT_DESKTOP_SNAPSHOT_DIR` here.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn pty_spawn(
    manager: State<'_, Arc<PtyManager>>,
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<Vec<(String, String)>>,
    on_event: Channel<PtyEvent>,
) -> Result<PaneId, String> {
    let cfg = SpawnConfig {
        program,
        args,
        cwd,
        cols,
        rows,
        env: env.unwrap_or_default(),
    };
    // Bridge the Tauri Channel into the manager's generic sink. A send error
    // (channel closed) maps to Err(()), which stops the read loop.
    manager.spawn_with_sink(cfg, move |ev| on_event.send(ev).map_err(|_| ()))
}

/// Forward raw input bytes from xterm to a pane's PTY writer.
#[tauri::command]
fn pty_write(manager: State<'_, Arc<PtyManager>>, id: PaneId, data: Vec<u8>) -> Result<(), String> {
    manager.write(id, data)
}

/// Open `path` in the Cursor editor (macOS `open -a Cursor <path>`). The frontend
/// resolves a relative filename against the agent's cwd before calling, so `path`
/// is absolute. Best-effort: spawns and returns; a launch failure is surfaced as a
/// string the frontend can log/ignore (never blocks the UI).
#[tauri::command]
fn open_in_editor(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Cursor", &path])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open -a Cursor {path}: {e}"))
}

/// Resolve a terminal `token` to an existing absolute path, cwd-aware. `~`/`~/...`
/// expand against `$HOME`; absolute tokens pass through; everything else is joined
/// against the pane's `cwd`. `fs::canonicalize` both validates existence (it errors
/// if the path is missing) and yields the absolute, symlink-resolved path. Returns
/// `Ok(None)` for anything that doesn't map to an existing path (no `cwd` for a
/// relative token, `~user` form, missing `$HOME`, or non-existent path) so the
/// frontend simply declines to linkify — only real paths get an affordance.
#[tauri::command]
fn resolve_path(cwd: Option<String>, token: String) -> Result<Option<String>, String> {
    let token = token.trim();
    if token.is_empty() {
        return Ok(None);
    }
    let candidate: PathBuf = if let Some(rest) = token.strip_prefix('~') {
        let home = crate::shell_path::home_dir();
        if home.is_empty() {
            return Ok(None);
        }
        if rest.is_empty() {
            PathBuf::from(home)
        } else if let Some(rest) = rest.strip_prefix('/') {
            PathBuf::from(home).join(rest)
        } else {
            // `~user` form is not supported.
            return Ok(None);
        }
    } else {
        let p = PathBuf::from(token);
        if p.is_absolute() {
            p
        } else {
            match cwd {
                Some(c) => PathBuf::from(c).join(p),
                None => return Ok(None),
            }
        }
    };
    Ok(fs::canonicalize(&candidate)
        .ok()
        .map(|abs| abs.to_string_lossy().into_owned()))
}

/// True when `path` resolves to a location inside `root` (or equal to it). Both
/// sides are canonicalized so symlinks (e.g. macOS `/var` → `/private/var`) and
/// `..` segments compare correctly; a non-existent root or path yields `false`.
/// PURE w.r.t. its inputs (reads only the filesystem); unit-tested.
fn path_within(root: &str, path: &str) -> bool {
    match (fs::canonicalize(root), fs::canonicalize(path)) {
        (Ok(r), Ok(p)) => p.starts_with(&r),
        _ => false,
    }
}

/// The standard macOS directories that hold application bundles, in probe order.
/// `~/Applications` is HOME-relative (expanded per-caller for testability); the
/// CoreServices root covers system apps like Finder that live outside
/// `/System/Applications`.
const APP_ROOTS: &[&str] = &[
    "/Applications",
    "~/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    "/System/Library/CoreServices",
];

/// PURE: the candidate `<name>.app` bundle paths for an application display name,
/// one per root. A leading `~/` (or bare `~`) root is expanded against `home` so
/// the detection logic is unit-testable against a temp dir without touching the
/// real filesystem. Used by [`detect_installed`].
fn app_bundle_paths(name: &str, home: &str, roots: &[&str]) -> Vec<PathBuf> {
    roots
        .iter()
        .map(|root| {
            let base = if let Some(rest) = root.strip_prefix("~/") {
                PathBuf::from(home).join(rest)
            } else if *root == "~" {
                PathBuf::from(home)
            } else {
                PathBuf::from(root)
            };
            base.join(format!("{name}.app"))
        })
        .collect()
}

/// PURE w.r.t. its inputs (reads only the filesystem): the subset of `names` whose
/// `<name>.app` bundle exists in any of `roots` (with `~/` expanded against `home`),
/// preserving input order. Backs the [`installed_apps`] command; split out so the
/// existence-filtering is unit-tested against temp dirs.
fn detect_installed(names: &[String], home: &str, roots: &[&str]) -> Vec<String> {
    names
        .iter()
        .filter(|name| {
            app_bundle_paths(name, home, roots)
                .iter()
                .any(|p| p.exists())
        })
        .cloned()
        .collect()
}

/// Return which of the given application display names are installed, by probing
/// the standard macOS application directories ([`APP_ROOTS`]) for each
/// `<name>.app` bundle. macOS-only by nature; on a system without those
/// directories every name is simply absent (an empty result). The frontend uses
/// this to offer only installed apps in the "Open files with" settings.
#[tauri::command]
fn installed_apps(names: Vec<String>) -> Vec<String> {
    let home = crate::shell_path::home_dir();
    detect_installed(&names, &home, APP_ROOTS)
}

/// The program a new shell pane launches when the user has set no preference
/// (`shell-selection`). Platform-derived — `pwsh`/`powershell.exe` on Windows,
/// `$SHELL`/`/bin/zsh` on Unix — because only the backend can probe `PATH`.
#[tauri::command]
fn default_shell() -> String {
    crate::shell_path::default_shell()
}

/// Build the argument vector passed to `open` (after the program name) for
/// [`open_path`]. PURE so the launch wiring is unit-tested without spawning:
/// - no app                  → `[path]`                    (OS default handler)
/// - app, no workspace        → `["-a", app, path]`
/// - app + workspace          → `["-a", app, workspace, path]` (editor opens the
///   folder as the workspace and reveals the file within it)
///
/// A `workspace` without an `app` is ignored (the OS default handler can't be told
/// a workspace), so it degrades to `[path]`.
fn open_args(path: &str, app: Option<&str>, workspace: Option<&str>) -> Vec<String> {
    match app {
        Some(app) => {
            let mut args = vec!["-a".to_string(), app.to_string()];
            if let Some(workspace) = workspace {
                args.push(workspace.to_string());
            }
            args.push(path.to_string());
            args
        }
        None => vec![path.to_string()],
    }
}

/// Open `path` in an application. With `app` set, launches that specific app
/// (macOS `open -a <app> <path>`, e.g. "Brave Browser", "Cursor"); with `app`
/// `None`/empty, opens in the OS default handler (`open <path>` — registered app
/// for files, Finder for directories). When `workspace` is set alongside an `app`
/// and actually contains `path`, the workspace folder is opened too
/// (`open -a <app> <workspace> <path>`) so a project-aware editor reveals the file
/// inside the project rather than guessing a workspace from the file's folder. A
/// `workspace` that doesn't contain the file (e.g. an absolute path clicked outside
/// the project, or a non-file target like a URL) is dropped so no unrelated project
/// is opened. The frontend picks `app`/`workspace` from the user's open-with
/// preferences. Mirrors `open_in_editor` — best-effort spawn-and-return; a launch
/// failure is surfaced as a string the frontend logs/ignores.
#[tauri::command]
fn open_path(path: String, app: Option<String>, workspace: Option<String>) -> Result<(), String> {
    let app = app.as_deref().map(str::trim).filter(|a| !a.is_empty());
    let workspace = workspace
        .as_deref()
        .map(str::trim)
        .filter(|w| !w.is_empty())
        // A workspace is honored only with a named app and when it really contains
        // the file — otherwise an unrelated project could be opened.
        .filter(|w| app.is_some() && path_within(w, &path));
    let args = open_args(&path, app, workspace);
    std::process::Command::new("open")
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open {path} (app {app:?}, workspace {workspace:?}): {e}"))
}

/// Title-budget constants for [`select_title_messages`]. `TITLE_MAX_MSGS` caps how
/// many user messages we feed the title model so the prompt fits the sidecar's
/// modest 4096-token context (each message is clipped to 200 chars by
/// [`clip_message`]). `TITLE_HEAD_MSGS` reserves the first slots for the EARLIEST
/// messages — the session's original/primary request usually lives there, and
/// recency-only truncation used to drop it in long sessions. The remaining
/// `TITLE_MAX_MSGS - TITLE_HEAD_MSGS` slots take the most RECENT messages so a
/// genuinely new later request can still surface. 8 + 12 keeps a strong anchor on
/// the original ask while leaving room for refinements and any late pivot.
const TITLE_MAX_MSGS: usize = 20;
const TITLE_HEAD_MSGS: usize = 8;

/// Clip `m` to at most `max` characters after whitespace-normalisation. For messages
/// at or under the limit the full text is returned. For longer messages the beginning
/// and end are shown, separated by a "…" ellipsis, so the reader (and the title
/// model) sees both where the message starts and where it ends. PURE and
/// unit-tested.
fn clip_message(m: &str, max: usize) -> String {
    let one = m.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = one.chars().collect();
    if chars.len() <= max {
        return one;
    }
    if max == 0 {
        return String::new();
    }
    let head_len = (max - 1) / 2;
    let tail_len = max - head_len - 1; // -1 for the "…"
    let head: String = chars[..head_len].iter().collect();
    let tail: String = chars[chars.len() - tail_len..].iter().collect();
    format!("{head}…{tail}")
}

/// Select which user messages to feed the title model, weighting the EARLIEST
/// (the original request) so recency truncation can never drop it. PURE so the
/// selection is unit-tested apart from the model call and the I/O in
/// [`session_focus`].
///
/// - When `msgs.len() <= max`, every message is returned (chronological order).
/// - Otherwise the first `head` messages (the original request and its immediate
///   context) PLUS the last `max - head` messages (recent activity, where a new
///   top-level task would appear) are returned, in chronological order, with any
///   index overlap de-duplicated (relevant only for tiny/odd `max`/`head`).
///
/// `head` is clamped to `max` so the tail window never has negative width.
fn select_title_messages(msgs: &[String], max: usize, head: usize) -> Vec<&str> {
    if msgs.len() <= max {
        return msgs.iter().map(String::as_str).collect();
    }
    let head = head.min(max);
    let tail_len = max - head;
    // De-dup by POSITION: start the tail window at the later of (last `tail_len`
    // messages) and (just past the head window), so a message is never emitted
    // twice. With `len > max >= head` the tail window already begins past the head,
    // but the `.max(head)` keeps the helper correct for tiny/odd `max`/`head` too.
    let tail_start = (msgs.len() - tail_len).max(head);
    let mut out: Vec<&str> = Vec::with_capacity(max);
    // HEAD: the earliest messages (always includes the original request).
    for m in &msgs[..head] {
        out.push(m.as_str());
    }
    // TAIL: the most recent messages (chronological order preserved).
    for m in &msgs[tail_start..] {
        out.push(m.as_str());
    }
    out
}

/// Clean a raw model completion into a session-title string: drop any Qwen3
/// `<think>…</think>` reasoning block that slipped into the content, take the first
/// non-empty line, strip wrapping quotes / trailing periods, drop a hallucinated
/// ticket-id prefix (see [`strip_phantom_ticket`]), de-slugify a bare slug the model
/// copied verbatim (see [`deslugify`]), and clip to 60 chars on a word boundary.
/// `source` is the joined user transcript the title was generated from — the only
/// ground truth for whether a ticket id is real. PURE so the post-processing is
/// unit-tested apart from the model call.
fn clean_title(raw: &str, source: &str) -> String {
    let body = strip_think_blocks(raw);
    let title = body
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim_matches(|c| c == '"' || c == '\'' || c == '.')
        .trim();
    let title = strip_phantom_ticket(title, source);
    let title = deslugify(&title);
    clip_title(&title, 60)
}

/// If `title` is a bare SLUG — all-lowercase words joined by hyphens with no spaces,
/// e.g. an OpenSpec change name like `footer-branch-switcher` that the model copied
/// out of the transcript — turn it into spaced, sentence-cased words
/// (`Footer branch switcher`). A title that already contains a space, or isn't
/// slug-shaped, is returned unchanged. The prompt tells the model not to emit slugs,
/// but the small model still does it for workflow/OpenSpec sessions, so this is the
/// deterministic salvage. PURE for unit testing.
fn deslugify(title: &str) -> String {
    let t = title.trim();
    let is_slug = t.contains('-')
        && !t.contains(' ')
        && t.split('-').filter(|s| !s.is_empty()).count() >= 2
        && t.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !is_slug {
        return title.to_string();
    }
    let spaced = t.replace('-', " ");
    let mut chars = spaced.chars();
    match chars.next() {
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str(),
        None => spaced,
    }
}

/// Clip `s` to at most `max` chars, backing off to the last word boundary when the
/// cut would land mid-word (and at least half the budget is kept), so a slightly
/// long title ends on a whole word rather than a truncated one. A single
/// over-long word with no space is hard-cut at `max`. PURE for unit testing.
fn clip_title(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let truncated: String = chars[..max].iter().collect();
    match truncated.rfind(' ') {
        Some(i) if i >= max / 2 => truncated[..i].trim_end().to_string(),
        _ => truncated.trim_end().to_string(),
    }
}

/// Drop a leading ticket/issue id from `title` when that id does NOT appear in
/// `source`. The local model parrots the prompt's example formats (`#45`,
/// `PROJ-45`) into titles for sessions that reference no ticket at all; the prompt
/// alone has not stopped it, so this is the deterministic backstop. Only a LEADING
/// id is considered (the documented title shape is "ID: focus"); an id genuinely
/// present in the user's messages is kept verbatim. PURE for unit testing.
fn strip_phantom_ticket(title: &str, source: &str) -> String {
    match split_leading_ticket(title) {
        Some((id, rest)) if !source_contains_id(source, id) => rest.to_string(),
        _ => title.to_string(),
    }
}

/// If `title` begins with a ticket/issue id, return `(id, rest)` where `rest` is
/// the title after the id and an optional `:`/whitespace separator. Recognized
/// forms: a GitHub issue `#<digits>`, or a tracker key `<2+ UPPERCASE letters>-<digits>`
/// (e.g. `PROJ-45`). Returns `None` when there is no leading id. The 2-letter
/// minimum avoids treating fragments like `I-9` or `A-1` as tickets.
fn split_leading_ticket(title: &str) -> Option<(&str, &str)> {
    let b = title.as_bytes();
    let id_end = if b.first() == Some(&b'#') {
        let mut i = 1;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == 1 {
            return None; // bare '#'
        }
        i
    } else {
        let mut i = 0;
        while i < b.len() && b[i].is_ascii_uppercase() {
            i += 1;
        }
        if i < 2 {
            return None; // need >=2 uppercase letters
        }
        if b.get(i) != Some(&b'-') {
            return None;
        }
        i += 1; // consume '-'
        let digits_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            return None; // no digits after '-'
        }
        i
    };
    let id = &title[..id_end];
    let mut rest = title[id_end..].trim_start();
    if let Some(stripped) = rest.strip_prefix(':') {
        rest = stripped.trim_start();
    }
    Some((id, rest))
}

/// Whether `source` contains the ticket `id` as a standalone token (ASCII
/// case-insensitive). Boundary-checked so `#45` does NOT match inside `#456` and
/// `PROJ-45` does NOT match inside `PROJ-456` or `MYPROJ-45`: the char before the
/// id must not be ASCII-alphanumeric and the char after must not be an ASCII digit.
fn source_contains_id(source: &str, id: &str) -> bool {
    let bytes = source.as_bytes();
    let mut from = 0;
    while let Some(rel) = find_ascii_ci(&source[from..], id) {
        let start = from + rel;
        let end = start + id.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let after_ok = end >= bytes.len() || !bytes[end].is_ascii_digit();
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// Byte index of the first ASCII-case-insensitive occurrence of `needle` in
/// `haystack`, as an offset valid for slicing `haystack` itself. `needle` MUST be
/// ASCII (our literal `<think>` tags are). Searching byte windows on the ORIGINAL
/// string keeps offsets aligned — unlike searching a `to_lowercase()` copy, whose
/// offsets can drift when case-folding changes the byte length (e.g. `İ` lowercases
/// to two code points), which would risk an out-of-bounds / non-boundary panic or
/// silent corruption. An all-ASCII match can only start on a char boundary (UTF-8
/// multi-byte sequences never contain ASCII bytes), so the index is always valid.
fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let (hay, ndl) = (haystack.as_bytes(), needle.as_bytes());
    if ndl.is_empty() || hay.len() < ndl.len() {
        return None;
    }
    (0..=hay.len() - ndl.len()).find(|&i| hay[i..i + ndl.len()].eq_ignore_ascii_case(ndl))
}

/// Remove every `<think>…</think>` span (case-insensitive) from `s`. Qwen3 is a
/// reasoning model; with thinking disabled the content is bare, but if a stray
/// reasoning block leaks through it must not corrupt a 6-word title. An unterminated
/// `<think>` drops the remainder. Offsets come from [`find_ascii_ci`] (valid for the
/// original string), so multi-byte content around a tag never panics or corrupts.
fn strip_think_blocks(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some(start) = find_ascii_ci(rest, "<think>") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after_open = &rest[start + "<think>".len()..];
        match find_ascii_ci(after_open, "</think>") {
            Some(end_rel) => rest = &after_open[end_rel + "</think>".len()..],
            // Unterminated `<think>`: everything after it is reasoning; drop it.
            None => break,
        }
    }
    out
}

/// Generate a short session FOCUS title from the user's messages. The PRIMARY path
/// is the LOCAL model (the `llama-server` sidecar loading the Qwen3 polish model —
/// see `polish.rs`): locate the session transcript, extract the user's prose
/// messages, and ask the local model for a <=6-word title (e.g. "Improve dialog
/// handling"). Returns `None` when the user has sent nothing yet.
///
/// When the on-device path fails for ANY reason (model absent, sidecar won't start,
/// HTTP error, timeout) AND `cloud_fallback` is set (the opt-in `titles.cloudFallback`
/// setting), regenerate the title with the `claude` CLI (`claude -p --model haiku` —
/// see `claude_title.rs`), reusing the same prompt + `clean_title` so the result is
/// identical in shape. With `cloud_fallback` off the on-device failure returns `Err`
/// and the frontend keeps the previous title (the original on-device-only behavior).
/// The frontend gates calls on the `user_hash` so a title is regenerated only when
/// the user's messages actually change.
///
/// `async` runs this off the main/UI thread: the model call can take a moment, and
/// the sidecar may need a lazy start on the first request; the UI stays responsive
/// while the title resolves in the background.
#[tauri::command]
async fn session_focus(
    app: AppHandle,
    state: State<'_, Arc<polish::LlamaServer>>,
    session_id: String,
    cwd: Option<String>,
    cloud_fallback: bool,
) -> Result<Option<String>, String> {
    let projects_base =
        activity::projects_base().ok_or("HOME unset; cannot locate ~/.claude/projects")?;
    let pane = PaneRef {
        pane_id: String::new(),
        session_id: Some(session_id),
        cwd,
    };
    let Some(transcript) = activity::find_transcript(&projects_base, &pane) else {
        return Ok(None);
    };
    // Title-specific view: drops skill/command/caveat scaffolding (isMeta preludes,
    // slash-command markup, interrupt markers) that the small title model otherwise
    // copies into the title. Distinct from `user_messages` so the auto-resume /
    // empty-session gates that read `user_hash`/`user_message_count` are unaffected.
    let msgs = activity::title_user_messages(&transcript);
    if msgs.is_empty() {
        return Ok(None);
    }
    let asst_msgs = activity::assistant_messages(&transcript);
    // Bound the prompt to fit the local model's modest context window (the sidecar
    // runs with a 4096-token context). Weight the EARLIEST messages so the session's
    // original request is always included even in a long session (head + tail
    // budget), then clip each message with head+tail ellipsis for long ones. The
    // first selected message is the original request; label it so the model anchors
    // on it (DATA, not a command).
    let selected = select_title_messages(&msgs, TITLE_MAX_MSGS, TITLE_HEAD_MSGS);
    let mut lines = selected.iter().map(|m| clip_message(m, 200));
    let first = lines.next().unwrap_or_default(); // msgs is non-empty (checked above)
    let rest: Vec<String> = lines.collect();

    // Earliest and most recent assistant responses bookend the session and let the
    // title model understand what was actually accomplished, not just what was asked.
    // Clip assistant messages tighter (150 chars) since they tend to be verbose.
    let earliest_asst = asst_msgs.first().map(|m| clip_message(m, 150));
    let most_recent_asst = if asst_msgs.len() > 1 {
        asst_msgs.last().map(|m| clip_message(m, 150))
    } else {
        None
    };

    let mut joined = format!("Original request:\n- {first}");
    if let Some(ea) = &earliest_asst {
        let label = if most_recent_asst.is_some() {
            "Earliest assistant response"
        } else {
            "Assistant response"
        };
        joined.push_str(&format!("\n{label}:\n- {ea}"));
    }
    if !rest.is_empty() {
        joined.push_str(&format!("\nLater messages:\n- {}", rest.join("\n- ")));
    }
    if let Some(mr) = &most_recent_asst {
        joined.push_str(&format!("\nMost recent assistant response:\n- {mr}"));
    }

    // Run the title completion through the shared local-model path (lazy-starts the
    // sidecar). The model id is the registry id; llama-server ignores it for routing.
    let body = polish::build_title_body(&joined, models::POLISH.id);
    let raw = match polish::chat_complete(&app, &state, body).await {
        Ok(raw) => raw,
        Err(on_device_err) => {
            // On-device unavailable. Fall back to the cloud (claude -p haiku) ONLY
            // when the user opted in; otherwise keep the previous title (Err).
            if !cloud_fallback {
                return Err(on_device_err);
            }
            claude_title::claude_title(&joined).await.map_err(|cloud_err| {
                format!(
                    "on-device title failed ({on_device_err}); cloud fallback failed ({cloud_err})"
                )
            })?
        }
    };
    let title = clean_title(&raw, &joined);
    Ok((!title.is_empty()).then_some(title))
}

/// Resize a pane's PTY (delivers SIGWINCH to the child).
#[tauri::command]
fn pty_resize(
    manager: State<'_, Arc<PtyManager>>,
    id: PaneId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

/// Kill a pane's child process (and let the read loop reap it on EOF).
#[tauri::command]
fn pty_kill(manager: State<'_, Arc<PtyManager>>, id: PaneId) -> Result<(), String> {
    manager.kill(id)
}

/// Resolve the absolute path to an app-data file named `file`, creating the
/// app-data dir if needed. Errors are stringified for the frontend (which falls
/// back gracefully on any failure).
fn app_data_file(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    Ok(dir.join(file))
}

/// Read an app-data JSON file, or `None` when it does not exist yet. A read
/// error (other than not-found) is surfaced so the frontend can fall back rather
/// than crash.
fn read_app_data_json(app: &AppHandle, file: &str) -> Result<Option<String>, String> {
    let path = app_data_file(app, file)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

/// Atomically write `json` to an app-data file: write a sibling temp file then
/// rename it over the target, so a crash mid-write never leaves a truncated file
/// (a reader always sees either the old or the new whole file).
fn write_app_data_json(app: &AppHandle, file: &str, json: &str) -> Result<(), String> {
    let path = app_data_file(app, file)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write {tmp:?}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))?;
    Ok(())
}

/// Load the persisted layout JSON, or `None` when no layout file exists yet.
/// A read error (other than not-found) is surfaced so the frontend can fall
/// back to a fresh workspace rather than crash.
#[tauri::command]
fn layout_load(app: AppHandle) -> Result<Option<String>, String> {
    read_app_data_json(&app, LAYOUT_FILE)
}

/// Atomically persist the layout JSON (see [`write_app_data_json`]).
#[tauri::command]
fn layout_save(app: AppHandle, json: String) -> Result<(), String> {
    write_app_data_json(&app, LAYOUT_FILE, &json)
}

/// Load the persisted recent-folders JSON (sibling `recents.json`), or `None`
/// when no file exists yet. The frontend parses tolerantly (empty list on any
/// malformed input), so a read error other than not-found is the only failure
/// surfaced here.
#[tauri::command]
fn recents_load(app: AppHandle) -> Result<Option<String>, String> {
    read_app_data_json(&app, RECENTS_FILE)
}

/// Atomically persist the recent-folders JSON (see [`write_app_data_json`]).
#[tauri::command]
fn recents_save(app: AppHandle, json: String) -> Result<(), String> {
    write_app_data_json(&app, RECENTS_FILE, &json)
}

/// Load the persisted projects JSON (sibling `projects.json`), or `None` when no
/// file exists yet. The frontend parses tolerantly (empty list on any malformed
/// input), so a read error other than not-found is the only failure surfaced here.
#[tauri::command]
fn projects_load(app: AppHandle) -> Result<Option<String>, String> {
    read_app_data_json(&app, PROJECTS_FILE)
}

/// Atomically persist the projects JSON (see [`write_app_data_json`]).
#[tauri::command]
fn projects_save(app: AppHandle, json: String) -> Result<(), String> {
    write_app_data_json(&app, PROJECTS_FILE, &json)
}

/// Load the persisted user-settings JSON (sibling `settings.json`), or `None` when
/// no file exists yet. The frontend parses tolerantly (falls back to defaults on
/// malformed input), so only a read error other than not-found surfaces here.
#[tauri::command]
fn settings_load(app: AppHandle) -> Result<Option<String>, String> {
    read_app_data_json(&app, SETTINGS_FILE)
}

/// Atomically persist the user-settings JSON (see [`write_app_data_json`]).
#[tauri::command]
fn settings_save(app: AppHandle, json: String) -> Result<(), String> {
    write_app_data_json(&app, SETTINGS_FILE, &json)
}

/// Load the persisted project-terminals JSON (sibling `terminals.json`), or `None`
/// when no file exists yet. The frontend parses tolerantly (empty collections on any
/// malformed input), so a read error other than not-found is the only failure here.
#[tauri::command]
fn terminals_load(app: AppHandle) -> Result<Option<String>, String> {
    read_app_data_json(&app, TERMINALS_FILE)
}

/// Atomically persist the project-terminals JSON (see [`write_app_data_json`]).
#[tauri::command]
fn terminals_save(app: AppHandle, json: String) -> Result<(), String> {
    write_app_data_json(&app, TERMINALS_FILE, &json)
}

/// Load the persisted project-tasks JSON (sibling `tasks.json`), or `None` when
/// no file exists yet. The frontend parses tolerantly. A one-time migration in the
/// frontend falls back to the legacy `terminals.json` (still read by `terminals_load`)
/// when this file is absent.
#[tauri::command]
fn tasks_load(app: AppHandle) -> Result<Option<String>, String> {
    read_app_data_json(&app, TASKS_FILE)
}

/// Atomically persist the project-tasks JSON (see [`write_app_data_json`]).
#[tauri::command]
fn tasks_save(app: AppHandle, json: String) -> Result<(), String> {
    write_app_data_json(&app, TASKS_FILE, &json)
}

/// Delete the LEGACY user-level `<app_data_dir>/tasks.json`. Deleting an absent
/// file is a NO-OP (not an error). Used to clean up the old user-level store after
/// migrating a project's tasks into its own `.agent-desktop/tasks.json` (see
/// [`project_store`]).
#[tauri::command]
fn tasks_clear(app: AppHandle) -> Result<(), String> {
    let path = app_data_file(&app, TASKS_FILE)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // no-op.
        Err(e) => Err(format!("remove {path:?}: {e}")),
    }
}

/// Delete the LEGACY user-level `<app_data_dir>/terminals.json` (the original name
/// of the user-level task store, still read by `terminals_load` as a migration
/// fallback). Deleting an absent file is a NO-OP. Cleared alongside
/// [`tasks_clear`] after a successful migration so the legacy fallback can never
/// re-fire and resurrect/clobber per-project `.agent-desktop/tasks.json` data.
#[tauri::command]
fn terminals_clear(app: AppHandle) -> Result<(), String> {
    let path = app_data_file(&app, TERMINALS_FILE)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // no-op.
        Err(e) => Err(format!("remove {path:?}: {e}")),
    }
}

/// List a project's SPECIALISTS — the native Claude Code subagent files under
/// `<projectPath>/.claude/agents/*.md`. Returns one `{ name, content }` per `.md`
/// file (raw contents; the frontend parses them via `parseSpecialist`), sorted by
/// name. A missing `.claude/agents/` dir yields an empty list, not an error. See
/// [`specialists::list_specialists`].
#[tauri::command]
fn specialists_list(project_path: String) -> Result<Vec<specialists::SpecialistFile>, String> {
    Ok(specialists::list_specialists(Path::new(&project_path)))
}

/// Read the raw `.md` contents of `<projectPath>/.claude/agents/<name>.md`. Errors
/// when `name` is unsafe or the file can't be read. See
/// [`specialists::read_specialist`].
#[tauri::command]
fn specialists_read(project_path: String, name: String) -> Result<String, String> {
    specialists::read_specialist(Path::new(&project_path), &name)
}

/// Create/overwrite `<projectPath>/.claude/agents/<name>.md` with `content`
/// (atomic temp+rename, creating the dir if needed). Errors when `name` is unsafe.
/// See [`specialists::write_specialist`].
#[tauri::command]
fn specialists_write(project_path: String, name: String, content: String) -> Result<(), String> {
    specialists::write_specialist(Path::new(&project_path), &name, &content)
}

/// Delete `<projectPath>/.claude/agents/<name>.md`. Deleting a nonexistent file is
/// a no-op (not an error). Errors when `name` is unsafe. See
/// [`specialists::delete_specialist`].
#[tauri::command]
fn specialists_delete(project_path: String, name: String) -> Result<(), String> {
    specialists::delete_specialist(Path::new(&project_path), &name)
}

/// Load a project's `.agent-desktop/tasks.json`, or `None` when it does not exist
/// yet. See [`project_store::load_tasks`].
#[tauri::command]
fn project_tasks_load(project_path: String) -> Result<Option<String>, String> {
    project_store::load_tasks(Path::new(&project_path))
}

/// Atomically persist a project's `.agent-desktop/tasks.json` (atomic temp+rename,
/// creating the dir if needed). See [`project_store::save_tasks`].
#[tauri::command]
fn project_tasks_save(project_path: String, json: String) -> Result<(), String> {
    project_store::save_tasks(Path::new(&project_path), &json)
}

/// Load a project's `.agent-desktop/config.json`, or `None` when it does not exist
/// yet. See [`project_store::load_config`].
#[tauri::command]
fn project_config_load(project_path: String) -> Result<Option<String>, String> {
    project_store::load_config(Path::new(&project_path))
}

/// Atomically persist a project's `.agent-desktop/config.json` (atomic temp+rename,
/// creating the dir if needed). See [`project_store::save_config`].
#[tauri::command]
fn project_config_save(project_path: String, json: String) -> Result<(), String> {
    project_store::save_config(Path::new(&project_path), &json)
}

/// Resolve `<app_data_dir>`, creating it if needed.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    Ok(dir)
}

/// Resolve the absolute path to the BUNDLED tiny whisper model, shipped as a
/// Tauri resource at `<resource_dir>/models/ggml-tiny.bin` (see
/// `tauri.conf.json` `bundle.resources`). This is what first-run / OFFLINE
/// transcription uses — it requires no download. Returns the path only if the
/// resource actually exists on disk (it may be absent in a non-bundled `cargo
/// build`/dev run where no resource was provisioned), so callers can fall back to
/// a downloaded model. The resource filename is the single source of truth in
/// `models::TINY`.
#[tauri::command]
fn voice_bundled_model_path(app: AppHandle) -> Result<Option<String>, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir: {e}"))?;
    let path = resource_dir
        .join("models")
        .join(models::tiny_spec().filename);
    if path.is_file() {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    // Dev fallback: in `tauri dev`/`cargo run` the bundle.resources are NOT staged
    // into resource_dir, so the bundled model isn't there. Fall back to the
    // provisioned source-tree copy (`src-tauri/models/<file>`, written by
    // scripts/fetch-models.sh) so dictation works while developing. Debug only —
    // a release bundle always ships the real resource.
    #[cfg(debug_assertions)]
    {
        let dev_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("models")
            .join(models::tiny_spec().filename);
        if dev_path.is_file() {
            return Ok(Some(dev_path.to_string_lossy().into_owned()));
        }
    }
    Ok(None)
}

/// Resolve the absolute on-disk path of the FINAL-pass whisper model for the given
/// `tier` (`fast` → small, `accurate` → large-v3-turbo) under
/// `<app_data_dir>/models/<filename>`. Returns the path only when that file is
/// actually present (it is downloaded on first use), so the voice pipeline can
/// fall back to the bundled tiny model (`voice_bundled_model_path`) when the
/// tier's larger model has not been downloaded yet. The filename is the single
/// source of truth in `models::final_model_for`.
#[tauri::command]
fn voice_model_path(app: AppHandle, tier: String) -> Result<Option<String>, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let spec = models::final_model_for(models::Tier::from_str(&tier));
    let path = models::model_path(&base, spec);
    Ok(path.is_file().then(|| path.to_string_lossy().into_owned()))
}

/// Install the baked statusline wrapper to `<app_data_dir>/bin/statusline-wrapper.js`
/// (mode 0755 on Unix) and ensure `<app_data_dir>/snapshots/` exists. Returns the
/// absolute wrapper path + snapshot dir. Idempotent: the wrapper is rewritten on
/// every call so an app update ships the latest source. The write is atomic
/// (sibling `.tmp` + rename) so a concurrent launch never reads a half-written
/// wrapper.
fn install_usage_assets(app: &AppHandle) -> Result<UsagePaths, String> {
    let base = app_data_dir(app)?;
    install_usage_assets_in(&base)
}

/// Filesystem half of [`install_usage_assets`], factored out so it can be tested
/// against a `tempdir` base without constructing a Tauri `AppHandle`. Writes the
/// wrapper to `<base>/bin/statusline-wrapper.js` (atomic, mode 0755 on Unix) and
/// ensures `<base>/snapshots/` exists, returning both absolute paths.
pub fn install_usage_assets_in(base: &std::path::Path) -> Result<UsagePaths, String> {
    let bin = base.join(BIN_DIR);
    fs::create_dir_all(&bin).map_err(|e| format!("create_dir_all {bin:?}: {e}"))?;

    // Install the baked scripts atomically (sibling `.tmp` + rename, mode 0755).
    let wrapper = install_executable(&bin, WRAPPER_FILE, STATUSLINE_WRAPPER_SRC)?;
    let event_hook = install_executable(&bin, EVENT_HOOK_FILE, EVENT_HOOK_SRC)?;
    let adapter = install_executable(&bin, ORCHESTRATION_MCP_FILE, ORCHESTRATION_MCP_SRC)?;

    let snapshots = base.join(SNAPSHOT_DIR);
    fs::create_dir_all(&snapshots).map_err(|e| format!("create_dir_all {snapshots:?}: {e}"))?;

    // Ensure the durable events dir exists; the socket lives at the app-data root.
    let events = base.join(EVENTS_DIR);
    fs::create_dir_all(&events).map_err(|e| format!("create_dir_all {events:?}: {e}"))?;

    Ok(UsagePaths {
        wrapper_path: wrapper.to_string_lossy().into_owned(),
        snapshot_dir: snapshots.to_string_lossy().into_owned(),
        event_hook_path: event_hook.to_string_lossy().into_owned(),
        // The socket ADDRESS, not the raw path: on Windows the servers bind a
        // `\\.\pipe\…` name, and a client handed the filesystem path would get
        // ENOENT and — because both clients swallow connect errors — drop every
        // event and every toolkit call SILENTLY. `ipc::socket_address` is
        // deterministic within a process, so this is byte-identical to what
        // `start_event_server` / `start_control_server` bind, and unchanged on Unix.
        socket_path: crate::ipc::events_address(base),
        adapter_path: adapter.to_string_lossy().into_owned(),
        control_socket_path: crate::ipc::control_address(base),
    })
}

/// Write a baked script to `<bin>/<file>` executably (mode 0755 on Unix) via a
/// unique sibling `.tmp` + atomic rename, so a concurrent launch never reads a
/// half-written file. Returns the installed path. Idempotent (rewritten each call,
/// so an app update ships the latest source).
fn install_executable(
    bin: &std::path::Path,
    file: &str,
    src: &str,
) -> Result<std::path::PathBuf, String> {
    let dest = bin.join(file);
    // Unique per-call tmp name (pid + a nanosecond timestamp) so two concurrent
    // installs (e.g. setup + a `usage_paths` call) never collide before rename.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = bin.join(format!("{file}.{}.{nanos}.tmp", std::process::id()));
    fs::write(&tmp, src).map_err(|e| format!("write {tmp:?}: {e}"))?;

    // Make it executable (it runs via its `#!/usr/bin/env node` shebang).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("chmod {tmp:?}: {e}"))?;
    }

    fs::rename(&tmp, &dest).map_err(|e| format!("rename {tmp:?} -> {dest:?}: {e}"))?;
    Ok(dest)
}

/// Return the absolute wrapper path + snapshot dir for launching sessions wired
/// into the usage dashboard, (re)installing the wrapper and ensuring both
/// directories exist as a side effect.
#[tauri::command]
fn usage_paths(app: AppHandle) -> Result<UsagePaths, String> {
    install_usage_assets(&app)
}

/// Return the current set of per-pane snapshots so the frontend can SEED its
/// store on mount (panes that already have a snapshot render immediately, before
/// any fs event fires). Reads `<app_data_dir>/snapshots/*.json`, skipping any
/// malformed/partial files; a missing dir yields an empty list. Never errors on
/// snapshot content — only on resolving the app-data dir.
#[tauri::command]
fn usage_snapshots(app: AppHandle) -> Result<Vec<Snapshot>, String> {
    let dir = app_data_dir(&app)?.join(SNAPSHOT_DIR);
    Ok(usage::read_all_snapshots(&dir))
}

/// Start the snapshot-directory watcher, emitting each parsed snapshot to the
/// frontend over the `usage://snapshot` event. The returned [`SnapshotWatcher`]
/// is held in Tauri-managed state so it lives for the app's lifetime and is
/// dropped cleanly on exit (its `Drop` stops the watch).
fn start_usage_watcher(app: &AppHandle) -> Result<SnapshotWatcher, String> {
    let dir = app_data_dir(app)?.join(SNAPSHOT_DIR);
    let handle = app.clone();
    usage::start_snapshot_watcher(&dir, move |snap| {
        // Push the parsed snapshot to the frontend. A failed emit (no window
        // yet / closing) is non-fatal — the next render re-emits, and the
        // frontend re-seeds via `usage_snapshots` on mount.
        if let Err(e) = handle.emit(SNAPSHOT_EVENT, &snap) {
            log::warn!("emit {SNAPSHOT_EVENT} failed: {e}");
        }
    })
}

/// The shared set of sessions the subagents watcher recomputes for, held in
/// Tauri-managed state. The frontend keeps it current via the `subagents_for`
/// command (passing its app-launched panes' `{sessionId, cwd}`); the watcher reads
/// it on every recompute so a newly-launched session starts surfacing its
/// subagents without restarting the watch.
#[derive(Default)]
struct WatchedSessionsState(subagents::WatchedSessions);

/// The app's launch time (Unix epoch MILLISECONDS), captured once at startup and
/// held in managed state. The subagents seed (`subagents_for`) and the watcher use
/// it to drop subagents that predate this run (see [`subagents::filter_pre_launch`]):
/// the app kills all its PTYs on close, so any subagent from a prior run is dead
/// and must not be restored when a session is resumed with `claude --resume`.
#[derive(Clone, Copy)]
struct AppLaunchTime(i64);

/// Return the `session_id -> [Subagent]` map for the caller's app-launched
/// sessions, after updating the shared watched-set to `sessions`. Each session
/// supplies its `{sessionId, cwd}`; the cwd locates the Claude project dir
/// (`~/.claude/projects/<encoded-cwd>/<sessionId>/`). Reads the live
/// `workflows/*.json` run records, tolerating absent/partial/malformed ones. Used
/// both to SEED the frontend on mount and to push the watched-set whenever the
/// app's session set changes (subsequent live updates arrive over the
/// `overview://subagents` event). A session with no subagents maps to an empty
/// list; a missing projects dir yields an empty map, never an error.
#[tauri::command]
fn subagents_for(
    state: State<'_, WatchedSessionsState>,
    launch: State<'_, AppLaunchTime>,
    sessions: Vec<SessionRef>,
) -> Result<HashMap<String, Vec<Subagent>>, String> {
    // Update the shared watched-set so the watcher's next recompute uses it too.
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "watched-sessions lock poisoned")?;
        *guard = sessions.clone();
    }
    let projects_base =
        subagents::default_projects_base().ok_or("HOME unset; cannot locate ~/.claude/projects")?;
    Ok(subagents::subagents_for_sessions(
        &projects_base,
        &sessions,
        launch.0,
    ))
}

/// Start the subagents watcher over `~/.claude/projects/`, emitting the
/// recomputed per-session subagent map to the frontend over
/// `overview://subagents`. Shares the watched-session set with the
/// `subagents_for` command so it is always current. The returned
/// [`SubagentsWatcher`] is held in managed state for the app's lifetime and
/// dropped cleanly on exit.
fn start_subagents_watcher(
    app: &AppHandle,
    sessions: subagents::WatchedSessions,
    launch_time_ms: i64,
) -> Result<SubagentsWatcher, String> {
    let projects_base =
        subagents::default_projects_base().ok_or("HOME unset; cannot locate ~/.claude/projects")?;
    let handle = app.clone();
    subagents::start_subagents_watcher(&projects_base, sessions, launch_time_ms, move |map| {
        if let Err(e) = handle.emit(SUBAGENTS_EVENT, &map) {
            log::warn!("emit {SUBAGENTS_EVENT} failed: {e}");
        }
    })
}

/// Return the `pane_id -> Activity` map (last assistant message + any pending
/// question) for the caller's app panes. Each pane supplies its `{paneId, cwd}`;
/// the cwd locates the agent's transcript (the newest `*.jsonl` under
/// `~/.claude/projects/<encoded-cwd>/`), so this is INDEPENDENT of the statusline
/// snapshot — the frontend polls it on a short clock. A pane with no cwd or no
/// transcript is simply absent from the map.
#[tauri::command]
fn activity_for(panes: Vec<PaneRef>) -> Result<HashMap<String, Activity>, String> {
    let projects_base =
        activity::projects_base().ok_or("HOME unset; cannot locate ~/.claude/projects")?;
    Ok(activity::activity_for_panes(&projects_base, &panes))
}

/// Return the `path -> GitStatus` map for the given project FOLDERS (branch +
/// dirty + ahead/behind), computed by shelling out to git per folder (in
/// parallel). Unlike the footer's git (which rides a running agent's statusline
/// snapshot), this works for any project folder even with no agent running, so the
/// project pane shows each project's branch directly. Off-repo / no-remote folders
/// map to an all-null status; the call never fails. The frontend polls it slowly.
#[tauri::command(async)]
fn git_status_for(paths: Vec<String>) -> Result<HashMap<String, git::GitStatus>, String> {
    Ok(git::status_for_paths(&paths))
}

/// Push the project's current branch to its remote (`git push` in `repo_path`),
/// fired from the project row's context menu. Returns git's own message on
/// success; `Err(message)` on failure (no upstream / rejected / offline) so the
/// frontend can surface it in a toast.
#[tauri::command(async)]
fn git_push(repo_path: String) -> Result<String, String> {
    git::push(&repo_path)
}

/// Pull the project's current branch from its remote (`git pull` in `repo_path`),
/// fired from the project row's context menu. Returns git's own message on
/// success; `Err(message)` on failure (conflict / no upstream / offline) so the
/// frontend can surface it in a toast.
#[tauri::command(async)]
fn git_pull(repo_path: String) -> Result<String, String> {
    git::pull(&repo_path)
}

/// Refresh the remote-tracking refs for the given project FOLDERS by fetching
/// each (in parallel, best-effort). Unlike `git_status_for` (which is fast and
/// local-only), this performs network I/O, so the frontend drives it on a SLOW
/// background clock; the next `git_status_for` poll then reports an accurate
/// ahead/behind count without any manual `git fetch`. Read-only and
/// non-interactive — a folder with no remote / offline / no creds never prompts
/// or pops an auth window — so this never fails the caller.
///
/// Returns each path's [`git::FetchStatus`] (`skipped` / `ok` / `failed`) so the
/// frontend can flag a folder that HAS a remote but couldn't fetch (offline /
/// missing credentials) with a subtle indicator, instead of the count just going
/// silently stale.
#[tauri::command(async)]
fn git_fetch_for(paths: Vec<String>) -> std::collections::HashMap<String, git::FetchStatus> {
    git::fetch_remotes(&paths)
}

/// List the local and remote-tracking branches for `repo_path`, plus the name
/// of the currently checked-out branch. Never fails: an off-repo path returns an
/// all-empty `BranchList`. Used by the footer branch-switcher UI.
#[tauri::command(async)]
fn git_list_branches(repo_path: String) -> Result<git::BranchList, String> {
    Ok(git::list_branches(&repo_path))
}

/// Check out `branch` in `repo_path` (git DWIM: a remote short name creates a
/// local tracking branch). Returns git's own message on success; `Err(message)`
/// on failure so the frontend can surface it in a toast.
#[tauri::command(async)]
fn git_checkout(repo_path: String, branch: String) -> Result<String, String> {
    git::checkout(&repo_path, &branch)
}

/// Create and check out a new branch `name` off the current HEAD in `repo_path`
/// (`git checkout -b`). Returns git's own message on success; `Err(message)` on
/// failure so the frontend can surface it in a toast.
#[tauri::command(async)]
fn git_create_branch(repo_path: String, name: String) -> Result<String, String> {
    git::create_branch(&repo_path, &name)
}

/// Look up the OPEN PR status for `repo_path`'s current branch into `base`
/// (default branch, typically `main`), for the footer's PR button. Resolves the
/// branch in `repo_path`, then runs `gh pr list --head <branch> --base <base>
/// --state open --json url,number`. Returns `{ kind: "exists", url, number }`
/// when one exists, `{ kind: "none" }` when not, and `{ kind: "unknown" }` (NOT
/// an error) when `gh` is missing/unauthenticated/errors — so the frontend falls
/// back to the create-confirm path. Best-effort; never fails.
#[tauri::command(async)]
async fn pr_status_for(repo_path: String, base: String) -> Result<pr::PrStatus, String> {
    Ok(pr::pr_status_for(&repo_path, &base).await)
}

/// Look up the OPEN PRs targeting `base` in `repo_path` that are AWAITING REVIEW,
/// plus the repo's pull-requests page URL, for the footer's "open PRs awaiting
/// review" button. Runs `gh pr list --base <base> --state open --json
/// number,reviewDecision` and counts the entries whose `reviewDecision` is NOT
/// `APPROVED`, and `gh repo view --json url` (+`/pulls`) for the link. Returns
/// `{ count, pullsUrl }`; degrades to the NEUTRAL `{ count: 0, pullsUrl: null }`
/// (NOT an error) when `gh` is missing/unauthenticated/errors. Best-effort.
#[tauri::command(async)]
async fn open_prs_for(repo_path: String, base: String) -> Result<pr::OpenPrs, String> {
    Ok(pr::open_prs_for(&repo_path, &base).await)
}

/// Resolve the repo's BASE web URL for `repo_path` via `gh repo view --json url`
/// (e.g. `https://github.com/o/r`), for the footer push popover's per-commit diff
/// links. Returns `null` (NOT an error) when the repo isn't on a host gh
/// recognizes or `gh` is missing/unauthenticated/errors. Best-effort; the
/// frontend treats `null` as "no link" and keeps the commit rows inert.
#[tauri::command(async)]
async fn repo_web_url(repo_path: String) -> Result<Option<String>, String> {
    Ok(pr::repo_url_for(&repo_path).await)
}

/// Create a fresh session worktree off `repo_path`'s HEAD (auto-worktree
/// projects). Returns `{ path, branch, base }`; ensures `.worktrees` is gitignored
/// and the branch is unique. `Err` when `repo_path` isn't a git repo or git fails.
#[tauri::command(async)]
fn worktree_create(repo_path: String) -> Result<git::WorktreeCreated, String> {
    git::worktree_create(&repo_path)
}

/// Remove a session worktree (and its branch) only if it's clean — empty
/// `status --porcelain` and zero commits past `base`. Returns `{ removed, reason }`;
/// a kept (dirty / has-commits) worktree is NOT an error. `Err` only on git failure.
#[tauri::command(async)]
fn worktree_remove_if_clean(
    worktree_path: String,
    base: String,
) -> Result<git::WorktreeRemoval, String> {
    git::worktree_remove_if_clean(&worktree_path, &base)
}

/// List the session worktrees under `<repo>/.worktrees/`, each as
/// `{ path, branch, clean }`, for the management UI. Off-repo yields `[]`.
#[tauri::command(async)]
fn worktree_list(repo_path: String) -> Result<Vec<git::WorktreeInfo>, String> {
    Ok(git::worktree_list(&repo_path))
}

/// Explicitly prune a worktree (and its branch), passing `--force` when `force`
/// is true. Used by the management UI. `Err` on git failure.
#[tauri::command(async)]
fn worktree_remove(worktree_path: String, force: bool) -> Result<(), String> {
    git::worktree_remove(&worktree_path, force)
}

/// Return the `pane_id -> [AgentEvent]` timeline for the caller's app panes, used
/// to SEED the overview's event store on mount/resume. For each pane the events
/// come from the in-memory ring (hot cache) first, then the durable per-session
/// sink (`events/<sessionId>.jsonl`) so a `claude --resume` shows its prior
/// timeline, then — for a session predating the event pipeline (no sink) — a
/// completed-tool timeline reconstructed from its transcript. A pane with no
/// session id, or no events anywhere, maps to an empty list.
#[tauri::command]
fn events_for(
    state: State<'_, Arc<EventState>>,
    panes: Vec<PaneRef>,
) -> Result<HashMap<String, Vec<AgentEvent>>, String> {
    let projects_base = activity::projects_base();
    let mut map = HashMap::new();
    for pane in &panes {
        let Some(sid) = pane.session_id.as_deref() else {
            continue;
        };
        let mut timeline = state.ring_for(&pane.pane_id);
        if timeline.is_empty() {
            timeline = state.sink_for(sid);
        }
        if timeline.is_empty() {
            if let Some(base) = projects_base.as_ref() {
                if let Some(transcript) = activity::find_transcript(base, pane) {
                    timeline = events::backfill_from_transcript(&transcript, &pane.pane_id, sid);
                }
            }
        }
        map.insert(pane.pane_id.clone(), timeline);
    }
    Ok(map)
}

/// Route the frontend executor's reply for an orchestration request back to the
/// in-flight control-socket request awaiting `id`. The frontend supplies exactly
/// one of `result` (success JSON) or `error` (a message); `error` wins if both are
/// somehow present. A reply for an unknown / already-timed-out id is a no-op (the
/// originating socket request already gave up), so it never errors. See
/// [`orchestration`].
#[tauri::command]
fn orchestration_reply(
    server: State<'_, Arc<orchestration::ControlServer>>,
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let outcome = match error {
        Some(e) => orchestration::ReplyOutcome::Error(e),
        None => orchestration::ReplyOutcome::Result(result.unwrap_or(serde_json::Value::Null)),
    };
    server.pending().complete(id, outcome);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Decode the image file at `path` and place it on the OS clipboard as an image,
/// so a subsequent Ctrl+V (`0x16`) written into an agent's PTY is ingested as an
/// inline image attachment — the drag-drop-onto-session flow (terminal-file-drop).
/// Decoding to RGBA happens here (the clipboard image is raw pixels, not an
/// encoded blob), which transparently handles non-PNG inputs. Every failure
/// (unreadable file, undecodable/unsupported image, clipboard error) is returned
/// as a string so the frontend can skip that file without crashing the drop.
#[tauri::command]
fn copy_image_to_clipboard(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let rgba = image::open(&path)
        .map_err(|e| format!("decode {path}: {e}"))?
        .to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let img = tauri::image::Image::new_owned(rgba.into_raw(), w, h);
    app.clipboard()
        .write_image(&img)
        .map_err(|e| format!("clipboard write_image: {e}"))
}

pub fn run() {
    // Capture the app launch time (Unix epoch millis) ONCE for this run. The
    // subagents seed/watcher use it to drop subagents that predate this launch
    // (see AppLaunchTime / subagents::filter_pre_launch), so a resumed session
    // does not restore a prior run's now-dead subagents.
    let launch_time_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    tauri::Builder::default()
        // Native dialogs (the session launcher's folder picker uses
        // `open({ directory: true })`). Granted `dialog:allow-open` in
        // capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        // Shell plugin: runs the bundled whisper.cpp `whisper-cli` STT sidecar
        // (voice input, Milestone 4). The sidecar scope is granted in
        // capabilities/default.json (`shell:allow-execute` + the externalBin
        // entry). See src/transcribe.rs.
        .plugin(tauri_plugin_shell::init())
        // Notification plugin: native OS desktop notifications for the needs-input
        // alerts (capability `needs-input-alerts`). The frontend requests permission
        // and posts notifications via @tauri-apps/plugin-notification; the scope is
        // granted by `notification:default` in capabilities/default.json.
        .plugin(tauri_plugin_notification::init())
        // In-app auto-update (desktop-auto-update spec). The updater plugin
        // checks the GitHub Release `latest.json` endpoint (configured in
        // tauri.conf.json `plugins.updater`) and verifies bundles against the
        // committed public key; the process plugin's `relaunch()` restarts the
        // app after an update installs. The launch check + install prompt lives
        // in the frontend (src/lib/updates). Scopes granted by `updater:default`
        // + `process:default` in capabilities/default.json.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Clipboard image write for drag-drop-onto-session (terminal-file-drop):
        // `copy_image_to_clipboard` calls this plugin's Rust API directly, so the
        // frontend never invokes a clipboard IPC command and no clipboard
        // capability is granted.
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Install the statusline wrapper and ensure the snapshots dir exists
            // up front, so sessions can be launched into the dashboard without a
            // first-launch race. Failure is logged but non-fatal — `usage_paths`
            // retries on demand.
            if let Err(e) = install_usage_assets(app.handle()) {
                log::warn!("install_usage_assets failed: {e}");
            }
            // Start watching the snapshots dir and pushing each parsed snapshot
            // to the frontend over `usage://snapshot`. The watcher is held in
            // managed state so it lives for the app's lifetime and is dropped
            // cleanly on exit. Failure is logged but non-fatal — the frontend
            // still seeds the current set via `usage_snapshots` on mount; it
            // simply won't receive live pushes.
            match start_usage_watcher(app.handle()) {
                Ok(watcher) => {
                    app.manage(watcher);
                }
                Err(e) => log::warn!("start_usage_watcher failed: {e}"),
            }
            // Start the subagents watcher over ~/.claude/projects/, sharing the
            // watched-session set with the `subagents_for` command so a session
            // launched after startup begins surfacing its subagents. Held in
            // managed state for the app's lifetime; failure is logged but
            // non-fatal — the frontend still seeds via `subagents_for` and simply
            // won't receive live `overview://subagents` pushes.
            let watched = app.state::<WatchedSessionsState>().0.clone();
            match start_subagents_watcher(app.handle(), watched, launch_time_ms) {
                Ok(watcher) => {
                    app.manage(watcher);
                }
                Err(e) => log::warn!("start_subagents_watcher failed: {e}"),
            }
            // Event pipeline: ALWAYS manage the shared event state (so `events_for`
            // resolves even if the socket can't bind), prune the durable sink on
            // boot, then best-effort start the Unix-socket server that emits each
            // parsed event over `overview://event`. A bind/emit failure is logged
            // but non-fatal — the overview falls back to transcript/PTW signals.
            let events_base = app_data_dir(app.handle())
                .map(|b| b.join(EVENTS_DIR))
                .unwrap_or_else(|_| std::env::temp_dir().join("agent-desktop-events"));
            let event_state = Arc::new(EventState::new(events_base));
            event_state.prune();
            app.manage(event_state.clone());
            if let Ok(base) = app_data_dir(app.handle()) {
                let handle = app.handle().clone();
                match events::start_event_server(&ipc::events_address(&base), event_state, move |ev| {
                    if let Err(e) = handle.emit(EVENT_EVENT, &ev) {
                        log::warn!("emit {EVENT_EVENT} failed: {e}");
                    }
                }) {
                    Ok(server) => {
                        app.manage(server);
                    }
                    Err(e) => log::warn!("start_event_server failed: {e}"),
                }
            }
            // Orchestration control socket: the transport the bundled MCP toolkit
            // adapter uses to round-trip toolkit ops through the frontend executor.
            // Each inbound request is emitted to the frontend over
            // `orchestration://request`; the frontend replies via the
            // `orchestration_reply` command, routed back through the server's pending
            // registry. Held in managed state (so `orchestration_reply` can reach the
            // registry and the listener lives for the app's lifetime). A bind failure
            // is logged but non-fatal — the orchestration toolkit simply won't work.
            if let Ok(base) = app_data_dir(app.handle()) {
                let handle = app.handle().clone();
                match orchestration::start_control_server(
                    &ipc::control_address(&base),
                    move |id, req| {
                        if let Err(e) = handle.emit(
                            orchestration::REQUEST_EVENT,
                            serde_json::json!({ "id": id, "op": req.op, "args": req.args }),
                        ) {
                            log::warn!("emit {} failed: {e}", orchestration::REQUEST_EVENT);
                        }
                    },
                ) {
                    Ok(server) => {
                        app.manage(Arc::new(server));
                    }
                    Err(e) => log::warn!("start_control_server failed: {e}"),
                }
            }
            // Install the native double-tap-right-Command monitor that emits
            // `voice://activate` for the voice panel. Best-effort and macOS-only;
            // a failure is logged inside `start` (the mic button is the fallback).
            voice_activation::start(app.handle().clone());
            Ok(())
        })
        .manage(Arc::new(PtyManager::new()))
        .manage(WatchedSessionsState::default())
        .manage(AppLaunchTime(launch_time_ms))
        // The single transcript-polish llama-server manager (lazy-started by
        // `voice_polish`). Held in managed state so it lives for the app's
        // lifetime and the spawned sidecar is reaped on exit.
        .manage(Arc::new(polish::LlamaServer::default()))
        // The single live-partials whisper-server manager (lazy-started by
        // `voice_transcribe_partial`). Managed so it lives for the app's lifetime
        // and the spawned sidecar is reaped on exit; keeps the tiny model resident.
        .manage(Arc::new(whisper_server::WhisperServer::default()))
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            open_in_editor,
            resolve_path,
            open_path,
            installed_apps,
            default_shell,
            session_focus,
            layout_load,
            layout_save,
            recents_load,
            recents_save,
            projects_load,
            projects_save,
            settings_load,
            settings_save,
            terminals_load,
            terminals_save,
            tasks_load,
            tasks_save,
            tasks_clear,
            terminals_clear,
            specialists_list,
            specialists_read,
            specialists_write,
            specialists_delete,
            project_tasks_load,
            project_tasks_save,
            project_config_load,
            project_config_save,
            usage_paths,
            usage_snapshots,
            subagents_for,
            activity_for,
            git_status_for,
            git_fetch_for,
            git_push,
            git_pull,
            git::commits_to_push,
            git_list_branches,
            git_checkout,
            git_create_branch,
            pr_status_for,
            open_prs_for,
            repo_web_url,
            worktree_create,
            worktree_remove_if_clean,
            worktree_list,
            worktree_remove,
            events_for,
            orchestration_reply,
            notify_click::notify_agent,
            transcribe::voice_transcribe_final,
            transcribe::voice_transcribe_stream,
            models::voice_download_models,
            models::voice_models_status,
            models::voice_models_disk_usage,
            models::voice_delete_models,
            polish::voice_polish,
            whisper_server::voice_transcribe_partial,
            voice_bundled_model_path,
            voice_model_path,
            copy_image_to_clipboard
        ])
        .on_window_event(|window, event| {
            // Kill + reap every pane on app quit so no zombie/orphan processes
            // remain. The LAYOUT flush is coordinated on the frontend: it listens
            // for `tauri://close-requested`, writes the latest state via
            // `layout_save`, then closes the window — so by the time this handler
            // runs (and kills the PTYs) the layout file is already persisted.
            if let WindowEvent::CloseRequested { .. } = event {
                let manager = window.state::<Arc<PtyManager>>();
                manager.kill_all();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A throwaway dir under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("agentdesk-{tag}-{nanos}"));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn open_args_builds_per_app_and_root_combination() {
        // No app → OS default handler gets just the path.
        assert_eq!(open_args("/p/a.ts", None, None), vec!["/p/a.ts"]);
        // App, no workspace root → open the file with that app.
        assert_eq!(
            open_args("/p/a.ts", Some("Cursor"), None),
            vec!["-a", "Cursor", "/p/a.ts"]
        );
        // App + workspace root → open the project folder, then reveal the file.
        assert_eq!(
            open_args("/p/sub/a.ts", Some("Cursor"), Some("/p")),
            vec!["-a", "Cursor", "/p", "/p/sub/a.ts"]
        );
        // A root with no app can't target a workspace → ignored.
        assert_eq!(open_args("/p/a.ts", None, Some("/p")), vec!["/p/a.ts"]);
    }

    #[test]
    fn path_within_checks_containment_with_canonicalization() {
        let tmp = TempDir::new("within");
        let root = tmp.path();
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let file = sub.join("a.ts");
        fs::write(&file, "x").unwrap();

        // A file under the root (even nested) is contained.
        assert!(path_within(
            root.to_str().unwrap(),
            file.to_str().unwrap()
        ));
        // The root itself counts as within.
        assert!(path_within(root.to_str().unwrap(), root.to_str().unwrap()));
        // A sibling directory outside the root is not contained.
        let other = TempDir::new("within-other");
        let outside = other.path().join("b.ts");
        fs::write(&outside, "y").unwrap();
        assert!(!path_within(
            root.to_str().unwrap(),
            outside.to_str().unwrap()
        ));
        // A non-existent path (canonicalize fails) is not contained.
        assert!(!path_within(
            root.to_str().unwrap(),
            sub.join("missing.ts").to_str().unwrap()
        ));
    }

    #[test]
    fn an_app_in_a_standard_directory_is_detected() {
        let tmp = TempDir::new("apps");
        let apps = tmp.path().join("Applications");
        fs::create_dir_all(apps.join("Cursor.app")).unwrap();
        let roots: Vec<&str> = vec![apps.to_str().unwrap()];
        let names = vec!["Cursor".to_string(), "Zed".to_string()];
        // Only the app whose bundle exists is reported, order preserved.
        assert_eq!(detect_installed(&names, "", &roots), vec!["Cursor".to_string()]);
    }

    #[test]
    fn an_absent_app_is_not_detected() {
        let tmp = TempDir::new("apps-empty");
        let apps = tmp.path().join("Applications");
        fs::create_dir_all(&apps).unwrap();
        let roots: Vec<&str> = vec![apps.to_str().unwrap()];
        let names = vec!["Cursor".to_string()];
        assert!(detect_installed(&names, "", &roots).is_empty());
    }

    #[test]
    fn finder_is_detected_under_core_services() {
        // Finder lives under /System/Library/CoreServices, so the candidate paths
        // must include that root for it to be found.
        let paths = app_bundle_paths("Finder", "/Users/x", APP_ROOTS);
        assert!(paths
            .iter()
            .any(|p| p.ends_with("System/Library/CoreServices/Finder.app")));
        // The HOME-relative `~/Applications` root is expanded against `home`.
        assert!(paths
            .iter()
            .any(|p| *p == PathBuf::from("/Users/x/Applications/Finder.app")));
    }

    #[test]
    fn clean_title_takes_first_nonempty_line_and_strips_decoration() {
        assert_eq!(clean_title("\n  \"Fix login bug\".  \n", ""), "Fix login bug");
        assert_eq!(
            clean_title("Improve frontend dialog handling\nextra line", ""),
            "Improve frontend dialog handling"
        );
    }

    #[test]
    fn clean_title_drops_think_blocks() {
        // The ticket id is in `source`, so it is kept (a real reference).
        assert_eq!(
            clean_title(
                "<think>let me reason\nabout this</think>\nPROJ-45: Fix login feature",
                "Messages:\n- fix PROJ-45 the login feature"
            ),
            "PROJ-45: Fix login feature"
        );
        // Case-insensitive tag, title on the same trailing segment.
        assert_eq!(
            clean_title("<THINK>hmm</THINK> Add dark mode", ""),
            "Add dark mode"
        );
        // Unterminated think block → no title leaks out.
        assert_eq!(clean_title("<think>never closes", ""), "");
    }

    #[test]
    fn strip_think_blocks_handles_multibyte_before_tag_without_panic() {
        // `İ` (U+0130) lowercases to TWO code points, so byte offsets found in a
        // `to_lowercase()` copy would drift off `s` — these used to panic / corrupt.
        // Offsets must stay valid for the original string.
        assert_eq!(strip_think_blocks("İ<think>x</think>Y"), "İY");
        assert_eq!(strip_think_blocks("İİ<think>x</think>Z"), "İİZ");
        // A multi-byte char INSIDE the reasoning block is dropped with it.
        assert_eq!(
            clean_title("<think>İİİ reasoning</think>\nFix the café page", ""),
            "Fix the café page"
        );
    }

    #[test]
    fn clean_title_clips_to_60_chars() {
        let long = "a".repeat(100);
        assert_eq!(clean_title(&long, "").chars().count(), 60);
    }

    #[test]
    fn clean_title_empty_for_blank_input() {
        assert_eq!(clean_title("", ""), "");
        assert_eq!(clean_title("   \n  ", ""), "");
    }

    #[test]
    fn clean_title_strips_phantom_ticket_absent_from_source() {
        // The model invented a ticket id; the session referenced none → drop it.
        assert_eq!(
            clean_title("PROJ-45: Fix login", "Messages:\n- please fix the login"),
            "Fix login"
        );
        assert_eq!(
            clean_title("#45: Add dark mode", "Messages:\n- add a dark mode"),
            "Add dark mode"
        );
        // No colon, just whitespace, still stripped.
        assert_eq!(
            clean_title("ENG-12 Refactor parser", "Messages:\n- refactor the parser"),
            "Refactor parser"
        );
    }

    #[test]
    fn clean_title_keeps_real_ticket_in_source() {
        // Id genuinely present in the user's messages → keep verbatim.
        assert_eq!(
            clean_title("PROJ-45: Fix login", "Messages:\n- work on PROJ-45 login"),
            "PROJ-45: Fix login"
        );
        // Case-insensitive match against the source.
        assert_eq!(
            clean_title("ENG-7: Cache layer", "Messages:\n- start eng-7"),
            "ENG-7: Cache layer"
        );
        assert_eq!(
            clean_title("#9: Crash on boot", "Messages:\n- see #9"),
            "#9: Crash on boot"
        );
    }

    #[test]
    fn strip_phantom_ticket_boundary_checks() {
        // A different number in source must not count as the title's id.
        assert_eq!(
            strip_phantom_ticket("#45: Foo", "issue #456 here"),
            "Foo"
        );
        assert_eq!(
            strip_phantom_ticket("PROJ-45: Foo", "see PROJ-456"),
            "Foo"
        );
        assert_eq!(
            strip_phantom_ticket("PROJ-45: Foo", "see MYPROJ-45"),
            "Foo"
        );
        // Exact match (not a longer number) is kept.
        assert_eq!(
            strip_phantom_ticket("#45: Foo", "issue #45 here"),
            "#45: Foo"
        );
    }

    #[test]
    fn ticket_issue_numbers_of_any_length() {
        // Issue numbers vary in length — #1, #456, #4567 are all valid and parse.
        assert_eq!(split_leading_ticket("#1: Crash"), Some(("#1", "Crash")));
        assert_eq!(split_leading_ticket("#456: Crash"), Some(("#456", "Crash")));
        assert_eq!(split_leading_ticket("#4567: Crash"), Some(("#4567", "Crash")));

        // Each is kept when it actually appears in the source...
        assert_eq!(clean_title("#1: Crash", "Messages:\n- see #1"), "#1: Crash");
        assert_eq!(
            clean_title("#4567: Crash", "Messages:\n- see #4567"),
            "#4567: Crash"
        );

        // ...and a different-length number in the source is NOT a match (boundary
        // check both directions): #456 is neither a prefix nor a superset hit of #4567.
        assert_eq!(strip_phantom_ticket("#456: Foo", "see #4567"), "Foo");
        assert_eq!(strip_phantom_ticket("#4567: Foo", "see #456"), "Foo");
        assert_eq!(strip_phantom_ticket("#1: Foo", "see #12"), "Foo");
    }

    #[test]
    fn split_leading_ticket_recognizes_and_rejects() {
        assert_eq!(split_leading_ticket("PROJ-45: Fix"), Some(("PROJ-45", "Fix")));
        assert_eq!(split_leading_ticket("#45 Fix"), Some(("#45", "Fix")));
        assert_eq!(split_leading_ticket("AB-1: x"), Some(("AB-1", "x")));
        // Not tickets: single-letter key, no digits, bare '#', plain words.
        assert_eq!(split_leading_ticket("I-9 form"), None);
        assert_eq!(split_leading_ticket("CI-CD pipeline"), None);
        assert_eq!(split_leading_ticket("# heading"), None);
        assert_eq!(split_leading_ticket("Improve dialog handling"), None);
    }

    #[test]
    fn install_writes_executable_wrapper_and_creates_snapshot_dir() {
        let tmp = TempDir::new("install");
        let paths = install_usage_assets_in(tmp.path()).unwrap();

        // Both returned paths are absolute and exist.
        let wrapper = PathBuf::from(&paths.wrapper_path);
        let snapshots = PathBuf::from(&paths.snapshot_dir);
        assert!(wrapper.is_absolute(), "wrapper path must be absolute");
        assert!(snapshots.is_absolute(), "snapshot dir must be absolute");
        assert!(wrapper.is_file(), "wrapper file must exist");
        assert!(snapshots.is_dir(), "snapshot dir must exist");

        // Installed under <base>/bin/statusline-wrapper.js and is the baked source.
        assert_eq!(wrapper, tmp.path().join(BIN_DIR).join(WRAPPER_FILE));
        assert_eq!(snapshots, tmp.path().join(SNAPSHOT_DIR));
        let installed = fs::read_to_string(&wrapper).unwrap();
        assert_eq!(installed, STATUSLINE_WRAPPER_SRC);
        assert!(
            installed.starts_with("#!/usr/bin/env node"),
            "wrapper keeps its node shebang"
        );

        // Executable bit set (0755) on Unix.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&wrapper).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "wrapper must be mode 0755");
        }

        // No leftover temp file from the atomic write.
        assert!(!tmp
            .path()
            .join(BIN_DIR)
            .join("statusline-wrapper.js.tmp")
            .exists());

        // The event hook is installed beside the wrapper (same baked-source +
        // shebang + 0755 contract) and the durable events dir + socket path are
        // returned, so the event pipeline is wired at spawn.
        let hook = PathBuf::from(&paths.event_hook_path);
        assert_eq!(hook, tmp.path().join(BIN_DIR).join(EVENT_HOOK_FILE));
        assert!(hook.is_file(), "event hook must exist");
        let hook_src = fs::read_to_string(&hook).unwrap();
        assert_eq!(hook_src, EVENT_HOOK_SRC);
        assert!(hook_src.starts_with("#!/usr/bin/env node"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&hook).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "event hook must be mode 0755");
        }
        // The exported socket ADDRESS must be exactly what the event server binds
        // for the same app-data root — asserting the raw PATH here instead is what
        // let the Windows divergence (pipe name vs path) pass CI while the event
        // pipeline was dead.
        assert_eq!(
            paths.socket_path,
            crate::ipc::events_address(tmp.path())
        );
        // On Unix that address IS the filesystem path, unchanged.
        #[cfg(unix)]
        assert_eq!(
            PathBuf::from(&paths.socket_path),
            tmp.path().join(crate::ipc::EVENTS_SOCKET_FILE)
        );
        assert!(
            tmp.path().join(EVENTS_DIR).is_dir(),
            "events dir must exist"
        );

        // The orchestration MCP adapter is installed beside the wrapper (same baked
        // source + shebang + 0755 contract) and the control socket path (sibling of
        // the events socket) is returned for the coordinator's --mcp-config server.
        let adapter = PathBuf::from(&paths.adapter_path);
        assert_eq!(adapter, tmp.path().join(BIN_DIR).join(ORCHESTRATION_MCP_FILE));
        assert!(adapter.is_file(), "orchestration adapter must exist");
        let adapter_src = fs::read_to_string(&adapter).unwrap();
        assert_eq!(adapter_src, ORCHESTRATION_MCP_SRC);
        assert!(adapter_src.starts_with("#!/usr/bin/env node"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&adapter).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "adapter must be mode 0755");
        }
        assert_eq!(
            paths.control_socket_path,
            crate::ipc::control_address(tmp.path())
        );
        #[cfg(unix)]
        assert_eq!(
            PathBuf::from(&paths.control_socket_path),
            tmp.path().join(crate::ipc::CONTROL_SOCKET_FILE)
        );
        // The two sockets must never resolve to the same address on any platform.
        assert_ne!(paths.socket_path, paths.control_socket_path);
    }

    /// THE invariant the Windows port hinges on: the address a session is told to
    /// connect to must be exactly the address the server binds.
    ///
    /// This is asserted against the LIVE servers rather than by recomputing the
    /// expression, because the original bug was precisely that `install_usage_assets_in`
    /// computed a different value (the raw path) from what `start_event_server`
    /// bound (a pipe name on Windows) — and every existing test passed while the
    /// event pipeline and the whole orchestration toolkit were silently dead.
    #[test]
    fn exported_socket_addresses_match_what_the_servers_bind() {
        let tmp = TempDir::new("addrmatch");
        let paths = install_usage_assets_in(tmp.path()).unwrap();

        let state = std::sync::Arc::new(crate::events::EventState::new(
            tmp.path().join(EVENTS_DIR),
        ));
        let event_server =
            crate::events::start_event_server(&crate::ipc::events_address(tmp.path()), state, |_| {})
                .unwrap();
        assert_eq!(
            paths.socket_path,
            event_server.address(),
            "AGENT_DESKTOP_SOCKET_PATH must equal the bound event-socket address"
        );

        let control_server =
            crate::orchestration::start_control_server(&crate::ipc::control_address(tmp.path()), |_, _| {})
                .unwrap();
        assert_eq!(
            paths.control_socket_path,
            control_server.address(),
            "AGENT_DESKTOP_CONTROL_SOCKET must equal the bound control-socket address"
        );

        // And a client can actually reach the event socket at the exported address
        // — the step the hook performs, which returned ENOENT on Windows before.
        assert!(
            crate::ipc::connect(&paths.socket_path).is_ok(),
            "a client must be able to connect at the exported address"
        );

        drop(event_server);
        drop(control_server);
    }

    #[test]
    fn install_is_idempotent_and_rewrites_wrapper() {
        let tmp = TempDir::new("idempotent");
        let first = install_usage_assets_in(tmp.path()).unwrap();

        // Clobber the installed wrapper, then re-install: it is rewritten verbatim.
        fs::write(&first.wrapper_path, "stale contents").unwrap();
        let second = install_usage_assets_in(tmp.path()).unwrap();

        assert_eq!(first.wrapper_path, second.wrapper_path);
        assert_eq!(first.snapshot_dir, second.snapshot_dir);
        assert_eq!(
            fs::read_to_string(&second.wrapper_path).unwrap(),
            STATUSLINE_WRAPPER_SRC
        );
    }

    // --- deslugify (salvage a model-copied slug into spaced words) -----------

    #[test]
    fn deslugify_converts_a_bare_slug_to_spaced_sentence_case() {
        assert_eq!(deslugify("footer-branch-switcher"), "Footer branch switcher");
        assert_eq!(deslugify("hide-agents-panel"), "Hide agents panel");
        assert_eq!(deslugify("add-csv-export-2"), "Add csv export 2");
    }

    #[test]
    fn deslugify_leaves_real_titles_untouched() {
        // Already spaced → not a slug.
        assert_eq!(deslugify("Fix the login bug"), "Fix the login bug");
        // Has a space around the hyphen → not a slug.
        assert_eq!(deslugify("Title fallback to claude-p with haiku"),
                   "Title fallback to claude-p with haiku");
        // Single hyphenless word → not a slug.
        assert_eq!(deslugify("Refactor"), "Refactor");
        // Uppercase present (e.g. a ticket title) → not a bare lowercase slug.
        assert_eq!(deslugify("PROJ-45"), "PROJ-45");
        // A single hyphenated pair is still salvaged.
        assert_eq!(deslugify("drag-drop"), "Drag drop");
    }

    #[test]
    fn clean_title_deslugifies_a_copied_change_name() {
        // The model copied the OpenSpec change slug verbatim; no ticket in source.
        assert_eq!(
            clean_title("footer-branch-switcher", "Messages:\n- change the branch from the footer"),
            "Footer branch switcher"
        );
    }

    // --- clip_title (word-boundary 60-char clip) -----------------------------

    #[test]
    fn clip_title_backs_off_to_a_word_boundary() {
        let s = "Adjust archived panel order to show the most recent items first";
        let out = clip_title(s, 60);
        assert!(out.chars().count() <= 60);
        assert!(!out.ends_with(' '));
        // Ends on a whole word (no mid-word cut).
        assert!(s.starts_with(&out));
        assert!(out.split(' ').last().unwrap().len() >= 1);
    }

    #[test]
    fn clip_title_hard_cuts_a_single_overlong_word() {
        let s = "a".repeat(100);
        assert_eq!(clip_title(&s, 60).chars().count(), 60);
    }

    #[test]
    fn clip_title_short_unchanged() {
        assert_eq!(clip_title("Fix login bug", 60), "Fix login bug");
    }

    // --- clip_message (beginning + ellipsis + end truncation) ----------------

    #[test]
    fn clip_message_short_message_returned_unchanged() {
        assert_eq!(clip_message("fix the bug", 200), "fix the bug");
        assert_eq!(clip_message("a".repeat(200).as_str(), 200), "a".repeat(200));
    }

    #[test]
    fn clip_message_long_message_shows_beginning_and_end() {
        // 210 chars → 200 max: head = (200-1)/2 = 99, tail = 200-99-1 = 100.
        let input = "a".repeat(105) + &"b".repeat(105);
        let clipped = clip_message(&input, 200);
        // Total chars = 200 (99 head + "…" + 100 tail).
        assert_eq!(clipped.chars().count(), 200);
        // Starts with the beginning and ends with the tail.
        assert!(clipped.starts_with("aaaa"), "should start with head");
        assert!(clipped.ends_with("bbbb"), "should end with tail");
        assert!(clipped.contains('…'), "must contain the ellipsis separator");
    }

    #[test]
    fn clip_message_normalises_whitespace() {
        // Multiple spaces / newlines are collapsed before clipping.
        assert_eq!(clip_message("fix   the\nbug", 200), "fix the bug");
    }

    #[test]
    fn clip_message_zero_max_returns_empty() {
        assert_eq!(clip_message("hello", 0), "");
    }

    #[test]
    fn clip_message_multibyte_respected() {
        // "…" (U+2026) is one char; ensure the count is in chars, not bytes.
        let input = "é".repeat(210);
        let clipped = clip_message(&input, 200);
        assert_eq!(clipped.chars().count(), 200);
        assert!(clipped.contains('…'));
    }

    // --- select_title_messages (HEAD + TAIL message budget) -----------------

    fn owned(strs: &[&str]) -> Vec<String> {
        strs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn select_title_messages_keeps_all_for_a_short_session() {
        // len <= max → every message is included, in order, none dropped.
        let msgs = owned(&["first request", "follow up", "another tweak"]);
        let picked = select_title_messages(&msgs, 20, 8);
        assert_eq!(picked, vec!["first request", "follow up", "another tweak"]);
    }

    #[test]
    fn select_title_messages_long_session_always_keeps_the_earliest() {
        // 30 messages, budget 20 (head 8 + tail 12). The ORIGINAL request (index 0)
        // must survive — that is the whole point: recency must not drop it.
        let raw: Vec<String> = (0..30).map(|i| format!("m{i}")).collect();
        let picked = select_title_messages(&raw, 20, 8);
        assert_eq!(picked.len(), 20);
        // The earliest message is always the first selected.
        assert_eq!(picked[0], "m0");
        // The first HEAD messages are the earliest ones, in order.
        assert_eq!(&picked[..8], &["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7"]);
        // The TAIL is the most recent (max - head = 12) messages, in order.
        assert_eq!(picked[8], "m18");
        assert_eq!(picked[19], "m29");
    }

    #[test]
    fn select_title_messages_preserves_chronological_order() {
        let raw: Vec<String> = (0..50).map(|i| format!("m{i}")).collect();
        let picked = select_title_messages(&raw, 20, 8);
        // Map each selected message back to its original index; indices must be
        // strictly increasing (chronological order preserved, no reordering).
        let idxs: Vec<usize> = picked
            .iter()
            .map(|p| p.trim_start_matches('m').parse::<usize>().unwrap())
            .collect();
        assert!(idxs.windows(2).all(|w| w[0] < w[1]), "indices must increase: {idxs:?}");
    }

    #[test]
    fn select_title_messages_dedupes_overlapping_head_and_tail_windows() {
        // The head window is the first `head` messages; the tail window is the last
        // `max - head` messages. When `head` is large relative to `max` the two
        // windows can overlap on the same indices — the helper must take the union
        // (each message at most once) and keep chronological order.
        //
        // 7 messages, max 6, head 5: head=[m0..m4], tail=last (6-5)=1=[m6]. The
        // value "m4" appears only in the head; nothing is duplicated.
        let seven = owned(&["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
        let picked = select_title_messages(&seven, 6, 5);
        assert_eq!(picked, vec!["m0", "m1", "m2", "m3", "m4", "m6"]);

        // True index overlap: identical message text repeated and a head window that
        // reaches into the tail window. 6 messages, max 8 > len → keep-all path, but
        // verify the union dedup never doubles a message even if a head index also
        // falls in the tail window. Use repeated text to prove de-dup is by index,
        // not by value: head still keeps each position once.
        let dup = owned(&["x", "x", "x", "x", "x", "x"]);
        // len 6 <= max 8 → keep all 6 positions (repeated text is fine; positions
        // are distinct), proving no spurious extra copies are appended.
        assert_eq!(select_title_messages(&dup, 8, 5).len(), 6);

        // Overlapping windows by index: 5 messages, max 5, head 4 → head=[m0..m3],
        // tail=last (5-4)=1=[m4]; union is all 5, each once, in order.
        let five = owned(&["m0", "m1", "m2", "m3", "m4"]);
        assert_eq!(
            select_title_messages(&five, 5, 4),
            vec!["m0", "m1", "m2", "m3", "m4"]
        );

        // No value is duplicated in the truncating path either.
        let raw: Vec<String> = (0..40).map(|i| format!("m{i}")).collect();
        let p = select_title_messages(&raw, 20, 8);
        let mut sorted = p.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), p.len(), "no message may appear twice");
    }
}
