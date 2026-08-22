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

use std::collections::{BTreeMap, HashMap, HashSet};

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
    AgentKind, AgentTarget, AppState, InstallManifest, InstallOptions, Repository, Scope, SkillId,
};
use skillkeeper_core::ports::{Clock, FsPort, HostEnv, PortResult};
use skillkeeper_core::skills::group_path::skill_path;
use skillkeeper_core::skills::requires::RequiresGraph;
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
    /// Skill paths, within this skill's own repository, that it needs. Drives
    /// the dependency tint and the broken-dependency marker in the renderer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<Vec<String>>,
    /// Content hash of the skill body (excludes `.skid.yml`), for update detection.
    pub content_hash: String,
    /// The skill ships a `GUIDE.md`/`RULES.md` guidance file (drives the badge).
    pub has_guidance: bool,
}

/// One skill-resolution warning, attributed to the repository it came from.
///
/// `resolve_skills` is infallible: it returns warnings rather than failing. A
/// warning is the only signal that a `SKILL.md` was found but cannot be
/// installed (nested deeper than one group, a malformed manifest, an unparsable
/// `skillkeeper.repo.yaml`). Dropping the list makes such a skill silently
/// invisible, so it is carried to the renderer and surfaced as a notification.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillResolveWarning {
    pub repo_id: String,
    pub repo_name: String,
    pub message: String,
}

/// The `skills:available` payload: the resolved catalog plus any warnings raised
/// while resolving it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableSkillsResult {
    pub skills: Vec<AvailableSkill>,
    pub warnings: Vec<SkillResolveWarning>,
}

/// `skills:available` -- every skill resolved across all cloned repositories,
/// plus the warnings raised while resolving them. Repos whose clone is missing
/// are skipped.
pub fn available(ctx: &AppContext) -> AvailableSkillsResult {
    let mut out = Vec::new();
    let mut warnings = Vec::new();
    let repos = {
        let _guard = lock(ctx);
        match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state.repositories,
            Err(_) => {
                return AvailableSkillsResult {
                    skills: out,
                    warnings,
                }
            }
        }
    };
    for repo in repos {
        if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
            continue;
        }
        let resolved = resolve_skills(&ctx.fs, &repo.local_path);
        for message in &resolved.warnings {
            warnings.push(SkillResolveWarning {
                repo_id: repo.id.clone(),
                repo_name: repo.name.clone(),
                message: message.clone(),
            });
        }
        for skill in &resolved.skills {
            // Skip the skill that cannot be hashed, and only that one. This
            // used to `break`, which dropped every skill the walk had not
            // reached yet -- a whole repository could go missing because one
            // skill deep inside it held a file that could not be read, and the
            // survivors were whichever ones the filesystem happened to list
            // first. Say which skill and why, rather than leaving the count
            // short with no explanation.
            let content_hash = match resolved_content_hash(&ctx.fs, &repo.local_path, skill) {
                Ok(h) => h,
                Err(e) => {
                    warnings.push(SkillResolveWarning {
                        repo_id: repo.id.clone(),
                        repo_name: repo.name.clone(),
                        message: format!("Skipping \"{}\": {e}", skill.root_path),
                    });
                    continue;
                }
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
                requires: skill.manifest.requires.clone().filter(|l| !l.is_empty()),
                content_hash,
                has_guidance,
            });
        }
    }
    AvailableSkillsResult {
        skills: out,
        warnings,
    }
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
        // Prefer the identity file: it is exactly the copy that survives a lost
        // source repository. Fall back to the ledger for a schema-1 skid, which
        // predates this field.
        requires: skid
            .as_ref()
            .and_then(|s| s.requires.clone())
            .or_else(|| existing.and_then(|e| e.requires.clone())),
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
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
    /// Which scope to install into. Absent means `project`, so an older caller
    /// keeps its behaviour.
    #[serde(default)]
    pub scope: Scope,
    /// Project UUID (recorded as `target.projectId`). Ignored at global scope.
    pub project_id: String,
    /// Project folder path (used for `PROJECT_DIR_ENV` path resolution).
    /// Ignored at global scope.
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
    /// Count of skills actually installed, including any dependencies
    /// `expand_requires` added to the requested list -- can exceed the
    /// number of skills requested; does not echo the request.
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

/// The install target for one agent, honouring the requested scope. At global
/// scope there is no project id to record; the adapters resolve every path from
/// the home directory (`base_dir` in `skillkeeper-agents::paths`).
fn target_for(agent: AgentKind, args: &ApplyArgs) -> AgentTarget {
    match args.scope {
        Scope::Global => AgentTarget::global(agent),
        Scope::Project => AgentTarget::project(agent, Some(&args.project_id)),
    }
}

/// Whether `m` was installed at the target this apply is acting on: at global
/// scope any global manifest, at project scope only that project's. A global
/// manifest carries no `project_id`, so comparing ids alone never matches it.
fn same_scope(m: &InstallManifest, args: &ApplyArgs) -> bool {
    match args.scope {
        Scope::Global => m.target.scope == Scope::Global,
        Scope::Project => {
            m.target.scope == Scope::Project
                && m.target.project_id.as_deref() == Some(args.project_id.as_str())
        }
    }
}

/// Add every transitive dependency of `refs` to the list, preserving the
/// caller's order and appending discovered dependencies after it.
/// Dependencies are same-repository by definition: references are grouped by
/// `repo_id` and each repository's own skills are resolved to build that
/// repository's graph, so a reference never resolves against a namesake in a
/// different repository. A reference whose target does not exist (an unknown
/// `repo_id`, or a path with no skill behind it) is dropped here -- the
/// resolver already warned about it, and `repo lint` reports it -- rather than
/// sent on to fail an install. Idempotent: an already-listed dependency
/// (compared by full reference identity) is never duplicated.
fn expand_requires(fs: &dyn FsPort, repos: &[Repository], refs: &[SkillRef]) -> Vec<SkillRef> {
    let mut out: Vec<SkillRef> = refs.to_vec();
    let mut by_repo: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for r in refs {
        by_repo
            .entry(r.repo_id.clone())
            .or_default()
            .push(skill_path(r.group.as_deref(), &r.name));
    }
    for (repo_id, roots) in by_repo {
        let Some(repo) = repos.iter().find(|r| r.id == repo_id) else {
            continue;
        };
        let resolved = resolve_skills(fs, &repo.local_path);
        let graph = RequiresGraph::build(&resolved.skills);
        for path in graph.closure(&roots) {
            if roots.contains(&path) {
                continue;
            }
            let Some(skill) = resolved
                .skills
                .iter()
                .find(|s| skill_path(s.id.group.as_deref(), &s.id.name) == path)
            else {
                continue;
            };
            let candidate = SkillRef {
                repo_id: repo_id.clone(),
                group: skill.id.group.clone(),
                name: skill.id.name.clone(),
            };
            if !out.iter().any(|r| *r == candidate) {
                out.push(candidate);
            }
        }
    }
    out
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

    // The renderer sends the closure already. Expanding again here is the
    // guarantee: the core is authoritative at apply time, so a preview that
    // missed a dependency is a cosmetic mismatch rather than a broken install.
    // Idempotent, so the common case adds nothing. Never applied to
    // `args.remove`: uninstalling a skill must not cascade to its dependents.
    let install = expand_requires(&ctx.fs, &state.repositories, &args.install);

    let per_skill = args.agents.len().max(1);
    let total = (install.len() + args.remove.len()) * per_skill;
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
            if let Some(pos) = installs
                .iter()
                .position(|m| same_scope(m, args) && m.target.agent == agent && same_skill(m, r))
            {
                let manifest = installs.remove(pos);
                uninstall_skill(&ctx.fs, &manifest).map_err(|e| e.to_string())?;
                if let Some(remote) = &manifest.source_remote {
                    let target = target_for(agent, args);
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
    for r in &install {
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
                let already = installs
                    .iter()
                    .any(|m| same_scope(m, args) && m.target.agent == agent && same_skill(m, r));
                if !already {
                    let adapter = ctx.registry.get(agent).map_err(|e| e.to_string())?;
                    let target = target_for(agent, args);
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
        if !same_scope(m, args) {
            continue;
        }
        let Some(remote) = &m.source_remote else {
            continue;
        };
        if new_this_run.contains(&manifest_key(m)) {
            continue;
        }
        let target = target_for(m.target.agent, args);
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
    Ok((install.len(), args.remove.len()))
}

// ---------------------------------------------------------------------------
// Tauri command wrappers.
// ---------------------------------------------------------------------------

/// `skills:available`.
#[tauri::command]
pub async fn skills_available(
    ctx: State<'_, Arc<AppContext>>,
) -> Result<AvailableSkillsResult, String> {
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
            scope: Scope::Project,
            project_id: project_id.to_string(),
            project_path: proj.path(),
            agents: vec![AgentKind::Claude],
            install,
            remove,
        }
    }

    /// Seed state with one tracked repository holding one skill (`skill-a`, via
    /// [`seed_state`]) inside a fresh project. Returns the owning temp-dir guards
    /// (kept alive by the caller for as long as `apply`/`reconcile` need to read
    /// the repo from disk), the seeded project id, and a ready-to-use
    /// [`SkillRef`] for that skill.
    fn seed_repo_with_skill(app: &TempAppData) -> (SkillRepo, ProjectDir, String, SkillRef) {
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(app, &src, &proj);
        (src, proj, project_id, install_ref(&repo_id))
    }

    // ---- available ----

    #[test]
    fn available_lists_a_seeded_skill_with_guidance_and_hash() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        seed_state(&app, &src, &proj);

        let listed = available(&app.ctx);
        assert_eq!(listed.skills.len(), 1);
        let s = &listed.skills[0];
        assert_eq!(s.name, "skill-a");
        assert_eq!(s.repo_id, "repo-1");
        assert_eq!(s.remote, src.url());
        assert!(s.group.is_none());
        assert!(!s.content_hash.is_empty());
        assert!(s.has_guidance);
        // A cleanly-resolving repository reports nothing.
        assert!(listed.warnings.is_empty());
    }

    #[test]
    fn available_is_empty_when_no_repositories() {
        let app = TempAppData::new();
        let listed = available(&app.ctx);
        assert!(listed.skills.is_empty());
        assert!(listed.warnings.is_empty());
    }

    #[test]
    fn available_reports_a_resolve_warning_attributed_to_its_repository() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        seed_state(&app, &src, &proj);
        // A SKILL.md nested deeper than three group levels resolves to nothing
        // and raises a warning; the rest of the repository still resolves. Four
        // group levels here, one past the limit -- three would resolve.
        let deep = src
            .path
            .join("a")
            .join("b")
            .join("c")
            .join("d")
            .join("too-deep");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("SKILL.md"), "---\nname: too-deep\n---\n").unwrap();

        let listed = available(&app.ctx);
        assert_eq!(listed.skills.len(), 1, "the valid skill still resolves");
        assert_eq!(listed.warnings.len(), 1);
        let w = &listed.warnings[0];
        assert_eq!(w.repo_id, "repo-1");
        assert_eq!(w.repo_name, "skills");
        assert!(w.message.contains("a/b/c/d/too-deep"), "{}", w.message);
    }

    #[test]
    fn available_lists_a_skill_carrying_a_binary_asset() {
        // Reading a body file as text failed on anything that is not UTF-8,
        // which is how a single icon.png used to take a repository's catalog
        // down with it.
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        seed_state(&app, &src, &proj);
        let assets = src.path.join("skill-a").join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(
            assets.join("icon.png"),
            [0x89u8, 0x50, 0x4E, 0x47, 0xFF, 0xFE],
        )
        .unwrap();

        let listed = available(&app.ctx);
        assert_eq!(listed.skills.len(), 1);
        assert!(listed.warnings.is_empty(), "{:?}", listed.warnings);
    }

    /// Only meaningful where a file can be made unreadable, and never as root.
    #[cfg(unix)]
    #[test]
    fn available_skips_only_the_unreadable_skill_and_says_which() {
        use std::os::unix::fs::PermissionsExt;

        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        seed_state(&app, &src, &proj);
        // A second skill whose body file the process cannot read.
        let broken = src.path.join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("SKILL.md"), "---\nname: broken\n---\nbody\n").unwrap();
        let locked = broken.join("locked.txt");
        std::fs::write(&locked, "secret\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&locked).is_ok() {
            return; // running as root: the permission bit proves nothing
        }

        let listed = available(&app.ctx);
        // The healthy skill survives regardless of walk order -- this used to
        // `break`, so whether it appeared depended on which one came first.
        assert!(
            listed.skills.iter().any(|s| s.name == "skill-a"),
            "the readable skill must still be listed"
        );
        assert!(listed.skills.iter().all(|s| s.name != "broken"));
        assert_eq!(listed.warnings.len(), 1);
        assert!(
            listed.warnings[0].message.contains("broken"),
            "{}",
            listed.warnings[0].message
        );
    }

    #[test]
    fn available_reports_nothing_for_skills_installed_in_the_working_tree() {
        let app = TempAppData::new();
        let src = SkillRepo::new();
        let proj = ProjectDir::new();
        seed_state(&app, &src, &proj);
        // A repository that itself uses SkillKeeper carries installed skills
        // under an agent directory. Those must not warn -- this is the case that
        // produced a spurious warning for ordinary projects.
        let installed = src.path.join(".claude").join("skills").join("release-prep");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::write(installed.join("SKILL.md"), "---\nname: release-prep\n---\n").unwrap();

        let listed = available(&app.ctx);
        assert_eq!(listed.skills.len(), 1, "only the published skill resolves");
        assert!(listed.warnings.is_empty(), "{:?}", listed.warnings);
    }

    // ---- apply ----

    #[test]
    fn apply_installs_a_skill_and_verify_reports_ok() {
        let app = TempAppData::new();
        let (_src, proj, project_id, skill) = seed_repo_with_skill(&app);

        let mut steps: Vec<ApplyProgress> = Vec::new();
        let result = apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![skill], vec![]),
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
    fn apply_installs_a_skill_globally_and_records_the_global_scope() {
        // Seed exactly as the project-scope apply test does (a tracked repo
        // holding one skill), but apply with scope: Global.
        let app = TempAppData::new();
        let (_src, _proj, _project_id, skill) = seed_repo_with_skill(&app);

        let result = apply(
            &app.ctx,
            ApplyArgs {
                scope: Scope::Global,
                project_id: String::new(),
                project_path: String::new(),
                agents: vec![AgentKind::Claude],
                install: vec![skill],
                remove: vec![],
            },
            &mut |_p| {},
        );
        assert!(result.ok, "global apply failed: {:?}", result.error);

        // The skill landed under the isolated home, not under any project.
        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        let manifest = installs
            .iter()
            .find(|m| m.target.agent == AgentKind::Claude)
            .expect("one manifest recorded");
        assert_eq!(manifest.target.scope, Scope::Global);
        assert_eq!(manifest.target.project_id, None);
        assert!(
            manifest.destination_root.contains("/.claude/skills"),
            "unexpected destination: {}",
            manifest.destination_root
        );
        assert!(app.ctx.fs.exists(&manifest.destination_root).unwrap());
    }

    #[test]
    fn reconcile_keeps_a_global_install() {
        // reconcile only walks tracked projects; a global manifest must survive
        // it untouched (commands/skills.rs `kept` seed).
        let app = TempAppData::new();
        let (_src, _proj, _project_id, skill) = seed_repo_with_skill(&app);
        let applied = apply(
            &app.ctx,
            ApplyArgs {
                scope: Scope::Global,
                project_id: String::new(),
                project_path: String::new(),
                agents: vec![AgentKind::Claude],
                install: vec![skill],
                remove: vec![],
            },
            &mut |_p| {},
        );
        assert!(applied.ok);

        let kept = reconcile(&app.ctx).expect("reconcile ok");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].target.scope, Scope::Global);
    }

    #[test]
    fn apply_is_idempotent_for_an_already_installed_global_skill() {
        // A global manifest carries no project_id; the already-installed check
        // must still recognize it by scope, or a second global apply appends a
        // duplicate manifest instead of a no-op.
        let app = TempAppData::new();
        let (_src, _proj, _project_id, skill) = seed_repo_with_skill(&app);
        let mut noop = |_p: ApplyProgress| {};
        let global_args = |skill: SkillRef| ApplyArgs {
            scope: Scope::Global,
            project_id: String::new(),
            project_path: String::new(),
            agents: vec![AgentKind::Claude],
            install: vec![skill],
            remove: vec![],
        };

        assert!(apply(&app.ctx, global_args(skill.clone()), &mut noop).ok);
        assert!(apply(&app.ctx, global_args(skill), &mut noop).ok);

        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert_eq!(installs.len(), 1, "duplicate global manifest recorded");
    }

    #[test]
    fn apply_removes_a_globally_installed_skill() {
        // A global manifest carries no project_id; the remove filter must still
        // recognize it by scope, or the remove silently no-ops while reporting
        // success (neither the manifest nor the on-disk skill would be gone).
        let app = TempAppData::new();
        let (_src, _proj, _project_id, skill) = seed_repo_with_skill(&app);
        let mut noop = |_p: ApplyProgress| {};

        let installed = apply(
            &app.ctx,
            ApplyArgs {
                scope: Scope::Global,
                project_id: String::new(),
                project_path: String::new(),
                agents: vec![AgentKind::Claude],
                install: vec![skill.clone()],
                remove: vec![],
            },
            &mut noop,
        );
        assert!(installed.ok);
        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert_eq!(installs.len(), 1);
        // `destination_root` is the shared agent-wide skills root; the skill's
        // own directory lives one level under it.
        let skill_dir = format!("{}/skill-a", installs[0].destination_root);
        assert!(app.ctx.fs.exists(&skill_dir).unwrap());

        let removed = apply(
            &app.ctx,
            ApplyArgs {
                scope: Scope::Global,
                project_id: String::new(),
                project_path: String::new(),
                agents: vec![AgentKind::Claude],
                install: vec![],
                remove: vec![skill],
            },
            &mut noop,
        );
        assert!(removed.ok, "global remove failed: {:?}", removed.error);
        assert_eq!(removed.removed, Some(1));

        let installs = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert!(installs.is_empty(), "global manifest not removed");
        assert!(
            !app.ctx.fs.exists(&skill_dir).unwrap(),
            "installed skill directory not deleted"
        );
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

    // ---- adopt_skill: requires ----
    //
    // `adopt_skill` is what every `skills:reconcile` call runs for each managed
    // skill directory, and `reconcile` wholesale-replaces the ledger with its
    // return values (see `reconcile` above). If `adopt_skill` ever stopped
    // carrying `requires` through, the first reconcile after any install would
    // silently erase every recorded dependency. These tests pin that it does
    // not.

    /// A no-op rehome callback for tests that call `adopt_skill` directly and
    /// do not care about repo re-homing.
    fn no_rehome(_: Option<&str>) -> Option<String> {
        None
    }

    /// The project-scope Claude target used by the direct `adopt_skill` tests.
    fn project_target() -> AgentTarget {
        AgentTarget {
            agent: AgentKind::Claude,
            scope: Scope::Project,
            project_id: Some("proj-1".to_string()),
        }
    }

    /// Write a minimal on-disk skill directly under `dest_root/dir_name`
    /// (`SKILL.md` plus a `.skid.yml`), bypassing `apply`, for tests that
    /// exercise `adopt_skill` in isolation. `skid_requires` controls the
    /// identity file's `requires` list.
    fn write_skill_dir(dest_root: &str, dir_name: &str, skid_requires: Option<&[&str]>) {
        let dir = Path::new(dest_root).join(dir_name);
        std::fs::create_dir_all(&dir).expect("create skill dir");
        std::fs::write(dir.join("SKILL.md"), "---\nname: skill-a\n---\nbody\n")
            .expect("write SKILL.md");
        let requires_yaml = skid_requires
            .map(|list| {
                let items: String = list.iter().map(|r| format!("\n  - {r}")).collect();
                format!("requires:{items}\n")
            })
            .unwrap_or_default();
        std::fs::write(
            dir.join(SKID_FILE),
            format!("schema: 2\nname: skill-a\nversion: abc\n{requires_yaml}"),
        )
        .expect("write .skid.yml");
    }

    /// A stand-in for a prior install's ledger entry, for tests that pass
    /// `existing` to `adopt_skill` directly. Only `requires` varies between
    /// callers.
    fn ledger_entry(requires: Option<Vec<String>>) -> InstallManifest {
        InstallManifest {
            skill_id: SkillId {
                group: None,
                name: "skill-a".to_string(),
            },
            target: project_target(),
            destination_root: "/dest".to_string(),
            source_repo_id: Some("repo-1".to_string()),
            source_remote: None,
            source_path: None,
            content_hash: Some("old-hash".to_string()),
            version: None,
            requires,
            installed_at: "2026-07-17T00:00:00.000Z".to_string(),
            files: vec![],
            hook_edits: vec![],
        }
    }

    #[test]
    fn adopt_skill_carries_requires_declared_in_skid_file() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        write_skill_dir(&proj.path(), "skill-a", Some(&["dep-a"]));

        let manifest = adopt_skill(
            &app.ctx.fs,
            &proj.path(),
            "skill-a",
            &project_target(),
            &no_rehome,
            None,
            0,
        )
        .unwrap()
        .expect("skill-a recognized as a skill");
        assert_eq!(manifest.requires, Some(vec!["dep-a".to_string()]));
    }

    #[test]
    fn adopt_skill_falls_back_to_ledger_requires_when_skid_omits_it() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        write_skill_dir(&proj.path(), "skill-a", None);
        let existing = ledger_entry(Some(vec!["dep-a".to_string()]));

        let manifest = adopt_skill(
            &app.ctx.fs,
            &proj.path(),
            "skill-a",
            &project_target(),
            &no_rehome,
            Some(&existing),
            0,
        )
        .unwrap()
        .expect("skill-a recognized as a skill");
        assert_eq!(
            manifest.requires,
            Some(vec!["dep-a".to_string()]),
            "a schema-1 skid with no requires field must fall back to the ledger"
        );
    }

    #[test]
    fn adopt_skill_requires_is_none_when_neither_source_carries_it() {
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        write_skill_dir(&proj.path(), "skill-a", None);
        let existing = ledger_entry(None);

        let manifest = adopt_skill(
            &app.ctx.fs,
            &proj.path(),
            "skill-a",
            &project_target(),
            &no_rehome,
            Some(&existing),
            0,
        )
        .unwrap()
        .expect("skill-a recognized as a skill");
        assert_eq!(manifest.requires, None);
    }

    #[test]
    fn adopt_skill_prefers_skid_requires_over_a_disagreeing_ledger() {
        // The identity file sits next to the skill on disk and survives a lost
        // source repository; it must win over a stale ledger entry.
        let app = TempAppData::new();
        let proj = ProjectDir::new();
        write_skill_dir(&proj.path(), "skill-a", Some(&["skid-dep"]));
        let existing = ledger_entry(Some(vec!["ledger-dep".to_string()]));

        let manifest = adopt_skill(
            &app.ctx.fs,
            &proj.path(),
            "skill-a",
            &project_target(),
            &no_rehome,
            Some(&existing),
            0,
        )
        .unwrap()
        .expect("skill-a recognized as a skill");
        assert_eq!(
            manifest.requires,
            Some(vec!["skid-dep".to_string()]),
            "the identity file must win over a disagreeing ledger entry"
        );
    }

    #[test]
    fn reconcile_preserves_requires_recorded_at_apply_time() {
        // The end-to-end regression this whole section guards against:
        // `reconcile` calls `adopt_skill` for every managed skill directory
        // and replaces the ledger wholesale with the results (see `reconcile`
        // above), so a `requires` that `adopt_skill` drops here is erased for
        // good on the very first reconcile after install.
        let app = TempAppData::new();
        let src = SkillRepo::new();
        // Declare a dependency in the skill's own frontmatter so `install_skill`
        // writes it into both the `.skid.yml` identity file and the ledger.
        std::fs::write(
            src.path.join("skill-a").join("SKILL.md"),
            "---\nname: skill-a\nrequires:\n  - dep-a\n---\nbody\n",
        )
        .expect("rewrite SKILL.md with a requires declaration");
        let proj = ProjectDir::new();
        let (repo_id, project_id) = seed_state(&app, &src, &proj);

        let mut noop = |_p: ApplyProgress| {};
        let applied = apply(
            &app.ctx,
            apply_args(&project_id, &proj, vec![install_ref(&repo_id)], vec![]),
            &mut noop,
        );
        assert!(applied.ok, "apply failed: {:?}", applied.error);
        let installed = load_state(&app.ctx.fs, &app.ctx.paths.state_json)
            .unwrap()
            .installs;
        assert_eq!(
            installed[0].requires,
            Some(vec!["dep-a".to_string()]),
            "apply did not record requires"
        );

        let kept = reconcile(&app.ctx).unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(
            kept[0].requires,
            Some(vec!["dep-a".to_string()]),
            "reconcile lost requires"
        );
    }

    // ---- available/apply: requires ----

    /// A throwaway working tree holding the given skills, each written with a
    /// `SKILL.md` whose frontmatter is `name: <name>` plus the given extra
    /// YAML block (used to declare `requires`). No git init: `available` and
    /// `apply` read straight off the working tree in these tests, and neither
    /// goes through git.
    struct MultiSkillRepo {
        path: PathBuf,
    }

    impl MultiSkillRepo {
        fn new(skills: &[(&str, &str)]) -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-multisrc-{}-{}", std::process::id(), n));
            for (name, extra) in skills {
                let skill_dir = path.join(name);
                std::fs::create_dir_all(&skill_dir).expect("create skill dir");
                std::fs::write(
                    skill_dir.join("SKILL.md"),
                    format!("---\nname: {name}\n{extra}---\nbody\n"),
                )
                .expect("write SKILL.md");
            }
            Self { path }
        }

        fn url(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for MultiSkillRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A [`TempAppData`] plus a tracked repository/project seeded with a
    /// custom skill set, for the dependency-carrying and closure-expansion
    /// tests. Derefs to [`AppContext`] so it can be passed anywhere the tests
    /// under this module already pass `&app.ctx`.
    struct TestCtx {
        app: TempAppData,
        _src: MultiSkillRepo,
        proj: ProjectDir,
        repo_id: String,
        project_id: String,
    }

    impl std::ops::Deref for TestCtx {
        type Target = AppContext;

        fn deref(&self) -> &AppContext {
            &self.app.ctx
        }
    }

    impl TestCtx {
        /// A [`SkillRef`] into this context's repository for the named skill.
        fn skill_ref(&self, name: &str) -> SkillRef {
            SkillRef {
                repo_id: self.repo_id.clone(),
                group: None,
                name: name.to_string(),
            }
        }
    }

    /// Seed one tracked repository containing `skills` (name -> extra
    /// frontmatter YAML, see [`MultiSkillRepo`]) inside one tracked project.
    fn ctx_with_repo_skills(skills: &[(&str, &str)]) -> TestCtx {
        let app = TempAppData::new();
        let src = MultiSkillRepo::new(skills);
        let proj = ProjectDir::new();
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
        TestCtx {
            app,
            _src: src,
            proj,
            repo_id: repo.id,
            project_id: project.id,
        }
    }

    /// Run [`apply`] against `ctx`'s seeded project, at project scope, for
    /// the Claude agent.
    fn apply_for_test(ctx: &TestCtx, install: &[SkillRef], remove: &[SkillRef]) -> ApplyResult {
        let mut noop = |_p: ApplyProgress| {};
        apply(
            ctx,
            apply_args(
                &ctx.project_id,
                &ctx.proj,
                install.to_vec(),
                remove.to_vec(),
            ),
            &mut noop,
        )
    }

    /// The names recorded in the install ledger, for asserting on the set of
    /// what actually got installed.
    fn installed_names(ctx: &TestCtx) -> Vec<String> {
        load_state(&ctx.fs, &ctx.paths.state_json)
            .unwrap()
            .installs
            .iter()
            .map(|m| m.skill_id.name.clone())
            .collect()
    }

    #[test]
    fn available_carries_declared_dependencies() {
        let ctx = ctx_with_repo_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let result = available(&ctx);
        let a = result
            .skills
            .iter()
            .find(|s| s.name == "a")
            .expect("a is listed");
        assert_eq!(a.requires, Some(vec!["b".to_string()]));
        let b = result
            .skills
            .iter()
            .find(|s| s.name == "b")
            .expect("b is listed");
        assert_eq!(b.requires, None);
    }

    #[test]
    fn apply_installs_the_dependency_closure_even_when_only_the_dependent_was_asked_for() {
        // The renderer normally sends the closure already; the backend expands
        // anyway, so a preview that missed one can never produce a broken
        // install. Idempotent: an already-listed dependency is not duplicated.
        let ctx = ctx_with_repo_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let result = apply_for_test(&ctx, &[ctx.skill_ref("a")], &[]);
        assert!(result.ok, "apply failed: {:?}", result.error);
        let installed = installed_names(&ctx);
        assert!(installed.contains(&"a".to_string()));
        assert!(installed.contains(&"b".to_string()));
    }

    #[test]
    fn apply_does_not_duplicate_a_dependency_the_caller_already_listed() {
        // The renderer's common case: it already sent the closure. Expanding
        // again must not add a second copy of `b`.
        let ctx = ctx_with_repo_skills(&[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")]);
        let result = apply_for_test(&ctx, &[ctx.skill_ref("a"), ctx.skill_ref("b")], &[]);
        assert!(result.ok, "apply failed: {:?}", result.error);
        let installed = installed_names(&ctx);
        assert_eq!(installed.iter().filter(|n| *n == "b").count(), 1);
    }

    // ---- expand_requires: cross-repository isolation ----

    /// Like [`TestCtx`] but with two tracked repositories, for asserting that
    /// dependency expansion never resolves a reference against a namesake in
    /// the wrong repository.
    struct TestCtx2 {
        app: TempAppData,
        _src1: MultiSkillRepo,
        _src2: MultiSkillRepo,
        proj: ProjectDir,
        repo1_id: String,
        project_id: String,
    }

    impl std::ops::Deref for TestCtx2 {
        type Target = AppContext;

        fn deref(&self) -> &AppContext {
            &self.app.ctx
        }
    }

    impl TestCtx2 {
        /// A [`SkillRef`] into repository one for the named skill.
        fn skill_ref_repo1(&self, name: &str) -> SkillRef {
            SkillRef {
                repo_id: self.repo1_id.clone(),
                group: None,
                name: name.to_string(),
            }
        }
    }

    /// Seed two tracked repositories, `skills1` and `skills2` (name -> extra
    /// frontmatter YAML, see [`MultiSkillRepo`]), inside one tracked project.
    ///
    /// The state's `repositories` list is saved with repository two BEFORE
    /// repository one, on purpose: `expand_requires` must resolve a reference
    /// by matching `repo_id` exactly, never by "the first repository whose
    /// skills happen to contain this name" in list order. Saving them in
    /// reverse order means an implementation that merged every repository's
    /// skills into one combined lookup (instead of grouping by `repo_id` and
    /// building one graph per repository) would resolve a shared name to
    /// repository two here, catching that regression instead of passing by
    /// coincidence of iteration order.
    fn ctx_with_two_repo_skills(skills1: &[(&str, &str)], skills2: &[(&str, &str)]) -> TestCtx2 {
        let app = TempAppData::new();
        let src1 = MultiSkillRepo::new(skills1);
        let src2 = MultiSkillRepo::new(skills2);
        let proj = ProjectDir::new();
        let repo1 = Repository {
            id: "repo-1".to_string(),
            name: "skills-1".to_string(),
            url: src1.url(),
            kind: RepositoryKind::Generic,
            transport: Transport::Https,
            lfs: false,
            local_path: src1.url(),
            last_fetched: None,
            branch: None,
        };
        let repo2 = Repository {
            id: "repo-2".to_string(),
            name: "skills-2".to_string(),
            url: src2.url(),
            kind: RepositoryKind::Generic,
            transport: Transport::Https,
            lfs: false,
            local_path: src2.url(),
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
            // Reverse order: see the doc comment above.
            repositories: vec![repo2.clone(), repo1.clone()],
            projects: vec![project.clone()],
            installs: vec![],
        };
        save_state(&app.ctx.fs, &app.ctx.paths.state_json, &state).unwrap();
        TestCtx2 {
            app,
            _src1: src1,
            _src2: src2,
            proj,
            repo1_id: repo1.id,
            project_id: project.id,
        }
    }

    #[test]
    fn apply_expands_dependencies_only_within_the_requesting_repository() {
        // Repository one holds "a" (which requires "b") and its own "b".
        // Repository two ALSO holds a skill named "b". Installing repo one's
        // "a" must expand to repo one's "b", never repo two's, even though
        // both are named "b" and repo two is listed first in tracked state
        // (see ctx_with_two_repo_skills).
        let ctx = ctx_with_two_repo_skills(
            &[("a", "skillkeeper:\n  requires:\n    - b\n"), ("b", "")],
            &[("b", "")],
        );
        let mut noop = |_p: ApplyProgress| {};
        let result = apply(
            &ctx,
            apply_args(
                &ctx.project_id,
                &ctx.proj,
                vec![ctx.skill_ref_repo1("a")],
                vec![],
            ),
            &mut noop,
        );
        assert!(result.ok, "apply failed: {:?}", result.error);
        let installed = load_state(&ctx.fs, &ctx.paths.state_json).unwrap().installs;
        let b_installs: Vec<_> = installed
            .iter()
            .filter(|m| m.skill_id.name == "b")
            .collect();
        assert_eq!(
            b_installs.len(),
            1,
            "expected exactly one \"b\" installed, got {b_installs:?}"
        );
        assert_eq!(
            b_installs[0].source_repo_id.as_deref(),
            Some(ctx.repo1_id.as_str()),
            "the expanded dependency must come from the requesting repository (repo-1), \
             not a namesake in another repository"
        );
    }
}
