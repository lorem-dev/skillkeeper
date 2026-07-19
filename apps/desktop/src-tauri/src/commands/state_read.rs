//! State read commands.
//!
//! Channel mapping: `repositories:list` -> `repositories_list`,
//! `projects:list` -> `projects_list`, `skills:list` -> `skills_list`.
//!
//! Each reads the JSON state file and returns the respective collection. A
//! missing file yields an empty state and a `StateError` (corrupt file) is
//! swallowed to an empty vec, matching the Electron handlers' `loadState`
//! catch behavior.

use tauri::State;

use skillkeeper_core::models::{InstallManifest, Project, Repository};
use skillkeeper_core::state::state::load_state;

use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// Tracked repositories from the state file (empty when missing or corrupt).
pub fn list_repositories(ctx: &AppContext) -> Vec<Repository> {
    let _guard = lock(ctx);
    match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state.repositories,
        Err(_) => Vec::new(),
    }
}

/// Tracked projects from the state file (empty when missing or corrupt).
pub fn list_projects(ctx: &AppContext) -> Vec<Project> {
    let _guard = lock(ctx);
    match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state.projects,
        Err(_) => Vec::new(),
    }
}

/// Install manifests from the state file (empty when missing or corrupt).
pub fn list_installs(ctx: &AppContext) -> Vec<InstallManifest> {
    let _guard = lock(ctx);
    match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state.installs,
        Err(_) => Vec::new(),
    }
}

/// Acquire the state lock, recovering the guard if a prior holder panicked.
fn lock(ctx: &AppContext) -> std::sync::MutexGuard<'_, ()> {
    ctx.state_lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// `repositories:list`.
#[tauri::command]
pub async fn repositories_list(ctx: State<'_, Arc<AppContext>>) -> Result<Vec<Repository>, String> {
    blocking(&ctx, list_repositories).await
}

/// `projects:list`.
#[tauri::command]
pub async fn projects_list(ctx: State<'_, Arc<AppContext>>) -> Result<Vec<Project>, String> {
    blocking(&ctx, list_projects).await
}

/// `skills:list` (install manifests recorded in the state file).
#[tauri::command]
pub async fn skills_list(ctx: State<'_, Arc<AppContext>>) -> Result<Vec<InstallManifest>, String> {
    blocking(&ctx, list_installs).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::models::{AppState, Project, RepositoryKind, Transport};
    use skillkeeper_core::state::state::save_state;

    #[test]
    fn lists_are_empty_on_missing_state_file() {
        let app = TempAppData::new();
        assert!(list_repositories(&app.ctx).is_empty());
        assert!(list_projects(&app.ctx).is_empty());
        assert!(list_installs(&app.ctx).is_empty());
    }

    #[test]
    fn lists_are_empty_on_corrupt_state_file() {
        let app = TempAppData::new();
        std::fs::write(&app.ctx.paths.state_json, "not json{").unwrap();
        assert!(list_repositories(&app.ctx).is_empty());
        assert!(list_projects(&app.ctx).is_empty());
        assert!(list_installs(&app.ctx).is_empty());
    }

    #[test]
    fn reads_back_persisted_repositories_and_projects() {
        let app = TempAppData::new();
        let state = AppState {
            version: skillkeeper_core::models::STATE_VERSION,
            repositories: vec![Repository {
                id: "r1".to_string(),
                name: "skills".to_string(),
                url: "git@github.com:acme/skills.git".to_string(),
                kind: RepositoryKind::Github,
                transport: Transport::Ssh,
                lfs: false,
                local_path: "/data/repos/r1".to_string(),
                last_fetched: None,
                branch: None,
            }],
            projects: vec![Project {
                id: "p1".to_string(),
                path: "/work/app".to_string(),
                name: "app".to_string(),
                added_at: "2026-07-17T00:00:00.000Z".to_string(),
            }],
            installs: vec![],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();

        let repos = list_repositories(&app.ctx);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].id, "r1");

        let projects = list_projects(&app.ctx);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "p1");

        assert!(list_installs(&app.ctx).is_empty());
    }
}
