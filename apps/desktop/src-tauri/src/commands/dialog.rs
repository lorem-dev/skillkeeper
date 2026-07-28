//! Native dialog commands (port of the `dialog:selectFolder` Electron IPC
//! handler in `apps/desktop/src/main/index.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `dialog:selectFolder` -> `dialog_select_folder`
//!   `dialog:selectSshKey` -> `dialog_select_ssh_key`
//!
//! Backed by `tauri-plugin-dialog` (registered in `lib.rs`, permitted in
//! `capabilities/default.json`). Returns the chosen path, or `null` when the
//! picker is cancelled -- matching the Electron `showOpenDialog` handler.

use std::path::Path;
use std::sync::Arc;

use skillkeeper_core::ports::HostEnv;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppContext;

/// `dialog:selectFolder` -- open a native folder picker; resolve to the chosen
/// path or `None` when cancelled.
///
/// Runs as an async command so the blocking picker never stalls the main event
/// loop.
///
/// The picker is parented to the main window so the OS makes it window-modal:
/// while it is open the app window cannot be interacted with, and it closes with
/// the dialog. Without a parent the picker is a free top-level window that leaves
/// the app window clickable (notably on Windows), which is why an in-app scrim
/// could never substitute for real modality.
#[tauri::command]
pub async fn dialog_select_folder(app: AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let folder = dialog.blocking_pick_folder();
    Ok(folder.map(|path| path.to_string()))
}

/// `dialog:selectSshKey` -- open a native file picker for a private SSH key;
/// resolve to the chosen path or `None` when cancelled.
///
/// Starts in `~/.ssh` when that directory exists, since that is where nearly
/// every key lives. No extension filter: private keys usually have no
/// extension at all, so filtering would hide the very files being looked for.
///
/// Whatever comes back is only a path, and only a candidate: `ssh_key_select`
/// re-validates it (rejecting a blank path, and one git cannot be told about),
/// and whether the file is actually a private key is reported as the resulting
/// `KeyState` rather than refused here.
#[tauri::command]
pub async fn dialog_select_ssh_key(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let ssh_dir = Path::new(ctx.env.home_dir()).join(".ssh");
    if ssh_dir.is_dir() {
        dialog = dialog.set_directory(&ssh_dir);
    }
    let file = dialog.blocking_pick_file();
    Ok(file.map(|path| path.to_string()))
}
