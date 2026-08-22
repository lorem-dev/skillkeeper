//! `skillkeeper skill` command group: list, info, install, uninstall, update,
//! verify, repair.
//!
//! Port of `packages/cli/src/commands/skill.ts`. Installs are driven through the
//! agents [`AdapterRegistry`], exactly like the desktop `skills_apply` command:
//! the adapter resolves each agent's destination root and hook capability for a
//! target, and those are passed into the core `install_skill` engine. Agent
//! path resolution reads the active project directory from the
//! [`PROJECT_DIR_ENV`] host variable, injected per operation via [`ProjectEnv`].
//!
//! Local ports: the skill-guidance IO helpers (`read_skill_guide`,
//! `write_skill_guidance`, `clear_skill_guidance`, `skill_guidance_block_key`)
//! have no `skillkeeper-core` equivalent yet -- the desktop `skills.rs` inlines
//! the same logic -- so they live here, composed over the ported guidance
//! string helpers (`upsert_guidance_block`, `remove_guidance_block`,
//! `strip_guidance_markers`, `guidance_key`, `skill_guidance_id`).

use std::collections::{HashMap, HashSet};
use std::io::Write;

use clap::Subcommand;
use skillkeeper_agents::{detect_project_agents, AdapterRegistry, AgentAdapter};
use skillkeeper_core::hooks::guidance::{
    guidance_key, remove_guidance_block, skill_guidance_id, strip_guidance_markers,
    upsert_guidance_block,
};
use skillkeeper_core::install::install::{install_skill, uninstall_skill, HookSupport};
use skillkeeper_core::install::verify::{repair_install, verify_install};
use skillkeeper_core::models::{
    AgentKind, AgentTarget, AppState, InstallManifest, InstallOptions, ManagedHookEdit,
    ResolvedSkill, Scope, SkillId, VerifyStatus,
};
use skillkeeper_core::ports::{Clock, FsPort, HostEnv, PortResult};
use skillkeeper_core::skills::group_path::skill_path;
use skillkeeper_core::skills::requires::RequiresGraph;
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::{load_state, save_state};

use crate::commands::agenthelpers::{parse_agent, scope_str, ProjectEnv};
use crate::commands::resolvewarnings::print_resolve_warnings;
use crate::error::CliError;
use crate::messages::{HOOKS_REQUIRE_CONSENT, PROJECT_REQUIRED};

/// `skill <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum SkillAction {
    /// List installed skills.
    List,
    /// Show details for an installed skill.
    Info {
        /// Skill id (`group/name` or `name`).
        id: String,
    },
    /// Install a skill for an agent.
    Install {
        /// Skill id (`group/name` or `name`, or a unique id prefix) as found in
        /// a tracked repository.
        id: String,
        /// Agent to install for (claude|codex|copilot|cursor|opencode). Omit to
        /// install for every agent detected in the project directory.
        #[arg(long)]
        agent: Option<String>,
        /// Install globally (default: project scope).
        #[arg(long)]
        global: bool,
        /// Project directory for project scope (default: cwd).
        #[arg(long)]
        project: Option<String>,
        /// Also install hooks (requires explicit consent).
        #[arg(long = "allow-hooks")]
        allow_hooks: bool,
    },
    /// Uninstall a skill.
    Uninstall {
        /// Skill id (`group/name` or `name`).
        id: String,
        /// Limit to a specific agent.
        #[arg(long)]
        agent: Option<String>,
    },
    /// Update an installed skill to the latest source.
    Update {
        /// Skill id (`group/name` or `name`).
        id: String,
        /// Limit to a specific agent.
        #[arg(long)]
        agent: Option<String>,
        /// Project directory for project-scope installs (default: recorded path or cwd).
        #[arg(long)]
        project: Option<String>,
        /// Re-apply hooks during update (requires consent).
        #[arg(long = "allow-hooks")]
        allow_hooks: bool,
    },
    /// Verify integrity of an installed skill.
    Verify {
        /// Skill id (`group/name` or `name`).
        id: String,
        /// Limit to a specific agent.
        #[arg(long)]
        agent: Option<String>,
    },
    /// Repair a drifted skill installation.
    Repair {
        /// Skill id (`group/name` or `name`).
        id: String,
        /// Limit to a specific agent.
        #[arg(long)]
        agent: Option<String>,
        /// Project directory for project-scope installs (default: recorded path or cwd).
        #[arg(long)]
        project: Option<String>,
        /// Re-apply hooks during repair (requires consent).
        #[arg(long = "allow-hooks")]
        allow_hooks: bool,
    },
}

/// The wired dependencies shared by every `skill` operation. Mirrors the TS
/// `SkillDeps`; `cwd` is injected so tests can pin it.
pub struct SkillCtx<'a> {
    pub fs: &'a dyn FsPort,
    pub registry: &'a AdapterRegistry,
    pub env: &'a dyn HostEnv,
    pub clock: &'a dyn Clock,
    pub state_path: &'a str,
    pub executable_globs: &'a [String],
    /// The current working directory (project-scope default).
    pub cwd: &'a str,
}

/// `group/name` when grouped, else `name`.
fn full_id(id: &SkillId) -> String {
    match &id.group {
        Some(group) => format!("{group}/{}", id.name),
        None => id.name.clone(),
    }
}

/// Whether a manifest matches `id` by full `group/name` label or bare name.
fn matches_id(m: &InstallManifest, id: &str) -> bool {
    full_id(&m.skill_id) == id || m.skill_id.name == id
}

/// Whether a manifest matches `id`, optionally restricted to `agent`.
fn matches(m: &InstallManifest, id: &str, agent: Option<&str>) -> bool {
    if !matches_id(m, id) {
        return false;
    }
    match agent {
        Some(a) => m.target.agent.as_str() == a,
        None => true,
    }
}

/// Resolve a user-supplied skill id to a single canonical `group/name` (or bare
/// `name`) among `candidates` -- each a `(full_id, name)` pair. An exact match on
/// either form wins; otherwise a unique prefix match on either form resolves it,
/// Docker-container-id style (`ab` -> `abba` when it is the only id starting with
/// `ab`). Returns the canonical full id, or an error message when nothing matches
/// or the prefix is ambiguous.
fn resolve_skill_ref(input: &str, candidates: &[(String, String)]) -> Result<String, String> {
    if let Some((full, _)) = candidates.iter().find(|(f, n)| f == input || n == input) {
        return Ok(full.clone());
    }
    let mut hits: Vec<String> = candidates
        .iter()
        .filter(|(f, n)| f.starts_with(input) || n.starts_with(input))
        .map(|(f, _)| f.clone())
        .collect();
    hits.sort();
    hits.dedup();
    match hits.len() {
        0 => Err(format!("Skill not found: {input}")),
        1 => Ok(hits.remove(0)),
        _ => Err(format!(
            "Ambiguous skill id '{input}'; matches: {}",
            hits.join(", ")
        )),
    }
}

/// The distinct `(full_id, name)` pairs across installed manifests, for prefix
/// resolution of a user-supplied id against what is installed.
fn installed_id_candidates(installs: &[InstallManifest]) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = installs
        .iter()
        .map(|m| (full_id(&m.skill_id), m.skill_id.name.clone()))
        .collect();
    v.sort();
    v.dedup();
    v
}

/// `VerifyStatus` as its wire string.
fn verify_status_str(s: VerifyStatus) -> &'static str {
    match s {
        VerifyStatus::Ok => "ok",
        VerifyStatus::Modified => "modified",
        VerifyStatus::Missing => "missing",
        VerifyStatus::Extraneous => "extraneous",
    }
}

/// The `kind` tag of a hook edit, matching the manifest's serialized discriminant.
fn hook_edit_kind(edit: &ManagedHookEdit) -> &'static str {
    match edit {
        ManagedHookEdit::Delimited { .. } => "delimited",
        ManagedHookEdit::Json { .. } => "json",
        ManagedHookEdit::File { .. } => "file",
    }
}

/// Read a skill's guide body from its source directory: `GUIDE.md` wins over
/// `RULES.md`; stray SkillKeeper markers are stripped and trailing newlines
/// trimmed. `None` when neither exists. Local port of `readSkillGuide`.
fn read_skill_guide(fs: &dyn FsPort, skill_source_dir: &str) -> PortResult<Option<String>> {
    for name in ["GUIDE.md", "RULES.md"] {
        let path = format!("{skill_source_dir}/{name}");
        if fs.exists(&path)? {
            let raw = fs.read_file(&path)?;
            let stripped = strip_guidance_markers(&raw);
            return Ok(Some(stripped.trim_end_matches('\n').to_string()));
        }
    }
    Ok(None)
}

/// The guidance block key for a skill installed from `remote`. Local port of
/// `skillGuidanceBlockKey`.
fn skill_guidance_block_key(remote: &str, id: &SkillId) -> String {
    guidance_key(remote, &skill_guidance_id(id.group.as_deref(), &id.name))
}

/// Upsert a skill's guide block into an agent's guidance file. Local port of
/// `writeSkillGuidance`.
fn write_skill_guidance(
    fs: &dyn FsPort,
    adapter: &AgentAdapter,
    target: &AgentTarget,
    env: &dyn HostEnv,
    remote: &str,
    id: &SkillId,
    body: &str,
) -> PortResult<()> {
    let file = adapter.guidance_file(fs, target, env)?;
    let existing = if fs.exists(&file)? {
        fs.read_file(&file)?
    } else {
        String::new()
    };
    let key = skill_guidance_block_key(remote, id);
    fs.write_file(&file, &upsert_guidance_block(&existing, &key, body))?;
    Ok(())
}

/// Remove a skill's guide block from an agent's guidance file, deleting the file
/// when removing the block empties it. Local port of `clearSkillGuidance`.
fn clear_skill_guidance(
    fs: &dyn FsPort,
    adapter: &AgentAdapter,
    target: &AgentTarget,
    env: &dyn HostEnv,
    remote: &str,
    id: &SkillId,
) -> PortResult<()> {
    let file = adapter.guidance_file(fs, target, env)?;
    if !fs.exists(&file)? {
        return Ok(());
    }
    let key = skill_guidance_block_key(remote, id);
    let next = remove_guidance_block(&fs.read_file(&file)?, &key);
    if next.is_empty() {
        fs.remove(&file)?;
    } else {
        fs.write_file(&file, &next)?;
    }
    Ok(())
}

/// Resolve the adapter's hook capability for a target into the engine's
/// [`HookSupport`]. `None` when the agent has no hook capability or the target
/// file cannot be resolved. Port of the desktop `resolve_hook_support`.
fn resolve_hook_support(
    adapter: &AgentAdapter,
    target: &AgentTarget,
    env: &dyn HostEnv,
) -> Option<HookSupport> {
    let cap = adapter.hook_support.as_ref()?;
    let target_file = cap.resolve_target_file(target, env).ok()?;
    Some(HookSupport {
        strategy: cap.strategy,
        target_file,
        comment_token: cap.comment_token.clone(),
        comment_close: cap.comment_close.clone(),
    })
}

/// Resolve the env + [`AgentTarget`] for an operation, honoring scope. For
/// project scope the [`PROJECT_DIR_ENV`] is injected (from `project_opt`, else
/// `cwd`) and recorded as `target.project_id` so later operations can rebuild the
/// destination. Port of the TS `resolveTarget`.
fn resolve_target<'e>(
    env: &'e dyn HostEnv,
    agent: skillkeeper_core::models::AgentKind,
    global: bool,
    project_opt: Option<&str>,
    cwd: &str,
) -> Result<(ProjectEnv<'e>, AgentTarget), CliError> {
    if global {
        return Ok((
            ProjectEnv {
                inner: env,
                project_path: cwd.to_string(),
            },
            AgentTarget {
                agent,
                scope: Scope::Global,
                project_id: None,
            },
        ));
    }
    let project_path = project_opt
        .map(str::to_string)
        .unwrap_or_else(|| cwd.to_string());
    if project_path.trim().is_empty() {
        return Err(CliError(PROJECT_REQUIRED.to_string()));
    }
    Ok((
        ProjectEnv {
            inner: env,
            project_path: project_path.clone(),
        },
        AgentTarget {
            agent,
            scope: Scope::Project,
            project_id: Some(project_path),
        },
    ))
}

/// `skill list`.
pub fn list(ctx: &SkillCtx, out: &mut dyn Write) -> Result<i32, CliError> {
    let state = load_state(ctx.fs, ctx.state_path)?;
    if state.installs.is_empty() {
        writeln!(out, "No skills installed.")?;
        return Ok(0);
    }
    writeln!(out, "{} skill(s) installed", state.installs.len())?;
    for m in &state.installs {
        let version = m
            .version
            .as_ref()
            .map(|v| format!("  v{v}"))
            .unwrap_or_default();
        writeln!(
            out,
            "  {}  agent={}  scope={}{version}",
            full_id(&m.skill_id),
            m.target.agent,
            scope_str(m.target.scope),
        )?;
    }
    Ok(0)
}

/// `skill info <id>`.
pub fn info(
    ctx: &SkillCtx,
    id: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let state = load_state(ctx.fs, ctx.state_path)?;
    let canonical = match resolve_skill_ref(id, &installed_id_candidates(&state.installs)) {
        Ok(c) => c,
        Err(msg) => {
            writeln!(err, "{msg}")?;
            return Ok(1);
        }
    };
    let matches: Vec<&InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches_id(m, &canonical))
        .collect();
    for m in matches {
        writeln!(out, "Skill:    {}", m.skill_id.name)?;
        if let Some(group) = &m.skill_id.group {
            writeln!(out, "Group:    {group}")?;
        }
        if let Some(version) = &m.version {
            writeln!(out, "Version:  {version}")?;
        }
        writeln!(
            out,
            "Agent:    {}  scope={}",
            m.target.agent,
            scope_str(m.target.scope)
        )?;
        writeln!(out, "Dest:     {}", m.destination_root)?;
        writeln!(out, "Installed: {}", m.installed_at)?;
        writeln!(out, "Files:    {}", m.files.len())?;
        writeln!(out, "Hooks:    {}", m.hook_edits.len())?;
    }
    Ok(0)
}

/// `skill install <id> --agent ...`.
#[allow(clippy::too_many_arguments)]
pub fn install(
    ctx: &SkillCtx,
    id: &str,
    agent: &str,
    global: bool,
    project: Option<&str>,
    allow_hooks: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(ctx.fs, ctx.state_path)?;

    // Gather every skill across tracked repositories, then resolve the id
    // (exact or unique prefix, Docker-style) against them.
    let mut all = Vec::new();
    for repo in &state.repositories {
        let resolved = resolve_skills(ctx.fs, &repo.local_path);
        // Report before the id lookup: a warning here often explains the
        // "Skill not found" that is about to follow.
        print_resolve_warnings(err, &repo.name, &resolved.warnings)?;
        for skill in resolved.skills {
            all.push((
                repo.local_path.clone(),
                repo.id.clone(),
                repo.url.clone(),
                skill,
            ));
        }
    }
    let candidates: Vec<(String, String)> = all
        .iter()
        .map(|(_, _, _, s)| (full_id(&s.id), s.id.name.clone()))
        .collect();
    let canonical = match resolve_skill_ref(id, &candidates) {
        Ok(c) => c,
        Err(msg) if msg.starts_with("Ambiguous") => {
            writeln!(err, "{msg}")?;
            return Ok(1);
        }
        Err(_) => {
            writeln!(err, "Skill not found in any tracked repository: {id}")?;
            return Ok(1);
        }
    };
    let (source_root, source_repo_id, source_remote, skill) = all
        .iter()
        .find(|(_, _, _, s)| full_id(&s.id) == canonical)
        .cloned()
        .expect("resolved id must be among the gathered skills");

    // Dependencies are same-repository by definition, so the graph is built from
    // this repository's skills alone -- mixing repositories here would let a
    // reference resolve against a namesake somewhere else.
    let siblings: Vec<ResolvedSkill> = all
        .iter()
        .filter(|(_, id, _, _)| *id == source_repo_id)
        .map(|(_, _, _, s)| s.clone())
        .collect();
    let graph = RequiresGraph::build(&siblings);
    let root_path = skill_path(skill.id.group.as_deref(), &skill.id.name);
    let order = graph.closure(std::slice::from_ref(&root_path));

    // A reference with no skill behind it is named, not fatal: the skill the
    // user asked for still installs.
    report_missing_requires(&graph, &order, err)?;

    let agent_kind = parse_agent(agent)?;
    for path in &order {
        let Some(member) = siblings
            .iter()
            .find(|s| skill_path(s.id.group.as_deref(), &s.id.name) == *path)
        else {
            // Already reported above.
            continue;
        };
        install_one(
            ctx,
            &mut state.installs,
            &source_root,
            &source_repo_id,
            &source_remote,
            member,
            agent_kind,
            global,
            project,
            allow_hooks,
            *path != root_path,
            out,
        )?;
    }
    save_state(ctx.fs, ctx.state_path, &state)?;
    Ok(0)
}

/// Install one already-resolved skill and append its manifest to `installs`,
/// without saving: the caller owns the ledger write, because one command may
/// install a whole dependency closure and the state file is written once at the
/// end. It takes the manifest list rather than the whole [`AppState`] because
/// that is all it touches, and because `update` works on a detached list.
///
/// `as_dependency` only changes the line printed, never what is written -- a
/// dependency install is an ordinary install that the user did not name.
#[allow(clippy::too_many_arguments)]
fn install_one(
    ctx: &SkillCtx,
    installs: &mut Vec<InstallManifest>,
    source_root: &str,
    source_repo_id: &str,
    source_remote: &str,
    skill: &ResolvedSkill,
    agent_kind: AgentKind,
    global: bool,
    project: Option<&str>,
    allow_hooks: bool,
    as_dependency: bool,
    out: &mut dyn Write,
) -> Result<(), CliError> {
    let adapter = ctx.registry.get(agent_kind)?;
    let (env, target) = resolve_target(ctx.env, agent_kind, global, project, ctx.cwd)?;

    // Already installed for this exact target: nothing to do. Without this,
    // installing a skill whose dependency is present would duplicate the
    // dependency's ledger entry. Reported rather than passed over in silence --
    // the user named this skill, or the skill that needs it, and an operation
    // that does nothing has to say so.
    if let Some(present) = installs
        .iter()
        .find(|m| m.skill_id == skill.id && m.target == target)
    {
        writeln!(
            out,
            "Skill already installed: {} -> {}",
            full_id(&skill.id),
            present.destination_root
        )?;
        return Ok(());
    }

    let dest_root = adapter.destination_root(&target, &env)?;
    let hook_support = resolve_hook_support(adapter, &target, &env);
    let opts = InstallOptions {
        target: target.clone(),
        source_root: source_root.to_string(),
        skill: skill.clone(),
        allow_hooks,
        executable_globs: ctx.executable_globs.to_vec(),
        source_repo_id: Some(source_repo_id.to_string()),
        source_remote: Some(source_remote.to_string()),
        source_path: Some(skill.root_path.clone()),
    };
    let manifest = install_skill(
        ctx.fs,
        &opts,
        &dest_root,
        hook_support.as_ref(),
        ctx.clock.now(),
    )?;

    // Guidance block.
    let guide_dir = format!("{source_root}/{}", skill.root_path);
    if let Some(body) = read_skill_guide(ctx.fs, &guide_dir)? {
        write_skill_guidance(
            ctx.fs,
            adapter,
            &target,
            &env,
            source_remote,
            &skill.id,
            &body,
        )?;
    }

    let dest = manifest.destination_root.clone();
    installs.push(manifest);

    // The skill is named: one command can print this notice once per closure
    // member, and N identical lines would say only that something had hooks.
    if !allow_hooks && !skill.hooks.is_empty() {
        writeln!(out, "{}: {HOOKS_REQUIRE_CONSENT}", full_id(&skill.id))?;
    }
    if as_dependency {
        writeln!(
            out,
            "Skill installed as a dependency: {} -> {dest}",
            full_id(&skill.id)
        )?;
    } else {
        writeln!(out, "Skill installed: {} -> {dest}", full_id(&skill.id))?;
    }
    Ok(())
}

/// Report every `skillkeeper.requires` reference inside `order` that no skill of
/// the repository satisfies, naming the skill that actually declared it.
///
/// Attribution is the whole point: a closure is a list of paths and has
/// forgotten who reached them, so reporting per closure member would blame the
/// root for a reference declared three hops down. `order` is used only to keep
/// the report to the part of the repository this command touched.
fn report_missing_requires(
    graph: &RequiresGraph,
    order: &[String],
    err: &mut dyn Write,
) -> Result<(), CliError> {
    for (referrer, missing) in graph.missing() {
        if !order.contains(&referrer) {
            continue;
        }
        writeln!(
            err,
            "Skill \"{referrer}\" requires \"{missing}\", which does not exist in this repository."
        )?;
    }
    Ok(())
}

/// `skill uninstall <id>`.
pub fn uninstall(
    ctx: &SkillCtx,
    id: &str,
    agent: Option<&str>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let state = load_state(ctx.fs, ctx.state_path)?;
    let canonical = match resolve_skill_ref(id, &installed_id_candidates(&state.installs)) {
        Ok(c) => c,
        Err(msg) => {
            writeln!(err, "{msg}")?;
            return Ok(1);
        }
    };
    let matched: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, &canonical, agent))
        .cloned()
        .collect();
    if matched.is_empty() {
        writeln!(err, "Skill not found: {id}")?;
        return Ok(1);
    }
    for m in &matched {
        uninstall_skill(ctx.fs, m)?;
        writeln!(out, "Uninstalled: {} ({})", m.skill_id.name, m.target.agent)?;
    }
    let surviving: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| !matched.contains(m))
        .cloned()
        .collect();

    // Remove each uninstalled skill's guidance block, unless a surviving install
    // still needs it in the same (possibly shared) file.
    let kept = kept_blocks_by_file(ctx, surviving.iter())?;
    for m in &matched {
        let Some(remote) = &m.source_remote else {
            continue;
        };
        let (env, target) = resolve_target(
            ctx.env,
            m.target.agent,
            m.target.scope == Scope::Global,
            m.target.project_id.as_deref(),
            ctx.cwd,
        )?;
        let adapter = ctx.registry.get(m.target.agent)?;
        let file = adapter.guidance_file(ctx.fs, &target, &env)?;
        let key = skill_guidance_block_key(remote, &m.skill_id);
        if kept.get(&file).is_some_and(|s| s.contains(&key)) {
            continue;
        }
        clear_skill_guidance(ctx.fs, adapter, &target, &env, remote, &m.skill_id)?;
    }

    let next = AppState {
        installs: surviving,
        ..state
    };
    save_state(ctx.fs, ctx.state_path, &next)?;

    // Uninstall never cascades: another installed skill may need what was
    // removed, and guessing is worse than saying so. Report, do not act -- the
    // exit code does not change. The report is taken from the ledger as it
    // stands after the removal, so a dependent removed in this same call is not
    // reported as broken by it.
    report_broken_dependents(&next.installs, &matched, err)?;
    Ok(0)
}

/// Report every still-installed skill that this command has just broken: one
/// whose dependency closure has lost a member that `removed` took away.
///
/// A dependency is satisfied for a dependent only AT THE DEPENDENT'S OWN
/// TARGET: a skill installed for one agent is invisible to a dependent
/// installed for another, so the installs are grouped by target and each group
/// is its own graph. Within a group, [`RequiresGraph::contains`] is exactly
/// "installed for this target" -- a path that is only ever a reference is not
/// a node -- so the unsatisfied members of a closure are the ones the graph
/// does not contain.
///
/// Of those, only the ones this invocation removed at that same target are
/// reported. The wording is causal, so the report has to be: a dependency that
/// was already absent before this command ran is breakage the user did not
/// cause, and blaming their `uninstall` for it would be noise. Pre-existing
/// breakage is `repo lint`'s to report.
///
/// The edges come from the ledger's recorded `requires` rather than from the
/// source repository: the question is what the installed skills were promised
/// at install time, not what the repository declares today.
fn report_broken_dependents(
    installs: &[InstallManifest],
    removed: &[InstallManifest],
    err: &mut dyn Write,
) -> Result<(), CliError> {
    let mut targets: Vec<&AgentTarget> = Vec::new();
    for m in installs {
        if !targets.contains(&&m.target) {
            targets.push(&m.target);
        }
    }
    for target in targets {
        let at_target: Vec<&InstallManifest> =
            installs.iter().filter(|m| m.target == *target).collect();
        let removed_here: Vec<String> = removed
            .iter()
            .filter(|m| m.target == *target)
            .map(|m| skill_path(m.skill_id.group.as_deref(), &m.skill_id.name))
            .collect();
        if removed_here.is_empty() {
            continue;
        }
        let graph = RequiresGraph::build_from_edges(at_target.iter().map(|m| {
            (
                skill_path(m.skill_id.group.as_deref(), &m.skill_id.name),
                m.requires.clone().unwrap_or_default(),
            )
        }));
        for m in &at_target {
            let path = skill_path(m.skill_id.group.as_deref(), &m.skill_id.name);
            let lost: Vec<String> = graph
                .closure(std::slice::from_ref(&path))
                .into_iter()
                .filter(|member| !graph.contains(member))
                .filter(|member| removed_here.contains(member))
                .map(|member| format!("\"{member}\""))
                .collect();
            if lost.is_empty() {
                continue;
            }
            let verb = if lost.len() == 1 {
                "which was"
            } else {
                "which were"
            };
            writeln!(
                err,
                "Skill \"{path}\" is still installed for {} and required {}, {verb} just removed; it may not work.",
                target.agent,
                lost.join(", ")
            )?;
        }
    }
    Ok(())
}

/// Build the `{ guidance_file -> {block_key} }` map of blocks that must be kept
/// because a surviving install still needs them.
fn kept_blocks_by_file<'m>(
    ctx: &SkillCtx,
    installs: impl Iterator<Item = &'m InstallManifest>,
) -> Result<HashMap<String, HashSet<String>>, CliError> {
    let mut kept: HashMap<String, HashSet<String>> = HashMap::new();
    for s in installs {
        let Some(remote) = &s.source_remote else {
            continue;
        };
        let (env, target) = resolve_target(
            ctx.env,
            s.target.agent,
            s.target.scope == Scope::Global,
            s.target.project_id.as_deref(),
            ctx.cwd,
        )?;
        let file = ctx
            .registry
            .get(s.target.agent)?
            .guidance_file(ctx.fs, &target, &env)?;
        kept.entry(file)
            .or_default()
            .insert(skill_guidance_block_key(remote, &s.skill_id));
    }
    Ok(kept)
}

/// `skill update <id>`.
pub fn update(
    ctx: &SkillCtx,
    id: &str,
    agent: Option<&str>,
    project: Option<&str>,
    allow_hooks: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let state = load_state(ctx.fs, ctx.state_path)?;
    let canonical = match resolve_skill_ref(id, &installed_id_candidates(&state.installs)) {
        Ok(c) => c,
        Err(msg) => {
            writeln!(err, "{msg}")?;
            return Ok(1);
        }
    };
    let matched: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, &canonical, agent))
        .cloned()
        .collect();
    if matched.is_empty() {
        writeln!(err, "Skill not found: {id}")?;
        return Ok(1);
    }

    let mut installs = state.installs.clone();
    let mut new_manifests: Vec<InstallManifest> = Vec::new();
    // (manifest, has_guide) for blocks (re)written this run.
    let mut updated_refs: Vec<(InstallManifest, bool)> = Vec::new();

    for m in &matched {
        let Some(repo) = state
            .repositories
            .iter()
            .find(|r| Some(&r.id) == m.source_repo_id.as_ref())
        else {
            writeln!(
                err,
                "Source repository not found for skill: {}",
                m.skill_id.name
            )?;
            continue;
        };
        let resolve_result = resolve_skills(ctx.fs, &repo.local_path);
        print_resolve_warnings(err, &repo.name, &resolve_result.warnings)?;
        let siblings = resolve_result.skills;

        // The closure is taken over the repository as it stands now, so a
        // dependency the new version newly declares is part of the order. As at
        // install time it is this repository's skills alone: dependencies are
        // same-repository by definition.
        let graph = RequiresGraph::build(&siblings);
        let root_path = skill_path(m.skill_id.group.as_deref(), &m.skill_id.name);
        let order = graph.closure(std::slice::from_ref(&root_path));
        report_missing_requires(&graph, &order, err)?;
        let is_global = m.target.scope == Scope::Global;
        let project_hint = project.or(m.target.project_id.as_deref());

        for path in &order {
            let Some(resolved) = siblings
                .iter()
                .find(|s| skill_path(s.id.group.as_deref(), &s.id.name) == *path)
            else {
                // A missing root is not a `missing()` pair (nothing in the
                // repository declares it), so it keeps its own message; a
                // missing dependency was already reported by attribution.
                if *path == root_path {
                    writeln!(err, "Skill not found in source: {id}")?;
                }
                continue;
            };
            // A closure member with no install for this target is a dependency
            // the current version declares and the installed one did not: it is
            // installed rather than updated.
            //
            // The origin is part of the match. A skill id is `(group, name)`
            // with no repository in it, so two repositories can hold the same
            // name; updating from one of them must not silently re-home the
            // other one's ledger entry. A same-named skill installed from
            // elsewhere is left alone, and `install_one` then declines to
            // install over it.
            let Some(current) = installs
                .iter()
                .find(|i| {
                    i.skill_id == resolved.id
                        && i.target == m.target
                        && i.source_repo_id.as_deref() == Some(repo.id.as_str())
                })
                .cloned()
            else {
                install_one(
                    ctx,
                    &mut installs,
                    &repo.local_path,
                    &repo.id,
                    &repo.url,
                    resolved,
                    m.target.agent,
                    is_global,
                    project_hint,
                    allow_hooks,
                    true,
                    out,
                )?;
                continue;
            };

            let adapter = ctx.registry.get(m.target.agent)?;
            let (env, target) =
                resolve_target(ctx.env, m.target.agent, is_global, project_hint, ctx.cwd)?;

            uninstall_skill(ctx.fs, &current)?;
            let dest_root = adapter.destination_root(&target, &env)?;
            let hook_support = resolve_hook_support(adapter, &target, &env);
            let opts = InstallOptions {
                target: target.clone(),
                source_root: repo.local_path.clone(),
                skill: resolved.clone(),
                allow_hooks,
                executable_globs: ctx.executable_globs.to_vec(),
                source_repo_id: Some(repo.id.clone()),
                source_remote: Some(repo.url.clone()),
                source_path: Some(resolved.root_path.clone()),
            };
            let new_manifest = install_skill(
                ctx.fs,
                &opts,
                &dest_root,
                hook_support.as_ref(),
                ctx.clock.now(),
            )?;
            installs.retain(|i| *i != current);
            installs.push(new_manifest.clone());
            new_manifests.push(new_manifest.clone());

            let guide_dir = format!("{}/{}", repo.local_path, resolved.root_path);
            let guide = read_skill_guide(ctx.fs, &guide_dir)?;
            if let Some(body) = &guide {
                write_skill_guidance(
                    ctx.fs,
                    adapter,
                    &target,
                    &env,
                    &repo.url,
                    &resolved.id,
                    body,
                )?;
            }
            updated_refs.push((new_manifest, guide.is_some()));

            if !allow_hooks && !resolved.hooks.is_empty() {
                writeln!(out, "{}: {HOOKS_REQUIRE_CONSENT}", full_id(&resolved.id))?;
            }
            writeln!(
                out,
                "Updated: {} ({})",
                current.skill_id.name, current.target.agent
            )?;
        }
    }

    // An updated skill that no longer ships a guide has its stale block removed,
    // unless a surviving install still needs it in the same guidance file.
    let mut kept: HashMap<String, HashSet<String>> = HashMap::new();
    let keep = |kept: &mut HashMap<String, HashSet<String>>, file: String, key: String| {
        kept.entry(file).or_default().insert(key);
    };
    for (manifest, has_guide) in &updated_refs {
        if !has_guide {
            continue;
        }
        let Some(remote) = &manifest.source_remote else {
            continue;
        };
        let (env, target) = resolve_target(
            ctx.env,
            manifest.target.agent,
            manifest.target.scope == Scope::Global,
            manifest.target.project_id.as_deref(),
            ctx.cwd,
        )?;
        let file = ctx
            .registry
            .get(manifest.target.agent)?
            .guidance_file(ctx.fs, &target, &env)?;
        keep(
            &mut kept,
            file,
            skill_guidance_block_key(remote, &manifest.skill_id),
        );
    }
    for s in &installs {
        if new_manifests.contains(s) {
            continue;
        }
        let Some(remote) = &s.source_remote else {
            continue;
        };
        let (env, target) = resolve_target(
            ctx.env,
            s.target.agent,
            s.target.scope == Scope::Global,
            s.target.project_id.as_deref(),
            ctx.cwd,
        )?;
        let file = ctx
            .registry
            .get(s.target.agent)?
            .guidance_file(ctx.fs, &target, &env)?;
        keep(
            &mut kept,
            file,
            skill_guidance_block_key(remote, &s.skill_id),
        );
    }
    for (manifest, has_guide) in &updated_refs {
        if *has_guide {
            continue;
        }
        let Some(remote) = &manifest.source_remote else {
            continue;
        };
        let (env, target) = resolve_target(
            ctx.env,
            manifest.target.agent,
            manifest.target.scope == Scope::Global,
            manifest.target.project_id.as_deref(),
            ctx.cwd,
        )?;
        let adapter = ctx.registry.get(manifest.target.agent)?;
        let file = adapter.guidance_file(ctx.fs, &target, &env)?;
        let key = skill_guidance_block_key(remote, &manifest.skill_id);
        if kept.get(&file).is_some_and(|s| s.contains(&key)) {
            continue;
        }
        clear_skill_guidance(ctx.fs, adapter, &target, &env, remote, &manifest.skill_id)?;
    }

    let next = AppState { installs, ..state };
    save_state(ctx.fs, ctx.state_path, &next)?;
    Ok(0)
}

/// `skill verify <id>`.
pub fn verify(
    ctx: &SkillCtx,
    id: &str,
    agent: Option<&str>,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let state = load_state(ctx.fs, ctx.state_path)?;
    let canonical = match resolve_skill_ref(id, &installed_id_candidates(&state.installs)) {
        Ok(c) => c,
        Err(msg) => {
            writeln!(err, "{msg}")?;
            return Ok(1);
        }
    };
    let matched: Vec<&InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, &canonical, agent))
        .collect();
    if matched.is_empty() {
        writeln!(err, "Skill not found: {id}")?;
        return Ok(1);
    }
    let mut any_problem = false;
    for m in matched {
        let report = verify_install(ctx.fs, m)?;
        if report.ok {
            writeln!(out, "OK: {} ({})", m.skill_id.name, m.target.agent)?;
        } else {
            any_problem = true;
            writeln!(out, "FAIL: {} ({})", m.skill_id.name, m.target.agent)?;
            for f in &report.files {
                if f.status != VerifyStatus::Ok {
                    writeln!(
                        out,
                        "  file {}: {}",
                        verify_status_str(f.status),
                        f.rel_path
                    )?;
                }
            }
            for h in &report.hook_edits {
                if h.status != VerifyStatus::Ok {
                    writeln!(
                        out,
                        "  hook {}: {}",
                        verify_status_str(h.status),
                        hook_edit_kind(&h.edit)
                    )?;
                }
            }
        }
    }
    Ok(if any_problem { 1 } else { 0 })
}

/// `skill repair <id>`.
pub fn repair(
    ctx: &SkillCtx,
    id: &str,
    agent: Option<&str>,
    project: Option<&str>,
    allow_hooks: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let state = load_state(ctx.fs, ctx.state_path)?;
    let canonical = match resolve_skill_ref(id, &installed_id_candidates(&state.installs)) {
        Ok(c) => c,
        Err(msg) => {
            writeln!(err, "{msg}")?;
            return Ok(1);
        }
    };
    let matched: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, &canonical, agent))
        .cloned()
        .collect();
    if matched.is_empty() {
        writeln!(err, "Skill not found: {id}")?;
        return Ok(1);
    }
    let mut installs = state.installs.clone();
    for m in &matched {
        let Some(repo) = state
            .repositories
            .iter()
            .find(|r| Some(&r.id) == m.source_repo_id.as_ref())
        else {
            writeln!(err, "Source repository not found for: {}", m.skill_id.name)?;
            continue;
        };
        let resolve_result = resolve_skills(ctx.fs, &repo.local_path);
        print_resolve_warnings(err, &repo.name, &resolve_result.warnings)?;
        let resolved = resolve_result
            .skills
            .into_iter()
            .find(|s| full_id(&s.id) == canonical);
        let Some(resolved) = resolved else {
            writeln!(err, "Skill not found in source: {id}")?;
            continue;
        };
        let adapter = ctx.registry.get(m.target.agent)?;
        let is_global = m.target.scope == Scope::Global;
        let project_hint = project.or(m.target.project_id.as_deref());
        let (env, target) =
            resolve_target(ctx.env, m.target.agent, is_global, project_hint, ctx.cwd)?;
        let dest_root = adapter.destination_root(&target, &env)?;
        let hook_support = resolve_hook_support(adapter, &target, &env);
        let opts = InstallOptions {
            target: target.clone(),
            source_root: repo.local_path.clone(),
            skill: resolved.clone(),
            allow_hooks,
            executable_globs: ctx.executable_globs.to_vec(),
            source_repo_id: Some(repo.id.clone()),
            source_remote: Some(repo.url.clone()),
            source_path: Some(resolved.root_path.clone()),
        };
        // Every other recorded install, so pruning cannot delete a co-located
        // skill's files (a destination directory is named after the skill alone,
        // so same-named skills from different groups or repos share one).
        let others: Vec<InstallManifest> =
            state.installs.iter().filter(|i| *i != m).cloned().collect();
        let outcome = repair_install(
            ctx.fs,
            &opts,
            &dest_root,
            hook_support.as_ref(),
            ctx.clock.now(),
            m,
            &others,
        )?;
        for i in installs.iter_mut() {
            if i == m {
                *i = outcome.manifest.clone();
            }
        }
        if !allow_hooks && !resolved.hooks.is_empty() {
            writeln!(out, "{HOOKS_REQUIRE_CONSENT}")?;
        }
        // Repair is the one operation that deletes files the user may have put
        // there by hand, so name every one rather than removing it silently.
        for rel in &outcome.removed {
            writeln!(out, "  removed extraneous: {rel}")?;
        }
        writeln!(out, "Repaired: {} ({})", m.skill_id.name, m.target.agent)?;
    }
    let next = AppState { installs, ..state };
    save_state(ctx.fs, ctx.state_path, &next)?;
    Ok(0)
}

/// Dispatch a `skill` subcommand.
pub fn run(
    action: &SkillAction,
    ctx: &SkillCtx,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        SkillAction::List => list(ctx, out),
        SkillAction::Info { id } => info(ctx, id, out, err),
        SkillAction::Install {
            id,
            agent,
            global,
            project,
            allow_hooks,
        } => {
            // With an explicit --agent, install for just that one; without it,
            // install for every agent detected in the project directory (the
            // same marker-based detection the desktop app uses).
            let agents: Vec<String> = match agent {
                Some(a) => vec![a.clone()],
                None => {
                    let dir = project.as_deref().unwrap_or(ctx.cwd);
                    let detected = detect_project_agents(ctx.fs, dir);
                    if detected.is_empty() {
                        writeln!(
                            err,
                            "No agents detected in {dir}; pass --agent to choose one."
                        )?;
                        return Ok(1);
                    }
                    detected.iter().map(|k| k.as_str().to_string()).collect()
                }
            };
            for a in &agents {
                let code = install(
                    ctx,
                    id,
                    a,
                    *global,
                    project.as_deref(),
                    *allow_hooks,
                    out,
                    err,
                )?;
                if code != 0 {
                    return Ok(code);
                }
            }
            Ok(0)
        }
        SkillAction::Uninstall { id, agent } => uninstall(ctx, id, agent.as_deref(), out, err),
        SkillAction::Update {
            id,
            agent,
            project,
            allow_hooks,
        } => update(
            ctx,
            id,
            agent.as_deref(),
            project.as_deref(),
            *allow_hooks,
            out,
            err,
        ),
        SkillAction::Verify { id, agent } => verify(ctx, id, agent.as_deref(), out, err),
        SkillAction::Repair {
            id,
            agent,
            project,
            allow_hooks,
        } => repair(
            ctx,
            id,
            agent.as_deref(),
            project.as_deref(),
            *allow_hooks,
            out,
            err,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::FixedClock;
    use skillkeeper_agents::{register_builtin_agents, AdapterRegistry};
    use skillkeeper_core::models::{
        AppState, Repository, RepositoryKind, Transport, STATE_VERSION,
    };
    use skillkeeper_core::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";
    const HOME: &str = "/home/u";
    const PROJECT: &str = "/proj";
    // 2025-07-17T00:00:00.000Z
    const FIXED_MS: i64 = 1_752_710_400_000;

    /// Minimal [`HostEnv`] double: fixed home + linux platform, no env vars (the
    /// project dir is injected by [`ProjectEnv`] per operation).
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

    struct TestCtx {
        fs: MemFs,
        registry: AdapterRegistry,
        env: FakeEnv,
        clock: FixedClock,
        globs: Vec<String>,
    }

    impl TestCtx {
        fn new(fs: MemFs) -> Self {
            Self {
                fs,
                registry: registry(),
                env: FakeEnv,
                clock: FixedClock(FIXED_MS),
                globs: Vec::new(),
            }
        }

        fn ctx(&self) -> SkillCtx<'_> {
            SkillCtx {
                fs: &self.fs,
                registry: &self.registry,
                env: &self.env,
                clock: &self.clock,
                state_path: STATE_PATH,
                executable_globs: &self.globs,
                cwd: PROJECT,
            }
        }
    }

    fn repo() -> Repository {
        Repository {
            id: "repo-1".to_string(),
            name: "skills".to_string(),
            url: "git@github.com:acme/skills.git".to_string(),
            kind: RepositoryKind::Generic,
            transport: Transport::Ssh,
            lfs: false,
            local_path: "/repos/r1".to_string(),
            last_fetched: None,
            branch: None,
        }
    }

    /// A second tracked repository, so a test can hold two skills of the same
    /// name from different origins.
    fn repo_other() -> Repository {
        Repository {
            id: "repo-2".to_string(),
            name: "extras".to_string(),
            url: "git@github.com:acme/extras.git".to_string(),
            local_path: "/repos/r2".to_string(),
            ..repo()
        }
    }

    /// A MemFs holding one repo skill (`skill-a`) with a body file and a guide.
    fn seeded_fs() -> MemFs {
        MemFs::new()
            .with_file(
                "/repos/r1/skill-a/SKILL.md",
                "---\nname: skill-a\n---\nbody\n",
            )
            .with_file("/repos/r1/skill-a/run.sh", "#!/bin/sh\necho hi\n")
            .with_file("/repos/r1/skill-a/GUIDE.md", "Do the thing.\n")
    }

    /// Two skills sharing the `skill-` prefix, for prefix-ambiguity tests.
    fn seeded_fs_two() -> MemFs {
        seeded_fs().with_file(
            "/repos/r1/skill-b/SKILL.md",
            "---\nname: skill-b\n---\nbody\n",
        )
    }

    fn seed_state(fs: &MemFs, installs: Vec<InstallManifest>) {
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo()],
            projects: vec![],
            installs,
        };
        save_state(fs, STATE_PATH, &state).unwrap();
    }

    /// A `SKILL.md` for `name` with `extra` spliced into the frontmatter, the
    /// same shape the core install tests use.
    fn skill_md(name: &str, extra: &str) -> String {
        format!("---\nname: {name}\n{extra}---\nbody\n")
    }

    /// A ready-to-use [`SkillCtx`] over one repository holding `specs` as flat
    /// skills, plus a state file naming that repository.
    ///
    /// The dependency tests want the context itself rather than the owning
    /// [`TestCtx`], so the owner is leaked: a test process ends before the leak
    /// matters, and the alternative (threading a `TestCtx` through every case)
    /// buys nothing here.
    fn install_ctx_with_skills(specs: &[(&str, &str)]) -> SkillCtx<'static> {
        let mut fs = MemFs::new();
        for (name, extra) in specs {
            fs = fs.with_file(
                &format!("/repos/r1/{name}/SKILL.md"),
                &skill_md(name, extra),
            );
        }
        let app: &'static TestCtx = Box::leak(Box::new(TestCtx::new(fs)));
        seed_state(&app.fs, vec![]);
        app.ctx()
    }

    /// Overwrite one repository `SKILL.md`, so a test can change what a skill
    /// declares between two commands.
    fn rewrite_skill(ctx: &SkillCtx, name: &str, extra: &str) {
        ctx.fs
            .write_file(
                &format!("/repos/r1/{name}/SKILL.md"),
                &skill_md(name, extra),
            )
            .unwrap();
    }

    fn install_a(app: &TestCtx) -> i32 {
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(
            &app.ctx(),
            "skill-a",
            "claude",
            false,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap()
    }

    #[test]
    fn list_reports_empty_and_populated() {
        let app = TestCtx::new(MemFs::new());
        save_state(&app.fs, STATE_PATH, &AppState::empty()).unwrap();
        let mut out = Vec::new();
        list(&app.ctx(), &mut out).unwrap();
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No skills installed."));

        let fs = seeded_fs();
        let app = TestCtx::new(fs);
        seed_state(&app.fs, vec![]);
        install_a(&app);
        let mut out = Vec::new();
        list(&app.ctx(), &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("1 skill(s) installed"));
        assert!(out.contains("skill-a  agent=claude  scope=project"));
    }

    #[test]
    fn install_copies_body_writes_guidance_and_records_manifest() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "skill-a",
            "claude",
            false,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("Skill installed: skill-a ->"));

        // Body copied to the claude project skills root.
        assert!(app
            .fs
            .exists("/proj/.claude/skills/skill-a/SKILL.md")
            .unwrap());
        // Guidance block written into the project CLAUDE.md.
        let guide = app.fs.read_file("/proj/.claude/CLAUDE.md").unwrap();
        assert!(guide.contains("Do the thing."));

        // Recorded manifest verifies clean.
        let installs = load_state(&app.fs, STATE_PATH).unwrap().installs;
        assert_eq!(installs.len(), 1);
        assert!(verify_install(&app.fs, &installs[0]).unwrap().ok);
    }

    #[test]
    fn install_reports_unknown_skill() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(
            &app.ctx(),
            "nope",
            "claude",
            false,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Skill not found in any tracked repository: nope"));
    }

    #[test]
    fn install_rejects_unknown_agent() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let res = install(
            &app.ctx(),
            "skill-a",
            "bogus",
            false,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        );
        assert!(res.is_err());
    }

    #[test]
    fn info_reports_details_and_missing() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        install_a(&app);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = info(&app.ctx(), "skill-a", &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("Skill:    skill-a"));
        assert!(out.contains("Agent:    claude  scope=project"));

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = info(&app.ctx(), "nope", &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Skill not found: nope"));
    }

    #[test]
    fn uninstall_removes_body_state_and_guidance() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        install_a(&app);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&app.ctx(), "skill-a", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Uninstalled: skill-a (claude)"));
        assert!(!app
            .fs
            .exists("/proj/.claude/skills/skill-a/SKILL.md")
            .unwrap());
        assert!(load_state(&app.fs, STATE_PATH).unwrap().installs.is_empty());
        // Guidance file emptied of the block -> removed.
        assert!(!app.fs.exists("/proj/.claude/CLAUDE.md").unwrap());
    }

    #[test]
    fn uninstall_reports_missing() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&app.ctx(), "nope", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Skill not found: nope"));
    }

    #[test]
    fn verify_reports_ok_then_fail_after_tampering() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        install_a(&app);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = verify(&app.ctx(), "skill-a", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("OK: skill-a (claude)"));

        // Tamper with an installed file.
        app.fs
            .write_file("/proj/.claude/skills/skill-a/SKILL.md", "changed")
            .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = verify(&app.ctx(), "skill-a", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("FAIL: skill-a (claude)"));
        assert!(out.contains("file modified:"));
    }

    #[test]
    fn repair_restores_a_tampered_file() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        install_a(&app);
        app.fs
            .write_file("/proj/.claude/skills/skill-a/SKILL.md", "changed")
            .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = repair(
            &app.ctx(),
            "skill-a",
            None,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Repaired: skill-a (claude)"));
        let installs = load_state(&app.fs, STATE_PATH).unwrap().installs;
        assert!(verify_install(&app.fs, &installs[0]).unwrap().ok);
    }

    #[test]
    fn update_reinstalls_from_source() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        install_a(&app);
        // Change the source body.
        app.fs
            .write_file("/repos/r1/skill-a/run.sh", "#!/bin/sh\necho updated\n")
            .unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &app.ctx(),
            "skill-a",
            None,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Updated: skill-a (claude)"));
        let body = app
            .fs
            .read_file("/proj/.claude/skills/skill-a/run.sh")
            .unwrap();
        assert!(body.contains("echo updated"));
        let installs = load_state(&app.fs, STATE_PATH).unwrap().installs;
        assert_eq!(installs.len(), 1);
        assert!(verify_install(&app.fs, &installs[0]).unwrap().ok);
    }

    #[test]
    fn install_resolves_a_unique_id_prefix() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        // "sk" uniquely prefixes "skill-a".
        let code = install(
            &app.ctx(),
            "sk",
            "claude",
            false,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let installs = load_state(&app.fs, STATE_PATH).unwrap().installs;
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].skill_id.name, "skill-a");
    }

    #[test]
    fn install_reports_ambiguous_id_prefix() {
        let app = TestCtx::new(seeded_fs_two());
        seed_state(&app.fs, vec![]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        // "skill" prefixes both skill-a and skill-b.
        let code = install(
            &app.ctx(),
            "skill",
            "claude",
            false,
            Some(PROJECT),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err).unwrap().contains("Ambiguous"));
        assert!(load_state(&app.fs, STATE_PATH).unwrap().installs.is_empty());
    }

    #[test]
    fn run_install_without_agent_targets_detected_agents() {
        // Markers for claude + codex in the project dir drive the install set.
        let fs = seeded_fs()
            .with_file("/proj/CLAUDE.md", "x")
            .with_file("/proj/AGENTS.md", "x");
        let app = TestCtx::new(fs);
        seed_state(&app.fs, vec![]);
        let action = SkillAction::Install {
            id: "skill-a".to_string(),
            agent: None,
            global: false,
            project: Some(PROJECT.to_string()),
            allow_hooks: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&action, &app.ctx(), &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let installs = load_state(&app.fs, STATE_PATH).unwrap().installs;
        assert_eq!(installs.len(), 2);
        let agents: Vec<&str> = installs.iter().map(|m| m.target.agent.as_str()).collect();
        assert!(agents.contains(&"claude"));
        assert!(agents.contains(&"codex"));
    }

    #[test]
    fn run_install_without_agent_errors_when_none_detected() {
        // The project dir has no agent markers.
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        let action = SkillAction::Install {
            id: "skill-a".to_string(),
            agent: None,
            global: false,
            project: Some(PROJECT.to_string()),
            allow_hooks: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(&action, &app.ctx(), &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("No agents detected"));
        assert!(load_state(&app.fs, STATE_PATH).unwrap().installs.is_empty());
    }

    #[test]
    fn uninstall_resolves_a_unique_id_prefix() {
        let app = TestCtx::new(seeded_fs());
        seed_state(&app.fs, vec![]);
        install_a(&app);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&app.ctx(), "sk", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(load_state(&app.fs, STATE_PATH).unwrap().installs.is_empty());
    }

    #[test]
    fn install_pulls_in_the_transitive_dependency_closure() {
        // a -> b -> c: asking for `a` installs three skills, in closure order.
        let ctx = install_ctx_with_skills(&[
            ("a", "skillkeeper:\n  requires:\n    - b\n"),
            ("b", "skillkeeper:\n  requires:\n    - c\n"),
            ("c", ""),
        ]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Skill installed: a"), "{text}");
        assert!(text.contains("as a dependency: b"), "{text}");
        assert!(text.contains("as a dependency: c"), "{text}");
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(state.installs.len(), 3);
    }

    #[test]
    fn install_names_a_dependency_that_does_not_exist_and_still_installs_the_skill() {
        // Two hops, so the report has to name `b` as the referrer: `a` requires
        // `b`, and it is `b` that requires the skill that is not there.
        let ctx = install_ctx_with_skills(&[
            ("a", "skillkeeper:\n  requires:\n    - b\n"),
            ("b", "skillkeeper:\n  requires:\n    - ghost\n"),
        ]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(state.installs.len(), 2);
        let text = String::from_utf8(err).unwrap();
        assert!(
            text.contains("Skill \"b\" requires \"ghost\""),
            "the referrer must be the skill that declared it: {text}"
        );
        assert!(
            !text.contains("Skill \"a\" requires \"ghost\""),
            "`a` never declared `ghost`: {text}"
        );
    }

    #[test]
    fn install_does_not_reinstall_a_dependency_already_installed_for_that_agent() {
        let ctx =
            install_ctx_with_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "b", "claude", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(state.installs.len(), 2, "b must not be installed twice");
    }

    #[test]
    fn install_says_so_when_the_skill_is_already_installed() {
        let ctx = install_ctx_with_skills(&[("a", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains("Skill already installed: a"),
            "doing nothing has to be reported: {text}"
        );
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(state.installs.len(), 1, "and it must stay one entry");
    }

    #[test]
    fn install_terminates_on_a_dependency_cycle() {
        let ctx = install_ctx_with_skills(&[
            ("a", "skillkeeper:\n  requires:\n    - b\n"),
            ("b", "skillkeeper:\n  requires:\n    - a\n"),
        ]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(state.installs.len(), 2);
    }

    #[test]
    fn update_installs_a_newly_declared_dependency() {
        let ctx = install_ctx_with_skills(&[("a", ""), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        // The repository's `a` now requires `b`, which is not installed.
        rewrite_skill(&ctx, "a", "skillkeeper:\n  requires:\n    - b\n");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(&ctx, "a", None, None, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(
            state.installs.len(),
            2,
            "the new dependency must be installed"
        );
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("as a dependency: b"));
    }

    #[test]
    fn update_refreshes_an_already_installed_dependency() {
        let ctx =
            install_ctx_with_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        let before = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(before.installs.len(), 2);
        let mut out = Vec::new();
        let mut err = Vec::new();
        update(&ctx, "a", None, None, false, &mut out, &mut err).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("Updated: a"), "{text}");
        assert!(text.contains("Updated: b"), "{text}");
    }

    #[test]
    fn update_leaves_a_same_named_skill_from_another_repository_alone() {
        // r1 holds `a` (requiring `b`) and its own `b`; r2 holds an unrelated
        // skill also called `b`, and r2's is the one installed.
        let fs = MemFs::new()
            .with_file(
                "/repos/r1/a/SKILL.md",
                &skill_md("a", "skillkeeper:\n  requires:\n    - b\n"),
            )
            .with_file("/repos/r1/b/SKILL.md", &skill_md("b", ""))
            .with_file("/repos/r2/b/SKILL.md", &skill_md("b", ""));
        let app: &'static TestCtx = Box::leak(Box::new(TestCtx::new(fs)));
        // Only r2 is tracked at first, so `b` resolves to r2 without ambiguity.
        let seeded = AppState {
            version: STATE_VERSION,
            repositories: vec![repo_other()],
            projects: vec![],
            installs: vec![],
        };
        save_state(&app.fs, STATE_PATH, &seeded).unwrap();
        let ctx = app.ctx();
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "b", "claude", true, None, false, &mut out, &mut err).unwrap();

        // Track r1 as well, then install its `a`, whose dependency `b` is
        // already taken by r2's skill of that name.
        let mut state = load_state(ctx.fs, ctx.state_path).unwrap();
        state.repositories.push(repo());
        save_state(ctx.fs, ctx.state_path, &state).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        assert_eq!(
            load_state(ctx.fs, ctx.state_path).unwrap().installs.len(),
            2
        );

        let mut out = Vec::new();
        let mut err = Vec::new();
        update(&ctx, "a", None, None, false, &mut out, &mut err).unwrap();
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        let b = state
            .installs
            .iter()
            .find(|m| m.skill_id.name == "b")
            .expect("r2's `b` must still be installed");
        assert_eq!(
            b.source_repo_id.as_deref(),
            Some("repo-2"),
            "updating r1's `a` must not re-home r2's `b`"
        );
    }

    #[test]
    fn uninstall_warns_about_installed_skills_that_depended_on_the_removed_one() {
        let ctx =
            install_ctx_with_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&ctx, "b", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 0, "uninstall never cascades and never fails on this");
        let text = String::from_utf8(err).unwrap();
        assert!(text.contains("\"a\""), "{text}");
        assert!(text.contains("still installed"), "{text}");
        assert!(
            text.contains("required \"b\", which was just removed"),
            "the wording says what this command did: {text}"
        );
        // Only what was asked for is gone.
        let state = load_state(ctx.fs, ctx.state_path).unwrap();
        assert_eq!(state.installs.len(), 1);
        assert_eq!(state.installs[0].skill_id.name, "a");
    }

    #[test]
    fn uninstall_does_not_warn_when_the_dependent_keeps_its_own_dependency() {
        // `a` and its dependency `b` are installed for codex; `b` is installed
        // for claude too. Removing the claude copy leaves the codex pair whole,
        // so there is nothing to report.
        let ctx =
            install_ctx_with_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "codex", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "b", "claude", true, None, false, &mut out, &mut err).unwrap();
        assert_eq!(
            load_state(ctx.fs, ctx.state_path).unwrap().installs.len(),
            3
        );

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&ctx, "b", Some("claude"), &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(err).unwrap();
        assert!(text.is_empty(), "nothing lost its dependency: {text}");
    }

    #[test]
    fn uninstall_warns_only_for_the_target_that_lost_the_dependency() {
        // The same setup, removing the codex copy instead: `a` is installed for
        // codex, and the surviving `b` is a claude install it cannot use.
        let ctx =
            install_ctx_with_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "codex", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "b", "claude", true, None, false, &mut out, &mut err).unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&ctx, "b", Some("codex"), &mut out, &mut err).unwrap();
        assert_eq!(code, 0, "uninstall never cascades and never fails on this");
        let text = String::from_utf8(err).unwrap();
        assert_eq!(text.lines().count(), 1, "one line, for codex only: {text}");
        assert!(text.contains("\"a\""), "{text}");
        assert!(text.contains("still installed"), "{text}");
        assert!(text.contains("codex"), "{text}");
        assert!(text.contains("just removed"), "{text}");
    }

    #[test]
    fn uninstall_does_not_report_breakage_it_did_not_cause() {
        // `a` requires a skill that was never there, so `a` is already broken.
        // Removing an unrelated `c` did not do that and must not claim it.
        let ctx = install_ctx_with_skills(&[
            ("a", "skillkeeper:\n  requires:\n    - ghost\n"),
            ("c", ""),
        ]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "c", "claude", true, None, false, &mut out, &mut err).unwrap();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = uninstall(&ctx, "c", None, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(err).unwrap();
        assert!(
            text.is_empty(),
            "`a` was broken before this command ran: {text}"
        );
    }

    #[test]
    fn uninstall_says_nothing_when_no_installed_skill_depended_on_it() {
        let ctx = install_ctx_with_skills(&[("a", ""), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "b", "claude", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        uninstall(&ctx, "b", None, &mut out, &mut err).unwrap();
        assert!(String::from_utf8(err).unwrap().is_empty());
    }

    #[test]
    fn uninstall_does_not_warn_about_a_dependent_that_is_already_gone() {
        // `a` requires `b`. Once `a` is uninstalled, removing `b` breaks
        // nothing: the report is built from the ledger, not from the source.
        let ctx =
            install_ctx_with_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let mut out = Vec::new();
        let mut err = Vec::new();
        install(&ctx, "a", "claude", true, None, false, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        uninstall(&ctx, "a", None, &mut out, &mut err).unwrap();
        let mut out = Vec::new();
        let mut err = Vec::new();
        uninstall(&ctx, "b", None, &mut out, &mut err).unwrap();
        assert!(String::from_utf8(err).unwrap().is_empty());
    }
}
