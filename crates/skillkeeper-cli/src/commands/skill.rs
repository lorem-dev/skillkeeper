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
use skillkeeper_agents::{AdapterRegistry, AgentAdapter};
use skillkeeper_core::hooks::guidance::{
    guidance_key, remove_guidance_block, skill_guidance_id, strip_guidance_markers,
    upsert_guidance_block,
};
use skillkeeper_core::install::install::{install_skill, uninstall_skill, HookSupport};
use skillkeeper_core::install::verify::{repair_install, verify_install};
use skillkeeper_core::models::{
    AgentTarget, InstallManifest, InstallOptions, ManagedHookEdit, Scope, SkillId, VerifyStatus,
};
use skillkeeper_core::ports::{Clock, FsPort, HostEnv, PortResult};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::{load_state, save_state};

use crate::commands::agenthelpers::{parse_agent, scope_str, ProjectEnv};
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
        /// Skill id (`group/name` or `name`) as found in a tracked repository.
        id: String,
        /// Agent to install for (claude|codex|copilot|cursor|opencode).
        #[arg(long)]
        agent: String,
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
    let matches: Vec<&InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches_id(m, id))
        .collect();
    if matches.is_empty() {
        writeln!(err, "Skill not found: {id}")?;
        return Ok(1);
    }
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

    // Find the skill in tracked repositories.
    let mut found = None;
    for repo in &state.repositories {
        let resolved = resolve_skills(ctx.fs, &repo.local_path);
        if let Some(skill) = resolved
            .skills
            .into_iter()
            .find(|s| full_id(&s.id) == id || s.id.name == id)
        {
            found = Some((
                repo.local_path.clone(),
                repo.id.clone(),
                repo.url.clone(),
                skill,
            ));
            break;
        }
    }
    let Some((source_root, source_repo_id, source_remote, skill)) = found else {
        writeln!(err, "Skill not found in any tracked repository: {id}")?;
        return Ok(1);
    };

    let agent_kind = parse_agent(agent)?;
    let adapter = ctx.registry.get(agent_kind)?;
    let (env, target) = resolve_target(ctx.env, agent_kind, global, project, ctx.cwd)?;

    let dest_root = adapter.destination_root(&target, &env)?;
    let hook_support = resolve_hook_support(adapter, &target, &env);
    let opts = InstallOptions {
        target: target.clone(),
        source_root: source_root.clone(),
        skill: skill.clone(),
        allow_hooks,
        executable_globs: ctx.executable_globs.to_vec(),
        source_repo_id: Some(source_repo_id),
        source_remote: Some(source_remote.clone()),
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
            &source_remote,
            &skill.id,
            &body,
        )?;
    }

    let dest = manifest.destination_root.clone();
    state.installs.push(manifest);
    save_state(ctx.fs, ctx.state_path, &state)?;

    if !allow_hooks && !skill.hooks.is_empty() {
        writeln!(out, "{HOOKS_REQUIRE_CONSENT}")?;
    }
    writeln!(out, "Skill installed: {} -> {dest}", full_id(&skill.id))?;
    Ok(0)
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
    let matched: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, id, agent))
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

    let next = skillkeeper_core::models::AppState {
        installs: surviving,
        ..state
    };
    save_state(ctx.fs, ctx.state_path, &next)?;
    Ok(0)
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
    let matched: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, id, agent))
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
        let resolved = resolve_skills(ctx.fs, &repo.local_path)
            .skills
            .into_iter()
            .find(|s| full_id(&s.id) == id || s.id.name == id);
        let Some(resolved) = resolved else {
            writeln!(err, "Skill not found in source: {id}")?;
            continue;
        };
        let adapter = ctx.registry.get(m.target.agent)?;
        let is_global = m.target.scope == Scope::Global;
        let project_hint = project.or(m.target.project_id.as_deref());
        let (env, target) =
            resolve_target(ctx.env, m.target.agent, is_global, project_hint, ctx.cwd)?;

        uninstall_skill(ctx.fs, m)?;
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
        installs.retain(|i| i != m);
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
            writeln!(out, "{HOOKS_REQUIRE_CONSENT}")?;
        }
        writeln!(out, "Updated: {} ({})", m.skill_id.name, m.target.agent)?;
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

    let next = skillkeeper_core::models::AppState { installs, ..state };
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
    let matched: Vec<&InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, id, agent))
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
    let matched: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| matches(m, id, agent))
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
        let resolved = resolve_skills(ctx.fs, &repo.local_path)
            .skills
            .into_iter()
            .find(|s| full_id(&s.id) == id || s.id.name == id);
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
        let new_manifest = repair_install(
            ctx.fs,
            &opts,
            &dest_root,
            hook_support.as_ref(),
            ctx.clock.now(),
            m,
        )?;
        for i in installs.iter_mut() {
            if i == m {
                *i = new_manifest.clone();
            }
        }
        if !allow_hooks && !resolved.hooks.is_empty() {
            writeln!(out, "{HOOKS_REQUIRE_CONSENT}")?;
        }
        writeln!(out, "Repaired: {} ({})", m.skill_id.name, m.target.agent)?;
    }
    let next = skillkeeper_core::models::AppState { installs, ..state };
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
        } => install(
            ctx,
            id,
            agent,
            *global,
            project.as_deref(),
            *allow_hooks,
            out,
            err,
        ),
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

    fn seed_state(fs: &MemFs, installs: Vec<InstallManifest>) {
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![repo()],
            projects: vec![],
            installs,
        };
        save_state(fs, STATE_PATH, &state).unwrap();
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
}
