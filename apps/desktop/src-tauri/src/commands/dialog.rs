//! Native dialog commands (port of the `dialog:selectFolder` Electron IPC
//! handler in `apps/desktop/src/main/index.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `dialog:selectFolder` -> `dialog_select_folder`
//!
//! Backed by `tauri-plugin-dialog` (registered in `lib.rs`, permitted in
//! `capabilities/default.json`). Returns the chosen path, or `null` when the
//! picker is cancelled -- matching the Electron `showOpenDialog` handler.

use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// `dialog:selectFolder` -- open a native folder picker; resolve to the chosen
/// path or `None` when cancelled.
///
/// Runs as an async command so the blocking picker never stalls the main event
/// loop.
#[tauri::command]
pub async fn dialog_select_folder(app: AppHandle) -> Result<Option<String>, String> {
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.map(|path| path.to_string()))
}
