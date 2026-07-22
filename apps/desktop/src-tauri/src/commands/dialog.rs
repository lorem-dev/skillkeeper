//! Native dialog commands (port of the `dialog:selectFolder` Electron IPC
//! handler in `apps/desktop/src/main/index.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `dialog:selectFolder` -> `dialog_select_folder`
//!
//! Backed by `tauri-plugin-dialog` (registered in `lib.rs`, permitted in
//! `capabilities/default.json`). Returns the chosen path, or `null` when the
//! picker is cancelled -- matching the Electron `showOpenDialog` handler.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

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
