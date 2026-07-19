//! Domain types the agent adapters need.
//!
//! The shared domain types (`AgentKind`, `HookStrategy`, `Scope`,
//! `AgentTarget`) live in `skillkeeper-core` and are re-exported here so the
//! adapters and their consumers keep using the `crate::model::` paths. Only the
//! agents-specific [`DiscoveredSkill`] is defined locally.

pub use skillkeeper_core::models::{AgentKind, AgentTarget, HookStrategy, Scope};

/// A skill discovered in an agent location that SkillKeeper did not install.
/// Mirrors the TS `DiscoveredSkill`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSkill {
    /// Skill directory name (the immediate folder under the skills root).
    pub name: String,
    /// Absolute path to the discovered skill directory.
    pub path: String,
    /// Group folder name when the agent nests skills one level, if any.
    pub group: Option<String>,
}
