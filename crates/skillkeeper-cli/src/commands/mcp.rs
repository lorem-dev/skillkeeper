//! `skillkeeper mcp` command group: list, install, remove, update.
//!
//! Port of `packages/cli/src/commands/mcp.ts`. MCP presets come from two
//! origins: repository `mcp.yml`/`mcp.yaml` files (the repo root, no group, plus
//! one per group directory found via `preset_group_dirs`, however deeply
//! nested) and manual presets recorded in
//! `config.mcp.servers`. Installing an instance renders `{param}` placeholders
//! and writes the target agent's native MCP config, tracking the install in the
//! `.skmcp.yml` / `.skmcp.params.yml` ledgers under that agent's skills
//! destination root (the SAME root the skill engine resolves).
//!
//! Target resolution (`resolve_mcp_target`) mirrors the desktop `mcp.rs`; the
//! transform/ledger/params logic is the shared core `mcp` subsystem.

use std::collections::BTreeMap;
use std::io::Write;

use clap::Subcommand;
use skillkeeper_agents::AdapterRegistry;
use skillkeeper_config::schema::McpOauth as ConfigOauth;
use skillkeeper_config::{McpPreset, McpTransport as ConfigTransport};
use skillkeeper_core::git_remote::normalize_remote;
use skillkeeper_core::mcp::discovery::preset_group_dirs;
use skillkeeper_core::mcp::markup::{
    parse_description, truncate_spans, DescriptionSpan, DESCRIPTION_BUDGET,
};
use skillkeeper_core::mcp::model::McpOauth;
use skillkeeper_core::mcp::params::{invalid_option_values, migrate_option_values};
use skillkeeper_core::mcp::{
    hash_mcp_def, install_mcp_instance, mcp_destination, missing_params, parse_mcp_config,
    parse_skmcp, parse_skmcp_params, remove_mcp_instance, supports_oauth, supports_transport,
    InstallMcpArgs, McpDestinationTarget, McpIdentity, McpServerDef, McpTransport, RemoveMcpArgs,
    SkmcpEntry, UpsertNote, SKMCP_FILE, SKMCP_PARAMS_FILE,
};
use skillkeeper_core::models::{AgentKind, AgentTarget, Scope};
use skillkeeper_core::ports::{FsPort, HostEnv};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::load_state;

use crate::commands::agenthelpers::ProjectEnv;
use crate::commands::resolvewarnings::print_resolve_warnings;
use crate::error::CliError;

/// Every MCP agent, eligible at both project and global scope: Codex resolves
/// a real project-scoped destination (see `mcp_destination`) exactly like
/// every other agent. Shared by the project pass and the global pass over MCP
/// ledgers (`mcp update --all`, `mcp update --global`, and the default agent
/// list at either scope).
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
        /// Agent(s) to check (repeatable/comma-separated; default: every agent).
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

/// Author-supplied text with its control characters removed, for anything on
/// its way to a terminal.
///
/// A `mcp.yml` comes out of a cloned repository, so every string in it is
/// untrusted text: `\r` alone lets its author overwrite the line SkillKeeper
/// just printed, and an escape sequence can colour or reposition the reader's
/// terminal. This was applied to a description's prose, link text and URL and
/// not to a server's `name`, which `mcp list` and the ambiguous-preset error
/// print from the same file -- so the rule that had a stated reason to live at
/// one boundary was in fact enforced on part of it.
fn printable(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}

/// Render description spans for a terminal: a link becomes its text followed by
/// its URL in parentheses.
///
/// Control characters are dropped from everything printed -- prose, a link's
/// visible text, and its URL. A description comes out of a cloned repository's
/// `mcp.yml`, so it is untrusted text on its way to a terminal: an escape
/// sequence in it would otherwise colour, clear or reposition the reader's
/// terminal, and `\r` alone is enough to overwrite the line SkillKeeper just
/// printed with something the repository author chose. The rule lives here, at
/// the single boundary where any of this reaches a terminal, rather than at
/// each parse site -- `is_allowed_url` refuses a URL with control characters
/// too, but that guards what may become a live link in the desktop app and
/// cannot cover the prose around it.
fn render_spans_for_terminal(spans: &[DescriptionSpan]) -> String {
    fn push_printable(out: &mut String, text: &str) {
        out.push_str(&printable(text));
    }
    let mut out = String::new();
    for span in spans {
        match span {
            DescriptionSpan::Text { text } => push_printable(&mut out, text),
            DescriptionSpan::Link { text, url } => {
                push_printable(&mut out, text);
                out.push_str(" (");
                push_printable(&mut out, url);
                out.push(')');
            }
        }
    }
    out
}

/// One indented line describing a parameter, for the two places a value is
/// asked for or refused: its `description` rendered for a terminal, then its
/// accepted option values. `None` when the parameter has neither, so a
/// parameter with no authoring metadata prints nothing extra.
///
/// Both halves exist because a CLI user has no select to look at: without the
/// accepted set they must guess wrong once to learn it, and without the
/// description they never see the prose the author wrote for exactly this
/// moment.
fn parameter_hint(def: &McpServerDef, name: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(description) = parameter_description(def, name) {
        parts.push(description);
    }
    if let Some(accepted) = accepted_option_values(def, name) {
        parts.push(format!("Accepted: {accepted}."));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!("  {name}: {}", parts.join(" ")))
}

/// A parameter's `description`, parsed and truncated by the one shared markup
/// implementation and rendered for a terminal. `None` when the parameter has
/// no entry, no description, or an empty one.
fn parameter_description(def: &McpServerDef, name: &str) -> Option<String> {
    let description = def.parameters.get(name)?.description.as_deref()?;
    let spans = truncate_spans(parse_description(description), DESCRIPTION_BUDGET);
    let rendered = render_spans_for_terminal(&spans);
    if rendered.is_empty() {
        return None;
    }
    Some(rendered)
}

/// A parameter's accepted option values, comma-separated in document order.
/// `None` when the parameter has no entry or no options, i.e. accepts anything.
fn accepted_option_values(def: &McpServerDef, name: &str) -> Option<String> {
    let parameter = def.parameters.get(name)?;
    if parameter.options.is_empty() {
        return None;
    }
    Some(
        parameter
            .options
            .iter()
            .map(|o| o.value.as_str())
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// One line for a writer note, shaped like the `Skipped ...` lines beside it:
/// what the agent could not do, and what happened instead. Printed to stdout
/// with the install it belongs to -- the install succeeded, so this is not an
/// error, but a dropped auth field must not be silent.
fn note_line(agent: AgentKind, note: &UpsertNote) -> String {
    match note {
        UpsertNote::DroppedField { field } => {
            format!("Note {agent}: cannot express \"{field}\"; it was not written.")
        }
        UpsertNote::CodexCallbackConflict { found, wanted } => format!(
            "Note {agent}: oauth callback port is already {found}; left alone (this server asked for {wanted})."
        ),
        UpsertNote::OptionSubstituted { parameter, value } => format!(
            "Note {agent}: \"{parameter}\" no longer offers its stored value; using \"{value}\" instead."
        ),
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

/// Map a config manual-preset oauth block onto the core one. The two structs
/// mirror each other field-for-field (see the comment on
/// `skillkeeper_config::McpOauth` for why they are mirrored rather than shared),
/// so this is a copy, not a reinterpretation.
fn to_core_oauth(o: &ConfigOauth) -> McpOauth {
    McpOauth {
        callback_port: o.callback_port,
        client_id: o.client_id.clone(),
        scopes: o.scopes.clone(),
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
        // Carried through like every neighbour above: dropping it here would
        // silently install a manual preset without the auth it asked for, and
        // would keep the `supports_oauth` gate below from ever seeing one.
        oauth: preset.oauth.as_ref().map(to_core_oauth),
        description: preset.description.clone(),
        // Manual presets have no config-side equivalent yet.
        parameters: BTreeMap::new(),
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
            .map(|p| format!("{} ({})", printable(&preset_label(p)), p.origin))
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
    /// The scope these paths were resolved at. Carried on the target so that
    /// anything depending on where the write lands -- the `.gitignore` entry
    /// above all -- reads it from the same value that chose the paths.
    ///
    /// It equals the requested scope for every agent. It did not while Codex
    /// was forced to global, which is what the indirection here existed for;
    /// that rule is gone, and keeping a function to express the equality only
    /// suggested a difference that cannot occur.
    scope: Scope,
}

/// Resolve where one MCP install for `agent` writes at `scope`: the native
/// config path, the ledger/params paths under the agent's skills destination
/// root for that scope (the SAME root the skills engine resolves), and the
/// agent's guidance file. Port of `resolveMcpTarget`; mirrors the desktop
/// `mcp.rs` version.
fn resolve_mcp_target(
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
            printable(&preset_label(p)),
            p.origin,
            transport_str(p.def.transport),
        )?;
        if let Some(description) = &p.def.description {
            let spans = truncate_spans(parse_description(description), DESCRIPTION_BUDGET);
            writeln!(out, "    {}", render_spans_for_terminal(&spans))?;
        }
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
        for name in &missing {
            if let Some(hint) = parameter_hint(&preset.def, name) {
                writeln!(err, "{hint}")?;
            }
        }
        return Ok(1);
    }
    let invalid = invalid_option_values(&preset.def, &values);
    if !invalid.is_empty() {
        for (name, value) in &invalid {
            writeln!(
                err,
                "Invalid value \"{value}\" for mcp param \"{name}\". Accepted: {}.",
                accepted_option_values(&preset.def, name).unwrap_or_default()
            )?;
            if let Some(description) = parameter_description(&preset.def, name) {
                writeln!(err, "  {name}: {description}")?;
            }
        }
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
        // Written without its auth block, this server would look installed and
        // fail to authenticate. Skipping is the honest outcome.
        if preset.def.oauth.is_some() && !supports_oauth(agent) {
            writeln!(out, "Skipped {agent}: cannot express an oauth client.")?;
            continue;
        }
        let target = resolve_mcp_target(ctx, agent, scope, project_path, project_path)?;
        let outcome = install_mcp_instance(
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
            "Installed: {} ({agent}) -> {}",
            outcome.instance_name, target.native_path
        )?;
        for note in &outcome.notes {
            writeln!(out, "{}", note_line(agent, note))?;
        }
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

/// Resolve a `--agent` list to concrete kinds: the given agents, or every
/// agent when none were given. Shared by the project and global (non-`--all`)
/// branches of `update` so neither duplicates the fallback. Every agent has a
/// config to check at either scope, codex included, so the default is the
/// same `ALL_MCP_AGENTS` list regardless of scope -- matching `--all`, which
/// already sweeps every agent at both scopes.
fn kinds_for(agents: &[String], _scope: Scope) -> Vec<AgentKind> {
    let agent_list = collect_csv(agents);
    if agent_list.is_empty() {
        ALL_MCP_AGENTS.to_vec()
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
            for agent in ALL_MCP_AGENTS {
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
    // An update this run declined but did not fail on. Tracked only so the
    // summary below does not claim there was nothing to update.
    let mut skipped = false;

    for scope in &scopes {
        if !ctx.registry.has(scope.agent) {
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
            // Validate what the USER just typed, before the up-to-date check
            // and before it is merged over anything stored. Provenance decides
            // the treatment: an override value came from this command line, so
            // refusing it names something the user can fix, whereas migrating
            // it would replace an input made seconds ago and then blame
            // storage for the substitution. A STORED value is migrated
            // instead, below -- nobody can act on an error about a file they
            // may never have opened.
            let invalid = invalid_option_values(&current.def, &override_params);
            if !invalid.is_empty() {
                for (param, value) in &invalid {
                    writeln!(
                        err,
                        "Cannot update {} ({}): invalid value \"{value}\" for mcp param \"{param}\". Accepted: {}.",
                        entry.name,
                        scope.agent,
                        accepted_option_values(&current.def, param).unwrap_or_default()
                    )?;
                    if let Some(description) = parameter_description(&current.def, param) {
                        writeln!(err, "  {param}: {description}")?;
                    }
                }
                failed = true;
                continue;
            }
            if hash_mcp_def(&current.def) == entry.hash {
                continue; // already up to date
            }

            let mut merged = params_map.get(&entry.name).cloned().unwrap_or_default();
            for (key, value) in &override_params {
                merged.insert(key.clone(), value.clone());
            }
            // Bring a STORED option value back in line with the source's
            // current options before anything else checks or uses `merged`:
            // a value an earlier install recorded may no longer be offered.
            // The overrides above are already known to be in the option set,
            // so this only ever migrates what came off disk.
            let option_notes = migrate_option_values(&current.def, &mut merged);
            // Rewritten without its auth block, this server would look
            // updated and fail to authenticate. Declining is the honest
            // outcome -- and it must happen before the remove below, or the
            // instance would be deleted and not put back.
            //
            // Reported like `install`'s skip and NOT counted as a failure: no
            // user can make copilot speak OAuth, so failing here would make
            // every later `mcp update` exit non-zero over a state the run left
            // exactly as it found it, breaking any scripted invocation for good.
            if current.def.oauth.is_some() && !supports_oauth(scope.agent) {
                writeln!(
                    out,
                    "Skipped {} ({}): cannot express an oauth client. Remove it with mcp remove {} --agent {} if it is no longer wanted.",
                    entry.name, scope.agent, entry.name, scope.agent
                )?;
                skipped = true;
                continue;
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
                for param in &missing {
                    if let Some(hint) = parameter_hint(&current.def, param) {
                        writeln!(err, "{hint}")?;
                    }
                }
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
            let outcome = install_mcp_instance(
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
            for note in &option_notes {
                writeln!(out, "{}", note_line(scope.agent, note))?;
            }
            for note in &outcome.notes {
                writeln!(out, "{}", note_line(scope.agent, note))?;
            }
        }
    }

    if updated == 0 && !failed && !skipped {
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

    /// A MemFs with one repo carrying an http preset with an oauth client and
    /// no params.
    fn oauth_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n    oauth:\n      clientId: sk-client\n      callbackPort: 8432\n",
        )
    }

    /// A MemFs with one repo carrying a plain http preset: no oauth, no params.
    /// The "before" state for an update that gains an oauth block.
    fn plain_http_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n",
        )
    }

    /// A MemFs with one repo carrying a stdio preset with one
    /// option-constrained parameter, "choice" (accepted values alpha/beta).
    /// The parameter is not tied to any `{placeholder}`: the option check
    /// applies to a stored value regardless of whether it is ever rendered.
    fn choice_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    parameters:\n      choice:\n        options:\n          alpha: Alpha\n          beta: Beta\n",
        )
    }

    /// Like [`choice_fs`], but `choice` is rendered into an argument and
    /// carries a description, so the missing-value and invalid-value paths
    /// have something to print besides the parameter's name.
    fn described_choice_fs() -> MemFs {
        MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    args: [\"--level\", \"{choice}\"]\n    parameters:\n      choice:\n        description: \"Which [level](https://example.com/levels) to request.\"\n        options:\n          alpha: Alpha\n          beta: Beta\n",
        )
    }

    /// A manual (config-defined) http preset carrying an oauth client.
    fn manual_oauth_preset() -> McpPreset {
        McpPreset {
            id: "abc123".to_string(),
            name: "manual-remote".to_string(),
            r#type: ConfigTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            description: None,
            oauth: Some(ConfigOauth {
                callback_port: Some(8432),
                client_id: Some("sk-client".to_string()),
                scopes: vec!["repo".to_string()],
            }),
        }
    }

    #[test]
    fn preset_to_def_carries_the_manual_presets_description() {
        let mut preset = manual_oauth_preset();
        preset.description = Some("A [doc](https://mcp.example.com/d)".to_string());
        let def = preset_to_def(&preset);
        assert_eq!(
            def.description.as_deref(),
            Some("A [doc](https://mcp.example.com/d)")
        );
        assert!(def.parameters.is_empty());
    }

    /// Runs the real `list` over a single repo preset whose description is
    /// `description`, and captures the outcome.
    fn run_list_with_description(description: &str) -> (i32, String, String) {
        let text = format!(
            "version: 1\nservers:\n  - name: github\n    type: stdio\n    command: npx\n    description: \"{description}\"\n"
        );
        let fs = MemFs::new().with_file("/repos/r1/mcp.yml", &text);
        let app = TestApp::new(fs);
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = list(&app.ctx(), &mut out, &mut err).unwrap();
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// Installs the `choice_fs` preset for claude with `choice=<value>`.
    /// Returns the app too, so a refusal test can assert nothing was written.
    fn run_install_with_choice(value: &str) -> (TestApp, i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &[format!("choice={value}")],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        (
            app,
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// Installs the `choice_fs` preset with `choice=alpha`, then drops "alpha"
    /// from the source's options (leaving only "beta") and runs `update`. The
    /// stored value is now outside the options, so the update must migrate it
    /// instead of failing.
    fn run_update_after_removing_the_stored_option() -> (i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    parameters:\n      choice:\n        options:\n          beta: Beta\n",
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
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// Installs the `choice_fs` preset with `choice=alpha`, then empties the
    /// source's option list entirely (leaving `choice` with nothing to
    /// choose from) and runs `update`. The stored value has nothing left to
    /// validate against, so the update must keep it -- and say nothing, since
    /// this entry is byte-identical to one that only carries a description.
    fn run_update_after_the_options_go_empty() -> (i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    parameters:\n      choice: {}\n",
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
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// Installs the `choice_fs` preset with `choice=alpha`, changes the source
    /// so an update is genuinely pending, then runs `update --param
    /// choice=<value>`. Returns the app so a refusal test can show the
    /// installed instance was left exactly as it was found.
    fn run_update_with_choice_override(value: &str) -> (TestApp, i32, String, String) {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // `rules` added: the def's hash changes, so the ledger entry is out of
        // date and the update loop has real work to do. Without this the
        // instance is up to date and the loop's body would never be reached.
        app.fs
            .write_file(
                "/repos/r1/mcp.yml",
                "version: 1\nservers:\n  - name: opts\n    type: stdio\n    command: npx\n    rules: \"Use it.\"\n    parameters:\n      choice:\n        options:\n          alpha: Alpha\n          beta: Beta\n",
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
            &[format!("choice={value}")],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        (
            app,
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    /// The value came from THIS command line, so it is refused rather than
    /// migrated: substituting it would replace an input made seconds ago and
    /// then report that the STORED value was no longer accepted, sending the
    /// user to look at a file instead of at what they typed.
    #[test]
    fn update_refuses_an_out_of_set_param_the_user_just_typed() {
        let (app, code, _out, err) = run_update_with_choice_override("admin");
        assert_eq!(code, 1, "an out-of-set --param must fail the update");
        assert!(err.contains("admin"), "the refused value: {err}");
        assert!(
            err.contains("alpha") && err.contains("beta"),
            "the accepted values must be named: {err}"
        );
        // The instance was left exactly as it was found: not migrated to
        // "alpha" behind the user's back, and not removed by the update's own
        // remove-then-reinstall.
        let stored = app
            .fs
            .read_file(&format!("/proj/.claude/skills/{SKMCP_PARAMS_FILE}"))
            .unwrap();
        assert!(stored.contains("alpha"), "got {stored}");
        assert!(!stored.contains("admin"), "got {stored}");
    }

    #[test]
    fn update_accepts_a_param_that_is_one_of_the_options() {
        let (app, code, _out, err) = run_update_with_choice_override("beta");
        assert_eq!(code, 0, "err was {err}");
        let stored = app
            .fs
            .read_file(&format!("/proj/.claude/skills/{SKMCP_PARAMS_FILE}"))
            .unwrap();
        assert!(stored.contains("beta"), "got {stored}");
    }

    /// The override check runs before the up-to-date check, so a value the
    /// interface would never have produced is refused whether or not this run
    /// had anything to reinstall.
    #[test]
    fn update_refuses_an_out_of_set_param_even_with_nothing_to_update() {
        let app = TestApp::new(choice_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=alpha".to_string()],
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
            &["choice=admin".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(err.contains("admin"), "got {err}");
    }

    /// A CLI user has no select to read, so the description and the accepted
    /// set have to arrive with the refusal -- otherwise they must guess wrong
    /// once to learn what the parameter takes.
    #[test]
    fn install_prints_a_parameters_description_and_options_when_a_value_is_missing() {
        let app = TestApp::new(described_choice_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(
            err.contains("Which level (https://example.com/levels) to request."),
            "the description must reach the terminal, links included: {err}"
        );
        assert!(err.contains("Accepted: alpha, beta."), "got {err}");
    }

    #[test]
    fn install_prints_a_parameters_description_beside_an_invalid_value() {
        let app = TestApp::new(described_choice_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "opts",
            Some(PROJECT),
            &["claude".to_string()],
            &["choice=nope".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(code, 1);
        assert!(err.contains("Accepted: alpha, beta."), "got {err}");
        assert!(
            err.contains("Which level (https://example.com/levels) to request."),
            "got {err}"
        );
    }

    #[test]
    fn a_parameter_with_no_metadata_prints_no_extra_line() {
        let app = TestApp::new(MemFs::new().with_file(
            "/repos/r1/mcp.yml",
            "version: 1\nservers:\n  - name: plain\n    type: stdio\n    command: npx\n    args: [\"{bare}\"]\n",
        ));
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(
            &app.ctx(),
            "plain",
            Some(PROJECT),
            &["claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let err = String::from_utf8(err).unwrap();
        assert_eq!(
            err.lines().count(),
            1,
            "only the missing-values line itself: {err}"
        );
    }

    #[test]
    fn list_prints_a_truncated_description_with_links_as_text_and_url() {
        // Exercised through the real `list`, so the wiring is covered, not just
        // the helper.
        let (code, out, _err) =
            run_list_with_description("See [docs](https://mcp.example.com/mcp).");
        assert_eq!(code, 0);
        assert!(
            out.contains("See docs (https://mcp.example.com/mcp)."),
            "got {out}"
        );
    }

    /// A server's `name` is repository-authored too, and `mcp list` prints it
    /// from the same file the descriptions come from. `\r` plus an erase-line
    /// sequence lets its author overwrite the line SkillKeeper just wrote, so
    /// the whole listing can be made to say something else. The strip covered
    /// descriptions and not this.
    #[test]
    fn a_preset_name_reaches_the_terminal_without_its_control_characters() {
        let hostile = "safe\r\u{1b}[2KFAKE: everything is fine";
        let cleaned = printable(hostile);
        assert!(
            !cleaned.chars().any(char::is_control),
            "no control character may survive: {cleaned:?}"
        );
        assert_eq!(cleaned, "safe[2KFAKE: everything is fine");
    }

    /// `mcp.yml` is repository-authored text on its way to a terminal. The
    /// URL is already refused at parse time, but prose and a link's visible
    /// text are printed verbatim, so the strip has to sit at the rendering
    /// boundary to cover all three. The URL span here could not come from
    /// `parse_description` today -- the point is that this function does not
    /// depend on that being true.
    #[test]
    fn rendering_for_a_terminal_drops_control_characters_from_prose_link_text_and_url() {
        let spans = vec![
            DescriptionSpan::Text {
                text: "red \u{1b}[31mALERT\u{1b}[0m ".to_string(),
            },
            DescriptionSpan::Link {
                text: "do\u{1b}[2Kcs".to_string(),
                url: "https://mcp.example.com/\rmcp".to_string(),
            },
        ];
        let out = render_spans_for_terminal(&spans);
        assert!(
            !out.chars().any(char::is_control),
            "no control character may survive: {out:?}"
        );
        // What is left is inert text, printed as the characters it is: the
        // sequence is broken by the missing ESC, not hidden.
        assert_eq!(
            out,
            "red [31mALERT[0m do[2Kcs (https://mcp.example.com/mcp)"
        );
    }

    #[test]
    fn list_never_prints_a_control_character_a_repository_authored() {
        // `\e` and `\r` are YAML escapes, so the file itself stays printable
        // while the parsed description holds real ESC and CR bytes -- the shape
        // that let a cloned repository clear the line SkillKeeper just printed
        // and write its own text over it.
        let (code, out, _err) =
            run_list_with_description("a\\e[2K\\rSkillKeeper: everything is fine");
        assert_eq!(code, 0);
        assert!(
            !out.contains('\u{1b}'),
            "an escape byte reached the terminal: {out:?}"
        );
        assert!(
            !out.contains('\r'),
            "a carriage return reached the terminal: {out:?}"
        );
        assert!(
            out.contains("SkillKeeper: everything is fine"),
            "the rest of the text is still printed: {out}"
        );
    }

    #[test]
    fn list_truncates_an_over_long_description() {
        // Longer than DESCRIPTION_BUDGET: the full string must never reach the
        // terminal, and the cut must be marked.
        let long = "x".repeat(DESCRIPTION_BUDGET + 50);
        let (code, out, _err) = run_list_with_description(&long);
        assert_eq!(code, 0);
        assert!(
            !out.contains(&long),
            "the untruncated description must not appear: {out}"
        );
        assert!(
            out.contains("..."),
            "expected an ellipsis marking the cut: {out}"
        );
    }

    #[test]
    fn install_refuses_a_value_outside_the_options_and_names_the_accepted_ones() {
        let (app, code, _out, err) = run_install_with_choice("nope");
        assert_eq!(code, 1);
        assert!(err.contains("choice"), "got {err}");
        assert!(
            err.contains("alpha") && err.contains("beta"),
            "the accepted values must be named: {err}"
        );
        // A refusal is not a partial install: the check runs before any
        // agent is touched, so neither the native config nor the ledger
        // exists. A check that ran AFTER a write would still return 1 here
        // and this would be the only thing to catch it.
        assert!(!app.fs.exists("/proj/.mcp.json").unwrap());
        assert!(!app
            .fs
            .exists(&format!("/proj/.claude/skills/{SKMCP_FILE}"))
            .unwrap());
    }

    #[test]
    fn install_accepts_a_value_that_is_one_of_the_options() {
        let (_app, code, _out, _err) = run_install_with_choice("alpha");
        assert_eq!(code, 0);
    }

    #[test]
    fn update_reports_a_substituted_option_and_does_not_fail() {
        let (code, out, _err) = run_update_after_removing_the_stored_option();
        assert_eq!(code, 0, "a reported substitution is not a failure");
        assert!(out.contains("choice"), "got {out}");
    }

    /// A parameter with an empty option list is indistinguishable from one
    /// that only carries a `description`, so an update has nothing true to say
    /// about it. The old note said something anyway, on every update of every
    /// described parameter.
    #[test]
    fn update_says_nothing_when_the_options_go_empty() {
        let (code, out, _err) = run_update_after_the_options_go_empty();
        assert_eq!(code, 0, "an empty option set is not a failure");
        assert!(
            out.contains("opts"),
            "the update itself must still have run: {out}"
        );
        assert!(
            !out.contains("choice"),
            "nothing is said about a parameter nothing happened to: {out}"
        );
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
    fn install_skips_copilot_for_an_oauth_preset_and_still_writes_claude() {
        let app = TestApp::new(oauth_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["copilot".to_string(), "claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();

        // Skipped for oauth, not for the transport -- copilot takes http fine.
        assert!(
            out.contains("Skipped copilot: cannot express an oauth client."),
            "expected an oauth skip, got:\n{out}"
        );
        assert!(!out.contains("transport"), "wrong skip reason:\n{out}");
        assert!(!out.contains("(copilot)"), "copilot was installed:\n{out}");
        // Nothing was written for copilot: no half-configured server, and no
        // ledger entry claiming one.
        assert!(!app.fs.exists("/proj/.vscode/mcp.json").unwrap());
        assert!(!app
            .fs
            .exists(&format!("/proj/.github/skills/{SKMCP_FILE}"))
            .unwrap());

        // Claude, which can express it, was written with the oauth block.
        assert!(out.contains("Installed: remote_1 (claude) ->"));
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(native.contains("\"oauth\""), "no oauth block:\n{native}");
        assert!(native.contains("sk-client"));
        assert!(native.contains("8432"));
    }

    #[test]
    fn install_prints_a_writer_note_for_a_field_the_agent_cannot_express() {
        let app = TestApp::new(oauth_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["cursor".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();

        assert!(out.contains("Installed: remote_1 (cursor) ->"));
        // Cursor has no callback-port setting; the drop is reported, not hidden.
        assert!(
            out.contains("Note cursor: cannot express \"callbackPort\""),
            "expected the dropped-field note, got:\n{out}"
        );
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
    fn a_manual_presets_oauth_block_survives_the_conversion_to_a_def() {
        let mut app = TestApp::new(MemFs::new());
        app.manual = vec![manual_oauth_preset()];
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "manual-remote",
            Some(PROJECT),
            &["copilot".to_string(), "claude".to_string()],
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();

        // Claude got the whole block, values intact.
        let native = app.fs.read_file("/proj/.mcp.json").unwrap();
        assert!(
            native.contains("\"oauth\""),
            "the manual preset lost its oauth block:\n{native}"
        );
        assert!(native.contains("sk-client"));
        assert!(native.contains("8432"));
        assert!(native.contains("repo"));

        // And the gate can SEE it, which it cannot when the field is dropped
        // during the conversion.
        assert!(
            out.contains("Skipped copilot: cannot express an oauth client."),
            "the oauth gate never saw the manual preset:\n{out}"
        );
    }

    #[test]
    fn update_declines_to_rewrite_a_copilot_instance_that_gained_an_oauth_block() {
        let app = TestApp::new(plain_http_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        // Installed while the preset had no oauth, which copilot can express.
        install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["copilot".to_string()],
            &[],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let before = app.fs.read_file("/proj/.vscode/mcp.json").unwrap();
        assert!(before.contains("remote_1"));

        // The source gains an oauth block copilot cannot express.
        app.fs
            .write_file("/repos/r1/mcp.yml", "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n    oauth:\n      clientId: sk-client\n      callbackPort: 8432\n")
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["copilot".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        // Reported, not failed: nothing the user can do makes copilot speak
        // OAuth, so a non-zero exit here would never clear and would break
        // every scripted `mcp update` from now on.
        assert_eq!(code, 0, "a declined update must not fail the command");
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.contains("Skipped remote_1 (copilot): cannot express an oauth client."),
            "no oauth skip on the update path:\n{out}"
        );
        // The remedy is named, and it is the command that actually exists.
        assert!(
            out.contains("mcp remove remote_1 --agent copilot"),
            "the skip names no remedy:\n{out}"
        );
        // Reported on stdout like `install`'s skip, not as an error.
        assert!(String::from_utf8(err).unwrap().is_empty());
        // And it does not then claim there was nothing to update.
        assert!(!out.contains("No MCP updates available."), "{out}");
        // Untouched: not rewritten without its auth, and NOT deleted by the
        // remove half of the reinstall -- the gate runs before the remove.
        assert_eq!(app.fs.read_file("/proj/.vscode/mcp.json").unwrap(), before);
    }

    #[test]
    fn update_prints_a_writer_note_for_a_field_the_agent_cannot_express() {
        let app = TestApp::new(plain_http_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "remote",
            Some(PROJECT),
            &["cursor".to_string()],
            &[],
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();

        // Cursor CAN express an oauth client, minus the callback port.
        app.fs
            .write_file("/repos/r1/mcp.yml", "version: 1\nservers:\n  - name: remote\n    type: http\n    url: https://example.com/mcp\n    oauth:\n      clientId: sk-client\n      callbackPort: 8432\n")
            .unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            None,
            Some(PROJECT),
            &["cursor".to_string()],
            false,
            &[],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("Updated: remote_1 (cursor)"));
        assert!(
            out.contains("Note cursor: cannot express \"callbackPort\""),
            "the update path dropped the writer note:\n{out}"
        );
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
    fn kinds_for_defaults_to_every_agent_at_project_scope() {
        // Codex now resolves a real project-scoped destination just like every
        // other agent, so an empty --agent list at project scope must cover
        // it too -- there is no longer a smaller project-capable subset.
        assert_eq!(kinds_for(&[], Scope::Project), ALL_MCP_AGENTS.to_vec());
    }

    #[test]
    fn kinds_for_defaults_to_every_agent_at_global_scope() {
        // Matching --all, which already sweeps every agent's global ledger
        // unconditionally.
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

    #[test]
    fn install_writes_a_project_scoped_codex_config_and_does_not_refuse() {
        // Codex used to be coerced to global scope no matter what was asked;
        // a project-scoped install must now land in the project's own
        // .codex/config.toml, not the refusal this used to print.
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["codex".to_string()],
            &["token=secret123".to_string()],
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(
            out.contains("Installed: github_1 (codex) ->"),
            "expected a successful codex install, got:\n{out}"
        );
        assert!(String::from_utf8(err).unwrap().is_empty());

        let native = app
            .fs
            .read_file(&format!("{PROJECT}/.codex/config.toml"))
            .expect("project-scoped codex config written");
        assert!(native.contains("github_1"));
        assert!(native.contains("secret123"));
        // Nothing was written to the user-wide config.
        assert!(!app
            .fs
            .exists(&format!("{HOME}/.codex/config.toml"))
            .unwrap());
    }

    #[test]
    fn update_reinstalls_a_project_scoped_codex_instance() {
        // The `update` path used to carry the same refusal `install` did;
        // it must now reinstall a project-scoped codex instance in place,
        // the same as any other agent.
        let app = TestApp::new(seeded_fs());
        seed_state(&app.fs);
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        install(
            &app.ctx(),
            "github",
            Some(PROJECT),
            &["codex".to_string()],
            &["token=abc".to_string()],
            false,
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
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: github_1 (codex)"));
        assert!(String::from_utf8(err).unwrap().is_empty());

        let native = app
            .fs
            .read_file(&format!("{PROJECT}/.codex/config.toml"))
            .unwrap();
        assert!(native.contains("--verbose"));
        assert!(native.contains("abc")); // stored token preserved

        // Resolved at project scope like any other agent, so the ledger's
        // gitignore entry applies here too.
        assert!(app.fs.exists(&format!("{PROJECT}/.gitignore")).unwrap());
    }
}
