//! `mcp:installs` / `mcp:reconcile`.

use std::collections::{BTreeMap, HashSet};

use skillkeeper_core::mcp::{
    parse_skmcp, parse_skmcp_params, serialize_skmcp, serialize_skmcp_params, writer_for,
    SkmcpEntry, SkmcpFile,
};
use skillkeeper_core::models::{AgentKind, Scope};
use skillkeeper_core::ports::FsPort;
use skillkeeper_core::state::state::load_state;

use crate::state::AppContext;

use super::target::{resolve_mcp_target, McpTarget};
use super::types::{McpInstall, McpInstallIdentity};
use super::{lock, ALL_MCP_AGENTS, GLOBAL_PROJECT_ID};

/// Map one ledger entry to an [`McpInstall`] for the given scope/agent (port of
/// the TS `entryToInstall`).
fn entry_to_install(
    scope_id: &str,
    agent: AgentKind,
    entry: &SkmcpEntry,
    has_params: bool,
) -> McpInstall {
    McpInstall {
        project_id: scope_id.to_string(),
        agent,
        instance_name: entry.name.clone(),
        identity: McpInstallIdentity {
            remote: entry.remote.clone(),
            group: entry.group.clone(),
            local: entry.local.clone(),
            source: entry.source.clone(),
        },
        hash: entry.hash.clone(),
        has_params,
    }
}

/// Read `target`'s ledger and push each entry as an [`McpInstall`] onto `out`.
/// No-op when the ledger file is missing or unparsable. Port of the `collect`
/// closure in the TS `listMcpInstalls`.
fn collect_installs(
    ctx: &AppContext,
    out: &mut Vec<McpInstall>,
    scope_id: &str,
    agent: AgentKind,
    target: &McpTarget,
) {
    if !ctx.fs.exists(&target.ledger_path).unwrap_or(false) {
        return;
    }
    let ledger_text = match ctx.fs.read_file(&target.ledger_path) {
        Ok(t) => t,
        Err(_) => return,
    };
    let Some(ledger) = parse_skmcp(&ledger_text) else {
        return;
    };
    let params = read_params_map(ctx, &target.params_path);
    for entry in &ledger.servers {
        out.push(entry_to_install(
            scope_id,
            agent,
            entry,
            params.contains_key(&entry.name),
        ));
    }
}

/// Read a params file into a map, empty when the file is absent or unreadable.
fn read_params_map(
    ctx: &AppContext,
    params_path: &str,
) -> BTreeMap<String, BTreeMap<String, String>> {
    if ctx.fs.exists(params_path).unwrap_or(false) {
        parse_skmcp_params(&ctx.fs.read_file(params_path).unwrap_or_default())
    } else {
        BTreeMap::new()
    }
}

/// `mcp:installs` -- read every agent's `.skmcp.yml` and map each entry to an
/// [`McpInstall`]: every agent across all tracked projects, plus every agent's
/// global ledger. Read-only (no pruning). Port of the TS `listMcpInstalls`.
pub fn installs(ctx: &AppContext) -> Vec<McpInstall> {
    let mut out = Vec::new();
    let projects = {
        let _guard = lock(ctx);
        match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state.projects,
            Err(_) => Vec::new(),
        }
    };

    for project in &projects {
        for agent in ALL_MCP_AGENTS {
            if let Ok(target) =
                resolve_mcp_target(ctx, agent, Scope::Project, &project.path, &project.id)
            {
                collect_installs(ctx, &mut out, &project.id, agent, &target);
            }
        }
    }

    // The global scope of every agent, reported under the reserved bucket id.
    for agent in ALL_MCP_AGENTS {
        if let Ok(target) = resolve_mcp_target(ctx, agent, Scope::Global, "", "") {
            collect_installs(ctx, &mut out, GLOBAL_PROJECT_ID, agent, &target);
        }
    }

    out
}

// ---------------------------------------------------------------------------
// mcp:reconcile
// ---------------------------------------------------------------------------

/// Reconcile one agent's `.skmcp.yml` with its native config: PRUNE-ONLY. Drop
/// each ledger + params entry whose native server no longer exists; leave an
/// all-present ledger byte-for-byte untouched. Surviving entries are pushed onto
/// `out`. Port of the `reconcileLedger` closure in the TS `reconcileMcp`.
fn reconcile_ledger(
    ctx: &AppContext,
    out: &mut Vec<McpInstall>,
    scope_id: &str,
    agent: AgentKind,
    target: &McpTarget,
) -> Result<(), String> {
    if !ctx
        .fs
        .exists(&target.ledger_path)
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let ledger_text = ctx
        .fs
        .read_file(&target.ledger_path)
        .map_err(|e| e.to_string())?;
    let Some(ledger) = parse_skmcp(&ledger_text) else {
        return Ok(());
    };

    let native_text = if ctx
        .fs
        .exists(&target.native_path)
        .map_err(|e| e.to_string())?
    {
        ctx.fs
            .read_file(&target.native_path)
            .map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let present: HashSet<String> = writer_for(agent)
        .existing_names(&native_text)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    let kept: Vec<SkmcpEntry> = ledger
        .servers
        .iter()
        .filter(|s| present.contains(&s.name))
        .cloned()
        .collect();
    let pruned = kept.len() != ledger.servers.len();

    if pruned {
        ctx.fs
            .write_file(
                &target.ledger_path,
                &serialize_skmcp(&SkmcpFile {
                    schema: ledger.schema,
                    servers: kept.clone(),
                }),
            )
            .map_err(|e| e.to_string())?;
        // Drop param entries for the pruned names; only rewrite when a key was
        // actually removed (never create an empty params file needlessly).
        if ctx
            .fs
            .exists(&target.params_path)
            .map_err(|e| e.to_string())?
        {
            let mut params = parse_skmcp_params(
                &ctx.fs
                    .read_file(&target.params_path)
                    .map_err(|e| e.to_string())?,
            );
            let kept_names: HashSet<&str> = kept.iter().map(|s| s.name.as_str()).collect();
            let before = params.len();
            params.retain(|name, _| kept_names.contains(name.as_str()));
            if params.len() != before {
                ctx.fs
                    .write_file(&target.params_path, &serialize_skmcp_params(&params))
                    .map_err(|e| e.to_string())?;
            }
        }
    }

    let params = read_params_map(ctx, &target.params_path);
    for entry in &kept {
        out.push(entry_to_install(
            scope_id,
            agent,
            entry,
            params.contains_key(&entry.name),
        ));
    }
    Ok(())
}

/// `mcp:reconcile` -- prune every agent's `.skmcp.yml`/params entries whose
/// native server is gone, then return the surviving install list. Port of the TS
/// `reconcileMcp`.
pub fn reconcile(ctx: &AppContext) -> Vec<McpInstall> {
    let _guard = lock(ctx);
    let mut out = Vec::new();
    let projects = match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state.projects,
        Err(_) => Vec::new(),
    };

    for project in &projects {
        for agent in ALL_MCP_AGENTS {
            if let Ok(target) =
                resolve_mcp_target(ctx, agent, Scope::Project, &project.path, &project.id)
            {
                // A ledger whose native config is malformed is skipped, mirroring
                // the per-project try/catch in the TS source.
                let _ = reconcile_ledger(ctx, &mut out, &project.id, agent, &target);
            }
        }
    }

    // The global scope of every agent, reported under the reserved bucket id.
    for agent in ALL_MCP_AGENTS {
        if let Ok(target) = resolve_mcp_target(ctx, agent, Scope::Global, "", "") {
            let _ = reconcile_ledger(ctx, &mut out, GLOBAL_PROJECT_ID, agent, &target);
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::apply;
    use crate::commands::mcp::testutil::*;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::models::{AppState, Project, STATE_VERSION};
    use skillkeeper_core::state::state::save_state;
    use std::path::Path;

    use super::super::types::{ApplyMcpArgs, McpBatch};

    // ---- installs / reconcile ----

    #[test]
    fn installs_and_reconcile_round_trip_then_prune() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        assert!(
            apply(
                &app.ctx,
                apply_args(
                    &proj,
                    vec![McpBatch {
                        agent: AgentKind::Claude,
                        install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                        remove: vec![],
                    }],
                ),
            )
            .ok
        );

        // Native server present -> reconcile keeps the ledger entry.
        let kept = reconcile(&app.ctx);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].instance_name, "github_1");
        assert_eq!(installs(&app.ctx).len(), 1);

        // Delete the native config: reconcile prunes the orphaned ledger entry.
        std::fs::remove_file(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        let pruned = reconcile(&app.ctx);
        assert!(pruned.is_empty());
        assert!(installs(&app.ctx).is_empty());
    }
    #[test]
    fn a_project_scoped_codex_install_appears_in_the_installs_listing() {
        // `installs()` used to skip codex in its per-project loop (the
        // now-removed `PROJECT_MCP_AGENTS` excluded it), so a project-scoped
        // codex install could land correctly on disk yet never surface here.
        let app = CodexApp::new();
        let project_path = app.home.join("proj").to_string_lossy().into_owned();

        let project = Project {
            id: "p1".to_string(),
            path: project_path.clone(),
            name: "app".to_string(),
            added_at: "2026-07-17T00:00:00.000Z".to_string(),
        };
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![],
            projects: vec![project],
            installs: vec![],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();

        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                scope: Scope::Project,
                project_id: "p1".to_string(),
                project_path: project_path.clone(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                    remove: vec![],
                }],
            },
        );
        assert!(
            result.ok,
            "codex project install failed: {:?}",
            result.error
        );
        assert_eq!(result.installed.as_ref().map(Vec::len), Some(1));

        let listed = installs(&app.ctx);
        let entry = listed
            .iter()
            .find(|i| i.agent == AgentKind::Codex && i.project_id == "p1");
        assert!(
            entry.is_some(),
            "expected a project-scoped codex install in the listing, got: {listed:?}"
        );
        assert_eq!(entry.unwrap().instance_name, "github_1");
    }
}
