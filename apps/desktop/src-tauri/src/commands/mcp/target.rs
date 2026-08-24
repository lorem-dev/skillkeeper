//! Per-agent MCP target resolution.

use skillkeeper_core::mcp::{
    mcp_destination, parse_mcp_config, McpDestinationTarget, McpServerDef, SKMCP_FILE,
    SKMCP_PARAMS_FILE,
};
use skillkeeper_core::models::{AgentKind, AgentTarget, Scope};
use skillkeeper_core::ports::{FsPort, HostEnv};

use crate::state::AppContext;

use super::{ProjectEnv, MCP_FILE_NAMES};

/// The resolved on-disk locations one MCP install writes to for an agent
/// (mirrors the TS `McpTarget`).
pub(super) struct McpTarget {
    /// Native agent MCP config file.
    pub(super) native_path: String,
    /// `.skmcp.yml` under the agent's skills root for this scope.
    pub(super) ledger_path: String,
    /// `.skmcp.params.yml` sibling of the ledger.
    pub(super) params_path: String,
    /// Per-agent guidance file(s) that MCP `rules` blocks install into.
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
/// agent's guidance file.
pub(super) fn resolve_mcp_target(
    ctx: &AppContext,
    agent: AgentKind,
    scope: Scope,
    project_path: &str,
    project_id: &str,
) -> Result<McpTarget, String> {
    let target = match scope {
        Scope::Global => AgentTarget::global(agent),
        Scope::Project => AgentTarget::project(agent, Some(project_id)),
    };
    let env = ProjectEnv {
        inner: &ctx.env,
        project_path: project_path.to_string(),
    };
    let native = mcp_destination(
        agent,
        scope,
        &McpDestinationTarget {
            project_path: Some(project_path.to_string()),
            home_dir: Some(ctx.env.home_dir().to_string()),
        },
    )?;
    let adapter = ctx.registry.get(agent).map_err(|e| e.to_string())?;
    let dest_root = adapter
        .destination_root(&target, &env)
        .map_err(|e| e.to_string())?;
    let guidance_file = adapter
        .guidance_file(&ctx.fs, &target, &env)
        .map_err(|e| e.to_string())?;
    Ok(McpTarget {
        native_path: native.path,
        ledger_path: format!("{dest_root}/{SKMCP_FILE}"),
        params_path: format!("{dest_root}/{SKMCP_PARAMS_FILE}"),
        guidance_files: vec![guidance_file],
        scope,
    })
}

/// Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
/// (preferring `mcp.yml`), plus anything worth telling the user about it.
/// Returns an empty list when neither exists, or when the file found fails to
/// parse. Port of the TS `readMcpDefs`.
///
/// Both outcomes that lose presets carry a message: a file that could not be
/// parsed at all, and one that only parsed because of the YAML leniency. Left
/// on stderr, as these were, they are invisible in a windowed app -- and a
/// skipped file is then indistinguishable from an absent one.
pub(super) fn read_mcp_defs(fs: &dyn FsPort, dir: &str) -> (Vec<McpServerDef>, Vec<String>) {
    for file_name in MCP_FILE_NAMES {
        let path = format!("{dir}/{file_name}");
        if !fs.exists(&path).unwrap_or(false) {
            continue;
        }
        let text = match fs.read_file(&path) {
            Ok(t) => t,
            // The third way to lose presets, and the one that used to be
            // silent: the file is there but cannot be read at all (permissions,
            // I/O, not valid UTF-8). Saying nothing here made a skipped file
            // indistinguishable from an absent one, which is exactly what this
            // warning channel exists to prevent.
            Err(e) => return (Vec::new(), vec![format!("Could not read \"{path}\": {e}")]),
        };
        return match parse_mcp_config(&text) {
            Ok(cfg) => {
                let notes = cfg
                    .warnings
                    .iter()
                    .map(|w| format!("{path}: {w}"))
                    .collect();
                (cfg.servers, notes)
            }
            Err(e) => (
                Vec::new(),
                vec![format!("Skipping invalid MCP config at \"{path}\": {e}")],
            ),
        };
    }
    (Vec::new(), Vec::new())
}
