//! Skill commands (port of `apps/desktop/src/main/skills.ts` and the
//! `listAvailableSkills` helper in `apps/desktop/src/main/repositories.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `skills:available` -> `skills_available`
//!   `skills:reconcile` -> `skills_reconcile`
//!   `skills:apply`     -> `skills_apply`   (emits `skills:progress` events)
//!
//! `skills:list` (install manifests) already lives in `state_read.rs`; it is the
//! recorded-installs list and is left there unchanged.
//!
//! This is where the Phase 1 parameterization of the install engine
//! (`install_skill(fs, opts, dest_root, hook_support, now_ms)`) is consumed: the
//! [`AdapterRegistry`] resolves each agent's destination root and hook capability
//! for a target, and those are passed into the engine. Agent path resolution
//! reads the active project directory from the [`PROJECT_DIR_ENV`] host variable,
//! which is injected per project via [`ProjectEnv`] (the Rust analogue of the TS
//! `adapterEnvFor`). Every state mutation runs under `ctx.state_lock`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use skillkeeper_agents::{AgentAdapter, PROJECT_DIR_ENV};
use skillkeeper_config::load_config;
use skillkeeper_core::git_remote::normalize_remote;
use skillkeeper_core::hashing::{content_hash, hash_tree, resolved_content_hash, HashEntry};
use skillkeeper_core::hooks::guidance::{
    guidance_key, remove_guidance_block, skill_guidance_id, strip_guidance_markers,
    upsert_guidance_block,
};
use skillkeeper_core::install::install::{install_skill, uninstall_skill, HookSupport};
use skillkeeper_core::models::{
    AgentKind, AgentTarget, AppState, InstallManifest, InstallOptions, Scope, SkillId,
};
use skillkeeper_core::ports::{Clock, FsPort, HostEnv, PortResult};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::skills::skid::{parse_skid, SKID_FILE};
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;

use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

/// Every agent kind, in the fixed order of the TS `AGENT_MARKERS` keys. Used by
/// reconcile to scan each agent's skill root.
const AGENT_ORDER: [AgentKind; 5] = [
    AgentKind::Claude,
    AgentKind::Codex,
    AgentKind::Copilot,
    AgentKind::Cursor,
    AgentKind::Opencode,
];

/// Acquire the state lock, recovering the guard if a prior holder panicked.
fn lock(ctx: &AppContext) -> std::sync::MutexGuard<'_, ()> {
    ctx.state_lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// A [`HostEnv`] view that injects the active project directory into
/// [`PROJECT_DIR_ENV`], leaving every other lookup to the wrapped environment.
/// The Rust analogue of the TS `adapterEnvFor`: adapters resolve project-scope
/// paths from this variable since an [`AgentTarget`] carries only a `projectId`.
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

/// Read a skill's guide body from its source directory: `GUIDE.md` wins over
/// `RULES.md`; stray SkillKeeper markers are stripped and trailing newlines
/// trimmed. `None` when neither file exists. Local port of `readSkillGuide`
/// (`hooks/guidanceApply.ts`), which has no Rust core equivalent yet.
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

/// The guidance block key for a skill installed from `remote` (local port of
/// `skillGuidanceBlockKey` in `hooks/guidanceApply.ts`).
fn skill_guidance_block_key(remote: &str, id: &SkillId) -> String {
    guidance_key(remote, &skill_guidance_id(id.group.as_deref(), &id.name))
}

/// List file paths (relative to `base`) recursively under `base/rel`. A listing
/// error yields the paths gathered so far (mirrors the TS `listFilesRec` catch).
fn list_files_rec(fs: &dyn FsPort, base: &str, rel: &str) -> Vec<String> {
    let mut out = Vec::new();
    let entries = match fs.list(&format!("{base}/{rel}")) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries {
        let child = format!("{rel}/{entry}");
        match fs.stat(&format!("{base}/{child}")) {
            Ok(Some(s)) if s.is_directory => out.extend(list_files_rec(fs, base, &child)),
            Ok(Some(s)) if s.is_file => out.push(child),
            _ => {}
        }
    }
    out
}

// ---------------------------------------------------------------------------
// skills:available
// ---------------------------------------------------------------------------

/// One skill available in a repository's working tree (mirrors the TS
/// `AvailableSkill`; drives the Skills page tree).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableSkill {
    pub repo_id: String,
    pub repo_name: String,
    /// Source repository remote URL; the stable identity for matching installs.
    pub remote: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Content hash of the skill body (excludes `.skid.yml`), for update detection.
    pub content_hash: String,
    /// The skill ships a `GUIDE.md`/`RULES.md` guidance file (drives the badge).
    pub has_guidance: bool,
}

/// `skills:available` -- every skill resolved across all cloned repositories.
/// Repos whose clone is missing or fails to resolve are skipped.
pub fn available(ctx: &AppContext) -> Vec<AvailableSkill> {
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
        let resolved = resolve_skills(&ctx.fs, &repo.local_path);
        for skill in &resolved.skills {
            // A read failure aborts the rest of this repo, keeping any already
            // pushed (mirrors the per-repo try/catch in the TS source).
            let content_hash = match resolved_content_hash(&ctx.fs, &repo.local_path, skill) {
                Ok(h) => h,
                Err(_) => break,
            };
            let guide = format!("{}/GUIDE.md", skill.root_path);
            let rules = format!("{}/RULES.md", skill.root_path);
            let has_guidance = skill.files.iter().any(|f| *f == guide || *f == rules);
            out.push(AvailableSkill {
                repo_id: repo.id.clone(),
                repo_name: repo.name.clone(),
                remote: repo.url.clone(),
                group: skill.id.group.clone(),
                name: skill.id.name.clone(),
                version: skill.manifest.version.clone(),
                description: skill.manifest.description.clone(),
                content_hash,
                has_guidance,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// skills:reconcile
// ---------------------------------------------------------------------------

/// Adopt/refresh the manifest for one on-disk skill dir found during a scan
/// (port of the TS `adoptSkill`). `Ok(None)` when the directory is not a skill.
#[allow(clippy::too_many_arguments)]
fn adopt_skill(
    fs: &dyn FsPort,
    dest_root: &str,
    dir_name: &str,
    target: &AgentTarget,
    rehome: &dyn Fn(Option<&str>) -> Option<String>,
    existing: Option<&InstallManifest>,
    now_ms: i64,
) -> Result<Option<InstallManifest>, String> {
    let skid_path = format!("{dest_root}/{dir_name}/{SKID_FILE}");
    let skid = if fs.exists(&skid_path).map_err(|e| e.to_string())? {
        parse_skid(&fs.read_file(&skid_path).map_err(|e| e.to_string())?)
    } else {
        None
    };
    // A skill dir is identified by SKILL.md; managed ones also carry `.skid.yml`.
    let is_skill = skid.is_some()
        || fs
            .exists(&format!("{dest_root}/{dir_name}/SKILL.md"))
            .map_err(|e| e.to_string())?;
    if !is_skill {
        return Ok(None);
    }

    let name = skid
        .as_ref()
        .map(|s| s.name.clone())
        .unwrap_or_else(|| dir_name.to_string());
    let group = skid.as_ref().and_then(|s| s.group.clone());

    let rels = list_files_rec(fs, dest_root, dir_name);
    let refs: Vec<&str> = rels.iter().map(String::as_str).collect();
    let files = hash_tree(fs, dest_root, &refs).map_err(|e| e.to_string())?;
    let prefix = format!("{name}/");
    let entries: Vec<HashEntry> = files
        .iter()
        .map(|f| HashEntry {
            rel_path: f
                .rel_path
                .strip_prefix(&prefix)
                .unwrap_or(&f.rel_path)
                .to_string(),
            sha256: f.sha256.clone(),
        })
        .collect();
    let hash = content_hash(&entries);

    let remote = skid
        .as_ref()
        .and_then(|s| s.remote.clone())
        .or_else(|| existing.and_then(|e| e.source_remote.clone()));
    // With a known remote: re-home to a tracked repo sharing it, else keep the
    // last-known id; otherwise the `''` sentinel marks it unmanaged.
    let source_repo_id = rehome(remote.as_deref())
        .or_else(|| existing.and_then(|e| e.source_repo_id.clone()))
        .unwrap_or_default();

    Ok(Some(InstallManifest {
        skill_id: SkillId { group, name },
        target: target.clone(),
        destination_root: dest_root.to_string(),
        source_repo_id: Some(source_repo_id),
        source_remote: remote,
        source_path: existing.and_then(|e| e.source_path.clone()),
        content_hash: Some(hash),
        version: existing.and_then(|e| e.version.clone()),
        installed_at: existing
            .map(|e| e.installed_at.clone())
            .unwrap_or_else(|| iso_from_millis(now_ms)),
        files,
        hook_edits: existing.map(|e| e.hook_edits.clone()).unwrap_or_default(),
    }))
}

/// `skills:reconcile` -- reconcile project-scoped installs with what is actually
/// on disk (port of the TS `reconcileProjectSkills`). Scans each tracked
/// project's agent skill roots, adopts untracked `.skid.yml` skills, refreshes
/// remote/content-hash, re-homes `sourceRepoId` by remote, and prunes manifests
/// whose skill dir is gone. Projects whose folder is missing are left untouched.
/// Returns the reconciled install list (persisted only when it changed).
pub fn reconcile(ctx: &AppContext) -> Result<Vec<InstallManifest>, String> {
    let _guard = lock(ctx);
    let state = load_state(&ctx.fs, &ctx.paths.state_json).map_err(|e| e.to_string())?;
    let now_ms = ctx.clock.now();

    let tracked_ids: HashSet<&str> = state.projects.iter().map(|p| p.id.as_str()).collect();
    let repos = &state.repositories;
    let rehome = |remote: Option<&str>| -> Option<String> {
        let remote = remote?;
        let norm = normalize_remote(remote);
        repos
            .iter()
            .find(|r| normalize_remote(&r.url) == norm)
            .map(|r| r.id.clone())
    };

    // Global installs and installs of untracked projects are preserved as-is.
    let mut kept: Vec<InstallManifest> = state
        .installs
        .iter()
        .filter(|m| {
            !(m.target.scope == Scope::Project
                && m.target
                    .project_id
                    .as_deref()
                    .is_some_and(|id| tracked_ids.contains(id)))
        })
        .cloned()
        .collect();

    for project in &state.projects {
        let proj_installs: Vec<&InstallManifest> = state
            .installs
            .iter()
            .filter(|m| {
                m.target.scope == Scope::Project
                    && m.target.project_id.as_deref() == Some(project.id.as_str())
            })
            .collect();
        if !ctx.fs.exists(&project.path).unwrap_or(false) {
            kept.extend(proj_installs.iter().map(|m| (*m).clone()));
            continue;
        }
        for agent in AGENT_ORDER {
            let target = AgentTarget {
                agent,
                scope: Scope::Project,
                project_id: Some(project.id.clone()),
            };
            let env = ProjectEnv {
                inner: &ctx.env,
                project_path: project.path.clone(),
            };
            let adapter = match ctx.registry.get(agent) {
                Ok(a) => a,
                Err(_) => continue,
            };
            let dest_root = match adapter.destination_root(&target, &env) {
                Ok(d) => d,
                Err(_) => continue,
            };
            if !ctx.fs.exists(&dest_root).unwrap_or(false) {
                continue;
            }
            let dir_names = match ctx.fs.list(&dest_root) {
                Ok(d) => d,
                Err(_) => continue,
            };
            for dir_name in dir_names {
                let existing = proj_installs
                    .iter()
                    .find(|m| m.target.agent == agent && m.skill_id.name == dir_name)
                    .copied();
                if let Some(manifest) = adopt_skill(
                    &ctx.fs, &dest_root, &dir_name, &target, &rehome, existing, now_ms,
                )? {
                    kept.push(manifest);
                }
            }
        }
    }

    if kept != state.installs {
        let next = AppState {
            version: state.version,
            repositories: state.repositories.clone(),
            projects: state.projects.clone(),
            installs: kept.clone(),
        };
        save_state(&ctx.fs, &ctx.paths.state_json, &next).map_err(|e| e.to_string())?;
    }
    Ok(kept)
}

// ---------------------------------------------------------------------------
// skills:apply
// ---------------------------------------------------------------------------

/// A skill identified by its source repo and (group, name). Mirrors the TS
/// `SkillRef`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRef {
    pub repo_id: String,
    #[serde(default)]
    pub group: Option<String>,
    pub name: String,
}

/// Arguments to `skills:apply` (mirrors the TS `ApplyArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyArgs {
    /// Project UUID (recorded as `target.projectId`).
    pub project_id: String,
    /// Project folder path (used for `PROJECT_DIR_ENV` path resolution).
    pub project_path: String,
    pub agents: Vec<AgentKind>,
    pub install: Vec<SkillRef>,
    pub remove: Vec<SkillRef>,
}

/// One `skills:progress` event payload (mirrors the TS `ApplyProgress`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProgress {
    pub done: usize,
    pub total: usize,
    pub label: String,
}

/// Outcome of `skills:apply`: `{ ok: true, installed, removed }` or
/// `{ ok: false, error }` (mirrors the TS `ApplyResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ApplyResult {
    fn ok(installed: usize, removed: usize) -> Self {
        Self {
            ok: true,
            installed: Some(installed),
            removed: Some(removed),
            error: None,
        }
    }

    fn err(error: String) -> Self {
        Self {
            ok: false,
            installed: None,
            removed: None,
            error: Some(error),
        }
    }
}

/// Identity of a project-scoped install for this run: `(agent, group, name)`.
fn manifest_key(m: &InstallManifest) -> (AgentKind, String, String) {
    (
        m.target.agent,
        m.skill_id.group.clone().unwrap_or_default(),
        m.skill_id.name.clone(),
    )
}

/// True when the manifest is the same skill as `r` (same source repo, group, name).
fn same_skill(m: &InstallManifest, r: &SkillRef) -> bool {
    m.source_repo_id.as_deref() == Some(r.repo_id.as_str())
        && m.skill_id.name == r.name
        && m.skill_id.group.clone().unwrap_or_default() == r.group.clone().unwrap_or_default()
}

/// Resolve the adapter's hook capability for a target into the engine's
/// [`HookSupport`] (strategy + resolved target file). `None` when the agent has
/// no hook capability or the target file cannot be resolved. This is the seam
/// where the Phase 1 `install_skill` hook parameter is fed from the adapters.
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

/// Insert or replace a `(block_key, body)` in the ordered per-file upsert map.
fn upsert_ordered(
    upserts: &mut Vec<(String, Vec<(String, String)>)>,
    file: String,
    key: String,
    body: String,
) {
    if let Some((_, blocks)) = upserts.iter_mut().find(|(f, _)| *f == file) {
        if let Some((_, b)) = blocks.iter_mut().find(|(k, _)| *k == key) {
            *b = body;
        } else {
            blocks.push((key, body));
        }
    } else {
        upserts.push((file, vec![(key, body)]));
    }
}

/// Record that `key` must be kept in guidance file `f`.
fn keep_block(map: &mut HashMap<String, HashSet<String>>, f: &str, key: &str) {
    map.entry(f.to_string())
        .or_default()
        .insert(key.to_string());
}

/// `skills:apply` -- apply a set of installs and removals for a project across
/// the given agents, reporting progress (port of the TS `applySkillChanges`).
/// Never throws across the boundary: returns an [`ApplyResult`]. `on_progress`
/// receives each [`ApplyProgress`] step (the command wrapper forwards it to the
/// `skills:progress` Tauri event).
pub fn apply(
    ctx: &AppContext,
    args: ApplyArgs,
    on_progress: &mut dyn FnMut(ApplyProgress),
) -> ApplyResult {
    let _guard = lock(ctx);
    match apply_inner(ctx, &args, on_progress) {
        Ok((installed, removed)) => ApplyResult::ok(installed, removed),
        Err(e) => ApplyResult::err(e),
    }
}

/// Increment `done` and emit one progress step.
fn tick(done: &mut usize, total: usize, label: &str, on_progress: &mut dyn FnMut(ApplyProgress)) {
    *done += 1;
    on_progress(ApplyProgress {
        done: *done,
        total,
        label: label.to_string(),
    });
}

/// The fallible body of [`apply`], run under the state lock.
fn apply_inner(
    ctx: &AppContext,
    args: &ApplyArgs,
    on_progress: &mut dyn FnMut(ApplyProgress),
) -> Result<(usize, usize), String> {
    let globs = load_config(&ctx.fs, &ctx.paths.config_yaml)
        .config
        .executables
        .globs;
    let state = load_state(&ctx.fs, &ctx.paths.state_json).map_err(|e| e.to_string())?;
    let now_ms = ctx.clock.now();
    let mut installs = state.installs.clone();
    let env = ProjectEnv {
        inner: &ctx.env,
        project_path: args.project_path.clone(),
    };

    let per_skill = args.agents.len().max(1);
    let total = (args.install.len() + args.remove.len()) * per_skill;
    let mut done = 0usize;

    // key = guidance file path; value = ordered (blockKey, body) upserts.
    let mut upserts: Vec<(String, Vec<(String, String)>)> = Vec::new();
    // { file, blockKey } to remove unless still needed.
    let mut removals: Vec<(String, String)> = Vec::new();
    // Manifests (re)installed this run, by identity key.
    let mut new_this_run: HashSet<(AgentKind, String, String)> = HashSet::new();

    // Removals first, so a re-install onto the same target starts clean.
    for r in &args.remove {
        for &agent in &args.agents {
            if let Some(pos) = installs.iter().position(|m| {
                m.target.project_id.as_deref() == Some(args.project_id.as_str())
                    && m.target.agent == agent
                    && same_skill(m, r)
            }) {
                let manifest = installs.remove(pos);
                uninstall_skill(&ctx.fs, &manifest).map_err(|e| e.to_string())?;
                if let Some(remote) = &manifest.source_remote {
                    let target = AgentTarget {
                        agent,
                        scope: Scope::Project,
                        project_id: Some(args.project_id.clone()),
                    };
                    let file = ctx
                        .registry
                        .get(agent)
                        .map_err(|e| e.to_string())?
                        .guidance_file(&ctx.fs, &target, &env)
                        .map_err(|e| e.to_string())?;
                    removals.push((file, skill_guidance_block_key(remote, &manifest.skill_id)));
                }
            }
            tick(&mut done, total, &r.name, on_progress);
        }
    }

    // Installs.
    for r in &args.install {
        let repo = state
            .repositories
            .iter()
            .find(|rp| rp.id == r.repo_id)
            .cloned();
        let resolved = match &repo {
            Some(repo) => resolve_skills(&ctx.fs, &repo.local_path)
                .skills
                .into_iter()
                .find(|s| {
                    s.id.name == r.name
                        && s.id.group.clone().unwrap_or_default()
                            == r.group.clone().unwrap_or_default()
                }),
            None => None,
        };
        for &agent in &args.agents {
            if let (Some(repo), Some(resolved)) = (&repo, &resolved) {
                let already = installs.iter().any(|m| {
                    m.target.project_id.as_deref() == Some(args.project_id.as_str())
                        && m.target.agent == agent
                        && same_skill(m, r)
                });
                if !already {
                    let adapter = ctx.registry.get(agent).map_err(|e| e.to_string())?;
                    let target = AgentTarget {
                        agent,
                        scope: Scope::Project,
                        project_id: Some(args.project_id.clone()),
                    };
                    let dest_root = adapter
                        .destination_root(&target, &env)
                        .map_err(|e| e.to_string())?;
                    // Resolve the adapter's hook capability for the target and
                    // feed it to the engine. Hooks are gated off here
                    // (allow_hooks: false), matching the desktop skill flow.
                    let hook_support = resolve_hook_support(adapter, &target, &env);
                    let opts = InstallOptions {
                        target: target.clone(),
                        source_root: repo.local_path.clone(),
                        skill: resolved.clone(),
                        allow_hooks: false,
                        executable_globs: globs.clone(),
                        source_repo_id: Some(repo.id.clone()),
                        source_remote: Some(repo.url.clone()),
                        source_path: Some(resolved.root_path.clone()),
                    };
                    let manifest =
                        install_skill(&ctx.fs, &opts, &dest_root, hook_support.as_ref(), now_ms)
                            .map_err(|e| e.to_string())?;
                    installs.push(manifest.clone());
                    new_this_run.insert(manifest_key(&manifest));
                    let guide_dir = format!("{}/{}", repo.local_path, resolved.root_path);
                    if let Some(body) =
                        read_skill_guide(&ctx.fs, &guide_dir).map_err(|e| e.to_string())?
                    {
                        let file = adapter
                            .guidance_file(&ctx.fs, &target, &env)
                            .map_err(|e| e.to_string())?;
                        let block_key = skill_guidance_block_key(&repo.url, &resolved.id);
                        upsert_ordered(&mut upserts, file, block_key, body);
                    }
                }
            }
            tick(&mut done, total, &r.name, on_progress);
        }
    }

    // Guidance blocks: upserts first, then removals no longer needed by a
    // surviving install sharing the same guidance file.
    let mut final_keys: HashMap<String, HashSet<String>> = HashMap::new();
    // (a) Blocks (re)written this run.
    for (file, blocks) in &upserts {
        for (key, _) in blocks {
            keep_block(&mut final_keys, file, key);
        }
    }
    // (b) Untouched surviving installs keep their block.
    for m in &installs {
        if m.target.project_id.as_deref() != Some(args.project_id.as_str()) {
            continue;
        }
        let Some(remote) = &m.source_remote else {
            continue;
        };
        if new_this_run.contains(&manifest_key(m)) {
            continue;
        }
        let target = AgentTarget {
            agent: m.target.agent,
            scope: Scope::Project,
            project_id: Some(args.project_id.clone()),
        };
        let file = ctx
            .registry
            .get(m.target.agent)
            .map_err(|e| e.to_string())?
            .guidance_file(&ctx.fs, &target, &env)
            .map_err(|e| e.to_string())?;
        keep_block(
            &mut final_keys,
            &file,
            &skill_guidance_block_key(remote, &m.skill_id),
        );
    }

    for (file, blocks) in &upserts {
        let mut text = if ctx.fs.exists(file).map_err(|e| e.to_string())? {
            ctx.fs.read_file(file).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        for (block_key, body) in blocks {
            text = upsert_guidance_block(&text, block_key, body);
        }
        ctx.fs.write_file(file, &text).map_err(|e| e.to_string())?;
    }

    for (file, block_key) in &removals {
        if final_keys.get(file).is_some_and(|s| s.contains(block_key)) {
            continue;
        }
        if !ctx.fs.exists(file).map_err(|e| e.to_string())? {
            continue;
        }
        let next = remove_guidance_block(
            &ctx.fs.read_file(file).map_err(|e| e.to_string())?,
            block_key,
        );
        // Removing our only block empties a guidance file we created; delete it.
        if next.is_empty() {
            ctx.fs.remove(file).map_err(|e| e.to_string())?;
        } else {
            ctx.fs.write_file(file, &next).map_err(|e| e.to_string())?;
        }
    }

    let next = AppState {
        version: state.version,
        repositories: state.repositories.clone(),
        projects: state.projects.clone(),
        installs: installs.clone(),
    };
    save_state(&ctx.fs, &ctx.paths.state_json, &next).map_err(|e| e.to_string())?;
    Ok((args.install.len(), args.remove.len()))
}

// ---------------------------------------------------------------------------
// Tauri command wrappers.
// ---------------------------------------------------------------------------

/// `skills:available`.
#[tauri::command]
pub async fn skills_available(
    ctx: State<'_, Arc<AppContext>>,
) -> Result<Vec<AvailableSkill>, String> {
    blocking(&ctx, available).await
}

/// `skills:reconcile`.
#[tauri::command]
pub async fn skills_reconcile(
    ctx: State<'_, Arc<AppContext>>,
) -> Result<Vec<InstallManifest>, String> {
    blocking(&ctx, reconcile).await?
}

/// `skills:apply` -- streams `skills:progress` events as it works.
#[tauri::command]
pub async fn skills_apply(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
    args: ApplyArgs,
) -> Result<ApplyResult, String> {
    let ctx = Arc::clone(ctx.inner());
    // Progress events emit from the blocking thread; `AppHandle` is Send + Sync.
    tauri::async_runtime::spawn_blocking(move || {
        let mut on_progress = |p: ApplyProgress| {
            let _ = app.emit("skills:progress", p);
        };
        apply(&ctx, args, &mut on_progress)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::install::verify::verify_install;
    use skillkeeper_core::models::{Project, Repository, RepositoryKind, Transport};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// Whether a usable `git` binary is on PATH.
    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// A throwaway working tree holding one skill (`skill-a`) with a guide,
    /// git-initialized (gpg signing off) when a git binary is available.
    struct SkillRepo {
        path: PathBuf,
    }

    impl SkillRepo {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-skillsrc-{}-{}", std::process::id(), n));
            let skill_dir = path.join("skill-a");
            std::fs::create_dir_all(&skill_dir).expect("create skill dir");
            std::fs::write(
                skill_dir.join("SKILL.md"),
                "---\nname: skill-a\n---\nbody\n",
            )
            .expect("write SKILL.md");
            std::fs::write(skill_dir.join("run.sh"), "#!/bin/sh\necho hi\n").expect("write run.sh");
            std::fs::write(skill_dir.join("GUIDE.md"), "Do the thing.\n").expect("write GUIDE.md");
            let repo = Self { path };
            repo.maybe_git_init();
            repo
        }

        fn url(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        /// Best-effort git init + commit (gpg signing off); no-op without git.
        fn maybe_git_init(&self) {
            if !git_available() {
                return;
            }
            let run = |args: &[&str]| {
                Command::new("git")
                    .args(args)
                    .current_dir(&self.path)
                    .output()
                    .expect("spawn git");
            };
            run(&["-c", "init.defaultBranch=main", "init"]);
            run(&["add", "-A"]);
            run(&[
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "init",
            ]);
        }
    }

    impl Drop for SkillRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A throwaway project directory (the install destination base).
    struct ProjectDir {
        path: PathBuf,
    }

    impl ProjectDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-proj-{}-{}", std::process::id(), n));
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

    /// Seed state with one repository (pointing at `src`) and one project.
    fn seed_state(app: &TempAppData, src: &SkillRepo, proj: &ProjectDir) -> (String, String) {
        let repo = Repository {
            id: "repo-1".to_string(),
            name: "skills".to_string(),
            url: src.url(),
            kind: RepositoryKind::Generic,
            transport: Transport::Https,
            lfs: false,
            local_path: src.url(),
            last_fetched: None,
            branch: None,
        };
        let project = Project {
            id: "proj-1".to_string(),
            path: proj.path(),
            name: "app".to_string(),
            added_at: "2026-07-17T00:00:00.000Z".to_string(),
        };
        let state = AppState {
            version: skillkeeper_core::models::STATE_VERSION,
            repositories: vec![repo.clone()],
            projects: vec![project.clone()],
            installs: vec![],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();
        (repo.id, project.id)
    }

    fn install_ref(repo_id: &str) -> SkillRef {
        SkillRef {
            repo_id: repo_id.to_string(),
            group: None,
            name: "skill-a".to_string(),
        }
    }

    fn apply_args(
        project_id: &str,
        proj: &ProjectDir,
        install: Vec<SkillRef>,
        remove: Vec<SkillRef>,
    ) -> ApplyArgs {
        ApplyArgs {
            project_id: project_id.to_string(),
            project_path: proj.path(),
            agents: vec![AgentKind::Claude],
            install,
            remove,
        }
    }

    // ---- available ----

    #[test]
    fn available_lists_a_seeded_skill_with_guidance_and_hash() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        seed_state(&app, &src, &proj);

        let listed = available(&app.ctx);
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "skill-a");
        assert_eq!(s.repo_id, "repo-1");
        assert_eq!(s.remote, src.url());
        assert!(s.group.is_none());
        assert!(!s.content_hash.is_empty());
        assert!(s.has_guidance);
    }

    #[test]
    fn available_is_empty_when_no_repositories() {
        let app = TempAppData::new();
        assert!(available(&app.ctx).is_empty());
    }

    // ---- apply ----

    #[test]
    fn apply_installs_a_skill_and_verify_reports_ok() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(&app, &src, &proj);

        let mut steps: Vec<ApplyProgress> = Vec::new();
        let result = apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
            &mut |p| steps.push(p),
        );
        assert!(result.ok, "apply failed: {:?}", result.error);
        assert_eq!(result.installed, Some(1));
        assert_eq!(result.removed, Some(0));

        // Progress streamed one step (one skill x one agent).
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].total, 1);
        assert_eq!(steps[0].done, 1);

        // Body copied to the Claude project skills root.
        let installed = Path::new(&proj.path()).join(".claude/skills/skill-a/SKILL.md");
        assert!(installed.exists(), "skill body not installed");

        // Guidance block written into the project CLAUDE.md.
        let guide = std::fs::read_to_string(Path::new(&proj.path()).join(".claude/CLAUDE.md"))
            .expect("guidance file written");
        assert!(guide.contains("SKILLKEEPER_START"));
        assert!(guide.contains("Do the thing."));

        // The recorded manifest verifies clean against disk.
        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert_eq!(installs.len(), 1);
        let report = verify_install(&app.ctx.fs, &installs[0]).unwrap();
        assert!(report.ok, "verify not ok: {report:?}");
        assert_eq!(installs[0].source_repo_id.as_deref(), Some("repo-1"));
    }

    #[test]
    fn apply_is_idempotent_for_an_already_installed_skill() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(&app, &src, &proj);

        let mut noop = |_p: ApplyProgress| {};
        assert!(
            apply(
                &app.ctx,
                apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
                &mut noop,
            )
            .ok
        );
        // Second apply installs nothing new (already present).
        assert!(
            apply(
                &app.ctx,
                apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
                &mut noop,
            )
            .ok
        );
        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert_eq!(installs.len(), 1);
    }

    #[test]
    fn apply_removes_a_skill_and_clears_its_guidance() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(&app, &src, &proj);

        let mut noop = |_p: ApplyProgress| {};
        apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
            &mut noop,
        );
        let result = apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![], vec![install_ref(&repo_id)]),
            &mut noop,
        );
        assert!(result.ok);
        assert_eq!(result.removed, Some(1));

        assert!(!Path::new(&proj.path())
            .join(".claude/skills/skill-a")
            .exists());
        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert!(installs.is_empty());
    }

    // ---- reconcile ----

    #[test]
    fn reconcile_round_trips_an_installed_skill_then_prunes_when_removed() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(&app, &src, &proj);

        let mut noop = |_p: ApplyProgress| {};
        apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
            &mut noop,
        );

        // Reconcile keeps the on-disk install and re-homes it to the repo.
        let kept = reconcile(&app.ctx).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].skill_id.name, "skill-a");
        assert_eq!(kept[0].source_repo_id.as_deref(), Some("repo-1"));

        // Delete the on-disk skill dir; reconcile prunes the manifest.
        std::fs::remove_dir_all(Path::new(&proj.path()).join(".claude/skills/skill-a")).unwrap();
        let pruned = reconcile(&app.ctx).unwrap();
        assert!(pruned.is_empty());
        assert!(load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs
            .is_empty());
    }

    #[test]
    fn reconcile_keeps_installs_of_a_project_whose_folder_is_missing() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(&app, &src, &proj);

        let mut noop = |_p: ApplyProgress| {};
        apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
            &mut noop,
        );
        // Drop the whole project folder: its installs must be preserved, not pruned.
        std::fs::remove_dir_all(&proj.path).unwrap();
        let kept = reconcile(&app.ctx).unwrap();
        assert_eq!(kept.len(), 1);
    }
}
