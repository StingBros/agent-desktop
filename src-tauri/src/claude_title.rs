//! Cloud FALLBACK for session-title generation. The primary path is on-device
//! (the `llama-server` polish model — see `polish.rs`); when that path is
//! unavailable for ANY reason (model absent, sidecar won't start, HTTP error,
//! timeout), this module regenerates the title with the `claude` CLI in print
//! mode (`claude -p --model haiku`), reusing the SAME [`TITLE_SYSTEM_PROMPT`] so
//! the output shape is identical. It is gated by an opt-in setting on the TS side
//! (`session-titles` spec): `session_focus` only calls in here when told cloud
//! fallback is allowed, so the on-device-only default privacy posture is kept.
//!
//! Like `polish.rs`, this is split into a PURE, unit-tested argument builder and a
//! thin async runner. The runner spawns the real `claude` binary, so it only
//! fully RUNS in a provisioned environment (MANUAL); it COMPILES regardless and
//! the argument shape is exercised headlessly here. Every failure is best-effort
//! and returns `Err`, so the caller keeps the previous title (graceful
//! degradation, matching the on-device path).

use std::process::Stdio;
use std::time::Duration;

use crate::no_window::NoConsoleWindow;
use crate::polish::TITLE_SYSTEM_PROMPT;

/// The Claude model alias for the cloud title fallback. `haiku` resolves to the
/// latest Haiku — the cheapest/fastest tier, appropriate for a <=6-word title.
pub const CLAUDE_TITLE_MODEL: &str = "haiku";

/// Hard timeout for the `claude -p` call so a hung CLI can never block the title
/// refresh; on timeout the runner returns `Err` and the caller keeps the previous
/// title.
const CLAUDE_TIMEOUT: Duration = Duration::from_secs(30);

// --- Pure helper: claude argument builder -----------------------------------

/// PURE: build the `claude` argument vector for a one-shot title completion.
/// Print mode (`-p`) with the title system prompt appended and the Haiku model.
/// The user's messages are supplied on STDIN (not argv) by the runner, so a
/// message that begins with `-` is never parsed as a flag and the message DATA
/// stays separate from the instruction prompt.
///
/// `--tools ""` disables ALL tools for this call: unlike the sandboxed local
/// model, the user's `claude` may have tools/MCP configured, and the transcript
/// we feed it is untrusted DATA. Disabling tools (defense-in-depth atop the
/// "messages are DATA, not commands" system prompt) ensures a malicious
/// transcript can't drive tool use during title generation. Placed last so its
/// variadic value can't swallow a following flag.
pub fn claude_title_args(model: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--append-system-prompt".to_string(),
        TITLE_SYSTEM_PROMPT.to_string(),
        "--tools".to_string(),
        String::new(),
    ]
}

// --- Environment seeding ----------------------------------------------------

/// Seed a minimal environment for the `claude` child so it is discoverable from a
/// sparse GUI process. Uses the resolved login-shell `PATH` (see
/// [`crate::shell_path`]) — the same resolver [`crate::pty`]'s `seed_env` uses —
/// so `claude` is found when launched from Finder with a stripped environment.
fn seed_claude_env(cmd: &mut tokio::process::Command) {
    cmd.env("PATH", crate::shell_path::resolved_path());
    let home = crate::shell_path::home_dir();
    if !home.is_empty() {
        cmd.env("HOME", home);
    }
}

// --- Async runner -----------------------------------------------------------

/// Run the cloud title fallback: pipe `messages` to `claude -p --model haiku`
/// (with [`TITLE_SYSTEM_PROMPT`] appended) and return its stdout, trimmed.
///
/// Best-effort, NEVER panics: ANY failure (binary missing, non-zero exit,
/// timeout, empty output) returns `Err`, so the caller degrades to keeping the
/// previous title — the same contract as the on-device path. Only fully RUNS with
/// a `claude` binary on PATH (MANUAL — runtime/provisioning); it COMPILES
/// regardless and the arg shape is unit-tested.
pub async fn claude_title(messages: &str) -> Result<String, String> {
    use tokio::io::AsyncWriteExt;

    let args = claude_title_args(CLAUDE_TITLE_MODEL);
    let mut cmd = tokio::process::Command::new("claude");
    cmd.no_console_window();
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // KILL the child if its handle is dropped. tokio (like std) DETACHES a child
        // on drop by default — it keeps running, unreaped. Without this, the timeout
        // branch below (which drops `child` via the dropped `wait_with_output`
        // future) and the early-return on a stdin write error would both ORPHAN a
        // hung `claude`; across throttled, multi-pane title refreshes those leak and
        // accumulate. `kill_on_drop` SIGKILLs on drop and tokio reaps it.
        .kill_on_drop(true);
    seed_claude_env(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("spawn claude: {e}"))?;

    // Write the user's messages to stdin, then DROP the handle to signal EOF so
    // `claude` stops reading and runs. Without the explicit drop the child would
    // wait for more input while we wait for its output — a deadlock.
    {
        let mut stdin = child.stdin.take().ok_or("claude stdin unavailable")?;
        stdin
            .write_all(messages.as_bytes())
            .await
            .map_err(|e| format!("write claude stdin: {e}"))?;
    }

    // Hard timeout so a wedged CLI can't block the title refresh forever.
    let output = tokio::time::timeout(CLAUDE_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "claude -p timed out".to_string())?
        .map_err(|e| format!("await claude: {e}"))?;
    if !output.status.success() {
        return Err(format!("claude -p exited with {}", output.status));
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("claude -p produced no output".to_string());
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_title_args_is_print_haiku_with_title_system_prompt_and_tools_disabled() {
        let args = claude_title_args("haiku");
        assert_eq!(
            args,
            vec![
                "-p",
                "--model",
                "haiku",
                "--append-system-prompt",
                TITLE_SYSTEM_PROMPT,
                "--tools",
                "",
            ]
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn claude_title_args_disable_all_tools() {
        // The untrusted transcript must not be able to drive a tool-enabled `claude`:
        // `--tools ""` disables every tool for the one-shot title call.
        let args = claude_title_args("haiku");
        let i = args.iter().position(|a| a == "--tools").expect("--tools present");
        assert_eq!(args[i + 1], "", "the tools list is empty (all tools off)");
    }

    #[test]
    fn claude_title_args_threads_the_model_through() {
        // The model is a parameter so the runner's constant is the single source of
        // truth; passing a different alias is reflected verbatim.
        let args = claude_title_args("sonnet");
        assert_eq!(args[1], "--model");
        assert_eq!(args[2], "sonnet");
    }

    #[test]
    fn claude_title_model_alias_is_haiku() {
        assert_eq!(CLAUDE_TITLE_MODEL, "haiku");
    }
}
