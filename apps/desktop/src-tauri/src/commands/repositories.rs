//! Repository commands (port of `apps/desktop/src/main/repositories.ts`).
//!
//! Channel mapping (dots replaced by underscores for the Phase 4 rewire):
//!   `repositories:add`         -> `repositories_add`
//!   `repositories:clone`       -> `repositories_clone`
//!   `repositories:update`      -> `repositories_update`
//!   `repositories:remove`      -> `repositories_remove`
//!   `repositories:sync`        -> `repositories_sync`
//!   `repositories:hasUpdate`   -> `repositories_has_update`
//!   `repositories:describe`    -> `repositories_describe`
//!   `repositories:listBranches`-> `repositories_list_branches`
//!
//! Nothing throws across the boundary: the mutating commands return a result
//! shape (`RepoResult`/`RemoveResult`) whose `ok` flag mirrors the Electron
//! handlers, and the read-only ones (`describe`, `listBranches`, `hasUpdate`)
//! degrade to empty/false on any failure. Every state mutation runs under
//! `ctx.state_lock` to reproduce the TypeScript `withStateLock` serialization.

use std::path::Path;

use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use skillkeeper_core::adapters::system_git::{
    build_clean_args, build_clone_args, build_fetch_args, build_force_checkout_args,
    build_lfs_pull_args, build_reset_hard_args,
};
use skillkeeper_core::git_remote::parse_remote;
use skillkeeper_core::models::{AppState, Repository};
use skillkeeper_core::ports::{Clock, CloneOptions, FsPort, GitPort, PortResult};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;

use std::sync::Arc;

use super::blocking;
use crate::state::AppContext;

// ---------------------------------------------------------------------------
// Git routing: PTY session when live, direct SystemGit otherwise.
//
// User-initiated clone/sync/update-checkout and the hasUpdate fetch run IN the
// interactive terminal session (`ctx.terminal.run_git`) so their output streams
// to the terminal view and an ssh-key passphrase prompt reads the terminal's
// input -- faithfully porting Electron's `terminalGit`. When no session has
// started (headless contexts and the repository unit tests) they fall back to
// the direct, silent `ctx.git` (`SystemGit`) so operations still work.
//
// The PTY steps reuse the same argument builders as `SystemGit`, decomposed to
// match `terminal.ts` exactly: a force-pull is fetch + `reset --hard @{u}` +
// `clean -fd` as three separate `run_git` invocations, and an lfs clone is the
// clone followed by a separate `lfs pull`.
//
// Configured git path: the PTY `run_git` invokes `git` from PATH (Wave 3 built
// it that way), and the Tauri `AppContext` wires `ctx.git` as `SystemGit::new()`
// -- which also resolves `git` on PATH -- so both routes agree. The Electron
// `repositories.gitPath` config is not threaded into either Rust git route yet
// (a pre-existing gap in the Tauri port, unchanged here).
// ---------------------------------------------------------------------------

/// Run a single git subcommand `args` in `cwd`: through the terminal PTY when a
/// session is live, otherwise via the direct SystemGit call `direct` (used
/// headless/in tests). Errors surface as strings.
fn run_git_op<F>(ctx: &AppContext, cwd: &str, args: &[String], direct: F) -> Result<(), String>
where
    F: FnOnce() -> PortResult<()>,
{
    if ctx.terminal.is_started() {
        ctx.terminal.run_git(cwd, args).map(|_| ())
    } else {
        direct().map_err(|e| e.to_string())
    }
}

/// Clone `options.url` into `options.destination`: the clone runs in the parent
/// of the destination with the dest as an arg (matching `SystemGit`/`terminal.ts`),
/// followed by an `lfs pull` in the clone when `options.lfs` is set.
fn clone_op(ctx: &AppContext, options: &CloneOptions) -> Result<(), String> {
    if ctx.terminal.is_started() {
        let parent = Path::new(&options.destination)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| ".".to_string());
        ctx.terminal.run_git(&parent, &build_clone_args(options))?;
        if options.lfs {
            ctx.terminal
                .run_git(&options.destination, &build_lfs_pull_args())?;
        }
        Ok(())
    } else {
        ctx.git.clone(options).map_err(|e| e.to_string())
    }
}

/// Force the clone at `path` to match upstream: fetch + `reset --hard @{u}` +
/// `clean -fd`, each a separate PTY invocation (matching `terminal.ts`).
fn force_pull_op(ctx: &AppContext, path: &str) -> Result<(), String> {
    if ctx.terminal.is_started() {
        ctx.terminal.run_git(path, &build_fetch_args())?;
        ctx.terminal.run_git(path, &build_reset_hard_args())?;
        ctx.terminal.run_git(path, &build_clean_args())?;
        Ok(())
    } else {
        ctx.git.force_pull(path).map_err(|e| e.to_string())
    }
}

/// Force-switch the clone at `path` to `branch` (`checkout -f`, discarding edits).
fn checkout_op(ctx: &AppContext, path: &str, branch: &str) -> Result<(), String> {
    run_git_op(ctx, path, &build_force_checkout_args(branch), || {
        ctx.git.checkout(path, branch)
    })
}

/// Run `lfs pull` in the clone at `path`.
fn lfs_pull_op(ctx: &AppContext, path: &str) -> Result<(), String> {
    run_git_op(ctx, path, &build_lfs_pull_args(), || ctx.git.lfs_pull(path))
}

/// Run `fetch --prune` in the clone at `path`.
fn fetch_op(ctx: &AppContext, path: &str) -> Result<(), String> {
    run_git_op(ctx, path, &build_fetch_args(), || ctx.git.fetch(path))
}

/// Outcome of a mutating repository command: `{ ok: true, repository }` on
/// success or `{ ok: false, error }` on failure (mirrors the Electron
/// `RepoResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<Repository>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RepoResult {
    fn ok(repository: Repository) -> Self {
        Self {
            ok: true,
            repository: Some(repository),
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            repository: None,
            error: Some(error.into()),
        }
    }
}

/// Outcome of `repositories:remove`: `{ ok: true }` or `{ ok: false, error }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl RemoveResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

/// Branch + skill-count summary for a cloned repository (card badges).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    /// Current branch, or null when the clone is missing or detached-unknown.
    pub branch: Option<String>,
    /// Number of skills resolved in the working tree.
    pub skill_count: usize,
}

/// Acquire the state lock, recovering the guard if a prior holder panicked.
fn lock(ctx: &AppContext) -> std::sync::MutexGuard<'_, ()> {
    ctx.state_lock.lock().unwrap_or_else(|e| e.into_inner())
}

/// Path a clone lives at: `<repositories_dir>/<id>`.
fn local_path_for(ctx: &AppContext, id: &str) -> String {
    Path::new(&ctx.paths.repositories_dir)
        .join(id)
        .to_string_lossy()
        .into_owned()
}

/// Find a repo by id in fresh state (under the lock). `Ok(None)` means no such
/// repo; `Err` means the state file could not be loaded (corrupt).
fn find_repo(ctx: &AppContext, id: &str) -> Result<Option<Repository>, String> {
    let _guard = lock(ctx);
    let state = load_state(&ctx.fs, &ctx.paths.state_json).map_err(|e| e.to_string())?;
    Ok(state.repositories.into_iter().find(|r| r.id == id))
}

/// Re-read fresh state, replace this repo via `patch`, and save -- all under the
/// lock (port of the TypeScript `persistRepo`).
fn persist_repo<F>(ctx: &AppContext, id: &str, patch: F) -> RepoResult
where
    F: FnOnce(Repository) -> Repository,
{
    let _guard = lock(ctx);
    let state = match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state,
        Err(e) => return RepoResult::err(e.to_string()),
    };
    let Some(current) = state.repositories.iter().find(|r| r.id == id).cloned() else {
        return RepoResult::err("not-found");
    };
    let updated = patch(current);
    let repositories = state
        .repositories
        .iter()
        .map(|r| {
            if r.id == id {
                updated.clone()
            } else {
                r.clone()
            }
        })
        .collect();
    let next = AppState {
        repositories,
        ..state
    };
    match save_state(&ctx.fs, &ctx.paths.state_json, &next) {
        Ok(()) => RepoResult::ok(updated),
        Err(e) => RepoResult::err(e.to_string()),
    }
}

/// Current wall-clock time as an ISO-8601 UTC timestamp (`new Date().toISOString()`).
fn now_iso(ctx: &AppContext) -> String {
    iso_from_millis(ctx.clock.now())
}

/// `repositories:add` -- add a repository record (no clone yet).
pub fn add(ctx: &AppContext, url: String, name: String) -> RepoResult {
    let _guard = lock(ctx);
    let state = match load_state(&ctx.fs, &ctx.paths.state_json) {
        Ok(state) => state,
        Err(e) => return RepoResult::err(e.to_string()),
    };
    if state.repositories.iter().any(|r| r.url == url) {
        return RepoResult::err("duplicate");
    }
    let id = Uuid::new_v4().to_string();
    let (kind, transport) = parse_remote(&url);
    let name = if name.trim().is_empty() {
        url.clone()
    } else {
        name.trim().to_string()
    };
    let repository = Repository {
        id: id.clone(),
        name,
        url,
        kind,
        transport,
        lfs: false,
        local_path: local_path_for(ctx, &id),
        last_fetched: None,
        branch: None,
    };
    let mut repositories = state.repositories.clone();
    repositories.push(repository.clone());
    let next = AppState {
        repositories,
        ..state
    };
    match save_state(&ctx.fs, &ctx.paths.state_json, &next) {
        Ok(()) => RepoResult::ok(repository),
        Err(e) => RepoResult::err(e.to_string()),
    }
}

/// `repositories:clone` -- clone an already-added repository into its localPath
/// and stamp lastFetched.
pub fn clone(ctx: &AppContext, id: String) -> RepoResult {
    let repo = match find_repo(ctx, &id) {
        Ok(Some(repo)) => repo,
        Ok(None) => return RepoResult::err("not-found"),
        Err(e) => return RepoResult::err(e),
    };
    // git clone runs in cwd=dirname(destination)=reposDir; that dir must exist.
    if let Err(e) = ctx.fs.mkdir(&ctx.paths.repositories_dir) {
        return RepoResult::err(e.to_string());
    }
    // Runs in the terminal session (background unless git asks for input, when
    // the terminal surfaces itself); falls back to the direct GitPort headless.
    let options = CloneOptions {
        url: repo.url.clone(),
        destination: repo.local_path.clone(),
        lfs: repo.lfs,
        filter: None,
    };
    if let Err(e) = clone_op(ctx, &options) {
        return RepoResult::err(e);
    }
    let stamp = now_iso(ctx);
    persist_repo(ctx, &id, move |mut r| {
        r.last_fetched = Some(stamp);
        r
    })
}

/// `repositories:update` -- edit name and/or remote. Changing the URL re-points
/// origin and re-derives kind/transport; a branch is force-checked-out.
pub fn update(
    ctx: &AppContext,
    id: String,
    name: String,
    url: String,
    branch: Option<String>,
) -> RepoResult {
    let repo = match find_repo(ctx, &id) {
        Ok(Some(repo)) => repo,
        Ok(None) => return RepoResult::err("not-found"),
        Err(e) => return RepoResult::err(e),
    };
    if url != repo.url {
        // The clone may not exist yet (add/clone failed); the record still
        // updates, so a set-url failure is intentionally ignored.
        let _ = ctx.git.set_remote_url(&repo.local_path, &url);
    }
    let (kind, transport) = parse_remote(&url);
    let branch = branch.filter(|b| !b.is_empty());
    if let Some(b) = &branch {
        if ctx.fs.exists(&repo.local_path).unwrap_or(false) {
            // Force-checkout in the terminal (visible, discards local edits);
            // falls back to the direct GitPort headless.
            if let Err(e) = checkout_op(ctx, &repo.local_path, b) {
                return RepoResult::err(e);
            }
        }
    }
    let new_name = if name.trim().is_empty() {
        repo.name.clone()
    } else {
        name.trim().to_string()
    };
    persist_repo(ctx, &id, move |mut r| {
        r.name = new_name;
        r.url = url;
        r.kind = kind;
        r.transport = transport;
        if let Some(b) = branch {
            r.branch = Some(b);
        }
        r
    })
}

/// `repositories:remove` -- remove from state and delete the local clone dir.
pub fn remove(ctx: &AppContext, id: String) -> RemoveResult {
    let removed = {
        let _guard = lock(ctx);
        let state = match load_state(&ctx.fs, &ctx.paths.state_json) {
            Ok(state) => state,
            Err(e) => return RemoveResult::err(e.to_string()),
        };
        match state.repositories.iter().find(|r| r.id == id).cloned() {
            None => None,
            Some(repo) => {
                let repositories = state
                    .repositories
                    .iter()
                    .filter(|r| r.id != repo.id)
                    .cloned()
                    .collect();
                let next = AppState {
                    repositories,
                    ..state
                };
                if let Err(e) = save_state(&ctx.fs, &ctx.paths.state_json, &next) {
                    return RemoveResult::err(e.to_string());
                }
                Some(repo)
            }
        }
    };
    match removed {
        None => RemoveResult::err("not-found"),
        Some(repo) => {
            // Best-effort clone removal (outside the lock); the clone dir lives
            // under reposDir. StdFs::remove only unlinks files, so remove the
            // tree directly.
            let _ = std::fs::remove_dir_all(&repo.local_path);
            RemoveResult::ok()
        }
    }
}

/// `repositories:sync` -- force the clone to match upstream (fetch + reset +
/// clean, plus lfs), re-cloning when the dir is missing, and stamp lastFetched.
pub fn sync(ctx: &AppContext, id: String) -> RepoResult {
    let repo = match find_repo(ctx, &id) {
        Ok(Some(repo)) => repo,
        Ok(None) => return RepoResult::err("not-found"),
        Err(e) => return RepoResult::err(e),
    };
    let tracked = repo.branch.as_deref().filter(|b| !b.is_empty());
    // Clone/pull run in the terminal session (background unless git needs input);
    // fall back to the direct, silent GitPort headless.
    if ctx.fs.exists(&repo.local_path).unwrap_or(false) {
        if let Some(b) = tracked {
            if let Err(e) = checkout_op(ctx, &repo.local_path, b) {
                return RepoResult::err(e);
            }
        }
        if let Err(e) = force_pull_op(ctx, &repo.local_path) {
            return RepoResult::err(e);
        }
        if repo.lfs {
            if let Err(e) = lfs_pull_op(ctx, &repo.local_path) {
                return RepoResult::err(e);
            }
        }
    } else {
        if let Err(e) = ctx.fs.mkdir(&ctx.paths.repositories_dir) {
            return RepoResult::err(e.to_string());
        }
        let options = CloneOptions {
            url: repo.url.clone(),
            destination: repo.local_path.clone(),
            lfs: repo.lfs,
            filter: None,
        };
        if let Err(e) = clone_op(ctx, &options) {
            return RepoResult::err(e);
        }
        // A fresh clone lands on the remote default branch; switch to the tracked one.
        if let Some(b) = tracked {
            if let Err(e) = checkout_op(ctx, &repo.local_path, b) {
                return RepoResult::err(e);
            }
        }
    }
    let stamp = now_iso(ctx);
    persist_repo(ctx, &id, move |mut r| {
        r.last_fetched = Some(stamp);
        r
    })
}

/// `repositories:describe` -- branch + skill count for a clone; zeros/null when
/// missing or on any failure.
pub fn describe(ctx: &AppContext, id: String) -> RepoInfo {
    let empty = RepoInfo {
        branch: None,
        skill_count: 0,
    };
    let repo = match find_repo(ctx, &id) {
        Ok(Some(repo)) => repo,
        _ => return empty,
    };
    if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
        return empty;
    }
    let branch = match ctx.git.current_branch(&repo.local_path) {
        Ok(b) if !b.is_empty() && b != "HEAD" => Some(b),
        _ => None,
    };
    let skill_count = resolve_skills(&ctx.fs, &repo.local_path).skills.len();
    RepoInfo {
        branch,
        skill_count,
    }
}

/// `repositories:listBranches` -- local + origin branch names for a clone; empty
/// when missing or on any failure.
pub fn list_branches(ctx: &AppContext, id: String) -> Vec<String> {
    let repo = match find_repo(ctx, &id) {
        Ok(Some(repo)) => repo,
        _ => return Vec::new(),
    };
    if !ctx.fs.exists(&repo.local_path).unwrap_or(false) {
        return Vec::new();
    }
    ctx.git.list_branches(&repo.local_path).unwrap_or_default()
}

/// `repositories:hasUpdate` -- fetch, then compare local `HEAD` against the
/// tracked upstream; false on any failure (port of the core `repoHasUpdate`).
pub fn has_update(ctx: &AppContext, id: String) -> bool {
    let repo = match find_repo(ctx, &id) {
        Ok(Some(repo)) => repo,
        _ => return false,
    };
    // Fetch in the terminal (visible, ssh-capable) like a pull; the rev-parse
    // comparisons below stay on the silent port.
    if fetch_op(ctx, &repo.local_path).is_err() {
        return false;
    }
    let local = match ctx.git.rev_parse(&repo.local_path, "HEAD") {
        Ok(r) => r,
        Err(_) => return false,
    };
    let upstream = match ctx.git.rev_parse(&repo.local_path, "@{upstream}") {
        Ok(r) => r,
        Err(_) => return false,
    };
    local.oid != upstream.oid
}

// ---------------------------------------------------------------------------
// Tauri command wrappers. Thin adapters over the `&AppContext` functions above.
// ---------------------------------------------------------------------------

/// `repositories:add`.
#[tauri::command]
pub async fn repositories_add(
    ctx: State<'_, Arc<AppContext>>,
    url: String,
    name: String,
) -> Result<RepoResult, String> {
    blocking(&ctx, move |c| add(c, url, name)).await
}

/// `repositories:clone`.
#[tauri::command]
pub async fn repositories_clone(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RepoResult, String> {
    blocking(&ctx, move |c| clone(c, id)).await
}

/// `repositories:update`.
#[tauri::command]
pub async fn repositories_update(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
    name: String,
    url: String,
    branch: Option<String>,
) -> Result<RepoResult, String> {
    blocking(&ctx, move |c| update(c, id, name, url, branch)).await
}

/// `repositories:remove`.
#[tauri::command]
pub async fn repositories_remove(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RemoveResult, String> {
    blocking(&ctx, move |c| remove(c, id)).await
}

/// `repositories:sync`.
#[tauri::command]
pub async fn repositories_sync(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RepoResult, String> {
    blocking(&ctx, move |c| sync(c, id)).await
}

/// `repositories:hasUpdate`.
#[tauri::command]
pub async fn repositories_has_update(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<bool, String> {
    blocking(&ctx, move |c| has_update(c, id)).await
}

/// `repositories:describe`.
#[tauri::command]
pub async fn repositories_describe(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RepoInfo, String> {
    blocking(&ctx, move |c| describe(c, id)).await
}

/// `repositories:listBranches`.
#[tauri::command]
pub async fn repositories_list_branches(
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<Vec<String>, String> {
    blocking(&ctx, move |c| list_branches(c, id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use skillkeeper_core::models::{RepositoryKind, Transport};
    use std::path::PathBuf;
    use std::process::Command;

    /// Whether a usable `git` binary is on PATH.
    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Run a `git` subcommand in `cwd`, asserting success.
    fn git(cwd: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A throwaway local git repository to clone from, with one skill committed.
    struct SourceRepo {
        path: PathBuf,
    }

    impl SourceRepo {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-src-{}-{}", std::process::id(), n));
            std::fs::create_dir_all(&path).expect("create source dir");
            git(&path, &["-c", "init.defaultBranch=main", "init"]);
            let skill_dir = path.join("skill-a");
            std::fs::create_dir_all(&skill_dir).expect("create skill dir");
            std::fs::write(
                skill_dir.join("SKILL.md"),
                "---\nname: skill-a\n---\nbody\n",
            )
            .expect("write SKILL.md");
            let repo = Self { path };
            repo.commit("init");
            repo
        }

        fn url(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        /// Commit all current changes with gpg signing forced off.
        fn commit(&self, message: &str) {
            git(&self.path, &["add", "-A"]);
            git(
                &self.path,
                &[
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    message,
                ],
            );
        }

        /// Add a second branch (so listBranches has more than `main`).
        fn add_branch(&self, name: &str) {
            git(&self.path, &["branch", name]);
        }

        /// Append a new commit so a cloned tracker sees an available update.
        fn advance(&self, file: &str) {
            std::fs::write(self.path.join(file), "more\n").expect("write file");
            git(&self.path, &["add", "-A"]);
            git(
                &self.path,
                &[
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    "advance",
                ],
            );
        }
    }

    impl Drop for SourceRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // ---- add (no git binary needed) ----

    #[test]
    fn add_persists_a_repository_with_parsed_remote_fields() {
        let app = TempAppData::new();
        let result = add(
            &app.ctx,
            "git@github.com:acme/skills.git".to_string(),
            "Skills".to_string(),
        );
        assert!(result.ok);
        let repo = result.repository.unwrap();
        assert_eq!(repo.name, "Skills");
        assert_eq!(repo.kind, RepositoryKind::Github);
        assert_eq!(repo.transport, Transport::Ssh);
        assert!(!repo.lfs);
        assert!(repo.local_path.ends_with(&repo.id));

        // Persisted into state.
        let state = load_state(&app.ctx.fs, &app.ctx.paths.state_json).unwrap();
        assert_eq!(state.repositories.len(), 1);
        assert_eq!(state.repositories[0].id, repo.id);
    }

    #[test]
    fn add_defaults_name_to_url_when_blank_and_derives_https_generic() {
        let app = TempAppData::new();
        let result = add(
            &app.ctx,
            "https://example.com/team/repo.git".to_string(),
            "   ".to_string(),
        );
        let repo = result.repository.unwrap();
        assert_eq!(repo.name, "https://example.com/team/repo.git");
        assert_eq!(repo.kind, RepositoryKind::Generic);
        assert_eq!(repo.transport, Transport::Https);
    }

    #[test]
    fn add_rejects_a_duplicate_url() {
        let app = TempAppData::new();
        let url = "https://example.com/r.git".to_string();
        assert!(add(&app.ctx, url.clone(), "one".to_string()).ok);
        let dup = add(&app.ctx, url, "two".to_string());
        assert!(!dup.ok);
        assert_eq!(dup.error.as_deref(), Some("duplicate"));
    }

    // ---- commands that operate on a missing repo ----

    #[test]
    fn commands_report_not_found_for_an_unknown_id() {
        let app = TempAppData::new();
        assert_eq!(
            clone(&app.ctx, "nope".to_string()).error.as_deref(),
            Some("not-found")
        );
        assert_eq!(
            sync(&app.ctx, "nope".to_string()).error.as_deref(),
            Some("not-found")
        );
        assert_eq!(
            remove(&app.ctx, "nope".to_string()).error.as_deref(),
            Some("not-found")
        );
        assert!(!has_update(&app.ctx, "nope".to_string()));
        assert!(list_branches(&app.ctx, "nope".to_string()).is_empty());
        let info = describe(&app.ctx, "nope".to_string());
        assert_eq!(info.branch, None);
        assert_eq!(info.skill_count, 0);
    }

    // ---- git-backed integration tests ----

    fn add_repo(app: &TempAppData, src: &SourceRepo) -> Repository {
        add(&app.ctx, src.url(), "src".to_string())
            .repository
            .expect("added")
    }

    #[test]
    fn clone_checks_out_and_stamps_last_fetched() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);

        let result = clone(&app.ctx, repo.id.clone());
        assert!(result.ok, "clone failed: {:?}", result.error);
        let cloned = result.repository.unwrap();
        assert!(cloned.last_fetched.is_some());
        assert!(Path::new(&repo.local_path)
            .join("skill-a/SKILL.md")
            .exists());
    }

    #[test]
    fn describe_reports_branch_and_skill_count() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);
        assert!(clone(&app.ctx, repo.id.clone()).ok);

        let info = describe(&app.ctx, repo.id.clone());
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.skill_count, 1);
    }

    #[test]
    fn list_branches_returns_local_and_origin_names() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        src.add_branch("feature");
        let repo = add_repo(&app, &src);
        assert!(clone(&app.ctx, repo.id.clone()).ok);

        let branches = list_branches(&app.ctx, repo.id.clone());
        assert!(branches.contains(&"main".to_string()));
        assert!(branches.contains(&"feature".to_string()));
    }

    #[test]
    fn sync_clones_when_missing_then_force_pulls() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);

        // No clone yet: sync should create it.
        let first = sync(&app.ctx, repo.id.clone());
        assert!(first.ok, "sync/clone failed: {:?}", first.error);
        assert!(Path::new(&repo.local_path)
            .join("skill-a/SKILL.md")
            .exists());

        // Existing clone: sync should force-pull without error.
        let second = sync(&app.ctx, repo.id.clone());
        assert!(second.ok, "sync/pull failed: {:?}", second.error);
        assert!(second.repository.unwrap().last_fetched.is_some());
    }

    #[test]
    fn has_update_is_false_when_current_and_true_after_upstream_advances() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);
        assert!(clone(&app.ctx, repo.id.clone()).ok);

        assert!(!has_update(&app.ctx, repo.id.clone()));
        src.advance("extra.txt");
        assert!(has_update(&app.ctx, repo.id.clone()));
    }

    #[test]
    fn update_edits_name_and_rederives_remote_fields() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);
        assert!(clone(&app.ctx, repo.id.clone()).ok);

        let result = update(
            &app.ctx,
            repo.id.clone(),
            "renamed".to_string(),
            "git@github.com:acme/other.git".to_string(),
            None,
        );
        assert!(result.ok, "update failed: {:?}", result.error);
        let updated = result.repository.unwrap();
        assert_eq!(updated.name, "renamed");
        assert_eq!(updated.url, "git@github.com:acme/other.git");
        assert_eq!(updated.kind, RepositoryKind::Github);
        assert_eq!(updated.transport, Transport::Ssh);
    }

    #[test]
    fn update_force_checks_out_a_selected_branch() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        src.add_branch("feature");
        let repo = add_repo(&app, &src);
        assert!(clone(&app.ctx, repo.id.clone()).ok);

        let result = update(
            &app.ctx,
            repo.id.clone(),
            "src".to_string(),
            src.url(),
            Some("feature".to_string()),
        );
        assert!(result.ok, "update failed: {:?}", result.error);
        assert_eq!(
            result.repository.unwrap().branch.as_deref(),
            Some("feature")
        );
        assert_eq!(
            describe(&app.ctx, repo.id.clone()).branch.as_deref(),
            Some("feature")
        );
    }

    #[test]
    fn remove_deletes_state_record_and_clone_dir() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);
        assert!(clone(&app.ctx, repo.id.clone()).ok);
        assert!(Path::new(&repo.local_path).exists());

        let result = remove(&app.ctx, repo.id.clone());
        assert!(result.ok);
        assert!(!Path::new(&repo.local_path).exists());
        let state = load_state(&app.ctx.fs, &app.ctx.paths.state_json).unwrap();
        assert!(state.repositories.is_empty());
    }
}
