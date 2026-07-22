//! SkillKeeper agent adapters (Rust port of `packages/agents`).
//!
//! Each adapter declares one AI coding agent's on-disk layout (skills root,
//! guidance file, availability directory) and its hook capability (strategy plus
//! a target-file resolver). The adapters are declarative and data-driven: when
//! an agent's real layout is confirmed, only that adapter's path/hook values
//! change, never the consumers.
//!
//! Unlike the TypeScript package -- where the adapters read the `FsPort` out of
//! the host environment via `fsOf(env)` -- the Rust adapters take `&dyn FsPort`
//! explicitly on every filesystem-backed method.

mod adapter;
mod claude;
mod codex;
mod copilot;
mod cursor;
mod detect;
mod model;
mod opencode;
mod paths;
mod registry;

#[cfg(test)]
mod test_env;

pub use adapter::{make_adapter, AdapterSpec, AgentAdapter, HookCapability};
pub use claude::claude_adapter;
pub use codex::codex_adapter;
pub use copilot::copilot_adapter;
pub use cursor::cursor_adapter;
pub use detect::detect_project_agents;
pub use model::{AgentKind, AgentTarget, DiscoveredSkill, HookStrategy, Scope};
pub use opencode::opencode_adapter;
pub use paths::{base_dir, discover_skill_dirs, join_path, require_project_dir, PROJECT_DIR_ENV};
pub use registry::{builtin_adapters, register_builtin_agents, AdapterRegistry};
