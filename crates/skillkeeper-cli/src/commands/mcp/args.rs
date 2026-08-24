//! Parsing and matching for the `mcp` command options: `--agent`, `--param`,
//! and the ledger-identity comparison the update sweep filters on.

use std::collections::BTreeMap;

use skillkeeper_core::git_remote::normalize_remote;
use skillkeeper_core::mcp::SkmcpEntry;
use skillkeeper_core::models::{AgentKind, Scope};

use crate::error::CliError;

use super::presets::PresetEntry;
use super::ALL_MCP_AGENTS;

/// Split a repeatable/comma-separated option into a de-duplicated list. Port of
/// `collectCsv`.
pub(super) fn collect_csv(values: &[String]) -> Vec<String> {
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
pub(super) fn collect_params(values: &[String]) -> Result<BTreeMap<String, String>, CliError> {
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
pub(super) fn agent_kind(name: &str) -> Option<AgentKind> {
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
pub(super) fn identity_matches(entry: &SkmcpEntry, preset: &PresetEntry) -> bool {
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

/// Resolve a `--agent` list to concrete kinds: the given agents, or every
/// agent when none were given. Shared by the project and global (non-`--all`)
/// branches of `update` so neither duplicates the fallback. Every agent has a
/// config to check at either scope, codex included, so the default is the
/// same `ALL_MCP_AGENTS` list regardless of scope -- matching `--all`, which
/// already sweeps every agent at both scopes.
pub(super) fn kinds_for(agents: &[String], _scope: Scope) -> Vec<AgentKind> {
    let agent_list = collect_csv(agents);
    if agent_list.is_empty() {
        ALL_MCP_AGENTS.to_vec()
    } else {
        agent_list.iter().filter_map(|a| agent_kind(a)).collect()
    }
}

/// One `(agent, scope, project_path, project_id)` scope to check for updates.
pub(super) struct UpdateScope {
    pub(super) agent: AgentKind,
    pub(super) scope: Scope,
    pub(super) project_path: String,
    pub(super) project_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
