//! Onboarding-state persistence.
//!
//! Desktop-only: the guided tour's progress lives in `onboarding.json`, a
//! sibling of `config.yaml` in the app-data dir. Unlike `config.yaml`/
//! `state.json`, this file is NOT shared with the CLI and has no external
//! watcher, so the renderer store is authoritative for the session.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use skillkeeper_core::ports::FsPort;

use super::blocking;
use crate::state::AppContext;

/// Persisted onboarding progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub version: u32,
    pub completed: bool,
    /// The current step id (a renderer `StepId`); kept as a string so the
    /// backend does not couple to the renderer's step set.
    pub step: String,
}

impl Default for OnboardingState {
    fn default() -> Self {
        Self {
            version: 1,
            completed: false,
            step: "welcome".to_string(),
        }
    }
}

/// Absolute path to `onboarding.json` (sibling of `config.yaml`).
fn onboarding_path(ctx: &AppContext) -> String {
    let dir = Path::new(&ctx.paths.config_yaml)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    dir.join("onboarding.json").to_string_lossy().into_owned()
}

/// Read + parse the onboarding state; any missing/unreadable/invalid file
/// degrades to the default (fresh, not completed, at "welcome").
pub fn load(ctx: &AppContext) -> OnboardingState {
    let path = onboarding_path(ctx);
    if !ctx.fs.exists(&path).unwrap_or(false) {
        return OnboardingState::default();
    }
    match ctx.fs.read_file(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => OnboardingState::default(),
    }
}

/// Persist the onboarding state as pretty JSON.
///
/// # Errors
/// Returns a message when serialization or the write fails.
pub fn save(ctx: &AppContext, state: &OnboardingState) -> Result<(), String> {
    let text = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    ctx.fs
        .write_file(&onboarding_path(ctx), &text)
        .map_err(|e| e.to_string())
}

/// `onboarding_get` -- read the onboarding state (never fails).
#[tauri::command]
pub async fn onboarding_get(ctx: State<'_, Arc<AppContext>>) -> Result<OnboardingState, String> {
    blocking(&ctx, load).await
}

/// `onboarding_set` -- persist the given onboarding state.
#[tauri::command]
pub async fn onboarding_set(
    ctx: State<'_, Arc<AppContext>>,
    state: OnboardingState,
) -> Result<(), String> {
    blocking(&ctx, move |c| save(c, &state)).await?
}

/// `onboarding_menu_sync` -- reflect onboarding mode in the macOS app menu:
/// set the Help toggle label and disable every other item (except Quit and
/// the toggle) while active; re-enable all when inactive. No-op off macOS.
#[tauri::command]
pub fn onboarding_menu_sync<R: tauri::Runtime>(app: tauri::AppHandle<R>, active: bool) {
    #[cfg(target_os = "macos")]
    crate::app::menu::sync_onboarding(&app, active);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, active);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;

    #[test]
    fn get_on_missing_file_returns_default() {
        let app = TempAppData::new();
        let state = load(&app.ctx);
        assert_eq!(state.version, 1);
        assert!(!state.completed);
        assert_eq!(state.step, "welcome");
    }

    #[test]
    fn set_then_get_round_trips() {
        let app = TempAppData::new();
        let saved = OnboardingState {
            version: 1,
            completed: false,
            step: "repositories".to_string(),
        };
        save(&app.ctx, &saved).unwrap();
        let loaded = load(&app.ctx);
        assert_eq!(loaded.step, "repositories");
        assert!(!loaded.completed);
    }

    #[test]
    fn get_on_invalid_json_returns_default() {
        let app = TempAppData::new();
        let path = onboarding_path(&app.ctx);
        app.ctx.fs.write_file(&path, "not json").unwrap();
        let state = load(&app.ctx);
        assert_eq!(state.step, "welcome");
        assert!(!state.completed);
    }
}
