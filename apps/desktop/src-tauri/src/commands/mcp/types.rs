//! Wire types for the MCP commands: the deserialized command arguments and the
//! serialized command results.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use skillkeeper_core::mcp::{McpIdentity, McpServerDef, McpTransport, UpsertNote};
use skillkeeper_core::models::{AgentKind, Scope};

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
    pub(super) fn to_core(&self) -> McpIdentity {
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

/// Install/remove work for one agent within an [`apply`](super::apply()) call (mirrors the TS
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

/// Arguments for [`apply`](super::apply()) (mirrors the TS `ApplyMcpArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMcpArgs {
    /// Which scope to write into. Absent means `project`.
    #[serde(default)]
    pub scope: Scope,
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

/// Arguments for [`update`](super::update()) (mirrors the TS `UpdateMcpArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpArgs {
    /// Which scope to write into. Absent means `project`.
    #[serde(default)]
    pub scope: Scope,
    #[serde(default)]
    pub updates: Vec<McpUpdateReq>,
}

/// Arguments for [`update_preflight`](super::update_preflight) (mirrors the TS `McpUpdatePreflightArgs`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpUpdatePreflightArgs {
    /// Which scope to write into. Absent means `project`.
    #[serde(default)]
    pub scope: Scope,
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

/// Why `apply` declined an operation. Mirrors the TS `McpSkipped.reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum McpSkipReason {
    /// The agent's native config cannot express the def's transport.
    Transport,
    /// The agent cannot express an OAuth client at all, so writing the server
    /// would leave it looking installed and unable to authenticate.
    Oauth,
}

/// One install `apply` declined to perform: one whose transport the agent
/// cannot express, or one carrying an oauth client the agent cannot express.
/// Removes are never skipped -- they carry no def, so neither rule applies.
/// Mirrors the TS `McpSkipped`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSkipped {
    pub agent: AgentKind,
    /// The preset's source name (an install or an update always carries a def,
    /// and its identity's source names it).
    pub source: String,
    /// Which rule declined it, so the renderer can say why rather than only how
    /// many. `mcpSkipsToMessages` in `features/mcpInstall/lib` is what reads it.
    pub reason: McpSkipReason,
    /// The transport that could not be expressed. Absent for an oauth skip,
    /// whose transport was perfectly expressible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<McpTransport>,
}

/// One install `apply` performed, and anything the writer could not express
/// while doing it. Mirrors the TS `McpInstalled`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInstalled {
    pub agent: AgentKind,
    /// The name the server was written under.
    pub instance_name: String,
    /// Writer notes, empty when nothing was dropped. The install succeeded, so
    /// these are not errors -- but a silently dropped auth field reads as
    /// configured when it is not, so the renderer shows them.
    pub notes: Vec<UpsertNote>,
}

/// Outcome of [`apply`](super::apply()): `{ ok: true, installed, removed, skipped }` or
/// `{ ok: false, error }` (mirrors the TS `ApplyMcpResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMcpResult {
    pub ok: bool,
    /// One entry per installed target, in the order they were written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed: Option<Vec<McpInstalled>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<McpSkipped>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl ApplyMcpResult {
    pub(super) fn ok(
        installed: Vec<McpInstalled>,
        removed: usize,
        skipped: Vec<McpSkipped>,
    ) -> Self {
        Self {
            ok: true,
            installed: Some(installed),
            removed: Some(removed),
            skipped: Some(skipped),
            error: None,
        }
    }

    pub(super) fn err(error: String) -> Self {
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
    /// The tracked project's id, or `"global"` for the reserved global bucket.
    /// Every agent can be installed at either scope; the parenthetical this
    /// used to carry named codex, from when codex alone was forced to global.
    pub project_id: String,
    pub agent: AgentKind,
    pub instance_name: String,
    pub identity: McpInstallIdentity,
    pub hash: String,
    /// Whether `.skmcp.params.yml` carries an entry for this instance.
    pub has_params: bool,
}

/// Outcome of [`update`](super::update()): `{ ok: true, updated }` or `{ ok: false, error }`
/// (mirrors the TS `UpdateMcpResult` union).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpResult {
    pub ok: bool,
    /// One entry per updated instance, in the order they were written. Same
    /// shape as `apply`'s `installed`, because an update IS a reinstall and its
    /// writer notes matter for exactly the same reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated: Option<Vec<McpInstalled>>,
    /// Updates declined, with the same reasons `apply` uses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<Vec<McpSkipped>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl UpdateMcpResult {
    pub(super) fn ok(updated: Vec<McpInstalled>, skipped: Vec<McpSkipped>) -> Self {
        Self {
            ok: true,
            updated: Some(updated),
            skipped: Some(skipped),
            error: None,
        }
    }

    pub(super) fn err(error: String) -> Self {
        Self {
            ok: false,
            updated: None,
            skipped: None,
            error: Some(error),
        }
    }
}

/// Outcome of [`update_preflight`](super::update_preflight): `{ ok: true, missingParams }` or
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
    pub(super) fn ok(missing_params: Vec<String>) -> Self {
        Self {
            ok: true,
            missing_params: Some(missing_params),
            error: None,
        }
    }

    pub(super) fn err(error: String) -> Self {
        Self {
            ok: false,
            missing_params: None,
            error: Some(error),
        }
    }
}

/// The `mcp:list-available` payload: the catalog plus any warning raised while
/// reading it. Mirrors `AvailableSkillsResult`, for the same reason -- a preset
/// that cannot be read is otherwise silently absent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableMcpResult {
    pub mcp: Vec<AvailableMcp>,
    pub warnings: Vec<McpConfigWarning>,
}

/// One problem found while reading a repository's MCP config, attributed to the
/// repository so the renderer can name it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigWarning {
    pub repo_id: String,
    pub repo_name: String,
    pub message: String,
}
