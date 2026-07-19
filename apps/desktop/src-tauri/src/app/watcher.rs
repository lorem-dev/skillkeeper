//! Config-file watcher (a port of `apps/desktop/src/main/configWatcher.ts`).
//!
//! Polls the config file *text* once per second -- deliberately NOT an
//! fs-notify watch, matching the Electron implementation -- and, when the text
//! changes on disk, reloads via [`skillkeeper_config::load_config`] and emits
//! `config:changed` with the same `LoadConfigResult` DTO shape as `config:get`.
//!
//! The change-detection is factored into [`WatcherState`], a pure state machine
//! over the observed text, so it is unit-testable without a filesystem or a
//! running Tauri app. `config_set` calls [`ConfigWatcher::note_written`] after
//! its own write so a self-write is re-baselined and never echoed back.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use skillkeeper_config::load_config;
use skillkeeper_core::adapters::StdFs;
use skillkeeper_core::ports::FsPort;

use crate::commands::config::to_dto;
use crate::state::AppContext;

/// Poll interval, mirroring `configWatcher.ts` `POLL_MS`.
const POLL: Duration = Duration::from_secs(1);

/// Pure change-detection state for the config poll.
///
/// Mirrors the `configWatcher.ts` `tick()` semantics: the first observation
/// only establishes the baseline; a subsequent change to a *present* text asks
/// the caller to reload + emit; a change to an *absent* file (deletion)
/// re-baselines silently.
#[derive(Debug, Default)]
pub struct WatcherState {
    last_text: Option<String>,
    baselined: bool,
}

impl WatcherState {
    /// A fresh, un-baselined state.
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed the freshly-read file text (`None` when the file is absent).
    ///
    /// Returns `true` when the caller should reload the config and emit
    /// `config:changed`.
    pub fn observe(&mut self, text: Option<String>) -> bool {
        if !self.baselined {
            self.last_text = text;
            self.baselined = true;
            return false;
        }
        if text == self.last_text {
            return false;
        }
        let emit = text.is_some();
        self.last_text = text;
        emit
    }

    /// Re-baseline to the given text so a self-write is not surfaced.
    pub fn note_written(&mut self, text: Option<String>) {
        self.last_text = text;
        self.baselined = true;
    }
}

/// Shared, thread-safe handle to a config watcher.
///
/// Held on [`AppContext`] so `config_set` can re-baseline after its own write;
/// the polling loop runs on a background thread started in `lib.rs` setup.
pub struct ConfigWatcher {
    state: Arc<Mutex<WatcherState>>,
    config_path: String,
}

/// Read the config file text, mapping "absent" and any read error to `None`
/// (mirrors `configWatcher.ts` `readText`, which returns null when missing).
fn read_text(fs: &StdFs, path: &str) -> Option<String> {
    if !fs.exists(path).unwrap_or(false) {
        return None;
    }
    fs.read_file(path).ok()
}

impl ConfigWatcher {
    /// Build a watcher for the given config path.
    pub fn new(config_path: String) -> Self {
        Self {
            state: Arc::new(Mutex::new(WatcherState::new())),
            config_path,
        }
    }

    /// Re-baseline to the current file so a self-write from `config_set` is not
    /// echoed back to the renderer as an external change.
    pub fn note_written(&self, fs: &StdFs) {
        let text = read_text(fs, &self.config_path);
        if let Ok(mut state) = self.state.lock() {
            state.note_written(text);
        }
    }

    /// Run one poll: read the file, update the state, and (on change) reload the
    /// config and emit `config:changed`. Exposed for the startup loop.
    fn tick(&self, app: &AppHandle, fs: &StdFs) {
        let text = read_text(fs, &self.config_path);
        let changed = match self.state.lock() {
            Ok(mut state) => state.observe(text),
            Err(_) => false,
        };
        if !changed {
            return;
        }
        let result = load_config(fs, &self.config_path);
        // Re-apply the native window theme so an external edit of the theme
        // preference updates the window immediately (mirrors rememberTheme on
        // the Electron config-watch path).
        if let Some(window) = app.get_webview_window("main") {
            crate::app::theme::apply(&window, result.config.general.theme);
        }
        if let Ok(payload) = to_dto(&result) {
            let _ = app.emit("config:changed", payload);
        }
    }
}

/// Start the config watcher on a background thread.
///
/// Establishes the baseline immediately, then polls every [`POLL`]. Errors from
/// the loop are swallowed so a transient read failure never crashes the thread.
pub fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let fs = StdFs::new();
        loop {
            {
                let ctx = app.state::<std::sync::Arc<AppContext>>();
                ctx.config_watcher.tick(&app, &fs);
            }
            std::thread::sleep(POLL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_observation_only_baselines() {
        let mut state = WatcherState::new();
        assert!(!state.observe(Some("a: 1\n".to_string())));
    }

    #[test]
    fn unchanged_text_does_not_emit() {
        let mut state = WatcherState::new();
        state.observe(Some("a: 1\n".to_string()));
        assert!(!state.observe(Some("a: 1\n".to_string())));
    }

    #[test]
    fn changed_present_text_emits() {
        let mut state = WatcherState::new();
        state.observe(Some("a: 1\n".to_string()));
        assert!(state.observe(Some("a: 2\n".to_string())));
    }

    #[test]
    fn deletion_rebaselines_without_emitting() {
        let mut state = WatcherState::new();
        state.observe(Some("a: 1\n".to_string()));
        assert!(!state.observe(None));
        // A later re-creation with different text emits again.
        assert!(state.observe(Some("a: 3\n".to_string())));
    }

    #[test]
    fn note_written_suppresses_the_matching_change() {
        let mut state = WatcherState::new();
        state.observe(Some("a: 1\n".to_string()));
        // A self-write re-baselines to the new text ...
        state.note_written(Some("a: 2\n".to_string()));
        // ... so observing that same text is not surfaced.
        assert!(!state.observe(Some("a: 2\n".to_string())));
    }

    #[test]
    fn absence_from_the_start_baselines_then_creation_emits() {
        let mut state = WatcherState::new();
        assert!(!state.observe(None));
        assert!(state.observe(Some("a: 1\n".to_string())));
    }
}
