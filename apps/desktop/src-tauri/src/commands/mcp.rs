//! MCP commands (port of `apps/desktop/src/main/mcp.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `mcp:list-available`   -> `mcp_list_available`
//!   `mcp:apply`            -> `mcp_apply`
//!   `mcp:installs`         -> `mcp_installs`
//!   `mcp:reconcile`        -> `mcp_reconcile`
//!   `mcp:update`           -> `mcp_update`
//!   `mcp:update-preflight` -> `mcp_update_preflight`
//!
//! Nothing throws across the boundary: the mutating commands (`apply`, `update`,
//! `update_preflight`) return a result shape whose `ok` flag mirrors the Electron
//! handlers, and the read-only ones (`list_available`, `installs`) degrade to an
//! empty list on any failure. `apply`, `reconcile`, and `update` run under
//! `ctx.state_lock` to reproduce the TypeScript `withStateLock` serialization.
//!
//! The transform, ledger, and params logic is reused verbatim from the core
//! `mcp` subsystem (`install_mcp_instance`/`remove_mcp_instance`, the native
//! `writers`, `skmcp` ledger/params, `gitignore` ensure). This module only
//! orchestrates: it resolves each agent's native-config destination and ledger
//! paths, reads/writes text through `ctx.fs`, and drives the pure core engine.
//! Ledger ownership (SkillKeeper only ever touches the exact instance names it
//! records) is enforced entirely by the core engine and its writers.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::State;

use skillkeeper_agents::PROJECT_DIR_ENV;
use skillkeeper_core::mcp::{
    hash_mcp_def, install_mcp_instance, mcp_destination, missing_params, parse_mcp_config,
    parse_skmcp, parse_skmcp_params, remove_mcp_instance, serialize_skmcp, serialize_skmcp_params,
    supports_transport, writer_for, InstallMcpArgs, McpDestinationTarget, McpIdentity,
    McpServerDef, McpTransport, RemoveMcpArgs, SkmcpEntry, SkmcpFile, SKMCP_FILE,
    SKMCP_PARAMS_FILE,
};
use skillkeeper_core::models::{AgentKind, AgentTarget, Scope};
use skillkeeper_core::ports::{FsPort, HostEnv};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::load_state;

use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// The four project-scoped MCP agents; codex is handled separately (global).
const PROJECT_MCP_AGENTS: [AgentKind; 4] = [
    AgentKind::Claude,
    AgentKind::Cursor,
    AgentKind::Copilot,
    AgentKind::Opencode,
];

/// The mcp.yml/mcp.yaml file names checked in each candidate directory. `mcp.yml`
/// wins outright: when both exist only `mcp.yml` is read (even if it fails to
/// parse), mirroring the documented precedence.
const MCP_FILE_NAMES: [&str; 2] = ["mcp.yml", "mcp.yaml"];

/// Acquire the state lock, recovering the guard if a prior holder panicked.
fn lock(ctx: &AppContext) -> std::sync::MutexGuard<'_, ()> {
    ctx.state_lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// A [`HostEnv`] view that injects the active project directory into
/// [`PROJECT_DIR_ENV`] (the Rust analogue of the TS `adapterEnvFor`): adapters
/// resolve project-scope paths from this variable since an [`AgentTarget`]
/// carries only a `projectId`, not a path.
struct ProjectEnv<'a> {
    inner: &'a dyn HostEnv,
    project_path: String,
}

impl HostEnv for ProjectEnv<'_> {
    fn home_dir(&self) -> &str {
        self.inner.home_dir()
    }
    fn platform(&self) -> &str {
        self.inner.platform()
    }
    fn env(&self, key: &str) -> Option<String> {
        if key == PROJECT_DIR_ENV {
            Some(self.project_path.clone())
        } else {
            self.inner.env(key)
        }
    }
}

// ---------------------------------------------------------------------------
// Wire types (deserialized command arguments).
// ---------------------------------------------------------------------------

/// Identity of an MCP install source (mirrors the TS `McpIdentity`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpIdentityArg {
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub local: Option<String>,
    pub source: String,
}

impl McpIdentityArg {
    fn to_core(&self) -> McpIdentity {
        McpIdentity {
            remote: self.remote.clone(),
            group: self.group.clone(),
            local: self.local.clone(),
            source: self.source.clone(),
        }
    }
}

/// Read this instance's values from another agent's already-installed instance of
/// the same identity, instead of the request's own `values` (mirrors the TS
/// `McpInstallReq.copyParamsFrom`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyParamsFrom {
    pub agent: AgentKind,
    pub instance_name: String,
}

/// One MCP server to install: its source identity, raw def, and param values
/// (mirrors the TS `McpInstallReq`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstallReq {
    pub identity: McpIdentityArg,
    pub def: McpServerDef,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub copy_params_from: Option<CopyParamsFrom>,
}

/// One MCP instance to remove by name (mirrors the TS `{ instanceName }`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRemoveReq {
    pub instance_name: String,
}

/// Install/remove work for one agent within an [`apply`] call (mirrors the TS
/// `McpBatch`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBatch {
    pub agent: AgentKind,
    #[serde(default)]
    pub install: Vec<McpInstallReq>,
    #[serde(default)]
    pub remove: Vec<McpRemoveReq>,
}

/// Arguments for [`apply`] (mirrors the TS `ApplyMcpArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMcpArgs {
    pub project_id: String,
    pub project_path: String,
    #[serde(default)]
    pub batches: Vec<McpBatch>,
}

/// One MCP instance to update in place (mirrors the TS `McpUpdateReq`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUpdateReq {
    pub project_id: String,
    pub project_path: String,
    pub agent: AgentKind,
    pub instance_name: String,
    pub identity: McpIdentityArg,
    pub def: McpServerDef,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

/// Arguments for [`update`] (mirrors the TS `UpdateMcpArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpArgs {
    #[serde(default)]
    pub updates: Vec<McpUpdateReq>,
}

/// Arguments for [`update_preflight`] (mirrors the TS `McpUpdatePreflightArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUpdatePreflightArgs {
    pub project_id: String,
    pub project_path: String,
    pub agent: AgentKind,
    pub instance_name: String,
    pub def: McpServerDef,
}

// ---------------------------------------------------------------------------
// Wire types (serialized command results).
// ---------------------------------------------------------------------------

/// One MCP server preset available from a cloned repository (mirrors the TS
/// `AvailableMcp`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableMcp {
    pub repo_id: String,
    /// Source repository remote URL; the stable identity for matching installs.
    pub remote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub def: McpServerDef,
    /// Content hash of the raw def (excludes `name`), for update detection.
    pub hash: String,
}

/// An install skipped because the agent cannot express the def's transport
/// (mirrors the TS `McpSkipped`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSkipped {
    pub agent: AgentKind,
    pub source: String,
    pub transport: McpTransport,
}

/// Outcome of [`apply`]: `{ ok: true, installed, removed, skipped }` or
/// `{ ok: false, error }` (mirrors the TS `ApplyMcpResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMcpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<McpSkipped>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ApplyMcpResult {
    fn ok(installed: usize, removed: usize, skipped: Vec<McpSkipped>) -> Self {
        Self {
            ok: true,
            installed: Some(installed),
            removed: Some(removed),
            skipped: Some(skipped),
            error: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            installed: None,
            removed: None,
            skipped: None,
            error: Some(error),
        }
    }
}

/// The identity object embedded in an [`McpInstall`] (mirrors the TS
/// `McpInstall.identity`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstallIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<String>,
    pub source: String,
}

/// One installed MCP instance recorded in a `.skmcp.yml` ledger (mirrors the TS
/// `McpInstall`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstall {
    /// The tracked project's id, or `"global"` for the (codex) global scope.
    pub project_id: String,
    pub agent: AgentKind,
    pub instance_name: String,
    pub identity: McpInstallIdentity,
    pub hash: String,
    /// Whether `.skmcp.params.yml` carries an entry for this instance.
    pub has_params: bool,
}

/// Outcome of [`update`]: `{ ok: true, updated }` or `{ ok: false, error }`
/// (mirrors the TS `UpdateMcpResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UpdateMcpResult {
    fn ok(updated: usize) -> Self {
        Self {
            ok: true,
            updated: Some(updated),
            error: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            updated: None,
            error: Some(error),
        }
    }
}

/// Outcome of [`update_preflight`]: `{ ok: true, missingParams }` or
/// `{ ok: false, error }` (mirrors the TS `McpUpdatePreflightResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUpdatePreflightResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub missing_params: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl McpUpdatePreflightResult {
    fn ok(missing_params: Vec<String>) -> Self {
        Self {
            ok: true,
            missing_params: Some(missing_params),
            error: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            missing_params: None,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Per-agent MCP target resolution.
// ---------------------------------------------------------------------------

/// The resolved on-disk locations one MCP install writes to for an agent
/// (mirrors the TS `McpTarget`).
struct McpTarget {
    /// Native agent MCP config file.
    native_path: String,
    /// `.skmcp.yml` under the agent's skills root for this scope.
    ledger_path: String,
    /// `.skmcp.params.yml` sibling of the ledger.
    params_path: String,
    /// Per-agent guidance file(s) that MCP `rules` blocks install into.
    guidance_files: Vec<String>,
}

/// Resolve where one MCP install for `agent` writes: the native config path, the
/// ledger/params paths under the agent's skills destination root (the SAME root
/// the skills engine resolves), and the agent's guidance file. Codex resolves
/// globally (native config, ledger, and guidance all under the home directory);
/// the other four resolve under the project. Port of the TS `resolveMcpTarget`.
fn resolve_mcp_target(
    ctx: &AppContext,
    agent: AgentKind,
    project_path: &str,
    project_id: &str,
) -> Result<McpTarget, String> {
    let is_codex = agent == AgentKind::Codex;
    let target = if is_codex {
        AgentTarget {
            agent,
            scope: Scope::Global,
            project_id: None,
        }
    } else {
        AgentTarget {
            agent,
            scope: Scope::Project,
            project_id: Some(project_id.to_string()),
        }
    };
    let env = ProjectEnv {
        inner: &ctx.env,
        project_path: project_path.to_string(),
    };
    // Mirror the TS: both fields are passed; the writer uses projectPath for the
    // four project agents and homeDir for codex.
    let native = mcp_destination(
        agent,
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
    })
}

// ---------------------------------------------------------------------------
// mcp:list-available
// ---------------------------------------------------------------------------

/// Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
/// (preferring `mcp.yml`). Returns an empty list when neither exists, or when the
/// file found fails to parse (a warning is reported in that case). Port of the TS
/// `readMcpDefs`.
fn read_mcp_defs(fs: &dyn FsPort, dir: &str) -> Vec<McpServerDef> {
    for file_name in MCP_FILE_NAMES {
        let path = format!("{dir}/{file_name}");
        if !fs.exists(&path).unwrap_or(false) {
            continue;
        }
        let text = match fs.read_file(&path) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };
        return match parse_mcp_config(&text) {
            Ok(cfg) => cfg.servers,
            Err(e) => {
                eprintln!("[mcp] Skipping invalid MCP config at \"{path}\": {e}");
                Vec::new()
            }
        };
    }
    Vec::new()
}

/// `mcp:list-available` -- every MCP server preset available across all cloned
/// repositories: a root mcp.yml/mcp.yaml plus one per skill-group directory.
/// Repos whose clone is missing are skipped. Port of the TS `listAvailableMcp`.
pub fn list_available(ctx: &AppContext) -> Vec<AvailableMcp> {
    let mut out = Vec::new();
    let repos = {
        let _guard = lock(ctx);
        match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state.repositories,
            Err(_) => return out,
        }
    };
    for repo in repos {
        if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
            continue;
        }
        for def in read_mcp_defs(&ctx.fs, &repo.local_path) {
            let hash = hash_mcp_def(&def);
            out.push(AvailableMcp {
                repo_id: repo.id.clone(),
                remote: repo.url.clone(),
                group: None,
                def,
                hash,
            });
        }
        // Group candidates are the on-disk directory holding each resolved skill
        // (rootPath's first segment when nested one level), not the skill's
        // declared `id.group` -- an mcp.yml sits in the actual directory.
        let resolved = resolve_skills(&ctx.fs, &repo.local_path);
        let mut groups: Vec<String> = Vec::new();
        for skill in &resolved.skills {
            let parts: Vec<&str> = skill.root_path.split('/').collect();
            if parts.len() >= 2 {
                let group = parts[0].to_string();
                if !groups.contains(&group) {
                    groups.push(group);
                }
            }
        }
        for group in groups {
            let dir = format!("{}/{}", repo.local_path, group);
            for def in read_mcp_defs(&ctx.fs, &dir) {
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
    out
}

// ---------------------------------------------------------------------------
// mcp:apply
// ---------------------------------------------------------------------------

/// Resolve the values to render for one install request: `ins.values`, unless
/// `copyParamsFrom` names another agent's already-installed instance of the same
/// identity, in which case its stored `.skmcp.params.yml` entry is used (falling
/// back to `ins.values` when that entry cannot be read). Port of the TS
/// `resolveInstallValues`.
fn resolve_install_values(
    ctx: &AppContext,
    args: &ApplyMcpArgs,
    ins: &McpInstallReq,
) -> BTreeMap<String, String> {
    let Some(copy) = &ins.copy_params_from else {
        return ins.values.clone();
    };
    let target = match resolve_mcp_target(ctx, copy.agent, &args.project_path, &args.project_id) {
        Ok(t) => t,
        Err(_) => return ins.values.clone(),
    };
    if !ctx.fs.exists(&target.params_path).unwrap_or(false) {
        return ins.values.clone();
    }
    let text = match ctx.fs.read_file(&target.params_path) {
        Ok(t) => t,
        Err(_) => return ins.values.clone(),
    };
    parse_skmcp_params(&text)
        .get(&copy.instance_name)
        .cloned()
        .unwrap_or_else(|| ins.values.clone())
}

/// `mcp:apply` -- apply install/remove batches for a project across agents.
/// Removes run before installs (so a re-install onto the same instance name
/// starts clean); an install whose transport the agent cannot express is skipped
/// and reported. Codex batches resolve to the global scope and take no
/// `.gitignore` path. Never throws across the boundary. Port of the TS
/// `applyMcp`.
pub fn apply(ctx: &AppContext, args: ApplyMcpArgs) -> ApplyMcpResult {
    let _guard = lock(ctx);
    match apply_inner(ctx, &args) {
        Ok((installed, removed, skipped)) => ApplyMcpResult::ok(installed, removed, skipped),
        Err(e) => ApplyMcpResult::err(e),
    }
}

/// The fallible body of [`apply`], run under the state lock.
fn apply_inner(
    ctx: &AppContext,
    args: &ApplyMcpArgs,
) -> Result<(usize, usize, Vec<McpSkipped>), String> {
    let mut installed = 0usize;
    let mut removed = 0usize;
    let mut skipped: Vec<McpSkipped> = Vec::new();

    for batch in &args.batches {
        let is_codex = batch.agent == AgentKind::Codex;
        let target = resolve_mcp_target(ctx, batch.agent, &args.project_path, &args.project_id)?;

        for rem in &batch.remove {
            remove_mcp_instance(
                &ctx.fs,
                &RemoveMcpArgs {
                    agent: batch.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    instance_name: rem.instance_name.clone(),
                },
            )
            .map_err(|e| e.to_string())?;
            removed += 1;
        }

        for ins in &batch.install {
            if !supports_transport(batch.agent, ins.def.transport) {
                skipped.push(McpSkipped {
                    agent: batch.agent,
                    source: ins.identity.source.clone(),
                    transport: ins.def.transport,
                });
                continue;
            }
            let values = resolve_install_values(ctx, args, ins);
            install_mcp_instance(
                &ctx.fs,
                &InstallMcpArgs {
                    agent: batch.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    identity: ins.identity.to_core(),
                    def: ins.def.clone(),
                    values,
                    instance_name: None,
                    gitignore_project_path: if is_codex {
                        None
                    } else {
                        Some(args.project_path.clone())
                    },
                },
            )
            .map_err(|e| e.to_string())?;
            installed += 1;
        }
    }

    Ok((installed, removed, skipped))
}

// ---------------------------------------------------------------------------
// mcp:installs
// ---------------------------------------------------------------------------

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
/// [`McpInstall`]: the four project agents across all tracked projects, plus the
/// codex global ledger. Read-only (no pruning). Port of the TS `listMcpInstalls`.
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
        for agent in PROJECT_MCP_AGENTS {
            if let Ok(target) = resolve_mcp_target(ctx, agent, &project.path, &project.id) {
                collect_installs(ctx, &mut out, &project.id, agent, &target);
            }
        }
    }

    if let Ok(target) = resolve_mcp_target(ctx, AgentKind::Codex, "", "") {
        collect_installs(ctx, &mut out, "global", AgentKind::Codex, &target);
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
        for agent in PROJECT_MCP_AGENTS {
            if let Ok(target) = resolve_mcp_target(ctx, agent, &project.path, &project.id) {
                // A ledger whose native config is malformed is skipped, mirroring
                // the per-project try/catch in the TS source.
                let _ = reconcile_ledger(ctx, &mut out, &project.id, agent, &target);
            }
        }
    }

    if let Ok(target) = resolve_mcp_target(ctx, AgentKind::Codex, "", "") {
        let _ = reconcile_ledger(ctx, &mut out, "global", AgentKind::Codex, &target);
    }

    out
}

// ---------------------------------------------------------------------------
// mcp:update / mcp:update-preflight
// ---------------------------------------------------------------------------

/// Read an instance's stored param values from its own `.skmcp.params.yml` entry
/// (`None` when the file or the entry is absent). Port of the TS
/// `readStoredParams`.
fn read_stored_params(
    ctx: &AppContext,
    target: &McpTarget,
    instance_name: &str,
) -> Result<Option<BTreeMap<String, String>>, String> {
    if !ctx
        .fs
        .exists(&target.params_path)
        .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let params = parse_skmcp_params(
        &ctx.fs
            .read_file(&target.params_path)
            .map_err(|e| e.to_string())?,
    );
    Ok(params.get(instance_name).cloned())
}

/// `mcp:update-preflight` -- compute which of the new def's `{param}`
/// placeholders are absent from the instance's OWN stored params (the only params
/// the renderer needs to prompt for; stored values are never disclosed). Port of
/// the TS `mcpUpdatePreflight`.
pub fn update_preflight(
    ctx: &AppContext,
    args: McpUpdatePreflightArgs,
) -> McpUpdatePreflightResult {
    match preflight_inner(ctx, &args) {
        Ok(missing) => McpUpdatePreflightResult::ok(missing),
        Err(e) => McpUpdatePreflightResult::err(e),
    }
}

fn preflight_inner(ctx: &AppContext, args: &McpUpdatePreflightArgs) -> Result<Vec<String>, String> {
    let target = resolve_mcp_target(ctx, args.agent, &args.project_path, &args.project_id)?;
    let stored = read_stored_params(ctx, &target, &args.instance_name)?;
    Ok(missing_params(&args.def, stored.as_ref()))
}

/// `mcp:update` -- update installed instances in place: for each, remove the old
/// instance and reinstall under the SAME name with the NEW def. Param values are
/// resolved server-side (the instance's own stored values merged under any
/// renderer-supplied newly-required params); the reinstall refreshes the ledger
/// hash automatically. Port of the TS `updateMcp`.
pub fn update(ctx: &AppContext, args: UpdateMcpArgs) -> UpdateMcpResult {
    let _guard = lock(ctx);
    match update_inner(ctx, &args) {
        Ok(updated) => UpdateMcpResult::ok(updated),
        Err(e) => UpdateMcpResult::err(e),
    }
}

fn update_inner(ctx: &AppContext, args: &UpdateMcpArgs) -> Result<usize, String> {
    let mut updated = 0usize;
    for u in &args.updates {
        let is_codex = u.agent == AgentKind::Codex;
        let target = resolve_mcp_target(ctx, u.agent, &u.project_path, &u.project_id)?;
        let stored = read_stored_params(ctx, &target, &u.instance_name)?;
        let mut values = stored.unwrap_or_default();
        for (key, value) in &u.values {
            values.insert(key.clone(), value.clone());
        }
        remove_mcp_instance(
            &ctx.fs,
            &RemoveMcpArgs {
                agent: u.agent,
                native_path: target.native_path.clone(),
                ledger_path: target.ledger_path.clone(),
                params_path: target.params_path.clone(),
                guidance_files: target.guidance_files.clone(),
                instance_name: u.instance_name.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
        install_mcp_instance(
            &ctx.fs,
            &InstallMcpArgs {
                agent: u.agent,
                native_path: target.native_path.clone(),
                ledger_path: target.ledger_path.clone(),
                params_path: target.params_path.clone(),
                guidance_files: target.guidance_files.clone(),
                identity: u.identity.to_core(),
                def: u.def.clone(),
                values,
                instance_name: Some(u.instance_name.clone()),
                gitignore_project_path: if is_codex {
                    None
                } else {
                    Some(u.project_path.clone())
                },
            },
        )
        .map_err(|e| e.to_string())?;
        updated += 1;
    }
    Ok(updated)
}

// ---------------------------------------------------------------------------
// Tauri command wrappers. Thin adapters over the `&AppContext` functions above.
// ---------------------------------------------------------------------------

/// `mcp:list-available`.
#[tauri::command]
pub async fn mcp_list_available(
    ctx: State<'_, Arc<AppContext>>,
) -> Result<Vec<AvailableMcp>, String> {
    blocking(&ctx, list_available).await
}

/// `mcp:apply`.
#[tauri::command]
pub async fn mcp_apply(
    ctx: State<'_, Arc<AppContext>>,
    args: ApplyMcpArgs,
) -> Result<ApplyMcpResult, String> {
    blocking(&ctx, move |c| apply(c, args)).await
}

/// `mcp:installs`.
#[tauri::command]
pub async fn mcp_installs(ctx: State<'_, Arc<AppContext>>) -> Result<Vec<McpInstall>, String> {
    blocking(&ctx, installs).await
}

/// `mcp:reconcile`.
#[tauri::command]
pub async fn mcp_reconcile(ctx: State<'_, Arc<AppContext>>) -> Result<Vec<McpInstall>, String> {
    blocking(&ctx, reconcile).await
}

/// `mcp:update`.
#[tauri::command]
pub async fn mcp_update(
    ctx: State<'_, Arc<AppContext>>,
    args: UpdateMcpArgs,
) -> Result<UpdateMcpResult, String> {
    blocking(&ctx, move |c| update(c, args)).await
}

/// `mcp:update-preflight`.
#[tauri::command]
pub async fn mcp_update_preflight(
    ctx: State<'_, Arc<AppContext>>,
    args: McpUpdatePreflightArgs,
) -> Result<McpUpdatePreflightResult, String> {
    blocking(&ctx, move |c| update_preflight(c, args)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use crate::state::{AppContext, AppPaths};
    use skillkeeper_core::adapters::SystemHostEnv;
    use skillkeeper_core::models::{
        AppState, Project, Repository, RepositoryKind, Transport, STATE_VERSION,
    };
    use skillkeeper_core::state::state::save_state;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    // ---- fixtures ----

    /// A throwaway project directory (the install destination base).
    struct ProjectDir {
        path: PathBuf,
    }

    impl ProjectDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-mcp-proj-{}-{}", std::process::id(), n));
            std::fs::create_dir_all(&path).expect("create project dir");
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

    /// A context whose home directory is a throwaway temp dir (via the
    /// `SystemHostEnv::with_home` test seam), so codex (global-scope) writes
    /// never touch the real home.
    struct CodexApp {
        base: PathBuf,
        home: PathBuf,
        ctx: AppContext,
    }

    impl CodexApp {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let base = std::env::temp_dir().join(format!(
                "skillkeeper-mcp-codex-{}-{}",
                std::process::id(),
                n
            ));
            let home = base.join("home");
            let app = base.join("app");
            std::fs::create_dir_all(&home).expect("create home dir");
            std::fs::create_dir_all(&app).expect("create app dir");

            // Use the host-env test seam so the temp home is captured directly,
            // without mutating process-global HOME/USERPROFILE (which is racy
            // under parallel tests and previously leaked writes into the real
            // ~/.codex).
            let env = SystemHostEnv::with_home(home.to_string_lossy().into_owned());

            let paths = AppPaths {
                config_yaml: app.join("config.yaml").to_string_lossy().into_owned(),
                state_json: app.join("state.json").to_string_lossy().into_owned(),
                repositories_dir: app.join("repositories").to_string_lossy().into_owned(),
            };
            let ctx = AppContext::with_paths(env, paths).unwrap();
            Self { base, home, ctx }
        }
    }

    impl Drop for CodexApp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    fn seed_project(app: &TempAppData, proj: &ProjectDir) {
        let project = Project {
            id: "proj-1".to_string(),
            path: proj.path(),
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
    }

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A stdio def with an `env` `TOKEN={token}` placeholder.
    fn stdio_token_def() -> McpServerDef {
        McpServerDef {
            name: "GitHub".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("npx".to_string()),
            args: Some(vec!["-y".to_string(), "server".to_string()]),
            env: Some(values(&[("TOKEN", "{token}")])),
            rules: None,
        }
    }

    /// The same stdio def with an extra `{org}` arg placeholder (an "updated"
    /// source that requires one new param).
    fn stdio_token_org_def() -> McpServerDef {
        McpServerDef {
            args: Some(vec!["--org".to_string(), "{org}".to_string()]),
            ..stdio_token_def()
        }
    }

    fn http_def() -> McpServerDef {
        McpServerDef {
            name: "Remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
        }
    }

    fn identity() -> McpIdentityArg {
        McpIdentityArg {
            remote: Some("git@github.com:acme/mcps.git".to_string()),
            group: None,
            local: None,
            source: "github".to_string(),
        }
    }

    fn install_req(def: McpServerDef, vals: &[(&str, &str)]) -> McpInstallReq {
        McpInstallReq {
            identity: identity(),
            def,
            values: values(vals),
            copy_params_from: None,
        }
    }

    fn apply_args(proj: &ProjectDir, batches: Vec<McpBatch>) -> ApplyMcpArgs {
        ApplyMcpArgs {
            project_id: "proj-1".to_string(),
            project_path: proj.path(),
            batches,
        }
    }

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
        assert_eq!(out.len(), 2);
        let root = out.iter().find(|m| m.group.is_none()).unwrap();
        assert_eq!(root.def.name, "root-srv");
        assert_eq!(root.repo_id, "repo-1");
        assert!(!root.hash.is_empty());
        let group = out.iter().find(|m| m.group.is_some()).unwrap();
        assert_eq!(group.group.as_deref(), Some("devtools"));
        assert_eq!(group.def.name, "dt-srv");
    }

    #[test]
    fn list_available_is_empty_without_repositories() {
        let app = TempAppData::new();
        assert!(list_available(&app.ctx).is_empty());
    }

    // ---- apply (JSON: claude) ----

    #[test]
    fn apply_creates_native_server_ledger_and_gitignore() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        let result = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![install_req(stdio_token_def(), &[("token", "secret123")])],
                    remove: vec![],
                }],
            ),
        );
        assert!(result.ok, "apply failed: {:?}", result.error);
        assert_eq!(result.installed, Some(1));
        assert_eq!(result.removed, Some(0));
        assert_eq!(result.skipped.as_ref().map(Vec::len), Some(0));

        // Native config written to the claude project destination.
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json"))
            .expect("native config written");
        assert!(native.contains("github_1"));
        assert!(native.contains("secret123"));
        assert!(!native.contains("{token}"));

        // gitignore ensured for the project.
        let gitignore = std::fs::read_to_string(Path::new(&proj.path()).join(".gitignore"))
            .expect("gitignore written");
        assert!(gitignore.contains(".skmcp.params.yml"));

        // Ledger round-trips via installs(); hasParams true (token stored).
        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent, AgentKind::Claude);
        assert_eq!(listed[0].instance_name, "github_1");
        assert_eq!(listed[0].identity.source, "github");
        assert_eq!(listed[0].project_id, "proj-1");
        assert!(listed[0].has_params);
    }

    #[test]
    fn apply_preserves_a_foreign_user_server_and_removal_is_idempotent() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        seed_project(&app, &proj);

        // A user-authored server SkillKeeper must never clobber.
        std::fs::write(
            Path::new(&proj.path()).join(".mcp.json"),
            "{\n  \"mcpServers\": {\n    \"user_server\": { \"type\": \"stdio\", \"command\": \"user-defined\" }\n  }\n}\n",
        )
        .unwrap();

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
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("user-defined"), "foreign server clobbered");
        assert!(native.contains("github_1"));

        // Remove our instance; the foreign server survives.
        let removed = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![],
                    remove: vec![McpRemoveReq {
                        instance_name: "github_1".to_string(),
                    }],
                }],
            ),
        );
        assert!(removed.ok);
        assert_eq!(removed.removed, Some(1));
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("user-defined"));
        assert!(!native.contains("github_1"));

        // Removing the same (now absent) instance again is a safe no-op.
        let again = apply(
            &app.ctx,
            apply_args(
                &proj,
                vec![McpBatch {
                    agent: AgentKind::Claude,
                    install: vec![],
                    remove: vec![McpRemoveReq {
                        instance_name: "github_1".to_string(),
                    }],
                }],
            ),
        );
        assert!(again.ok);
        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("user-defined"));
        assert!(installs(&app.ctx).is_empty());
    }

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

    // ---- update / preflight ----

    #[test]
    fn update_preflight_reports_only_newly_required_params_then_update_reinstalls() {
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

        // Preflight the updated def: token is stored, only org is missing.
        let pre = update_preflight(
            &app.ctx,
            McpUpdatePreflightArgs {
                project_id: "proj-1".to_string(),
                project_path: proj.path(),
                agent: AgentKind::Claude,
                instance_name: "github_1".to_string(),
                def: stdio_token_org_def(),
            },
        );
        assert!(pre.ok);
        assert_eq!(
            pre.missing_params.as_deref(),
            Some(["org".to_string()].as_slice())
        );

        // Update supplying only the newly-required org; token is merged from store.
        let updated = update(
            &app.ctx,
            UpdateMcpArgs {
                updates: vec![McpUpdateReq {
                    project_id: "proj-1".to_string(),
                    project_path: proj.path(),
                    agent: AgentKind::Claude,
                    instance_name: "github_1".to_string(),
                    identity: identity(),
                    def: stdio_token_org_def(),
                    values: values(&[("org", "acme")]),
                }],
            },
        );
        assert!(updated.ok, "update failed: {:?}", updated.error);
        assert_eq!(updated.updated, Some(1));

        let native = std::fs::read_to_string(Path::new(&proj.path()).join(".mcp.json")).unwrap();
        assert!(native.contains("acme"));
        assert!(native.contains("abc")); // stored token preserved

        // Ledger hash refreshed to the new def; instance name reused.
        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instance_name, "github_1");
        assert_eq!(listed[0].hash, hash_mcp_def(&stdio_token_org_def()));
    }

    // ---- codex (TOML) + transport gating ----

    #[test]
    fn apply_writes_codex_toml_and_installs_reports_global_scope() {
        let app = CodexApp::new();

        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                project_id: String::new(),
                project_path: String::new(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(stdio_token_def(), &[("token", "abc")])],
                    remove: vec![],
                }],
            },
        );
        assert!(result.ok, "codex apply failed: {:?}", result.error);
        assert_eq!(result.installed, Some(1));

        // Native config is TOML under the (temp) home .codex dir.
        let toml = std::fs::read_to_string(app.home.join(".codex/config.toml"))
            .expect("codex config written");
        assert!(toml.contains("[mcp_servers.github_1]"));
        assert!(toml.contains("npx"));
        assert!(toml.contains("abc"));

        // Codex is global-scoped and takes no gitignore.
        let listed = installs(&app.ctx);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent, AgentKind::Codex);
        assert_eq!(listed[0].project_id, "global");
        assert_eq!(listed[0].instance_name, "github_1");
    }

    #[test]
    fn apply_skips_an_install_whose_transport_the_agent_cannot_express() {
        let app = CodexApp::new();

        // Codex is stdio-only; an http def is skipped, not installed.
        let result = apply(
            &app.ctx,
            ApplyMcpArgs {
                project_id: String::new(),
                project_path: String::new(),
                batches: vec![McpBatch {
                    agent: AgentKind::Codex,
                    install: vec![install_req(http_def(), &[])],
                    remove: vec![],
                }],
            },
        );
        assert!(result.ok);
        assert_eq!(result.installed, Some(0));
        let skipped = result.skipped.expect("skipped list present");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].agent, AgentKind::Codex);
        assert_eq!(skipped[0].source, "github");
        assert_eq!(skipped[0].transport, McpTransport::Http);
        assert!(installs(&app.ctx).is_empty());
    }
}
