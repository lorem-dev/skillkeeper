//! `skillkeeper check` command: read-only update detection at repo and skill
//! level. Port of `packages/cli/src/commands/check.ts`.

use std::io::Write;

use clap::Args;
use skillkeeper_core::ports::{FsPort, GitPort};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::load_state;

use crate::error::CliError;
use crate::updates::{repo_has_update, skill_has_update};

/// `check` command options.
#[derive(Debug, Args)]
pub struct CheckArgs {
    /// Check all repositories and skills (accepted for parity; the command
    /// always checks every tracked repository).
    #[arg(long)]
    pub all: bool,
}

/// Run the read-only update check. Returns exit code 1 when any update is
/// available, matching the TypeScript command.
pub fn run(
    fs: &dyn FsPort,
    git: &dyn GitPort,
    state_path: &str,
    _all: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let state = load_state(fs, state_path)?;

    if state.repositories.is_empty() {
        writeln!(out, "No repositories to check.")?;
        return Ok(0);
    }

    let mut any_update = false;

    for repo in &state.repositories {
        let repo_update = match repo_has_update(git, repo) {
            Ok(v) => v,
            Err(_) => {
                writeln!(err, "  Could not check repo {}: fetch failed", repo.name)?;
                continue;
            }
        };

        if repo_update {
            any_update = true;
            writeln!(
                out,
                "UPDATE AVAILABLE: repository {} ({})",
                repo.name, repo.id
            )?;
        } else {
            writeln!(out, "up to date: repository {}", repo.name)?;
        }

        // Skill-level check. `resolve_skills` is infallible in the Rust core
        // (it returns a `ResolveResult` with warnings rather than throwing), so
        // the TypeScript resolve `try/catch` has no counterpart here.
        let resolve_result = resolve_skills(fs, &repo.local_path);

        for resolved in &resolve_result.skills {
            let related = state.installs.iter().filter(|m| {
                m.source_repo_id.as_deref() == Some(repo.id.as_str())
                    && m.skill_id.name == resolved.id.name
                    && m.skill_id.group == resolved.id.group
            });
            for manifest in related {
                let has_update = match skill_has_update(fs, &repo.local_path, resolved, manifest) {
                    Ok(v) => v,
                    Err(_) => {
                        writeln!(err, "  Could not check skill {}", resolved.id.name)?;
                        continue;
                    }
                };
                if has_update {
                    any_update = true;
                    writeln!(
                        out,
                        "  UPDATE AVAILABLE: skill {} ({})",
                        resolved.id.name, manifest.target.agent
                    )?;
                } else {
                    writeln!(
                        out,
                        "  up to date: skill {} ({})",
                        resolved.id.name, manifest.target.agent
                    )?;
                }
            }
        }
    }

    Ok(if any_update { 1 } else { 0 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::FakeGit;
    use skillkeeper_core::models::{
        AgentKind, AgentTarget, AppState, InstallManifest, Repository, RepositoryKind, Scope,
        SkillId, Transport, STATE_VERSION,
    };
    use skillkeeper_core::state::state::save_state;
    use skillkeeper_core::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";

    fn repo(id: &str, local: &str) -> Repository {
        Repository {
            id: id.to_string(),
            name: format!("repo-{id}"),
            url: "https://github.com/acme/skills.git".to_string(),
            kind: RepositoryKind::Github,
            transport: Transport::Https,
            lfs: false,
            local_path: local.to_string(),
            last_fetched: None,
            branch: None,
        }
    }

    fn seed_state(fs: &MemFs, state: &AppState) {
        save_state(fs, STATE_PATH, state).unwrap();
    }

    #[test]
    fn reports_no_repositories() {
        let fs = MemFs::new();
        seed_state(&fs, &AppState::empty());
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&fs, &git, STATE_PATH, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No repositories to check."));
    }

    #[test]
    fn reports_repository_up_to_date() {
        let fs = MemFs::new();
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo("r1", "/repos/r1")],
            projects: vec![],
            installs: vec![],
        };
        seed_state(&fs, &state);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&fs, &git, STATE_PATH, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("up to date: repository repo-r1"));
    }

    #[test]
    fn reports_repository_update_and_exits_one() {
        let fs = MemFs::new();
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo("r1", "/repos/r1")],
            projects: vec![],
            installs: vec![],
        };
        seed_state(&fs, &state);
        let git = FakeGit::behind();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&fs, &git, STATE_PATH, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("UPDATE AVAILABLE: repository repo-r1 (r1)"));
    }

    #[test]
    fn warns_when_fetch_fails() {
        let fs = MemFs::new();
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo("r1", "/repos/r1")],
            projects: vec![],
            installs: vec![],
        };
        seed_state(&fs, &state);
        let mut git = FakeGit::up_to_date();
        git.fetch_fails = true;
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&fs, &git, STATE_PATH, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Could not check repo repo-r1: fetch failed"));
    }

    #[test]
    fn detects_skill_level_update() {
        let fs = MemFs::new().with_file(
            "/repos/r1/myskill/SKILL.md",
            "---\nname: myskill\n---\nbody\n",
        );
        let manifest = InstallManifest {
            skill_id: SkillId {
                group: None,
                name: "myskill".to_string(),
            },
            target: AgentTarget {
                agent: AgentKind::Claude,
                scope: Scope::Global,
                project_id: None,
            },
            destination_root: "/home/u/.claude".to_string(),
            source_repo_id: Some("r1".to_string()),
            source_remote: None,
            source_path: None,
            // A hash that cannot match the resolved content, forcing an update.
            content_hash: Some("stale".to_string()),
            version: None,
            installed_at: "2026-07-17T00:00:00.000Z".to_string(),
            files: vec![],
            hook_edits: vec![],
        };
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo("r1", "/repos/r1")],
            projects: vec![],
            installs: vec![manifest],
        };
        seed_state(&fs, &state);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&fs, &git, STATE_PATH, false, &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert_eq!(code, 1);
        assert!(out.contains("UPDATE AVAILABLE: skill myskill (claude)"));
    }
}
