//! Codex adapter. Ported from `packages/agents/src/codex.ts`.
//!
//! - Skills: project `<project>/.codex/skills/<name>/`, global
//!   `~/.codex/skills/<name>/`.
//! - Hooks: `json-merge` into `<base>/.codex/settings.json` under `hooks`.

use skillkeeper_core::ports::{HostEnv, PortResult};

use crate::adapter::{make_adapter, AdapterSpec, AgentAdapter, HookCapability};
use crate::model::{AgentKind, AgentTarget, HookStrategy};
use crate::paths::{base_dir, join_path};

fn codex_dir(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    Ok(join_path(&[&base_dir(target, env)?, ".codex"]))
}

/// Build the Codex adapter.
pub fn codex_adapter() -> AgentAdapter {
    make_adapter(AdapterSpec {
        kind: AgentKind::Codex,
        skills_root: Box::new(|target, env| Ok(join_path(&[&codex_dir(target, env)?, "skills"]))),
        availability_dir: Box::new(|env| join_path(&[env.home_dir(), ".codex"])),
        discovery_group: None,
        guidance_file: Box::new(|_fs, target, env| {
            Ok(join_path(&[&base_dir(target, env)?, "AGENTS.md"]))
        }),
        hook: HookCapability::new(
            HookStrategy::JsonMerge,
            None,
            None,
            Box::new(|target, env| Ok(join_path(&[&codex_dir(target, env)?, "settings.json"]))),
        ),
    })
}
