//! Editor commands (port of the `editors:list`, `config:openInEditor`, and
//! `projects:open` Electron IPC handlers in `apps/desktop/src/main/index.ts`,
//! backed by `apps/desktop/src/main/editors.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `editors:list`         -> `editors_list`
//!   `config:openInEditor`  -> `open_config_in_editor`
//!   `projects:open`        -> `open_project`
//!
//! Nothing throws across the boundary: `editors_list` returns the detected list
//! (possibly just the OS-default entry) and the open commands return an
//! [`OpenResult`]. Editor detection/launch lives in [`crate::app::editor_launch`].

use tauri::State;

use crate::app::editor_launch::{list_editors, open_in_editor, EditorOption, OpenResult};
use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// `editors:list` -- detect installed editors, plus the OS-default entry, for
/// opening the config file (the icon target is the config path).
pub fn editors(ctx: &AppContext) -> Vec<EditorOption> {
    list_editors(&ctx.paths.config_yaml)
}

/// `config:openInEditor` -- open the config file in the given allowlisted editor
/// id (or the OS default). Reuses the current window when supported.
pub fn open_config(ctx: &AppContext, editor_id: &str) -> OpenResult {
    open_in_editor(editor_id, &ctx.paths.config_yaml, false)
}

/// `projects:open` -- open a project folder in the given editor id (or the OS
/// file manager). Always forces a NEW window, never reusing the current one.
pub fn open_project_folder(path: &str, editor_id: &str) -> OpenResult {
    open_in_editor(editor_id, path, true)
}

// ---------------------------------------------------------------------------
// Tauri command wrappers.
// ---------------------------------------------------------------------------

/// `editors:list`.
#[tauri::command]
pub async fn editors_list(ctx: State<'_, Arc<AppContext>>) -> Result<Vec<EditorOption>, String> {
    blocking(&ctx, editors).await
}

/// `config:openInEditor`.
#[tauri::command]
pub async fn open_config_in_editor(
    ctx: State<'_, Arc<AppContext>>,
    editor_id: String,
) -> Result<OpenResult, String> {
    blocking(&ctx, move |c| open_config(c, &editor_id)).await
}

/// `projects:open`.
#[tauri::command]
pub async fn open_project(path: String, editor_id: String) -> Result<OpenResult, String> {
    // Launching an editor spawns a subprocess; keep it off the async workers.
    tauri::async_runtime::spawn_blocking(move || open_project_folder(&path, &editor_id))
        .await
        .map_err(|e| e.to_string())
}

/// `shell:openExternal` -- open a URL in the OS default browser (used for the
/// About dialog's documentation link).
#[tauri::command]
pub async fn open_external(url: String) -> Result<OpenResult, String> {
    // opener::open spawns the browser; keep it off the async workers.
    tauri::async_runtime::spawn_blocking(move || crate::app::editor_launch::open_external(&url))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;

    #[test]
    fn editors_list_returns_at_least_the_default_entry() {
        let app = TempAppData::new();
        let list = editors(&app.ctx);
        assert!(!list.is_empty());
        assert!(list.iter().any(|e| e.id == "default"));
    }

    #[test]
    fn open_config_reports_unknown_editor() {
        let app = TempAppData::new();
        let r = open_config(&app.ctx, "no-such-editor");
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("Unknown editor: no-such-editor"));
    }

    #[test]
    fn open_project_reports_unknown_editor() {
        let r = open_project_folder("/tmp/whatever", "no-such-editor");
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("Unknown editor: no-such-editor"));
    }
}
