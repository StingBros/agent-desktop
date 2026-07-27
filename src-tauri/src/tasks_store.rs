//! Per-project on-disk store for the COORDINATOR TASK BOARD (add-coordinator-task-
//! backchannel, task group 2). Persists the board snapshot to
//! `<project_path>/.agent-desktop/coordinator-tasks.json` and writes large Task
//! results as artifacts under `<project_path>/.agent-desktop/artifacts/<taskId>/`.
//!
//! This mirrors [`crate::project_store`] exactly:
//!
//!   1. A PURE core over a given `project_path: &Path` — path resolution and the
//!      load/save operations — testable WITHOUT Tauri (temp-dir tests below).
//!   2. Thin `#[tauri::command]` wrappers (in `lib.rs`) over that core.
//!
//! The board core traffics in RAW JSON STRINGS (it never parses the document
//! itself — the frontend owns the Task shape, `tasks.ts`). A missing file/dir is
//! reported as `Ok(None)`, and writes use the ATOMIC sibling-temp-file + rename
//! pattern shared with [`crate::project_store::save_file`] and the statusline
//! snapshot, so a crash mid-write never leaves a truncated file (design D1).
//!
//! The artifacts writer (design D7 — "Results and artifacts are stored by
//! reference") persists an out-of-band result and returns the POSIX-style,
//! project-root-relative path the frontend records on the Task (matching
//! `artifactRelPath` in `tasks.ts`).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The board snapshot file name, sibling of `tasks.json` / `config.json`.
const BOARD_FILE: &str = "coordinator-tasks.json";

/// The `.agent-desktop/` directory under a project path.
fn agent_desktop_dir(project_path: &Path) -> PathBuf {
    project_path.join(".agent-desktop")
}

/// Reject a `name` that is not a safe single path component (could escape the
/// artifacts dir): empty, or containing a path separator or `..`. Returns the
/// trimmed name when safe. Mirrors `safe_component` in [`crate::specialists`].
fn safe_component(name: &str) -> Option<&str> {
    let t = name.trim();
    if t.is_empty() || t.contains('/') || t.contains('\\') || t.contains("..") {
        None
    } else {
        Some(t)
    }
}

/// Load the raw board JSON at `<project_path>/.agent-desktop/coordinator-tasks.json`,
/// or `Ok(None)` when the file (or the `.agent-desktop/` dir) does not exist yet — an
/// absent file means the board is empty (spec: "Absent file is an empty board"). Any
/// other IO error is surfaced so the frontend can fall back rather than crash.
pub fn load_board(project_path: &Path) -> Result<Option<String>, String> {
    let path = agent_desktop_dir(project_path).join(BOARD_FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

/// Atomically persist the board JSON to `<project_path>/.agent-desktop/coordinator-
/// tasks.json`, creating the `.agent-desktop/` dir if needed. Uses an ATOMIC write
/// (sibling temp file + rename), mirroring [`crate::project_store::save_file`]. `Err`
/// when any IO step fails.
pub fn save_board(project_path: &Path, json: &str) -> Result<(), String> {
    let dir = agent_desktop_dir(project_path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    let path = dir.join(BOARD_FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))?;
    Ok(())
}

/// Persist a Task result artifact to `<project_path>/.agent-desktop/artifacts/<task_id>/
/// <name>` (default name `result.md`), creating the per-Task dir as needed, and return
/// the POSIX-style, PROJECT-ROOT-RELATIVE path the frontend records on the Task
/// (`.agent-desktop/artifacts/<task_id>/<name>`) — matching `artifactRelPath` in
/// `tasks.ts`. The write is ATOMIC (sibling temp file + rename). `task_id` and `name`
/// must be safe single path components (no separators, no `..`); an unsafe value is
/// rejected BEFORE touching the filesystem (design D7 fail-closed).
pub fn write_artifact(
    project_path: &Path,
    task_id: &str,
    name: Option<&str>,
    content: &str,
) -> Result<String, String> {
    let task_id = safe_component(task_id).ok_or_else(|| format!("unsafe task id: {task_id:?}"))?;
    // Default + normalize the file name exactly like `artifactRelPath` in `tasks.ts`:
    // an empty/whitespace name falls back to `result.md`.
    let file = match name {
        Some(n) if !n.trim().is_empty() => {
            safe_component(n).ok_or_else(|| format!("unsafe artifact name: {n:?}"))?
        }
        _ => "result.md",
    };

    let dir = agent_desktop_dir(project_path)
        .join("artifacts")
        .join(task_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    let path = dir.join(file);
    // Sibling temp file in the same dir so the rename stays on one filesystem.
    let tmp = dir.join(format!("{file}.tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("write {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename {tmp:?} -> {path:?}: {e}"))?;

    // Return the stored reference with forward slashes always (it's a portable
    // reference, not an OS path) — identical to the frontend `artifactRelPath`.
    Ok(format!(".agent-desktop/artifacts/{task_id}/{file}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A monotonic per-test counter, combined with the process id, for a unique
    /// temp subdir per test WITHOUT pulling in `rand`. Mirrors [`crate::project_store`].
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("agentdesk-tasksstore-{tag}-{}-{n}", process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const BOARD_JSON: &str =
        r#"{"tasks":[{"id":"T1","goal":"Research","state":"assigned"},{"id":"T2","goal":"Build","state":"working"}]}"#;

    /// Loading a board from a project with no `.agent-desktop/` dir yields `None`
    /// (an empty board), not an error. (Spec: "Absent file is an empty board".)
    #[test]
    fn load_missing_board_is_none() {
        let tmp = TempDir::new("missing");
        assert_eq!(load_board(tmp.path()).unwrap(), None);
    }

    /// Save-then-load round-trips the EXACT board JSON string. (Spec: "Board
    /// persists across restart".)
    #[test]
    fn save_then_load_board_round_trip() {
        let tmp = TempDir::new("roundtrip");
        save_board(tmp.path(), BOARD_JSON).unwrap();
        assert_eq!(load_board(tmp.path()).unwrap().as_deref(), Some(BOARD_JSON));
    }

    /// Saving creates `.agent-desktop/` and lands the file at coordinator-tasks.json,
    /// and the atomic write leaves NO `.json.tmp` sibling behind.
    #[test]
    fn save_creates_dir_and_leaves_no_temp() {
        let tmp = TempDir::new("createdir");
        let dir = agent_desktop_dir(tmp.path());
        assert!(!dir.exists(), "agent-desktop dir absent before save");
        save_board(tmp.path(), BOARD_JSON).unwrap();
        assert!(dir.join(BOARD_FILE).is_file(), "board file present");
        assert!(
            !dir.join("coordinator-tasks.json.tmp").exists(),
            "no temp file left after atomic rename"
        );
    }

    /// The artifact writer creates the per-Task dir, defaults the name to
    /// `result.md`, writes the content, and returns the POSIX relative path that
    /// matches `artifactRelPath` in `tasks.ts`.
    #[test]
    fn write_artifact_default_name_returns_rel_path() {
        let tmp = TempDir::new("artifact-default");
        let rel = write_artifact(tmp.path(), "T3", None, "# big result\n").unwrap();
        assert_eq!(rel, ".agent-desktop/artifacts/T3/result.md");
        let abs = tmp.path().join(".agent-desktop").join("artifacts").join("T3").join("result.md");
        assert_eq!(std::fs::read_to_string(abs).unwrap(), "# big result\n");
    }

    /// A blank/whitespace name also falls back to `result.md` (matching the
    /// frontend boundary), and an explicit name is honored.
    #[test]
    fn write_artifact_named_and_blank_fallback() {
        let tmp = TempDir::new("artifact-named");
        let rel = write_artifact(tmp.path(), "T4", Some("summary.md"), "hi").unwrap();
        assert_eq!(rel, ".agent-desktop/artifacts/T4/summary.md");
        let blank = write_artifact(tmp.path(), "T4", Some("   "), "x").unwrap();
        assert_eq!(blank, ".agent-desktop/artifacts/T4/result.md");
    }

    /// Full board round-trip AND artifact write in one project: save board -> load
    /// board equals, and the artifact write returns the correct relative path (task
    /// 2.2 integration test).
    #[test]
    fn board_round_trip_and_artifact_write() {
        let tmp = TempDir::new("integration");
        save_board(tmp.path(), BOARD_JSON).unwrap();
        assert_eq!(load_board(tmp.path()).unwrap().as_deref(), Some(BOARD_JSON));
        let rel = write_artifact(tmp.path(), "T1", Some("result.md"), "done").unwrap();
        assert_eq!(rel, ".agent-desktop/artifacts/T1/result.md");
        // Board file untouched by the artifact write.
        assert_eq!(load_board(tmp.path()).unwrap().as_deref(), Some(BOARD_JSON));
    }

    /// Unsafe task ids / names are rejected BEFORE any filesystem work (fail-closed,
    /// design D7) — no artifacts dir is created for a rejected write.
    #[test]
    fn unsafe_task_id_or_name_is_rejected() {
        let tmp = TempDir::new("unsafe");
        for bad_id in ["../evil", "a/b", "a\\b", "..", "  ", ""] {
            assert!(write_artifact(tmp.path(), bad_id, None, "x").is_err(), "id {bad_id:?}");
        }
        for bad_name in ["../evil", "a/b", "a\\b", ".."] {
            assert!(
                write_artifact(tmp.path(), "T9", Some(bad_name), "x").is_err(),
                "name {bad_name:?}"
            );
        }
        assert!(
            !agent_desktop_dir(tmp.path()).join("artifacts").join("T9").exists(),
            "no dir created for rejected writes"
        );
    }
}
