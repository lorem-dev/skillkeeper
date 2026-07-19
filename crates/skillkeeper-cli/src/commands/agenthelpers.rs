//! Shared helpers for the agent-facing command groups (`skill`, `mcp`).
//!
//! [`ProjectEnv`] is the Rust analogue of the TypeScript `adapterEnvFor`: it
//! injects the active project directory into [`PROJECT_DIR_ENV`] so an adapter
//! can resolve project-scope paths, since an [`AgentTarget`] carries only a
//! `projectId`. [`parse_agent`] maps a `--agent` string to an [`AgentKind`].

use skillkeeper_agents::PROJECT_DIR_ENV;
use skillkeeper_core::models::{AgentKind, Scope};
use skillkeeper_core::ports::HostEnv;

use crate::error::CliError;

/// A [`HostEnv`] view that injects the active project directory into
/// [`PROJECT_DIR_ENV`], leaving every other lookup to the wrapped environment.
pub struct ProjectEnv<'a> {
    pub inner: &'a dyn HostEnv,
    pub project_path: String,
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

/// Parse a `--agent` string into an [`AgentKind`]. Mirrors the TypeScript
/// `agent as AgentKind` cast, but validates up front with a clear error.
pub fn parse_agent(name: &str) -> Result<AgentKind, CliError> {
    match name {
        "claude" => Ok(AgentKind::Claude),
        "codex" => Ok(AgentKind::Codex),
        "copilot" => Ok(AgentKind::Copilot),
        "cursor" => Ok(AgentKind::Cursor),
        "opencode" => Ok(AgentKind::Opencode),
        other => Err(CliError(format!("Unknown agent: {other}"))),
    }
}

/// The wire string for a scope (`"project"` / `"global"`).
pub fn scope_str(scope: Scope) -> &'static str {
    match scope {
        Scope::Project => "project",
        Scope::Global => "global",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_agent_maps_known_names() {
        assert_eq!(parse_agent("claude").unwrap(), AgentKind::Claude);
        assert_eq!(parse_agent("opencode").unwrap(), AgentKind::Opencode);
        assert!(parse_agent("bogus").is_err());
    }

    #[test]
    fn scope_str_matches_wire_values() {
        assert_eq!(scope_str(Scope::Project), "project");
        assert_eq!(scope_str(Scope::Global), "global");
    }
}
