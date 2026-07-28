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
//!
//! The three commands that reach the network -- `clone`, `sync` and
//! `hasUpdate` -- run behind the SSH gate first (see [`gate_offline`]), so a
//! repository served over SSH never starts a git subprocess that would sit
//! waiting on a passphrase nobody is going to type. `update` and
//! `listBranches` are deliberately outside it: the former only rewrites the
//! remote URL and force-checks-out a local branch, and the latter reads
//! `for-each-ref` out of the existing clone. Neither opens a connection. Nor
//! does an update check on a repository that was never cloned, so that one is
//! outside the gate too, even though `hasUpdate` as a whole is inside it.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use skillkeeper_core::adapters::system_git::{
    build_clean_args, build_clone_args, build_fetch_args, build_force_checkout_args,
    build_lfs_pull_args, build_reset_hard_args,
};
use skillkeeper_core::git_remote::parse_remote;
use skillkeeper_core::models::{AppState, Repository, Transport};
use skillkeeper_core::ports::{Clock, CloneOptions, FsPort, GitPort, PortResult};
use skillkeeper_core::skills::resolver::resolve_skills;
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;

use std::sync::Arc;

use super::blocking;
use crate::app::ssh_key::{gate_for, Gate, KEY_LOCKED_ERROR};
use crate::commands::ssh_key::require_unlocked;
use crate::state::AppContext;

// ---------------------------------------------------------------------------
// Git routing: PTY session when live, direct SystemGit otherwise.
//
// User-initiated clone/sync/update-checkout and the hasUpdate fetch run IN the
// interactive terminal session (`ctx.terminal.run_git_with_env`) so their
// output streams to the terminal view and an ssh-key passphrase prompt reads
// the terminal's input -- faithfully porting Electron's `terminalGit`. When no
// session has started (headless contexts and the repository unit tests) they
// fall back to the direct, silent `ctx.git` (`SystemGit`) so operations still
// work.
//
// Every PTY call is threaded with a `make_env` closure over
// `app::ssh_git::git_env_lease(ctx)`, evaluated by the PTY layer only once it
// has actually entered its queued slot: empty when no SSH key is chosen
// (today's behaviour, unchanged), the key alone when it is locked or needs no
// passphrase, or the key plus a token minted (and, once the invocation's git
// subprocess exits, revoked) fresh for that one invocation when it is
// unlocked for this session.
//
// The PTY steps reuse the same argument builders as `SystemGit`, decomposed to
// match `terminal.ts` exactly: a force-pull is fetch + `reset --hard @{u}` +
// `clean -fd` as three separate `run_git_with_env` invocations, and an lfs
// clone is the clone followed by a separate `lfs pull`.
//
// Configured git path: the PTY `run_git_with_env` invokes `git` from PATH
// (Wave 3 built it that way), and the Tauri `AppContext` wires `ctx.git` as
// `SystemGit::new()`
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
        crate::app::ssh_git::run_git_in_terminal(ctx, cwd, args).map(|_| ())
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
        crate::app::ssh_git::run_git_in_terminal(ctx, &parent, &build_clone_args(options))?;
        if options.lfs {
            crate::app::ssh_git::run_git_in_terminal(
                ctx,
                &options.destination,
                &build_lfs_pull_args(),
            )?;
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
        crate::app::ssh_git::run_git_in_terminal(ctx, path, &build_fetch_args())?;
        crate::app::ssh_git::run_git_in_terminal(ctx, path, &build_reset_hard_args())?;
        crate::app::ssh_git::run_git_in_terminal(ctx, path, &build_clean_args())?;
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
    // A repository that was never cloned (its clone failed, or the directory was
    // deleted) has no local commit to compare against, so there is nothing this
    // can report. Checking first also keeps the update sweep from running
    // `git -C <missing dir> fetch` -- which prints a `fatal:` into the terminal
    // on every startup, once per such repository. Matches `list_branches`.
    if !has_clone(ctx, &repo) {
        return false;
    }
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
// The SSH gate.
//
// Split in two on purpose, and the split is what makes it testable:
//
// - `offer_unlock` is the half that can raise the passphrase window. It needs
//   the `AppHandle`, so it lives in the command wrapper -- also the only layer
//   where neither the state lock nor a git-queue slot is held yet. Its outcome
//   is not consulted.
// - `gate_offline` is the half that decides, and it needs no window at all. Each
//   command's `*_gated` function runs it a moment later, re-reading the key
//   state, and shapes the refusal the way that command's renderer expects.
//
// Every outcome `offer_unlock` can have -- unlocked, cancelled, closed, timed
// out, key gone -- leaves a key state that `gate_offline` maps to exactly the
// same answer, so nothing is lost by dropping the first result, and the whole
// decision sits in one place a unit test can reach.
// ---------------------------------------------------------------------------

/// Whether `repo`'s remote is reached over SSH, and so needs the chosen key.
///
/// A field read: `transport` was parsed once when the record was written, so
/// this never re-parses the URL.
fn needs_key(repo: &Repository) -> bool {
    repo.transport == Transport::Ssh
}

/// Whether `repo`'s clone directory is actually there.
fn has_clone(ctx: &AppContext, repo: &Repository) -> bool {
    ctx.fs.exists(&repo.local_path).unwrap_or(false)
}

/// Give the user a chance to unlock the chosen key before git work on `repo`
/// starts.
///
/// Only ever raises the unlock window for an `interactive` caller;
/// [`gate_for`], reached through [`require_unlocked`], is what enforces that, so
/// a scheduled sweep returns from here at once. Callers must hold neither the
/// state lock nor a git-queue slot: an answered-at-leisure prompt parks this
/// thread for minutes.
///
/// The outcome is deliberately dropped -- see the section comment above.
fn offer_unlock(app: &AppHandle, ctx: &AppContext, repo: &Repository, interactive: bool) {
    let _ = require_unlocked(app, ctx, needs_key(repo), interactive);
}

/// The gate's decision for `repo` with no window in reach.
///
/// # Errors
///
/// The stable `ssh.*` code for a key that cannot serve this remote, never a raw
/// window-system or git message. `Gate::Prompt` lands on
/// [`KEY_LOCKED_ERROR`]: the window belongs to [`offer_unlock`], which has
/// already had its turn by the time this runs, so still needing one means the
/// key is still locked.
fn gate_offline(ctx: &AppContext, repo: &Repository, interactive: bool) -> Result<(), String> {
    match gate_for(needs_key(repo), ctx.ssh_key.state(), interactive) {
        Gate::Proceed => Ok(()),
        Gate::Fail(code) => Err(code.to_string()),
        Gate::Prompt => Err(KEY_LOCKED_ERROR.to_string()),
    }
}

/// [`clone`] behind the SSH gate.
///
/// A refusal is a `RepoResult`, not an `Err` across the bridge: the renderer
/// awaits `cloneRepository` without a `try`, so a rejected call there would be
/// an unhandled rejection instead of the error the user is shown. That shape is
/// load-bearing, which is why this is a plain `&AppContext` function with a test
/// on it rather than a match arm inside the command wrapper.
fn clone_gated(ctx: &AppContext, id: String, interactive: bool) -> RepoResult {
    // An unresolvable id is not the gate's failure to report; `clone` answers
    // `not-found` for it exactly as it always has.
    let Ok(Some(repo)) = find_repo(ctx, &id) else {
        return clone(ctx, id);
    };
    match gate_offline(ctx, &repo, interactive) {
        Ok(()) => clone(ctx, id),
        Err(code) => RepoResult::err(code),
    }
}

/// [`sync`] behind the SSH gate. Same refusal shape, and same reason, as
/// [`clone_gated`].
fn sync_gated(ctx: &AppContext, id: String, interactive: bool) -> RepoResult {
    let Ok(Some(repo)) = find_repo(ctx, &id) else {
        return sync(ctx, id);
    };
    match gate_offline(ctx, &repo, interactive) {
        Ok(()) => sync(ctx, id),
        Err(code) => RepoResult::err(code),
    }
}

/// [`has_update`] behind the SSH gate.
///
/// The missing-clone check comes first, ahead of the gate: a repository that was
/// never cloned makes [`has_update`] short-circuit before it runs any git, so
/// there is no remote for a key to serve. Gating it anyway would fail one check
/// per such repository on every scheduled sweep -- and prompt for a passphrase
/// on the Refresh button -- for work that never touches the network.
///
/// # Errors
///
/// The stable `ssh.*` code for a key that cannot serve this remote. Everything
/// else still degrades to `Ok(false)`, as the update sweep has always done.
fn has_update_gated(ctx: &AppContext, id: &str, interactive: bool) -> Result<bool, String> {
    let Ok(Some(repo)) = find_repo(ctx, id) else {
        return Ok(false);
    };
    if !has_clone(ctx, &repo) {
        return Ok(false);
    }
    gate_offline(ctx, &repo, interactive)?;
    Ok(has_update(ctx, id.to_string()))
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

/// `repositories:clone` -- user-initiated, so a locked key may ask.
///
/// A gate refusal comes back as `{ ok: false, error }` carrying the stable
/// code, like every other clone failure, rather than as a rejected call.
#[tauri::command]
pub async fn repositories_clone(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RepoResult, String> {
    blocking(&ctx, move |c| {
        if let Ok(Some(repo)) = find_repo(c, &id) {
            offer_unlock(&app, c, &repo, true);
        }
        clone_gated(c, id, true)
    })
    .await
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

/// `repositories:sync` -- user-initiated, so a locked key may ask.
///
/// A gate refusal comes back as `{ ok: false, error }` carrying the stable
/// code, like every other sync failure, rather than as a rejected call.
#[tauri::command]
pub async fn repositories_sync(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
    id: String,
) -> Result<RepoResult, String> {
    blocking(&ctx, move |c| {
        if let Ok(Some(repo)) = find_repo(c, &id) {
            offer_unlock(&app, c, &repo, true);
        }
        sync_gated(c, id, true)
    })
    .await
}

/// `repositories:hasUpdate`.
///
/// `interactive` says whether a user pressed Refresh (`true`) or this is the
/// scheduled/startup sweep (`false`). The backend cannot tell the two apart, and
/// the difference decides whether a locked key may raise the unlock prompt --
/// so the caller states it. The scheduled sweep fails with `ssh.keyLocked`
/// instead, and the renderer marks that check errored.
#[tauri::command]
pub async fn repositories_has_update(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
    id: String,
    interactive: bool,
) -> Result<bool, String> {
    blocking(&ctx, move |c| {
        // Never ask for a key the check has no use for: a repository that was
        // never cloned makes `has_update` short-circuit before it runs git, so
        // pressing Refresh on one must not raise a passphrase window.
        if let Ok(Some(repo)) = find_repo(c, &id) {
            if has_clone(c, &repo) {
                offer_unlock(&app, c, &repo, interactive);
            }
        }
        has_update_gated(c, &id, interactive)
    })
    .await?
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

    /// A tracked repository that was never cloned must not be fetched: there is
    /// nothing to compare against, and running git in a directory that does not
    /// exist only reports a fatal error into the terminal on every sweep.
    #[test]
    fn has_update_is_false_without_touching_git_when_the_clone_is_missing() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let app = TempAppData::new();
        let src = SourceRepo::new();
        let repo = add_repo(&app, &src);
        // Added but never cloned, so the recorded local path does not exist.
        assert!(!Path::new(&repo.local_path).exists());
        assert!(!has_update(&app.ctx, repo.id.clone()));

        // And once it IS cloned, the same call reports normally again.
        assert!(clone(&app.ctx, repo.id.clone()).ok);
        assert!(!has_update(&app.ctx, repo.id.clone()));
        src.advance("extra.txt");
        assert!(has_update(&app.ctx, repo.id));
    }

    // ---- the ssh gate (no git binary and no window system needed) ----

    /// Configure an encrypted key and leave it locked, so every gate decision
    /// below is the interesting one.
    fn with_locked_key(app: &TempAppData) {
        let path = crate::commands::test_support::write_key(app.dir(), "enc", Some("topsecret"));
        app.ctx.ssh_key.set_path(Some(path));
    }

    /// Record a repository at `url` and put a directory where its clone would
    /// be, so the gate is reached rather than short-circuited by the
    /// missing-clone check. The directory is not a git repository -- nothing
    /// past the gate needs it to be.
    fn added_and_cloned(app: &TempAppData, url: &str) -> String {
        let repo = add(&app.ctx, url.to_string(), "acme".to_string())
            .repository
            .expect("added");
        std::fs::create_dir_all(&repo.local_path).expect("create clone dir");
        repo.id
    }

    #[test]
    fn a_scheduled_update_check_fails_instead_of_prompting() {
        let app = TempAppData::new();
        with_locked_key(&app);
        // A cloned SSH repository whose key is locked: the scheduled path must
        // report the locked key, not open a window (there is no AppHandle here
        // at all).
        let id = added_and_cloned(&app, "git@example.com:acme/skills.git");
        let res = has_update_gated(&app.ctx, &id, false);
        assert_eq!(res, Err("ssh.keyLocked".to_string()));
    }

    /// A repository that was never cloned reaches no remote -- `has_update`
    /// short-circuits before running git -- so the locked key is irrelevant to
    /// it. Gating it anyway would fail one check per such repository on every
    /// sweep, and (worse) prompt for a passphrase on the Refresh button, for
    /// work that never touches the network.
    #[test]
    fn an_uncloned_repository_is_not_gated_even_over_ssh() {
        let app = TempAppData::new();
        with_locked_key(&app);
        let repo = add(
            &app.ctx,
            "git@example.com:acme/skills.git".to_string(),
            "acme".to_string(),
        )
        .repository
        .expect("added");
        assert!(!Path::new(&repo.local_path).exists());
        // Both directions: the scheduled sweep and the Refresh button. Neither
        // can prompt -- there is no AppHandle here -- and neither may fail.
        assert_eq!(has_update_gated(&app.ctx, &repo.id, false), Ok(false));
        assert_eq!(has_update_gated(&app.ctx, &repo.id, true), Ok(false));
    }

    #[test]
    fn an_https_repository_is_never_gated() {
        let app = TempAppData::new();
        with_locked_key(&app);
        let id = added_and_cloned(&app, "https://example.com/acme/skills.git");
        // Not an SSH remote: the gate lets it through, and the check then
        // reports no update because the directory is not a clone. Pinned
        // exactly, so a gate that fired with any other code would fail here.
        assert_eq!(has_update_gated(&app.ctx, &id, false), Ok(false));
    }

    /// The refusal shape is load-bearing: the renderer awaits `cloneRepository`
    /// without a `try`, so a rejected call would be an unhandled rejection
    /// rather than the error the user is shown.
    #[test]
    fn a_locked_key_refuses_clone_and_sync_as_a_result_not_a_rejection() {
        let app = TempAppData::new();
        with_locked_key(&app);
        let repo = add(
            &app.ctx,
            "git@example.com:acme/skills.git".to_string(),
            "acme".to_string(),
        )
        .repository
        .expect("added");

        for result in [
            clone_gated(&app.ctx, repo.id.clone(), true),
            sync_gated(&app.ctx, repo.id.clone(), true),
        ] {
            assert!(!result.ok);
            assert_eq!(result.error.as_deref(), Some("ssh.keyLocked"));
            assert!(result.repository.is_none());
        }
        // Refused before any git ran, so nothing was cloned.
        assert!(!Path::new(&repo.local_path).exists());
    }

    /// The same two commands over HTTPS must not consult the key at all -- they
    /// fail for their own ordinary reasons instead.
    #[test]
    fn a_locked_key_does_not_refuse_an_https_clone_or_sync() {
        let app = TempAppData::new();
        with_locked_key(&app);
        let repo = add(
            &app.ctx,
            "https://example.invalid/acme/skills.git".to_string(),
            "acme".to_string(),
        )
        .repository
        .expect("added");

        for result in [
            clone_gated(&app.ctx, repo.id.clone(), true),
            sync_gated(&app.ctx, repo.id.clone(), true),
        ] {
            assert_ne!(result.error.as_deref(), Some("ssh.keyLocked"));
        }
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
