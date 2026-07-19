//! `skillkeeper project` command group: add, remove, list.
//!
//! Port of `packages/cli/src/commands/project.ts`. Projects are tracked project
//! directories persisted in the state store.

use std::io::Write;

use clap::Subcommand;
use skillkeeper_core::models::Project;
use skillkeeper_core::ports::{Clock, FsPort};
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;
use uuid::Uuid;

use crate::error::CliError;

/// `project <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum ProjectAction {
    /// Track a project directory.
    Add {
        /// Project directory path to track.
        path: String,
        /// Human-readable name for the project.
        #[arg(long)]
        name: Option<String>,
    },
    /// Stop tracking a project directory.
    Remove {
        /// Project id to remove.
        id: String,
    },
    /// List tracked projects.
    List,
}

/// Derive a default project name from a path, mirroring the TypeScript
/// `projectPath.split('/').pop() ?? id`.
fn default_project_name(path: &str, fallback: &str) -> String {
    let last = path.rsplit('/').next().unwrap_or("");
    if last.is_empty() {
        fallback.to_string()
    } else {
        last.to_string()
    }
}

/// `project add <path>`.
pub fn add(
    fs: &dyn FsPort,
    clock: &dyn Clock,
    state_path: &str,
    project_path: &str,
    name: Option<&str>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;
    if let Some(existing) = state.projects.iter().find(|p| p.path == project_path) {
        writeln!(err, "Project already tracked (id: {})", existing.id)?;
        return Ok(1);
    }
    let id = Uuid::new_v4().to_string();
    let name = name
        .map(str::to_string)
        .unwrap_or_else(|| default_project_name(project_path, &id));
    state.projects.push(Project {
        id: id.clone(),
        path: project_path.to_string(),
        name: name.clone(),
        added_at: iso_from_millis(clock.now()),
    });
    save_state(fs, state_path, &state)?;
    writeln!(out, "Project added: {name} ({id})")?;
    Ok(0)
}

/// `project remove <id>`.
pub fn remove(
    fs: &dyn FsPort,
    state_path: &str,
    id: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;
    let Some(pos) = state.projects.iter().position(|p| p.id == id) else {
        writeln!(err, "Project not found: {id}")?;
        return Ok(1);
    };
    let removed = state.projects.remove(pos);
    save_state(fs, state_path, &state)?;
    writeln!(out, "Project removed: {}", removed.name)?;
    Ok(0)
}

/// `project list`.
pub fn list(fs: &dyn FsPort, state_path: &str, out: &mut dyn Write) -> Result<i32, CliError> {
    let state = load_state(fs, state_path)?;
    if state.projects.is_empty() {
        writeln!(out, "No projects tracked.")?;
        return Ok(0);
    }
    for p in &state.projects {
        writeln!(out, "{}  {}  {}", p.id, p.name, p.path)?;
    }
    Ok(0)
}

/// Dispatch a `project` subcommand.
pub fn run(
    action: &ProjectAction,
    fs: &dyn FsPort,
    clock: &dyn Clock,
    state_path: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        ProjectAction::Add { path, name } => {
            add(fs, clock, state_path, path, name.as_deref(), out, err)
        }
        ProjectAction::Remove { id } => remove(fs, state_path, id, out, err),
        ProjectAction::List => list(fs, state_path, out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::FixedClock;
    use skillkeeper_core::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";
    // 2025-07-17T00:00:00.000Z
    const FIXED_MS: i64 = 1_752_710_400_000;

    fn clock() -> FixedClock {
        FixedClock(FIXED_MS)
    }

    #[test]
    fn default_project_name_uses_last_segment() {
        assert_eq!(default_project_name("/home/u/app", "fallback"), "app");
        assert_eq!(default_project_name("", "fallback"), "fallback");
    }

    #[test]
    fn add_tracks_a_project_and_persists_it() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = add(
            &fs,
            &clock(),
            STATE_PATH,
            "/home/u/app",
            None,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .starts_with("Project added: app ("));
        let state = load_state(&fs, STATE_PATH).unwrap();
        assert_eq!(state.projects.len(), 1);
        assert_eq!(state.projects[0].path, "/home/u/app");
        assert_eq!(state.projects[0].name, "app");
        assert_eq!(state.projects[0].added_at, "2025-07-17T00:00:00.000Z");
    }

    #[test]
    fn add_uses_provided_name() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        add(
            &fs,
            &clock(),
            STATE_PATH,
            "/home/u/app",
            Some("My App"),
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(
            load_state(&fs, STATE_PATH).unwrap().projects[0].name,
            "My App"
        );
    }

    #[test]
    fn add_rejects_a_duplicate_path() {
        let fs = MemFs::new();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &clock(),
            STATE_PATH,
            "/home/u/app",
            None,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = add(
            &fs,
            &clock(),
            STATE_PATH,
            "/home/u/app",
            None,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Project already tracked"));
    }

    #[test]
    fn remove_deletes_a_tracked_project() {
        let fs = MemFs::new();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &clock(),
            STATE_PATH,
            "/home/u/app",
            None,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let id = load_state(&fs, STATE_PATH).unwrap().projects[0].id.clone();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(&fs, STATE_PATH, &id, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Project removed: app"));
        assert!(load_state(&fs, STATE_PATH).unwrap().projects.is_empty());
    }

    #[test]
    fn remove_reports_missing_project() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(&fs, STATE_PATH, "nope", &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Project not found: nope"));
    }

    #[test]
    fn list_reports_empty_and_populated() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        list(&fs, STATE_PATH, &mut out).unwrap();
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No projects tracked."));

        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &clock(),
            STATE_PATH,
            "/home/u/app",
            None,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        list(&fs, STATE_PATH, &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("app"));
        assert!(out.contains("/home/u/app"));
    }
}
