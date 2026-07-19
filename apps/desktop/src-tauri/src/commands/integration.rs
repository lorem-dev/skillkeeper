//! Phase 2 acceptance test.
//!
//! Builds an [`AppContext`](crate::state::AppContext) on a fresh, hermetic
//! temp app-data dir with an isolated `$HOME` (via
//! [`test_support::TempAppData`](super::test_support::TempAppData) -- never the
//! real home) and drives a representative end-to-end sequence against the inner
//! command functions:
//!
//! 1. config set -> config get (round-trip)
//! 2. add a project -> projects list (shows it) -> describe -> exists
//! 3. remove -> list (empty)

use super::test_support::TempAppData;
use crate::commands::{config, projects, state_read};

use skillkeeper_config::{default_config, Theme};

/// A throwaway on-disk project directory, removed on drop.
struct ProjectDir {
    path: std::path::PathBuf,
}

impl ProjectDir {
    fn new() -> Self {
        use std::sync::atomic::{AtomicU32, Ordering};
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "skillkeeper-integration-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
}

impl Drop for ProjectDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
fn phase2_command_surface_end_to_end() {
    let app = TempAppData::new();
    let ctx = &app.ctx;

    // --- config: set -> get round-trip ---
    let mut cfg = default_config();
    cfg.general.theme = Theme::Dark;
    cfg.repositories.git_path = "/opt/git/bin/git".to_string();

    let saved = config::save(ctx, &cfg).expect("config set persists");
    assert_eq!(saved.config, cfg);

    let loaded = config::load(ctx);
    assert_eq!(loaded.config.general.theme, Theme::Dark);
    assert_eq!(loaded.config.repositories.git_path, "/opt/git/bin/git");

    // --- projects: add -> list shows it ---
    let dir = ProjectDir::new();
    let added = projects::add(ctx, dir.path(), "My App".to_string());
    assert!(added.ok, "add failed: {:?}", added.error);
    let project = added.project.expect("project record");
    assert_eq!(project.name, "My App");
    assert_eq!(project.path, dir.path());

    let listed = state_read::list_projects(ctx);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, project.id);
    assert_eq!(listed[0].path, dir.path());

    // --- projects: describe (no installs/agents yet -> zeros) ---
    let info = projects::describe(ctx, project.id.clone());
    assert_eq!(info.skill_count, 0);
    assert_eq!(info.from_repos_count, 0);
    assert_eq!(info.agent_count, 0);

    // --- projects: exists (present now, gone after the folder is deleted) ---
    assert!(projects::exists(ctx, project.id.clone()));
    assert!(!projects::exists(ctx, "no-such-id".to_string()));

    // --- projects: remove -> list empty ---
    let removed = projects::remove(ctx, project.id.clone());
    assert!(removed.ok, "remove failed: {:?}", removed.error);
    assert!(state_read::list_projects(ctx).is_empty());

    // A removed project no longer exists to the command surface.
    assert!(!projects::exists(ctx, project.id));
}
