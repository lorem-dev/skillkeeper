//! OpenCode adapter. Ported from `packages/agents/src/opencode.ts`.
//!
//! - Skills: project `<project>/.opencode/skills/<name>/`, global
//!   `~/.config/opencode/skills/<name>/`.
//! - Hooks: `delimited-text` into `opencode.json`. OpenCode's config is a
//!   comment-capable format, so an owned, comment-delimited region (comment
//!   token `#`) is inserted rather than merging JSON.

use skillkeeper_core::ports::{HostEnv, PortResult};

use crate::adapter::{make_adapter, AdapterSpec, AgentAdapter, HookCapability};
use crate::model::{AgentKind, AgentTarget, HookStrategy, Scope};
use crate::paths::{base_dir, join_path, require_project_dir};

/// OpenCode's base config directory differs between project and global scope.
fn opencode_dir(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    match target.scope {
        Scope::Project => Ok(join_path(&[&require_project_dir(env)?, ".opencode"])),
        Scope::Global => Ok(join_path(&[env.home_dir(), ".config", "opencode"])),
    }
}

/// Build the OpenCode adapter.
pub fn opencode_adapter() -> AgentAdapter {
    make_adapter(AdapterSpec {
        kind: AgentKind::Opencode,
        skills_root: Box::new(|target, env| {
            Ok(join_path(&[&opencode_dir(target, env)?, "skills"]))
        }),
        availability_dir: Box::new(|env| join_path(&[env.home_dir(), ".config", "opencode"])),
        discovery_group: None,
        guidance_file: Box::new(|_fs, target, env| {
            Ok(join_path(&[&base_dir(target, env)?, "AGENTS.md"]))
        }),
        hook: HookCapability::new(
            HookStrategy::DelimitedText,
            Some("#".to_string()),
            None,
            Box::new(|target, env| Ok(join_path(&[&opencode_dir(target, env)?, "opencode.json"]))),
        ),
    })
}
