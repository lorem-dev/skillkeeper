//! `skillkeeper repo` command group: add, remove, list, update.
//!
//! Port of `packages/cli/src/commands/repo.ts`. Repositories are persisted in
//! the state store; git operations are delegated to the injected [`GitPort`].

use std::io::Write;

use clap::Subcommand;
use skillkeeper_core::git_remote::parse_remote;
use skillkeeper_core::models::Repository;
use skillkeeper_core::ports::{Clock, CloneOptions, FsPort, GitPort};
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;
use uuid::Uuid;

/// `repo <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum RepoAction {
    /// Add and clone a skill repository.
    Add {
        /// Remote URL to clone.
        url: String,
        /// Local destination path for the clone.
        local_path: String,
        /// Human-readable name for the repository.
        #[arg(long)]
        name: Option<String>,
        /// Enable Git LFS for this repository.
        #[arg(long)]
        lfs: bool,
    },
    /// Remove a tracked repository (does not delete the local clone).
    Remove {
        /// Repository id to remove.
        id: String,
    },
    /// List tracked repositories.
    List,
    /// Update one repository, or all repositories with --all.
    Update {
        /// Repository id to update (omit with --all).
        id: Option<String>,
        /// Update all tracked repositories.
        #[arg(long)]
        all: bool,
    },
}

use crate::error::CliError;

/// Derive a default repository name from a remote URL, mirroring the TypeScript
/// `url.split('/').pop()?.replace(/\.git$/, '')`.
fn default_repo_name(url: &str) -> String {
    let last = url.rsplit('/').next().unwrap_or(url);
    last.strip_suffix(".git").unwrap_or(last).to_string()
}

/// `repo add <url> <localPath>`.
#[allow(clippy::too_many_arguments)]
pub fn add(
    fs: &dyn FsPort,
    git: &dyn GitPort,
    clock: &dyn Clock,
    state_path: &str,
    url: &str,
    local_path: &str,
    name: Option<&str>,
    lfs: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;
    if let Some(existing) = state
        .repositories
        .iter()
        .find(|r| r.url == url || r.local_path == local_path)
    {
        writeln!(err, "Repository already tracked (id: {})", existing.id)?;
        return Ok(1);
    }

    git.clone(&CloneOptions {
        url: url.to_string(),
        destination: local_path.to_string(),
        lfs,
        filter: None,
    })?;

    let id = Uuid::new_v4().to_string();
    let (kind, transport) = parse_remote(url);
    let name = name
        .map(str::to_string)
        .unwrap_or_else(|| default_repo_name(url));
    let last_fetched = iso_from_millis(clock.now());

    state.repositories.push(Repository {
        id: id.clone(),
        name: name.clone(),
        url: url.to_string(),
        kind,
        transport,
        lfs,
        local_path: local_path.to_string(),
        last_fetched: Some(last_fetched),
        branch: None,
    });
    save_state(fs, state_path, &state)?;
    writeln!(out, "Repository added: {name} ({id})")?;
    Ok(0)
}

/// `repo remove <id>`.
pub fn remove(
    fs: &dyn FsPort,
    state_path: &str,
    id: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;
    let Some(pos) = state.repositories.iter().position(|r| r.id == id) else {
        writeln!(err, "Repository not found: {id}")?;
        return Ok(1);
    };
    let removed = state.repositories.remove(pos);
    save_state(fs, state_path, &state)?;
    writeln!(out, "Repository removed: {}", removed.name)?;
    Ok(0)
}

/// `repo list`.
pub fn list(fs: &dyn FsPort, state_path: &str, out: &mut dyn Write) -> Result<i32, CliError> {
    let state = load_state(fs, state_path)?;
    if state.repositories.is_empty() {
        writeln!(out, "No repositories tracked.")?;
        return Ok(0);
    }
    for r in &state.repositories {
        writeln!(out, "{}  {}  {}  ({})", r.id, r.name, r.url, r.local_path)?;
    }
    Ok(0)
}

/// `repo update [id] [--all]`.
#[allow(clippy::too_many_arguments)]
pub fn update(
    fs: &dyn FsPort,
    git: &dyn GitPort,
    clock: &dyn Clock,
    state_path: &str,
    id: Option<&str>,
    all: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;

    let has_target = if all {
        !state.repositories.is_empty()
    } else {
        id.is_some_and(|wanted| state.repositories.iter().any(|r| r.id == wanted))
    };
    if !has_target {
        let msg = match id {
            Some(wanted) => format!("Repository not found: {wanted}"),
            None => "No repositories tracked.".to_string(),
        };
        writeln!(err, "{msg}")?;
        return Ok(1);
    }

    let now_iso = iso_from_millis(clock.now());
    let mut any_error = false;
    for repo in &mut state.repositories {
        let is_target = all || id == Some(repo.id.as_str());
        if !is_target {
            continue;
        }
        match git.pull(&repo.local_path) {
            Ok(()) => {
                repo.last_fetched = Some(now_iso.clone());
                writeln!(out, "Updated: {}", repo.name)?;
            }
            Err(e) => {
                writeln!(err, "Failed to update {}: {e}", repo.name)?;
                any_error = true;
            }
        }
    }
    save_state(fs, state_path, &state)?;
    Ok(if any_error { 1 } else { 0 })
}

/// Dispatch a `repo` subcommand.
pub fn run(
    action: &RepoAction,
    fs: &dyn FsPort,
    git: &dyn GitPort,
    clock: &dyn Clock,
    state_path: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        RepoAction::Add {
            url,
            local_path,
            name,
            lfs,
        } => add(
            fs,
            git,
            clock,
            state_path,
            url,
            local_path,
            name.as_deref(),
            *lfs,
            out,
            err,
        ),
        RepoAction::Remove { id } => remove(fs, state_path, id, out, err),
        RepoAction::List => list(fs, state_path, out),
        RepoAction::Update { id, all } => {
            update(fs, git, clock, state_path, id.as_deref(), *all, out, err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{FakeGit, FixedClock};
    use skillkeeper_core::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";
    // 2025-07-17T00:00:00.000Z
    const FIXED_MS: i64 = 1_752_710_400_000;

    fn clock() -> FixedClock {
        FixedClock(FIXED_MS)
    }

    #[test]
    fn default_repo_name_strips_git_suffix() {
        assert_eq!(
            default_repo_name("https://github.com/acme/skills.git"),
            "skills"
        );
        assert_eq!(default_repo_name("git@github.com:acme/tools"), "tools");
    }

    #[test]
    fn add_clones_and_persists_a_repository() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            "https://github.com/acme/skills.git",
            "/repos/skills",
            None,
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.starts_with("Repository added: skills ("));
        assert!(git
            .calls
            .borrow()
            .iter()
            .any(|c| c.contains("clone https://github.com/acme/skills.git -> /repos/skills")));

        let state = load_state(&fs, STATE_PATH).unwrap();
        assert_eq!(state.repositories.len(), 1);
        let repo = &state.repositories[0];
        assert_eq!(repo.name, "skills");
        assert_eq!(repo.local_path, "/repos/skills");
        assert_eq!(
            repo.last_fetched.as_deref(),
            Some("2025-07-17T00:00:00.000Z")
        );
    }

    #[test]
    fn add_uses_provided_name() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            "https://github.com/acme/skills.git",
            "/repos/skills",
            Some("my-skills"),
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        let state = load_state(&fs, STATE_PATH).unwrap();
        assert_eq!(state.repositories[0].name, "my-skills");
        assert!(state.repositories[0].lfs);
    }

    #[test]
    fn add_rejects_a_duplicate_url() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            "https://github.com/acme/skills.git",
            "/repos/skills",
            None,
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let mut out2 = Vec::new();
        let mut err2 = Vec::new();
        let code = add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            "https://github.com/acme/skills.git",
            "/repos/other",
            None,
            false,
            &mut out2,
            &mut err2,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err2)
            .unwrap()
            .contains("Repository already tracked"));
    }

    #[test]
    fn remove_deletes_a_tracked_repository() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            "https://github.com/acme/skills.git",
            "/repos/skills",
            None,
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let id = load_state(&fs, STATE_PATH).unwrap().repositories[0]
            .id
            .clone();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(&fs, STATE_PATH, &id, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Repository removed: skills"));
        assert!(load_state(&fs, STATE_PATH).unwrap().repositories.is_empty());
    }

    #[test]
    fn remove_reports_missing_repository() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(&fs, STATE_PATH, "nope", &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Repository not found: nope"));
    }

    #[test]
    fn list_reports_empty_and_populated() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        list(&fs, STATE_PATH, &mut out).unwrap();
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No repositories tracked."));

        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            "https://github.com/acme/skills.git",
            "/repos/skills",
            None,
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        list(&fs, STATE_PATH, &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("skills"));
        assert!(out.contains("(/repos/skills)"));
    }

    fn seed_two(fs: &MemFs) -> (String, String) {
        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        for (url, dest) in [
            ("https://github.com/acme/a.git", "/repos/a"),
            ("https://github.com/acme/b.git", "/repos/b"),
        ] {
            add(
                fs,
                &git,
                &clock(),
                STATE_PATH,
                url,
                dest,
                None,
                false,
                &mut sink,
                &mut sink2,
            )
            .unwrap();
        }
        let state = load_state(fs, STATE_PATH).unwrap();
        (
            state.repositories[0].id.clone(),
            state.repositories[1].id.clone(),
        )
    }

    #[test]
    fn update_single_repository_by_id() {
        let fs = MemFs::new();
        let (id_a, _id_b) = seed_two(&fs);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            Some(&id_a),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let calls = git.calls.borrow();
        assert!(calls.iter().any(|c| c == "pull /repos/a"));
        assert!(!calls.iter().any(|c| c == "pull /repos/b"));
    }

    #[test]
    fn update_all_repositories() {
        let fs = MemFs::new();
        seed_two(&fs);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            None,
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let calls = git.calls.borrow();
        assert!(calls.iter().any(|c| c == "pull /repos/a"));
        assert!(calls.iter().any(|c| c == "pull /repos/b"));
    }

    #[test]
    fn update_reports_missing_id() {
        let fs = MemFs::new();
        seed_two(&fs);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            Some("nope"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Repository not found: nope"));
    }

    #[test]
    fn update_reports_error_and_exits_one_on_pull_failure() {
        let fs = MemFs::new();
        let (id_a, _) = seed_two(&fs);
        let mut git = FakeGit::up_to_date();
        git.pull_fails.insert("/repos/a".to_string());
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            Some(&id_a),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err).unwrap().contains("Failed to update"));
    }

    #[test]
    fn update_empty_state_reports_no_repositories() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            None,
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("No repositories tracked."));
    }
}
