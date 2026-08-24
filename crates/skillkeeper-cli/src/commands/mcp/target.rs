//! Where one MCP install writes: the native config path, the ledger/params
//! paths, and the agent's guidance file.

use skillkeeper_core::mcp::{mcp_destination, McpDestinationTarget, SKMCP_FILE, SKMCP_PARAMS_FILE};
use skillkeeper_core::models::{AgentKind, AgentTarget, Scope};

use crate::commands::agenthelpers::ProjectEnv;
use crate::error::CliError;

use super::McpCtx;

/// The resolved on-disk locations one MCP install writes to for an agent.
pub(super) struct McpTarget {
    pub(super) native_path: String,
    pub(super) ledger_path: String,
    pub(super) params_path: String,
    pub(super) guidance_files: Vec<String>,
    /// The scope these paths were resolved at. Carried on the target so that
    /// anything depending on where the write lands -- the `.gitignore` entry
    /// above all -- reads it from the same value that chose the paths.
    ///
    /// It equals the requested scope for every agent. It did not while Codex
    /// was forced to global, which is what the indirection here existed for;
    /// that rule is gone, and keeping a function to express the equality only
    /// suggested a difference that cannot occur.
    pub(super) scope: Scope,
}

/// Resolve where one MCP install for `agent` writes at `scope`: the native
/// config path, the ledger/params paths under the agent's skills destination
/// root for that scope (the SAME root the skills engine resolves), and the
/// agent's guidance file. Port of `resolveMcpTarget`; mirrors the desktop
/// `mcp.rs` version.
pub(super) fn resolve_mcp_target(
    ctx: &McpCtx,
    agent: AgentKind,
    scope: Scope,
    project_path: &str,
    project_id: &str,
) -> Result<McpTarget, CliError> {
    let target = match scope {
        Scope::Global => AgentTarget::global(agent),
        Scope::Project => AgentTarget::project(agent, Some(project_id)),
    };
    let env = ProjectEnv {
        inner: ctx.env,
        project_path: project_path.to_string(),
    };
    let native = mcp_destination(
        agent,
        scope,
        &McpDestinationTarget {
            project_path: Some(project_path.to_string()),
            home_dir: Some(ctx.env.home_dir().to_string()),
        },
    )
    .map_err(CliError)?;
    let adapter = ctx.registry.get(agent)?;
    let dest_root = adapter.destination_root(&target, &env)?;
    let guidance_file = adapter.guidance_file(ctx.fs, &target, &env)?;
    Ok(McpTarget {
        native_path: native.path,
        ledger_path: format!("{dest_root}/{SKMCP_FILE}"),
        params_path: format!("{dest_root}/{SKMCP_PARAMS_FILE}"),
        guidance_files: vec![guidance_file],
        scope,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp::testutil::{seed_state, seeded_fs, TestApp, PROJECT};

    #[test]
    fn resolve_mcp_target_resolves_codex_at_the_requested_scope() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        // Codex now resolves a real project-scoped destination, exactly like
        // every other agent: the resolved scope always matches the requested
        // one, and the native path lands under the project.
        let codex = resolve_mcp_target(
            &app.ctx(),
            AgentKind::Codex,
            Scope::Project,
            PROJECT,
            PROJECT,
        )
        .unwrap();
        assert_eq!(codex.scope, Scope::Project);
        assert_eq!(codex.native_path, format!("{PROJECT}/.codex/config.toml"));

        let claude = resolve_mcp_target(
            &app.ctx(),
            AgentKind::Claude,
            Scope::Project,
            PROJECT,
            PROJECT,
        )
        .unwrap();
        assert_eq!(claude.scope, Scope::Project);
    }
}
