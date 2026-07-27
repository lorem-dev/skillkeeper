//! Terminal commands (port of the `terminal:*` Electron IPC handlers in
//! `apps/desktop/src/main/terminal.ts`, driven from the renderer via
//! `apps/desktop/src/preload/index.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `terminal:start`       -> `terminal_start`
//!   `terminal:input`       -> `terminal_input`
//!   `terminal:resize`      -> `terminal_resize`
//!   `terminal:clearBuffer` -> `terminal_clear_buffer`
//!   `terminal:runSshAdd`   -> `terminal_run_ssh_add`
//!
//! Output is not returned from these commands: the shell streams asynchronously
//! as `terminal:data` / `terminal:exit` Tauri events, pumped from the
//! [`TerminalManager`](crate::pty::TerminalManager) reader thread in `lib.rs`
//! setup. In-shell git (`run_git`) is exposed on the manager for Wave 4 to call
//! and is not yet surfaced as a command.

use serde::Serialize;
use tauri::State;

use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// Whether a live shell session exists, and why not when it does not.
///
/// The repository commands run git through the PTY only while a session is
/// live, falling back to the silent headless port otherwise. The renderer reads
/// this to explain that fallback instead of leaving the user with a terminal
/// that shows nothing during a clone.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatus {
    /// True once the shell has started (git output streams to the view).
    pub started: bool,
    /// The last shell/git launch failure, when there is one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `terminal:status` -- is the shell live, and if not, why not.
#[tauri::command]
pub fn terminal_status(state: State<'_, Arc<AppContext>>) -> TerminalStatus {
    TerminalStatus {
        started: state.terminal.is_started(),
        error: state.terminal.last_error(),
    }
}

/// `terminal:start` -- (re)ensure the shell is running at `cols` x `rows` and
/// return its retained scrollback for the renderer to replay.
#[tauri::command]
pub async fn terminal_start(
    state: State<'_, Arc<AppContext>>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    blocking(&state, move |c| c.terminal.start(cols, rows)).await?
}

/// `terminal:input` -- write renderer keystrokes into the shell.
#[tauri::command]
pub fn terminal_input(state: State<'_, Arc<AppContext>>, data: String) -> Result<(), String> {
    state.terminal.write(&data)
}

/// `terminal:resize` -- resize the pseudo-terminal to `cols` x `rows`.
#[tauri::command]
pub fn terminal_resize(
    state: State<'_, Arc<AppContext>>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.terminal.resize(cols, rows)
}

/// `terminal:clearBuffer` -- drop the retained scrollback (the live shell is
/// untouched and redraws on the next resize).
#[tauri::command]
pub fn terminal_clear_buffer(state: State<'_, Arc<AppContext>>) -> Result<(), String> {
    state.terminal.clear_buffer();
    Ok(())
}

/// `ssh:agentAvailable` -- whether an ssh-agent exists to hold a key.
///
/// Without one, every SSH operation has to ask for the passphrase again, so the
/// renderer uses this to explain the repeated prompts and point at the setup
/// documentation rather than leaving them unexplained.
#[tauri::command]
pub fn ssh_agent_available() -> bool {
    crate::app::ssh_agent::is_available()
}

/// `terminal:runSshAdd` -- type `ssh-add` into the interactive shell so its key
/// passphrase prompt appears in the terminal view (macOS adds
/// `--apple-use-keychain`).
#[tauri::command]
pub async fn terminal_run_ssh_add(state: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&state, |c| c.terminal.run_ssh_add()).await?
}
