//! `skillkeeper mcp` command group: list, install, remove, update.
//!
//! Port of `packages/cli/src/commands/mcp.ts`. MCP presets come from two
//! origins: repository `mcp.yml`/`mcp.yaml` files (the repo root, no group, plus
//! one per group directory found via `preset_group_dirs`, however deeply
//! nested) and manual presets recorded in
//! `config.mcp.servers`. Installing an instance renders `{param}` placeholders
//! and writes the target agent's native MCP config, tracking the install in the
//! `.skmcp.yml` / `.skmcp.params.yml` ledgers under that agent's skills
//! destination root (the SAME root the skill engine resolves). Codex installs
//! are always global.
//!
//! Target resolution (`resolve_mcp_target`) mirrors the desktop `mcp.rs`; the
//! transform/ledger/params logic is the shared core `mcp` subsystem.

use std::collections::BTreeMap;
use std::io::Write;

use clap::Subcommand;
use skillkeeper_agents::AdapterRegistry;
use skillkeeper_config::{McpPreset, McpTransport as ConfigTransport};
use skillkeeper_core::git_remote::normalize_remote;
use skillkeeper_core::mcp::discovery::preset_group_dirs;
use skillkeeper_core::mcp::{
    hash_mcp_def, install_mcp_instance, mcp_destination, missing_params, parse_mcp_config,
    parse_skmcp, parse_skmcp_params, remove_mcp_instance, supports_transport, InstallMcpArgs,
    McpDestinationTarget, McpIdentity, McpServerDef, McpTransport, RemoveMcpArgs, SkmcpEntry,
    SKMCP_FILE, SKMCP_PARAMS_FILE,
};
use skillkeeper_core::models::{AgentKind, AgentTarget, Scope};
use skillkeeper_core::ports::{FsPort, HostEnv};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::load_state;

use crate::commands::agenthelpers::ProjectEnv;
use crate::commands::resolvewarnings::print_resolve_warnings;
use crate::error::CliError;

/// The four project-scoped MCP agents; codex is handled separately (global).
const PROJECT_MCP_AGENTS: [AgentKind; 4] = [
    AgentKind::Claude,
    AgentKind::Cursor,
    AgentKind::Copilot,
    AgentKind::Opencode,
];

/// Every agent, for a global-scope pass over MCP ledgers (`mcp update --all`
/// and `mcp update --global`).
const ALL_MCP_AGENTS: [AgentKind; 5] = [
    AgentKind::Claude,
    AgentKind::Codex,
    AgentKind::Copilot,
    AgentKind::Cursor,
    AgentKind::Opencode,
];

/// The mcp.yml/mcp.yaml file names, in precedence order.
const MCP_FILE_NAMES: [&str; 2] = ["mcp.yml", "mcp.yaml"];

/// `mcp <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum McpAction {
    /// List available MCP presets.
    List,
    /// Install an MCP preset for one or more agents.
    Install {
        /// Preset name (`group/name` or `name`).
        name: String,
        /// Project directory (default: cwd). Mutually exclusive with --global.
        #[arg(long)]
        project: Option<String>,
        /// Agent(s) to install for (repeatable or comma-separated).
        #[arg(long)]
        agent: Vec<String>,
        /// Parameter value `name=value` (repeatable).
        #[arg(long)]
        param: Vec<String>,
        /// Install for the whole user instead of a project.
        #[arg(long, conflicts_with = "project")]
        global: bool,
    },
    /// Remove an installed MCP instance.
    Remove {
        /// The assigned instance name (the native config key).
        instance_name: String,
        /// Agent the instance is installed for.
        #[arg(long)]
        agent: String,
        /// Project directory (default: cwd). Mutually exclusive with --global.
        #[arg(long)]
        project: Option<String>,
        /// Act on the user-wide installs instead of a project's.
        #[arg(long, conflicts_with = "project")]
        global: bool,
    },
    /// Reinstall MCP instances whose source definition changed.
    Update {
        /// Preset name to limit to (`group/name` or `name`); omit for all.
        name: Option<String>,
        /// Project directory (default: cwd); ignored with --all. Mutually
        /// exclusive with --global.
        #[arg(long)]
        project: Option<String>,
        /// Agent(s) to check (repeatable/comma-separated; default: all project agents).
        #[arg(long)]
        agent: Vec<String>,
        /// Check every tracked project and agent, plus every agent's global ledger.
        #[arg(long)]
        all: bool,
        /// Value `name=value` for a newly-required parameter (repeatable).
        #[arg(long)]
        param: Vec<String>,
        /// Act on the user-wide installs instead of a project's.
        #[arg(long, conflicts_with_all = ["project", "all"])]
        global: bool,
    },
}

/// The wired dependencies shared by every `mcp` operation.
pub struct McpCtx<'a> {
    pub fs: &'a dyn FsPort,
    pub registry: &'a AdapterRegistry,
    pub env: &'a dyn HostEnv,
    pub state_path: &'a str,
    /// Manual presets from `config.mcp.servers`.
    pub manual_presets: &'a [McpPreset],
    /// The current working directory (project default).
    pub cwd: &'a str,
}

/// One MCP preset available for install: repo-discovered or manual.
struct PresetEntry {
    origin: &'static str,
    def: McpServerDef,
    remote: Option<String>,
    group: Option<String>,
    local_id: Option<String>,
}

/// A transport as its wire string.
fn transport_str(t: McpTransport) -> &'static str {
    match t {
        McpTransport::Stdio => "stdio",
        McpTransport::Http => "http",
        McpTransport::Sse => "sse",
    }
}

/// Map a config manual-preset transport onto the core transport.
fn to_core_transport(t: ConfigTransport) -> McpTransport {
    match t {
        ConfigTransport::Stdio => McpTransport::Stdio,
        ConfigTransport::Http => McpTransport::Http,
        ConfigTransport::Sse => McpTransport::Sse,
    }
}

/// Convert a config manual [`McpPreset`] into a raw [`McpServerDef`] (dropping the
/// preset `id`, which becomes the ledger identity's `local`).
fn preset_to_def(preset: &McpPreset) -> McpServerDef {
    McpServerDef {
        name: preset.name.clone(),
        transport: to_core_transport(preset.r#type),
        url: preset.url.clone(),
        headers: preset.headers.clone(),
        command: preset.command.clone(),
        args: preset.args.clone(),
        env: preset.env.clone(),
        rules: preset.rules.clone(),
    }
}

/// Read and parse the first mcp.yml/mcp.yaml found directly under `dir`
/// (preferring `mcp.yml`). Empty on absent/unparsable. Port of `readMcpDefs`.
fn read_mcp_defs(fs: &dyn FsPort, dir: &str, err: &mut dyn Write) -> Vec<McpServerDef> {
    for file_name in MCP_FILE_NAMES {
        let path = format!("{dir}/{file_name}");
        if !fs.exists(&path).unwrap_or(false) {
            continue;
        }
        let text = match fs.read_file(&path) {
            Ok(t) => t,
            // Present but unreadable (permissions, I/O, not valid UTF-8). This
            // used to return silently, making a skipped file look like an
            // absent one.
            Err(e) => {
                let _ = writeln!(err, "[mcp] Could not read \"{path}\": {e}");
                return Vec::new();
            }
        };
        return match parse_mcp_config(&text) {
            Ok(cfg) => {
                // A file that only parsed because of the YAML leniency still
                // says so: tolerated is not the same as correct, and the note
                // names the line to quote.
                for warning in &cfg.warnings {
                    let _ = writeln!(err, "[mcp] {path}: {warning}");
                }
                cfg.servers
            }
            Err(e) => {
                let _ = writeln!(err, "[mcp] Skipping invalid MCP config at \"{path}\": {e}");
                Vec::new()
            }
        };
    }
    Vec::new()
}

/// Every MCP preset available: repo-discovered (root + skill-group directories)
/// plus every manual preset from config. Port of `listPresets`.
fn list_presets(ctx: &McpCtx, err: &mut dyn Write) -> Vec<PresetEntry> {
    let mut out = Vec::new();
    let state = match load_state(ctx.fs, ctx.state_path) {
        Ok(s) => s,
        Err(_) => return out,
    };

    for repo in &state.repositories {
        if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
            continue;
        }
        for def in read_mcp_defs(ctx.fs, &repo.local_path, err) {
            out.push(PresetEntry {
                origin: "repo",
                def,
                remote: Some(repo.url.clone()),
                group: None,
                local_id: None,
            });
        }
        // Group candidates: every ancestor directory of each resolved skill, so
        // `a/b` counts even when the only skill is at `a/b/c/deep` and that
        // directory holds no skill of its own.
        // A skill that fails to resolve cannot contribute its directory as a
        // group, so an unresolved path can also hide a group's `mcp.yml` --
        // worth reporting here, not only from the skill commands.
        let resolved = resolve_skills(ctx.fs, &repo.local_path);
        let _ = print_resolve_warnings(err, &repo.name, &resolved.warnings);
        for group in preset_group_dirs(&resolved.skills) {
            let dir = format!("{}/{}", repo.local_path, group);
            for def in read_mcp_defs(ctx.fs, &dir, err) {
                out.push(PresetEntry {
                    origin: "repo",
                    def,
                    remote: Some(repo.url.clone()),
                    group: Some(group.clone()),
                    local_id: None,
                });
            }
        }
    }

    for preset in ctx.manual_presets {
        out.push(PresetEntry {
            origin: "manual",
            def: preset_to_def(preset),
            remote: None,
            group: None,
            local_id: Some(preset.id.clone()),
        });
    }

    out
}

/// Display/match label for a preset: `group/name` when grouped, else `name`.
fn preset_label(p: &PresetEntry) -> String {
    match &p.group {
        Some(group) => format!("{group}/{}", p.def.name),
        None => p.def.name.clone(),
    }
}

/// The `.skmcp.yml` ledger identity for a preset entry.
fn preset_identity(p: &PresetEntry) -> McpIdentity {
    McpIdentity {
        remote: p.remote.clone(),
        group: p.group.clone(),
        local: p.local_id.clone(),
        source: p.def.name.clone(),
    }
}

/// Resolve one preset by exact `def.name` or its `group/name` label. Errors when
/// none or more than one match. Port of `findPreset`.
fn find_preset(presets: Vec<PresetEntry>, name: &str) -> Result<PresetEntry, CliError> {
    let mut matches: Vec<PresetEntry> = presets
        .into_iter()
        .filter(|p| p.def.name == name || preset_label(p) == name)
        .collect();
    if matches.is_empty() {
        return Err(CliError(format!("MCP preset not found: {name}")));
    }
    if matches.len() > 1 {
        let labels: Vec<String> = matches
            .iter()
            .map(|p| format!("{} ({})", preset_label(p), p.origin))
            .collect();
        return Err(CliError(format!(
            "Ambiguous MCP preset name \"{name}\"; candidates: {}",
            labels.join(", ")
        )));
    }
    Ok(matches.remove(0))
}

/// The resolved on-disk locations one MCP install writes to for an agent.
struct McpTarget {
    native_path: String,
    ledger_path: String,
    params_path: String,
    guidance_files: Vec<String>,
    /// The scope these paths were actually resolved at, which is not always the
    /// requested one (codex is global-only). Gate anything that depends on
    /// where the write lands -- the `.gitignore` entry above all -- on THIS,
    /// never on the requested scope, or the two can disagree.
    scope: Scope,
}

/// The scope an MCP write for `agent` really lands at. Codex has no
/// project-scoped native config, so it is always global no matter what was
/// requested.
fn resolved_mcp_scope(agent: AgentKind, requested: Scope) -> Scope {
    if agent == AgentKind::Codex {
        Scope::Global
    } else {
        requested
    }
}

/// Resolve where one MCP install for `agent` writes at `scope`: the native
/// config path, the ledger/params paths under the agent's skills destination
/// root for that scope (the SAME root the skills engine resolves), and the
/// agent's guidance file. Codex is global-only and ignores `scope`. Port of
/// `resolveMcpTarget`; mirrors the desktop `mcp.rs` version.
fn resolve_mcp_target(
    ctx: &McpCtx,
    agent: AgentKind,
    scope: Scope,
    project_path: &str,
    project_id: &str,
) -> Result<McpTarget, CliError> {
    let resolved = resolved_mcp_scope(agent, scope);
    let target = match resolved {
        Scope::Global => AgentTarget::global(agent),
        Scope::Project => AgentTarget::project(agent, Some(project_id)),
    };
    let env = ProjectEnv {
        inner: ctx.env,
        project_path: project_path.to_string(),
    };
    let native = mcp_destination(
        agent,
        resolved,
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
        scope: resolved,
    })
}

/// Split a repeatable/comma-separated option into a de-duplicated list. Port of
/// `collectCsv`.
fn collect_csv(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for value in values {
        for part in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if !out.iter().any(|p| p == part) {
                out.push(part.to_string());
            }
        }
    }
    out
}

/// Parse repeatable `--param name=value` entries into a map. Errors on a
/// malformed entry (no `=`, or empty name). Port of `collectParam`.
fn collect_params(values: &[String]) -> Result<BTreeMap<String, String>, CliError> {
    let mut out = BTreeMap::new();
    for entry in values {
        match entry.find('=') {
            Some(idx) if idx > 0 => {
                out.insert(entry[..idx].to_string(), entry[idx + 1..].to_string());
            }
            _ => {
                return Err(CliError(format!(
                    "Invalid --param \"{entry}\"; expected name=value"
                )))
            }
        }
    }
    Ok(out)
}

/// Map a `--agent` string to an [`AgentKind`], or `None` when unknown.
fn agent_kind(name: &str) -> Option<AgentKind> {
    match name {
        "claude" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        "copilot" => Some(AgentKind::Copilot),
        "cursor" => Some(AgentKind::Cursor),
        "opencode" => Some(AgentKind::Opencode),
        _ => None,
    }
}

/// True when a ledger entry's identity matches `preset`. Port of `identityMatches`.
fn identity_matches(entry: &SkmcpEntry, preset: &PresetEntry) -> bool {
    if preset.origin == "manual" {
        return entry.local.is_some()
            && entry.local == preset.local_id
            && entry.source == preset.def.name;
    }
    match (&entry.remote, &preset.remote) {
        (Some(er), Some(pr)) => {
            normalize_remote(er) == normalize_remote(pr)
                && entry.group == preset.group
                && entry.source == preset.def.name
        }
        _ => false,
    }
}

/// `mcp list`.
pub fn list(ctx: &McpCtx, out: &mut dyn Write, err: &mut dyn Write) -> Result<i32, CliError> {
    let presets = list_presets(ctx, err);
    if presets.is_empty() {
        writeln!(out, "No MCP presets available.")?;
        return Ok(0);
    }
    for p in &presets {
        let source = if p.origin == "manual" {
            format!("manual:{}", p.local_id.as_deref().unwrap_or(""))
        } else {
            p.remote
                .clone()
                .unwrap_or_else(|| "(unknown remote)".to_string())
        };
        writeln!(
            out,
            "{}  origin={}  type={}  source={source}",
            preset_label(p),
            p.origin,
            transport_str(p.def.transport),
        )?;
    }
    Ok(0)
}

/// `mcp install <name>`.
#[allow(clippy::too_many_arguments)]
pub fn install(
    ctx: &McpCtx,
    name: &str,
    project: Option<&str>,
    agents: &[String],
    params: &[String],
    global: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let agents = collect_csv(agents);
    if agents.is_empty() {
        writeln!(err, "At least one --agent is required.")?;
        return Ok(1);
    }
    let preset = match find_preset(list_presets(ctx, err), name) {
        Ok(p) => p,
        Err(e) => {
            writeln!(err, "{e}")?;
            return Ok(1);
        }
    };
    let values = collect_params(params)?;
    let missing = missing_params(&preset.def, Some(&values));
    if !missing.is_empty() {
        writeln!(
            err,
            "Missing values for mcp params: {}. Pass --param <name>=<value>.",
            missing.join(", ")
        )?;
        return Ok(1);
    }

    let scope = if global {
        Scope::Global
    } else {
        Scope::Project
    };
    // At global scope there is no project directory to record or gitignore.
    let project_path = if global {
        ""
    } else {
        project.unwrap_or(ctx.cwd)
    };
    let identity = preset_identity(&preset);
    let mut any_installed = false;

    for agent_name in &agents {
        let Some(agent) = agent_kind(agent_name) else {
            writeln!(err, "Unknown agent: {agent_name}")?;
            continue;
        };
        if !ctx.registry.has(agent) {
            writeln!(err, "Unknown agent: {agent_name}")?;
            continue;
        }
        if !supports_transport(agent, preset.def.transport) {
            writeln!(
                out,
                "Skipped {agent}: does not support transport \"{}\".",
                transport_str(preset.def.transport)
            )?;
            continue;
        }
        // Codex's MCP config is user-wide; a project-scope request for it
        // cannot be honoured, so refuse rather than silently install globally.
        if agent == AgentKind::Codex && scope == Scope::Project {
            writeln!(
                err,
                "codex MCP servers are user-wide, not per project: pass --global."
            )?;
            continue;
        }
        let target = resolve_mcp_target(ctx, agent, scope, project_path, project_path)?;
        let instance_name = install_mcp_instance(
            ctx.fs,
            &InstallMcpArgs {
                agent,
                native_path: target.native_path.clone(),
                ledger_path: target.ledger_path.clone(),
                params_path: target.params_path.clone(),
                guidance_files: target.guidance_files.clone(),
                identity: identity.clone(),
                def: preset.def.clone(),
                values: values.clone(),
                instance_name: None,
                // Gated on the RESOLVED scope, not the requested one: a global
                // write has no repository to keep the ledger out of.
                gitignore_project_path: if target.scope == Scope::Global {
                    None
                } else {
                    Some(project_path.to_string())
                },
            },
        )
        .map_err(|e| CliError(e.to_string()))?;
        any_installed = true;
        writeln!(
            out,
            "Installed: {instance_name} ({agent}) -> {}",
            target.native_path
        )?;
    }

    Ok(if any_installed { 0 } else { 1 })
}

/// `mcp remove <instanceName>`.
pub fn remove(
    ctx: &McpCtx,
    instance_name: &str,
    agent: &str,
    project: Option<&str>,
    global: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let Some(agent) = agent_kind(agent).filter(|a| ctx.registry.has(*a)) else {
        writeln!(err, "Unknown agent: {agent}")?;
        return Ok(1);
    };
    let scope = if global {
        Scope::Global
    } else {
        Scope::Project
    };
    let project_path = if global {
        ""
    } else {
        project.unwrap_or(ctx.cwd)
    };
    let target = resolve_mcp_target(ctx, agent, scope, project_path, project_path)?;

    if !ctx.fs.exists(&target.ledger_path)? {
        writeln!(err, "No MCP ledger found for {agent}.")?;
        return Ok(1);
    }
    let ledger = parse_skmcp(&ctx.fs.read_file(&target.ledger_path)?);
    let present = ledger
        .as_ref()
        .is_some_and(|l| l.servers.iter().any(|s| s.name == instance_name));
    if !present {
        writeln!(err, "MCP instance not found: {instance_name}")?;
        return Ok(1);
    }

    remove_mcp_instance(
        ctx.fs,
        &RemoveMcpArgs {
            agent,
            native_path: target.native_path,
            ledger_path: target.ledger_path,
            params_path: target.params_path,
            guidance_files: target.guidance_files,
            instance_name: instance_name.to_string(),
        },
    )
    .map_err(|e| CliError(e.to_string()))?;
    writeln!(out, "Removed: {instance_name} ({agent})")?;
    Ok(0)
}

/// Resolve a `--agent` list to concrete kinds: the given agents, or a
/// scope-appropriate default when none were given. Shared by the project and
/// global (non-`--all`) branches of `update` so neither duplicates the
/// fallback. At project scope the default is the four project-capable agents
/// (codex has no project-scoped MCP config); at global scope every agent has
/// a config to check, codex included, so the default is all five -- matching
/// `--all`, which already sweeps codex's global ledger unconditionally.
fn kinds_for(agents: &[String], scope: Scope) -> Vec<AgentKind> {
    let agent_list = collect_csv(agents);
    if agent_list.is_empty() {
        match scope {
            Scope::Project => PROJECT_MCP_AGENTS.to_vec(),
            Scope::Global => ALL_MCP_AGENTS.to_vec(),
        }
    } else {
        agent_list.iter().filter_map(|a| agent_kind(a)).collect()
    }
}

/// One `(agent, scope, project_path, project_id)` scope to check for updates.
struct UpdateScope {
    agent: AgentKind,
    scope: Scope,
    project_path: String,
    project_id: String,
}

/// `mcp update [name]`.
#[allow(clippy::too_many_arguments)]
pub fn update(
    ctx: &McpCtx,
    name: Option<&str>,
    project: Option<&str>,
    agents: &[String],
    all: bool,
    params: &[String],
    global: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let presets = list_presets(ctx, err);
    let override_params = collect_params(params)?;

    let mut scopes: Vec<UpdateScope> = Vec::new();
    if all {
        let state = load_state(ctx.fs, ctx.state_path)?;
        for project in &state.projects {
            for agent in PROJECT_MCP_AGENTS {
                scopes.push(UpdateScope {
                    agent,
                    scope: Scope::Project,
                    project_path: project.path.clone(),
                    project_id: project.id.clone(),
                });
            }
        }
        // Every agent's user-wide ledger, not just codex's.
        for agent in ALL_MCP_AGENTS {
            scopes.push(UpdateScope {
                agent,
                scope: Scope::Global,
                project_path: String::new(),
                project_id: String::new(),
            });
        }
    } else if global {
        for agent in kinds_for(agents, Scope::Global) {
            scopes.push(UpdateScope {
                agent,
                scope: Scope::Global,
                project_path: String::new(),
                project_id: String::new(),
            });
        }
    } else {
        let project_path = project.unwrap_or(ctx.cwd).to_string();
        for agent in kinds_for(agents, Scope::Project) {
            scopes.push(UpdateScope {
                agent,
                scope: Scope::Project,
                project_path: project_path.clone(),
                project_id: project_path.clone(),
            });
        }
    }

    let mut updated = 0usize;
    let mut failed = false;

    for scope in &scopes {
        if !ctx.registry.has(scope.agent) {
            continue;
        }
        // Codex's MCP config is user-wide, so a project-scope request for it
        // cannot be honoured; refuse it the way `install` does rather than
        // updating the user-wide file behind a project's back. Only an explicit
        // `--agent codex` without `--global` reaches this: neither the
        // project-scope default (`PROJECT_MCP_AGENTS`) nor `--all` puts codex at
        // project scope.
        if scope.agent == AgentKind::Codex && scope.scope == Scope::Project {
            writeln!(
                err,
                "codex MCP servers are user-wide, not per project: pass --global."
            )?;
            failed = true;
            continue;
        }
        let target = resolve_mcp_target(
            ctx,
            scope.agent,
            scope.scope,
            &scope.project_path,
            &scope.project_id,
        )?;
        if !ctx.fs.exists(&target.ledger_path)? {
            continue;
        }
        let Some(ledger) = parse_skmcp(&ctx.fs.read_file(&target.ledger_path)?) else {
            continue;
        };
        let params_map = if ctx.fs.exists(&target.params_path)? {
            parse_skmcp_params(&ctx.fs.read_file(&target.params_path)?)
        } else {
            BTreeMap::new()
        };

        for entry in &ledger.servers {
            if let Some(name) = name {
                let grouped = format!("{}/{}", entry.group.as_deref().unwrap_or(""), entry.source);
                if entry.source != name && grouped != name {
                    continue;
                }
            }
            let Some(current) = presets.iter().find(|p| identity_matches(entry, p)) else {
                continue; // source no longer available; leave as-is
            };
            if hash_mcp_def(&current.def) == entry.hash {
                continue; // already up to date
            }

            let mut merged = params_map.get(&entry.name).cloned().unwrap_or_default();
            for (key, value) in &override_params {
                merged.insert(key.clone(), value.clone());
            }
            let missing = missing_params(&current.def, Some(&merged));
            if !missing.is_empty() {
                writeln!(
                    err,
                    "Cannot update {} ({}): missing values for mcp params: {}. Pass --param <name>=<value>.",
                    entry.name,
                    scope.agent,
                    missing.join(", ")
                )?;
                failed = true;
                continue;
            }

            remove_mcp_instance(
                ctx.fs,
                &RemoveMcpArgs {
                    agent: scope.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    instance_name: entry.name.clone(),
                },
            )
            .map_err(|e| CliError(e.to_string()))?;
            install_mcp_instance(
                ctx.fs,
                &InstallMcpArgs {
                    agent: scope.agent,
                    native_path: target.native_path.clone(),
                    ledger_path: target.ledger_path.clone(),
                    params_path: target.params_path.clone(),
                    guidance_files: target.guidance_files.clone(),
                    identity: McpIdentity {
                        remote: entry.remote.clone(),
                        group: entry.group.clone(),
                        local: entry.local.clone(),
                        source: entry.source.clone(),
                    },
                    def: current.def.clone(),
                    values: merged,
                    instance_name: Some(entry.name.clone()),
                    // Gated on the RESOLVED scope, not the requested one: see
                    // `McpTarget::scope`.
                    gitignore_project_path: if target.scope == Scope::Global {
                        None
                    } else {
                        Some(scope.project_path.clone())
                    },
                },
            )
            .map_err(|e| CliError(e.to_string()))?;
            updated += 1;
            writeln!(out, "Updated: {} ({})", entry.name, scope.agent)?;
        }
    }

    if updated == 0 && !failed {
        writeln!(out, "No MCP updates available.")?;
    }
    Ok(if failed { 1 } else { 0 })
}

/// Dispatch an `mcp` subcommand.
pub fn run(
    action: &McpAction,
    ctx: &McpCtx,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        McpAction::List => list(ctx, out, err),
        McpAction::Install {
            name,
            project,
            agent,
            param,
            global,
        } => install(
            ctx,
            name,
            project.as_deref(),
            agent,
            param,
            *global,
            out,
            err,
        ),
        McpAction::Remove {
            instance_name,
            agent,
            project,
            global,
        } => remove(
            ctx,
            instance_name,
            agent,
            project.as_deref(),
            *global,
            out,
            err,
        ),
        McpAction::Update {
            name,
            project,
            agent,
            all,
            param,
            global,
        } => update(
            ctx,
            name.as_deref(),
            project.as_deref(),
            agent,
            *all,
            param,
            *global,
            out,
            err,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillkeeper_agents::register_builtin_agents;
    use skillkeeper_core::models::{
        AppState, Project, Repository, RepositoryKind, Transport, STATE_VERSION,
    };
    use skillkeeper_core::state::state::save_state;
    use skillkeeper_core::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";
    const HOME: &str = "/home/u";
    const PROJECT: &str = "/proj";

    struct FakeEnv;
    impl HostEnv for FakeEnv {
        fn home_dir(&self) -> &str {
            HOME
        }
        fn platform(&self) -> &str {
            "linux"
        }
        fn env(&self, _key: &str) -> Option<String> {
            None
        }
    }

    fn registry() -> AdapterRegistry {
        let mut r = AdapterRegistry::new();
        register_builtin_agents(&mut r).unwrap();
        r
    }

    struct TestApp {
        fs: MemFs,
        registry: AdapterRegistry,
        env: FakeEnv,
        manual: Vec<McpPreset>,
    }

    impl TestApp {
        fn new(fs: MemFs) -> Self {
            Self {
                fs,
                registry: registry(),
                env: FakeEnv,
                manual: Vec::new(),
            }
        }

        fn ctx(&self) -> McpCtx<'_> {
            McpCtx {
                fs: &self.fs,
                registry: &self.registry,
                env: &self.env,
                state_path: STATE_PATH,
                manual_presets: &self.manual,
                cwd: PROJECT,
            }
        }
    }

    fn repo() -> Repository {
        Repository {
            id: "repo-1".to_string(),
            name: "mcps".to_string(),
            url: "git@github.com:acme/mcps.git".to_string(),
            kind: RepositoryKind::Generic,
            transport: Transport::Ssh,
            lfs: false,
            local_path: "/repos/r1".to_string(),
            last_fetched: None,
            branch: None,
        }
    }

    /// A MemFs with one repo carrying a root mcp.yml (stdio, one `{token}` param).
    fn seeded_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    env:\n      TOKEN: \"{token}\"\n",
        )
    }

    fn seed_state(fs: &MemFs) {
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo()],
            projects: vec![Project {
                id: "proj-1".to_string(),
                path: PROJECT.to_string(),
                name: "app".to_string(),
                added_at: "2025-07-17T00:00:00.000Z".to_string(),
            }],
            installs: vec![],
        };
        save_state(fs, STATE_PATH, &state).unwrap();
    }

    #[test]
    fn list_reports_repo_presets_and_empty() {
        let app = TestApp::new(MemFs::new());
        save_state(&app.fs, STATE_PATH, &AppState::empty()).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        list(&app.ctx(), &mut out, &mut err).unwrap();
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No MCP presets available."));

        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        list(&app.ctx(), &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("github  origin=repo  type=stdio"));
        assert!(out.contains("git@github.com:acme/mcps.git"));
    }

    #[test]
    fn lists_a_preset_from_a_nested_group_directory() {
        // A skill three group levels down with an mcp.yml beside it: the preset
        // must be discovered and labelled by its full group path.
        let fs = seeded_fs()
            .with_file("/repos/r1/a/b/c/deep/SKILL.md", "---\nname: deep\n---\n# deep\n")
            .with_file(
                "/repos/r1/a/b/c/mcp.yml",
                "version: 1\nservers:\n  - name: deep-registry\n    type: stdio\n    command: npx\n",
            );
        let app = TestApp::new(fs);
        seed_state(&app.fs);

        let mut out = Vec::new();
        let mut err = Vec::new();
        list(&app.ctx(), &mut out, &mut err).unwrap();
        let out = String::from_utf8(out).unwrap();

        assert!(
            out.contains("a/b/c/deep-registry"),
            "expected a nested preset label, got:\n{out}"
        );
    }

    #[test]
    fn install_renders_native_config_and_ledger() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=secret123".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Installed: github_1 (claude) ->"));

        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(native.contains("github_1"));
        assert!(native.contains("secret123"));
        assert!(!native.contains("{token}"));
        // Ledger written under the claude project skills root.
        assert!(app
            .fs
            .exists(&format!("/proj/.claude/skills/{SKMCP_FILE}"))
            .unwrap());
    }

    #[test]
    fn install_requires_an_agent() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &[],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("At least one --agent is required."));
    }

    #[test]
    fn install_reports_missing_params() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Missing values for mcp params: token"));
    }

    #[test]
    fn install_reports_unknown_preset() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "nope",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("MCP preset not found: nope"));
    }

    #[test]
    fn remove_deletes_an_installed_instance() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(
            &app.ctx(),
            "github_1",
            "claude",
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Removed: github_1 (claude)"));
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(!native.contains("github_1"));
    }

    #[test]
    fn remove_reports_missing_instance() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(
            &app.ctx(),
            "github_9",
            "claude",
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("MCP instance not found: github_9"));
    }

    #[test]
    fn update_reinstalls_when_source_changed() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Change the source def (add a static arg -> new hash, no new param).
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    args:\n      - --verbose\n    env:\n      TOKEN: \"{token}\"\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: github_1 (claude)"));
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(native.contains("--verbose"));
        assert!(native.contains("abc")); // stored token preserved
    }

    #[test]
    fn update_reports_nothing_when_up_to_date() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["claude".to_string()],
            &["token=abc".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["claude".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No MCP updates available."));
    }

    #[test]
    fn kinds_for_defaults_to_project_agents_at_project_scope() {
        assert_eq!(kinds_for(&[], Scope::Project), PROJECT_MCP_AGENTS.to_vec());
    }

    #[test]
    fn kinds_for_defaults_to_every_agent_at_global_scope() {
        // Codex's MCP config exists *only* at global scope, so an empty
        // --agent list at global scope must still cover it -- matching --all,
        // which already sweeps codex's global ledger unconditionally.
        assert_eq!(kinds_for(&[], Scope::Global), ALL_MCP_AGENTS.to_vec());
    }

    #[test]
    fn update_at_global_scope_skips_gitignore_for_a_non_codex_agent() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        // Install claude's MCP server globally; no project is involved.
        install(
            &app.ctx(),
            "github",
            None,
            &["claude".to_string()],
            &["token=abc".to_string()],
            true,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Change the source def (same edit as the project-scope update test).
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    args:\n      - --verbose\n    env:\n      TOKEN: \"{token}\"\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            None,
            &["claude".to_string()],
            false,
            &[],
            true, // --global
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: github_1 (claude)"));
        let native = app.fs.read_file(&format!("{HOME}/.claude.json")).unwrap();
        assert!(native.contains("--verbose"));
        assert!(native.contains("abc")); // stored token preserved

        // The bug this guards against: gating `gitignore_project_path` on
        // `is_codex` instead of the scope reads the global entry's empty
        // `project_path` as a real path and asks `ensure_gitignore` to write
        // "<empty>/.gitignore", i.e. "/.gitignore" at the filesystem root.
        // Reverting the fix locally and running just this test reproduces
        // that file appearing here (see the task report for the captured
        // failure).
        assert!(!app.fs.exists("/.gitignore").unwrap());
    }

    #[test]
    fn resolve_mcp_target_reports_the_scope_it_really_resolved() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        // Codex ignores the requested scope, so the target must report Global --
        // everything gated on "did this write land in a repository?" reads this
        // field rather than the requested scope.
        let codex = resolve_mcp_target(
            &app.ctx(),
            AgentKind::Codex,
            Scope::Project,
            PROJECT,
            PROJECT,
        )
        .unwrap();
        assert_eq!(codex.scope, Scope::Global);
        assert_eq!(codex.native_path, format!("{HOME}/.codex/config.toml"));

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

    #[test]
    fn update_refuses_codex_at_project_scope_and_touches_no_project_gitignore() {
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        // A codex instance exists, installed the only way it can be: globally.
        install(
            &app.ctx(),
            "github",
            None,
            &["codex".to_string()],
            &["token=abc".to_string()],
            true,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        // Its source def changes, so an update has real work to do.
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    args:\n      - --verbose\n    env:\n      TOKEN: \"{token}\"\n",
            )
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            None,
            &["codex".to_string()],
            false,
            &[],
            false, // no --global: the cwd project is the requested scope
            &mut out,
            &mut err,
        )
        .unwrap();

        // `install` already refuses this combination; `update` now does too,
        // instead of writing the user-wide config on a project's behalf.
        assert_eq!(code, 1);
        assert!(String::from_utf8(err).unwrap().contains("--global"));
        // The bug this guards against: the gate keyed on the REQUESTED scope
        // while `resolve_mcp_target` forced codex global, so the reinstall
        // handed `ensure_gitignore` the project path and created (or polluted)
        // a .gitignore in a repository nothing had been written into.
        assert!(!app.fs.exists(&format!("{PROJECT}/.gitignore")).unwrap());
    }
}
