//! Suppress the console window Windows flashes when this GUI app spawns a
//! console subprocess (git, gh, claude, curl, …).
//!
//! A Windows GUI process (no attached console) that launches a console program
//! via `Command` gets a fresh console window allocated for the child, which
//! flashes on screen. The `CREATE_NO_WINDOW` process-creation flag suppresses
//! it. On non-Windows platforms this is a no-op.
//!
//! Implemented for both `std::process::Command` and `tokio::process::Command`
//! so every spawn site can call `.no_console_window()` uniformly.

/// The Windows `CREATE_NO_WINDOW` process-creation flag.
/// <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Adds `.no_console_window()` to a process `Command`. On Windows sets
/// `CREATE_NO_WINDOW`; elsewhere returns the command unchanged, so call sites
/// stay platform-agnostic.
pub trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(windows)]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        // tokio exposes `creation_flags` as an inherent method on Windows
        // (NOT via std's CommandExt trait).
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}
