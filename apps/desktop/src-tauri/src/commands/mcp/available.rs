//! `mcp:list-available`.

use skillkeeper_core::mcp::discovery::preset_group_dirs;
use skillkeeper_core::mcp::hash_mcp_def;
use skillkeeper_core::ports::FsPort;
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::load_state;

use crate::state::AppContext;

use super::lock;
use super::target::read_mcp_defs;
use super::types::{AvailableMcp, AvailableMcpResult, McpConfigWarning};

/// `mcp:list-available` -- every MCP server preset available across all cloned
/// repositories: a root mcp.yml/mcp.yaml plus one per skill-group directory.
/// Repos whose clone is missing are skipped. Port of the TS `listAvailableMcp`.
pub fn list_available(ctx: &AppContext) -> AvailableMcpResult {
    let mut out = Vec::new();
    let mut warnings: Vec<McpConfigWarning> = Vec::new();
    let repos = {
        let _guard = lock(ctx);
        match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state.repositories,
            Err(_) => return AvailableMcpResult { mcp: out, warnings },
        }
    };
    for repo in repos {
        if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
            continue;
        }
        let mut note = |message: String| {
            warnings.push(McpConfigWarning {
                repo_id: repo.id.clone(),
                repo_name: repo.name.clone(),
                message,
            });
        };
        let (defs, notes) = read_mcp_defs(&ctx.fs, &repo.local_path);
        for message in notes {
            note(message);
        }
        for def in defs {
            let hash = hash_mcp_def(&def);
            out.push(AvailableMcp {
                repo_id: repo.id.clone(),
                remote: repo.url.clone(),
                group: None,
                def,
                hash,
            });
        }
        // Group candidates are every ancestor directory of each resolved skill,
        // as computed by `preset_group_dirs`, not the skill's declared
        // `id.group` -- an mcp.yml sits in the actual directory.
        let resolved = resolve_skills(&ctx.fs, &repo.local_path);
        // Carry the resolution warnings, as the CLI already does: a skill that
        // fails to resolve cannot contribute its directory as a group, so a
        // broken SKILL.md silently hides its sibling mcp.yml. This page can be
        // refreshed on its own, so the skills-side warning is not guaranteed to
        // be in the log alongside it.
        for message in &resolved.warnings {
            note(message.clone());
        }
        for group in preset_group_dirs(&resolved.skills) {
            let dir = format!("{}/{}", repo.local_path, group);
            let (defs, notes) = read_mcp_defs(&ctx.fs, &dir);
            for message in notes {
                note(message);
            }
            for def in defs {
                let hash = hash_mcp_def(&def);
                out.push(AvailableMcp {
                    repo_id: repo.id.clone(),
                    remote: repo.url.clone(),
                    group: Some(group.clone()),
                    def,
                    hash,
                });
            }
        }
    }
    AvailableMcpResult { mcp: out, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::testutil::ProjectDir;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::models::{
        AppState, Repository, RepositoryKind, Transport, STATE_VERSION,
    };
    use skillkeeper_core::state::state::save_state;
    use std::path::Path;

    // ---- list_available ----

    #[test]
    fn list_available_flattens_root_and_group_presets() {
        let app = TempAppData::new();
        let repo = ProjectDir::new(); // reuse temp-dir fixture as a repo clone
        std::fs::write(
            Path::new(&repo.path()).join("mcp.yml"),
            "version: 1\nservers:\n  - name: root-srv\n    type: http\n    url: https://example.com/mcp\n",
        )
        .unwrap();
        let group_skill = Path::new(&repo.path()).join("devtools/tool");
        std::fs::create_dir_all(&group_skill).unwrap();
        std::fs::write(group_skill.join("SKILL.md"), "---\nname: tool\n---\nbody\n").unwrap();
        std::fs::write(
            Path::new(&repo.path()).join("devtools/mcp.yml"),
            "version: 1\nservers:\n  - name: dt-srv\n    type: stdio\n    command: run\n",
        )
        .unwrap();

        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![Repository {
                id: "repo-1".to_string(),
                name: "mcps".to_string(),
                url: "git@github.com:acme/mcps.git".to_string(),
                kind: RepositoryKind::Generic,
                transport: Transport::Ssh,
                lfs: false,
                local_path: repo.path(),
                last_fetched: None,
                branch: None,
            }],
            projects: vec![],
            installs: vec![],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();

        let out = list_available(&app.ctx);
        assert_eq!(out.mcp.len(), 2);
        assert!(out.warnings.is_empty());
        let root = out.mcp.iter().find(|m| m.group.is_none()).unwrap();
        assert_eq!(root.def.name, "root-srv");
        assert_eq!(root.repo_id, "repo-1");
        assert!(!root.hash.is_empty());
        let group = out.mcp.iter().find(|m| m.group.is_some()).unwrap();
        assert_eq!(group.group.as_deref(), Some("devtools"));
        assert_eq!(group.def.name, "dt-srv");
    }

    #[test]
    fn list_available_is_empty_without_repositories() {
        let app = TempAppData::new();
        let out = list_available(&app.ctx);
        assert!(out.mcp.is_empty());
        assert!(out.warnings.is_empty());
    }

    /// One repository holding `mcp.yml` with `text`, registered in state.
    fn app_with_mcp_yml(text: &str) -> (TempAppData, ProjectDir) {
        let app = TempAppData::new();
        let repo = ProjectDir::new();
        std::fs::write(Path::new(&repo.path()).join("mcp.yml"), text).unwrap();
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![Repository {
                id: "repo-1".to_string(),
                name: "mcps".to_string(),
                url: "git@github.com:acme/mcps.git".to_string(),
                kind: RepositoryKind::Generic,
                transport: Transport::Ssh,
                lfs: false,
                local_path: repo.path(),
                last_fetched: None,
                branch: None,
            }],
            projects: vec![],
            installs: vec![],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();
        (app, repo)
    }

    #[test]
    fn list_available_reports_an_unparsable_config_instead_of_dropping_it() {
        let (app, _repo) = app_with_mcp_yml("version: 1\nservers:\n  - name: s\n    type: nope\n");
        let out = list_available(&app.ctx);
        assert!(out.mcp.is_empty());
        assert_eq!(out.warnings.len(), 1);
        assert_eq!(out.warnings[0].repo_id, "repo-1");
        assert_eq!(out.warnings[0].repo_name, "mcps");
        assert!(
            out.warnings[0]
                .message
                .contains("Skipping invalid MCP config"),
            "{}",
            out.warnings[0].message
        );
    }

    #[test]
    fn list_available_keeps_a_bare_placeholder_and_warns_about_it() {
        let (app, _repo) = app_with_mcp_yml(
            "version: 1\nservers:\n  - name: jira\n    type: http\n    url: https://example.com/mcp\n    headers:\n      X-Token: {personal_token}\n",
        );
        let out = list_available(&app.ctx);
        assert_eq!(out.mcp.len(), 1);
        assert_eq!(
            out.mcp[0]
                .def
                .headers
                .as_ref()
                .and_then(|h| h.get("X-Token")),
            Some(&"{personal_token}".to_string())
        );
        assert_eq!(out.warnings.len(), 1);
        assert!(
            out.warnings[0].message.contains("{personal_token}"),
            "{}",
            out.warnings[0].message
        );
    }
}
