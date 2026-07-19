//! Window / host commands.
//!
//! Channel mapping: `app:getVersion` -> `get_app_version`, the `platform`
//! getter (Electron exposed `process.platform` synchronously on the bridge) ->
//! the `platform` command, and the frameless-title-bar window controls
//! (`window:minimize|toggleMaximize|close|isMaximized`). Each control acts on
//! the `tauri::WebviewWindow` that dispatched it, mirroring the Electron
//! `BrowserWindow.fromWebContents(e.sender)` lookup.

use tauri::State;

use skillkeeper_core::ports::HostEnv;

use crate::state::AppContext;

/// `app:getVersion` -- the packaged application version.
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// `platform` -- the host platform string (`"darwin"`, `"win32"`, `"linux"`,
/// ...), used by the renderer to choose the window-control chrome.
#[tauri::command]
pub fn platform(ctx: State<std::sync::Arc<AppContext>>) -> String {
    ctx.env.platform().to_string()
}

/// `window:minimize` -- minimize the window that dispatched the command.
#[tauri::command]
pub fn window_minimize(window: tauri::WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// `window:toggleMaximize` -- toggle the dispatching window between maximized
/// and restored (mirrors the Electron `isMaximized() ? unmaximize : maximize`).
#[tauri::command]
pub fn window_toggle_maximize(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// `window:close` -- close the window that dispatched the command.
#[tauri::command]
pub fn window_close(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/// `window:isMaximized` -- whether the dispatching window is maximized.
#[tauri::command]
pub fn window_is_maximized(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

/// Wire the frameless chrome and the maximize-state relay onto the main window.
///
/// Frameless setup (mirrors the Electron `createWindow`): macOS keeps the native
/// traffic lights via the `Overlay` title-bar style declared in
/// `tauri.conf.json`, so nothing is done here; every other platform drops the
/// native decorations so the renderer can draw its own title strip.
///
/// The relay watches the window's `Resized` events -- Tauri has no dedicated
/// maximize/unmaximize event -- and emits `window:maximizeChanged` (bool) only
/// when the maximized state actually flips, so the renderer's maximize/restore
/// glyph can follow it (mirrors the Electron `maximize`/`unmaximize` relay).
pub fn wire_window_chrome(window: &tauri::WebviewWindow) {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_decorations(false);
    }

    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tauri::Emitter;

    let seed = window.is_maximized().unwrap_or(false);
    let last = Arc::new(AtomicBool::new(seed));
    let relay_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            let now = relay_window.is_maximized().unwrap_or(false);
            if last.swap(now, Ordering::SeqCst) != now {
                let _ = relay_window.emit("window:maximizeChanged", now);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    // The `window_*` controls and `wire_window_chrome` operate on a live
    // `tauri::WebviewWindow`, which cannot be constructed off a running event
    // loop, so they are exercised by integration/manual runs rather than unit
    // tests. Only the platform getter is covered here.
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::ports::HostEnv;

    #[test]
    fn platform_reports_a_non_empty_host_string() {
        let app = TempAppData::new();
        assert!(!app.ctx.env.platform().is_empty());
    }
}
