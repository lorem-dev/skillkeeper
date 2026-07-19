//! Project commands (port of `apps/desktop/src/main/projects.ts` and the
//! `detectProjectAgents` helper in `apps/desktop/src/main/skills.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `projects:add`         -> `projects_add`
//!   `projects:update`      -> `projects_update`
//!   `projects:remove`      -> `projects_remove`
//!   `projects:describe`    -> `projects_describe`
//!   `projects:exists`      -> `projects_exists`
//!   `projects:detectAgents`-> `projects_detect_agents`
//!
//! `projects:list` already lives in `state_read.rs` and is left there.
//!
//! Nothing throws across the boundary: mutating commands return a result shape
//! (`ProjectResult`/`RemoveResult`) and the read-only ones degrade to
//! empty/false/zeros on any failure. Every state mutation runs under
//! `ctx.state_lock` to reproduce the TypeScript `withStateLock` serialization.
//! `describe` folds in the sanitized project icon (see [`crate::app::icon_sanitize`])
//! and the skill/agent summary the card badges show.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use skillkeeper_core::models::{AgentKind, AppState, InstallManifest, Project};
use skillkeeper_core::ports::{Clock, FsPort};
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;

use crate::app::icon_sanitize::resolve_project_icon;
use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// Outcome of a mutating project command: `{ ok: true, project }` on success or
/// `{ ok: false, error }` on failure (mirrors the TypeScript `ProjectResult`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<Project>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ProjectResult {
    fn ok(project: Project) -> Self {
        Self {
            ok: true,
            project: Some(project),
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            project: None,
            error: Some(error.into()),
        }
    }
}

/// Outcome of `projects:remove`: `{ ok: true }` or `{ ok: false, error }`
/// (mirrors the TypeScript `RemoveResult`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RemoveResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

/// Skill counts + detected-agent count + icon for a project (drives the card
/// badges; mirrors the TypeScript `ProjectInfo`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    /// Total distinct skills installed in the project (agents collapsed).
    pub skill_count: usize,
    /// Of those, how many were installed from a currently-tracked repository.
    pub from_repos_count: usize,
    /// Number of agents detected in the project folder (by markers).
    pub agent_count: usize,
    /// A data URL for the project's own icon when the folder carries a safe one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

/// Files/dirs whose presence in a project marks an agent as having been used.
/// The tuple order mirrors the TypeScript `AGENT_MARKERS` key order.
const AGENT_MARKERS: [(AgentKind, &[&str]); 5] = [
    (AgentKind::Claude, &["CLAUDE.md", ".claude"]),
    (AgentKind::Codex, &["AGENTS.md", ".codex"]),
    (AgentKind::Copilot, &[".github/copilot-instructions.md"]),
    (AgentKind::Cursor, &[".cursor", ".cursorrules"]),
    (AgentKind::Opencode, &[".opencode", "opencode.json"]),
];

/// Acquire the state lock, recovering the guard if a prior holder panicked.
fn lock(ctx: &AppContext) -> std::sync::MutexGuard<'_, ()> {
    ctx.state_lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// Current wall-clock time as an ISO-8601 UTC timestamp (`new Date().toISOString()`).
fn now_iso(ctx: &AppContext) -> String {
    iso_from_millis(ctx.clock.now())
}

/// Which agents appear to have been used in the project folder (by markers).
/// Port of the TypeScript `detectProjectAgents`.
pub fn detect_project_agents(fs: &dyn FsPort, project_path: &str) -> Vec<AgentKind> {
    let mut found = Vec::new();
    for (agent, markers) in AGENT_MARKERS {
        for marker in markers {
            let path = Path::new(project_path)
                .join(marker)
                .to_string_lossy()
                .into_owned();
            if fs.exists(&path).unwrap_or(false) {
                found.push(agent);
                break;
            }
        }
    }
    found
}

/// Distinct-skill counts for a project's installs, agents collapsed: a skill
/// installed for several agents counts once. Identity is `(sourceRepoId, group,
/// name)`. Port of the TypeScript `projectSkillCounts`.
fn project_skill_counts(
    installs: &[&InstallManifest],
    tracked_repo_ids: &HashSet<&str>,
) -> (usize, usize) {
    let mut all: HashSet<String> = HashSet::new();
    let mut from_repos: HashSet<String> = HashSet::new();
    for m in installs {
        let key = format!(
            "{} {} {}",
            m.source_repo_id.as_deref().unwrap_or(""),
            m.skill_id.group.as_deref().unwrap_or(""),
            m.skill_id.name
        );
        all.insert(key.clone());
        if let Some(rid) = m.source_repo_id.as_deref() {
            if !rid.is_empty() && tracked_repo_ids.contains(rid) {
                from_repos.insert(key);
            }
        }
    }
    (all.len(), from_repos.len())
}

/// `projects:add` -- track a project for a chosen folder.
pub fn add(ctx: &AppContext, path: String, name: String) -> ProjectResult {
    let _guard = lock(ctx);
    let state = match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state,
        Err(e) => return ProjectResult::err(e.to_string()),
    };
    if state.projects.iter().any(|p| p.path == path) {
        return ProjectResult::err("duplicate");
    }
    let name = if name.trim().is_empty() {
        path.clone()
    } else {
        name.trim().to_string()
    };
    let project = Project {
        id: Uuid::new_v4().to_string(),
        path,
        name,
        added_at: now_iso(ctx),
    };
    let mut projects = state.projects.clone();
    projects.push(project.clone());
    let next = AppState { projects, ..state };
    match save_state(&ctx.fs, &ctx.paths.state_json, &next) {
        Ok(()) => ProjectResult::ok(project),
        Err(e) => ProjectResult::err(e.to_string()),
    }
}

/// `projects:update` -- edit a project's folder and/or display name.
pub fn update(ctx: &AppContext, id: String, path: String, name: String) -> ProjectResult {
    let _guard = lock(ctx);
    let state = match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state,
        Err(e) => return ProjectResult::err(e.to_string()),
    };
    let Some(current) = state.projects.iter().find(|p| p.id == id).cloned() else {
        return ProjectResult::err("not-found");
    };
    let updated = Project {
        id: current.id.clone(),
        path: if path.trim().is_empty() {
            current.path.clone()
        } else {
            path
        },
        name: if name.trim().is_empty() {
            current.name.clone()
        } else {
            name.trim().to_string()
        },
        added_at: current.added_at.clone(),
    };
    let projects = state
        .projects
        .iter()
        .map(|p| {
            if p.id == id {
                updated.clone()
            } else {
                p.clone()
            }
        })
        .collect();
    let next = AppState { projects, ..state };
    match save_state(&ctx.fs, &ctx.paths.state_json, &next) {
        Ok(()) => ProjectResult::ok(updated),
        Err(e) => ProjectResult::err(e.to_string()),
    }
}

/// `projects:remove` -- stop tracking a project. The folder on disk is untouched.
/// Mirrors the TypeScript: a missing id is not an error (the filter is a no-op).
pub fn remove(ctx: &AppContext, id: String) -> RemoveResult {
    let _guard = lock(ctx);
    let state = match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state,
        Err(e) => return RemoveResult::err(e.to_string()),
    };
    let projects = state
        .projects
        .iter()
        .filter(|p| p.id != id)
        .cloned()
        .collect();
    let next = AppState { projects, ..state };
    match save_state(&ctx.fs, &ctx.paths.state_json, &next) {
        Ok(()) => RemoveResult::ok(),
        Err(e) => RemoveResult::err(e.to_string()),
    }
}

/// `projects:exists` -- whether the project's folder still exists on disk
/// (false when untracked, gone, or on any failure).
pub fn exists(ctx: &AppContext, id: String) -> bool {
    let state = {
        let _guard = lock(ctx);
        match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state,
            Err(_) => return false,
        }
    };
    match state.projects.iter().find(|p| p.id == id) {
        Some(project) => ctx.fs.exists(&project.path).unwrap_or(false),
        None => false,
    }
}

/// `projects:describe` -- skill counts, detected-agent count, and the sanitized
/// project icon for the card badges. Zeros/no-icon on any failure.
pub fn describe(ctx: &AppContext, id: String) -> ProjectInfo {
    let empty = ProjectInfo {
        skill_count: 0,
        from_repos_count: 0,
        agent_count: 0,
        icon_data_url: None,
    };
    let state = {
        let _guard = lock(ctx);
        match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state,
            Err(_) => return empty,
        }
    };
    let installs: Vec<&InstallManifest> = state
        .installs
        .iter()
        .filter(|m| m.target.project_id.as_deref() == Some(id.as_str()))
        .collect();
    let project = state.projects.iter().find(|p| p.id == id);
    let agent_count = project.map_or(0, |p| detect_project_agents(&ctx.fs, &p.path).len());
    let icon_data_url = project.and_then(|p| resolve_project_icon(&p.path));
    let tracked_repo_ids: HashSet<&str> =
        state.repositories.iter().map(|r| r.id.as_str()).collect();
    let (skill_count, from_repos_count) = project_skill_counts(&installs, &tracked_repo_ids);
    ProjectInfo {
        skill_count,
        from_repos_count,
        agent_count,
        icon_data_url,
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers.
// ---------------------------------------------------------------------------

/// `projects:add`.
#[tauri::command]
pub async fn projects_add(
    ctx: State<'_, Arc<AppContext>>,
    path: String,
    name: String,
) -> Result<ProjectResult, String> {
    blocking(&ctx, move |c| add(c, path, name)).await
}

/// `projects:update`.
#[tauri::command]
pub async fn projects_update(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
    path: String,
    name: String,
) -> Result<ProjectResult, String> {
    blocking(&ctx, move |c| update(c, id, path, name)).await
}

/// `projects:remove`.
#[tauri::command]
pub async fn projects_remove(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RemoveResult, String> {
    blocking(&ctx, move |c| remove(c, id)).await
}

/// `projects:exists`.
#[tauri::command]
pub async fn projects_exists(ctx: State<'_, Arc<AppContext>>, id: String) -> Result<bool, String> {
    blocking(&ctx, move |c| exists(c, id)).await
}

/// `projects:describe`.
#[tauri::command]
pub async fn projects_describe(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<ProjectInfo, String> {
    blocking(&ctx, move |c| describe(c, id)).await
}

/// `projects:detectAgents`.
#[tauri::command]
pub async fn projects_detect_agents(
    ctx: State<'_, Arc<AppContext>>,
    path: String,
) -> Result<Vec<AgentKind>, String> {
    blocking(&ctx, move |c| detect_project_agents(&c.fs, &path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::models::{
        AgentTarget, InstallManifest, Repository, RepositoryKind, Scope, SkillId, Transport,
    };
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A throwaway project directory on disk, removed on drop.
    struct ProjectDir {
        path: PathBuf,
    }

    impl ProjectDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "skillkeeper-projtest-{}-{}",
                std::process::id(),
                n
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        fn write(&self, rel: &str, bytes: &[u8]) {
            let file = self.path.join(rel);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }
    }

    impl Drop for ProjectDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // ---- add / update / remove / exists round-trip ----

    #[test]
    fn add_persists_a_project_and_defaults_name_to_path_when_blank() {
        let app = TempAppData::new();
        let dir = ProjectDir::new();
        let result = add(&app.ctx, dir.path(), "   ".to_string());
        assert!(result.ok);
        let project = result.project.unwrap();
        assert_eq!(project.name, dir.path());
        assert_eq!(project.path, dir.path());
        assert!(project.added_at.ends_with('Z'));

        let state = load_state(&app.ctx.fs, &app.ctx.paths.state_json).unwrap();
        assert_eq!(state.projects.len(), 1);
        assert_eq!(state.projects[0].id, project.id);
    }

    #[test]
    fn add_rejects_a_duplicate_path() {
        let app = TempAppData::new();
        let dir = ProjectDir::new();
        assert!(add(&app.ctx, dir.path(), "one".to_string()).ok);
        let dup = add(&app.ctx, dir.path(), "two".to_string());
        assert!(!dup.ok);
        assert_eq!(dup.error.as_deref(), Some("duplicate"));
    }

    #[test]
    fn update_edits_name_and_keeps_id_and_added_at() {
        let app = TempAppData::new();
        let dir = ProjectDir::new();
        let added = add(&app.ctx, dir.path(), "orig".to_string())
            .project
            .unwrap();

        let result = update(
            &app.ctx,
            added.id.clone(),
            "  ".to_string(),
            "renamed".to_string(),
        );
        assert!(result.ok);
        let updated = result.project.unwrap();
        assert_eq!(updated.name, "renamed");
        assert_eq!(updated.path, added.path); // blank path keeps the current one
        assert_eq!(updated.id, added.id);
        assert_eq!(updated.added_at, added.added_at);
    }

    #[test]
    fn update_reports_not_found_for_unknown_id() {
        let app = TempAppData::new();
        let result = update(
            &app.ctx,
            "nope".to_string(),
            "/x".to_string(),
            "n".to_string(),
        );
        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("not-found"));
    }

    #[test]
    fn remove_drops_the_record_and_is_ok_for_unknown_id() {
        let app = TempAppData::new();
        let dir = ProjectDir::new();
        let added = add(&app.ctx, dir.path(), "p".to_string()).project.unwrap();

        assert!(remove(&app.ctx, added.id.clone()).ok);
        assert!(load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .projects
            .is_empty());
        // Removing an unknown id is not an error (matches the TS filter).
        assert!(remove(&app.ctx, "nope".to_string()).ok);
    }

    #[test]
    fn exists_is_true_for_a_present_folder_and_false_otherwise() {
        let app = TempAppData::new();
        let dir = ProjectDir::new();
        let added = add(&app.ctx, dir.path(), "p".to_string()).project.unwrap();
        assert!(exists(&app.ctx, added.id.clone()));

        // Unknown id -> false.
        assert!(!exists(&app.ctx, "nope".to_string()));

        // Folder gone -> false.
        std::fs::remove_dir_all(&dir.path).unwrap();
        assert!(!exists(&app.ctx, added.id));
    }

    // ---- detect_agents ----

    #[test]
    fn detect_agents_finds_markers_in_key_order() {
        let dir = ProjectDir::new();
        dir.write("CLAUDE.md", b"x"); // claude
        dir.write(".cursor/rules", b"x"); // cursor (dir marker)
        dir.write(".github/copilot-instructions.md", b"x"); // copilot
        let app = TempAppData::new();
        let found = detect_project_agents(&app.ctx.fs, &dir.path());
        assert_eq!(
            found,
            vec![AgentKind::Claude, AgentKind::Copilot, AgentKind::Cursor]
        );
    }

    #[test]
    fn detect_agents_is_empty_for_a_bare_folder() {
        let dir = ProjectDir::new();
        let app = TempAppData::new();
        assert!(detect_project_agents(&app.ctx.fs, &dir.path()).is_empty());
    }

    // ---- describe (with icon + counts) ----

    fn seed_project_with_install(app: &TempAppData, dir: &ProjectDir) -> String {
        let project = Project {
            id: "proj-1".to_string(),
            path: dir.path(),
            name: "app".to_string(),
            added_at: "2026-07-17T00:00:00.000Z".to_string(),
        };
        let repo = Repository {
            id: "repo-1".to_string(),
            name: "skills".to_string(),
            url: "https://example.com/r.git".to_string(),
            kind: RepositoryKind::Generic,
            transport: Transport::Https,
            lfs: false,
            local_path: "/tmp/repo-1".to_string(),
            last_fetched: None,
            branch: None,
        };
        let manifest = InstallManifest {
            skill_id: SkillId {
                group: None,
                name: "skill-a".to_string(),
            },
            target: AgentTarget {
                agent: AgentKind::Claude,
                scope: Scope::Project,
                project_id: Some("proj-1".to_string()),
            },
            destination_root: format!("{}/.claude/skills", dir.path()),
            source_repo_id: Some("repo-1".to_string()),
            source_remote: Some("https://example.com/r.git".to_string()),
            source_path: None,
            content_hash: Some("h".to_string()),
            version: None,
            installed_at: "2026-07-17T00:00:00.000Z".to_string(),
            files: vec![],
            hook_edits: vec![],
        };
        let state = AppState {
            version: skillkeeper_core::models::STATE_VERSION,
            repositories: vec![repo],
            projects: vec![project.clone()],
            installs: vec![manifest],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();
        project.id
    }

    #[test]
    fn describe_reports_counts_agents_and_icon() {
        let app = TempAppData::new();
        let dir = ProjectDir::new();
        // A marker for one agent and a safe project icon.
        dir.write("CLAUDE.md", b"x");
        dir.write("icon.svg", b"<svg><rect/></svg>");
        let id = seed_project_with_install(&app, &dir);

        let info = describe(&app.ctx, id);
        assert_eq!(info.skill_count, 1);
        assert_eq!(info.from_repos_count, 1); // repo-1 is tracked
        assert_eq!(info.agent_count, 1); // CLAUDE.md marker
        assert!(info
            .icon_data_url
            .as_deref()
            .is_some_and(|u| u.starts_with("data:image/svg+xml;base64,")));
    }

    #[test]
    fn describe_zeroes_out_for_unknown_project() {
        let app = TempAppData::new();
        let info = describe(&app.ctx, "nope".to_string());
        assert_eq!(info.skill_count, 0);
        assert_eq!(info.from_repos_count, 0);
        assert_eq!(info.agent_count, 0);
        assert!(info.icon_data_url.is_none());
    }
}
