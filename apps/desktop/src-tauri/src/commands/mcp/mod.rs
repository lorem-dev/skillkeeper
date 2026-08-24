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

use std::sync::Arc;

use tauri::State;

use skillkeeper_agents::PROJECT_DIR_ENV;
use skillkeeper_core::mcp::markup::DescriptionSpan;
use skillkeeper_core::models::AgentKind;
use skillkeeper_core::ports::HostEnv;

use super::blocking;
use crate::state::AppContext;

mod apply;
mod available;
mod description;
mod installs;
mod target;
mod types;
mod update;

pub use available::list_available;
pub use installs::{installs, reconcile};
pub use types::*;

use apply::apply_inner;
use description::description_spans;
use update::{preflight_inner, update_inner};

/// The reserved `projectId` an install reports at global scope. It is a bucket
/// label on the wire only -- `state.json` never gains a project with this id.
pub const GLOBAL_PROJECT_ID: &str = "global";

/// Every MCP agent, for both the per-project pass and the global pass over
/// MCP ledgers. Every agent is eligible at both scopes now that Codex resolves
/// a real project-scoped destination (see `mcp_destination`).
const ALL_MCP_AGENTS: [AgentKind; 5] = [
    AgentKind::Claude,
    AgentKind::Codex,
    AgentKind::Copilot,
    AgentKind::Cursor,
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
/// resolve project-scope paths from this variable since an [`AgentTarget`](skillkeeper_core::models::AgentTarget)
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

/// `mcp:apply` -- apply install/remove batches for a project across agents.
/// Every install request's RENDERER-supplied values are validated against its
/// preset's option-constrained parameters BEFORE anything is touched: an
/// out-of-options value is an error, not a skip, and nothing is written when
/// one is found (the renderer already blocks this client-side, so a value
/// reaching here means that check was bypassed). A value read off
/// `.skmcp.params.yml` through `copyParamsFrom` is migrated and reported
/// instead -- see [`ValuesOrigin`](apply::ValuesOrigin). Removes run before installs (so a re-install onto the
/// same instance name starts clean); an install the agent cannot express --
/// its transport, or an oauth client at all -- is skipped and reported, and
/// every install that DID run carries the writer's notes back out. Never
/// throws across the boundary. Port of the TS `applyMcp`.
pub fn apply(ctx: &AppContext, args: ApplyMcpArgs) -> ApplyMcpResult {
    let _guard = lock(ctx);
    match apply_inner(ctx, &args) {
        Ok((installed, removed, skipped)) => ApplyMcpResult::ok(installed, removed, skipped),
        Err(e) => ApplyMcpResult::err(e),
    }
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

/// `mcp:update` -- update installed instances in place: for each, remove the old
/// instance and reinstall under the SAME name with the NEW def. Param values are
/// resolved server-side (the instance's own stored values merged under any
/// renderer-supplied newly-required params).
///
/// The two halves of that merge are checked differently, by provenance -- the
/// same split [`ValuesOrigin`](apply::ValuesOrigin) documents for `apply`. A RENDERER-supplied
/// value is validated against the new def's options BEFORE the merge and
/// refused outright: the interface should have blocked it, and migrating it
/// would replace a value the user typed seconds ago while reporting that the
/// STORED one was no longer accepted. The stored values are then migrated back
/// in line with the new def's options BEFORE the old instance is removed -- a
/// value an earlier install recorded may no longer be offered -- and the
/// resulting `OptionSubstituted` notes flow out alongside the
/// writer's own notes; the reinstall refreshes the ledger hash
/// automatically. An update the agent cannot express -- an oauth client it
/// has no setting for -- is declined and reported instead of rewriting the
/// server without its auth, and every update that DID run carries the writer's
/// notes back out. Port of the TS `updateMcp`.
pub fn update(ctx: &AppContext, args: UpdateMcpArgs) -> UpdateMcpResult {
    let _guard = lock(ctx);
    match update_inner(ctx, &args) {
        Ok((updated, skipped)) => UpdateMcpResult::ok(updated, skipped),
        Err(e) => UpdateMcpResult::err(e),
    }
}

// ---------------------------------------------------------------------------
// Tauri command wrappers. Thin adapters over the `&AppContext` functions above.
// ---------------------------------------------------------------------------

/// `mcp:list-available`.
#[tauri::command]
pub async fn mcp_list_available(
    ctx: State<'_, Arc<AppContext>>,
) -> Result<AvailableMcpResult, String> {
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

/// `mcp:description-spans` -- parse and truncate a batch of raw descriptions,
/// one round trip when a modal opens. No `AppContext` needed: this is a pure
/// parse, not a filesystem read, so it needs no `blocking` wrapper either.
#[tauri::command]
pub fn mcp_description_spans(descriptions: Vec<String>) -> Vec<Vec<DescriptionSpan>> {
    description_spans(&descriptions)
}

/// Sandbox fixtures shared by the MCP submodules' tests.
#[cfg(test)]
mod testutil {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use skillkeeper_core::adapters::SystemHostEnv;
    use skillkeeper_core::mcp::model::{McpOauth, McpOption, McpParameter};
    use skillkeeper_core::mcp::{McpServerDef, McpTransport};
    use skillkeeper_core::models::{AppState, Project, Scope, STATE_VERSION};
    use skillkeeper_core::state::state::save_state;

    use crate::commands::test_support::TempAppData;
    use crate::state::{AppContext, AppPaths};

    use super::types::{ApplyMcpArgs, McpBatch, McpIdentityArg, McpInstallReq};

    // ---- fixtures ----

    /// A throwaway project directory (the install destination base).
    pub(super) struct ProjectDir {
        path: PathBuf,
    }

    impl ProjectDir {
        pub(super) fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-mcp-proj-{}-{}", std::process::id(), n));
            std::fs::create_dir_all(&path).expect("create project dir");
            Self { path }
        }

        pub(super) fn path(&self) -> String {
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
    pub(super) struct CodexApp {
        base: PathBuf,
        pub(super) home: PathBuf,
        pub(super) ctx: AppContext,
    }

    impl CodexApp {
        pub(super) fn new() -> Self {
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
                app_update_json: app.join("app-update.json").to_string_lossy().into_owned(),
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

    pub(super) fn seed_project(app: &TempAppData, proj: &ProjectDir) {
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

    pub(super) fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A stdio def with an `env` `TOKEN={token}` placeholder.
    pub(super) fn stdio_token_def() -> McpServerDef {
        McpServerDef {
            name: "GitHub".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("npx".to_string()),
            args: Some(vec!["-y".to_string(), "server".to_string()]),
            env: Some(values(&[("TOKEN", "{token}")])),
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        }
    }

    /// The same stdio def with an extra `{org}` arg placeholder (an "updated"
    /// source that requires one new param).
    pub(super) fn stdio_token_org_def() -> McpServerDef {
        McpServerDef {
            args: Some(vec!["--org".to_string(), "{org}".to_string()]),
            ..stdio_token_def()
        }
    }

    pub(super) fn http_def() -> McpServerDef {
        McpServerDef {
            name: "Remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        }
    }

    /// The same http def carrying an oauth client. Copilot cannot express one
    /// at all; cursor can, minus the callback port.
    pub(super) fn oauth_http_def() -> McpServerDef {
        McpServerDef {
            oauth: Some(McpOauth {
                callback_port: Some(8432),
                client_id: Some("sk-client".to_string()),
                scopes: vec!["repo".to_string()],
            }),
            ..http_def()
        }
    }

    /// An sse def -- the one transport Codex still rejects (it now accepts
    /// both stdio and http).
    pub(super) fn sse_def() -> McpServerDef {
        McpServerDef {
            transport: McpTransport::Sse,
            url: Some("https://mcp.example.com/mcp".to_string()),
            ..http_def()
        }
    }

    /// A def carrying one option-constrained parameter, "choice" (accepted
    /// values alpha/beta, in that order). Not tied to any `{placeholder}`: the
    /// option check applies to a stored value regardless of whether it is
    /// ever rendered.
    pub(super) fn choice_def() -> McpServerDef {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "choice".to_string(),
            McpParameter {
                description: None,
                options: vec![
                    McpOption {
                        value: "alpha".to_string(),
                        label: "Alpha".to_string(),
                    },
                    McpOption {
                        value: "beta".to_string(),
                        label: "Beta".to_string(),
                    },
                ],
            },
        );
        McpServerDef {
            parameters,
            ..http_def()
        }
    }

    /// The same def with "alpha" dropped from the options, leaving only
    /// "beta" -- an updated source whose stored "alpha" value must migrate.
    pub(super) fn choice_def_alpha_dropped() -> McpServerDef {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "choice".to_string(),
            McpParameter {
                description: None,
                options: vec![McpOption {
                    value: "beta".to_string(),
                    label: "Beta".to_string(),
                }],
            },
        );
        McpServerDef {
            parameters,
            ..http_def()
        }
    }

    pub(super) fn identity() -> McpIdentityArg {
        McpIdentityArg {
            remote: Some("git@github.com:acme/mcps.git".to_string()),
            group: None,
            local: None,
            source: "github".to_string(),
        }
    }

    pub(super) fn install_req(def: McpServerDef, vals: &[(&str, &str)]) -> McpInstallReq {
        McpInstallReq {
            identity: identity(),
            def,
            values: values(vals),
            copy_params_from: None,
        }
    }

    pub(super) fn apply_args(proj: &ProjectDir, batches: Vec<McpBatch>) -> ApplyMcpArgs {
        ApplyMcpArgs {
            scope: Scope::Project,
            project_id: "proj-1".to_string(),
            project_path: proj.path(),
            batches,
        }
    }
}
