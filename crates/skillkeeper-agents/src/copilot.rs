//! GitHub Copilot adapter. Ported from `packages/agents/src/copilot.ts`.
//!
//! - Skills: project `<project>/.github/copilot/skills/<name>/`, global
//!   `~/.config/github-copilot/skills/<name>/`.
//! - Hooks: `json-merge` into the Copilot config JSON (`hooks.json`) under
//!   `hooks`.

use skillkeeper_core::ports::{HostEnv, PortResult};

use crate::adapter::{make_adapter, AdapterSpec, AgentAdapter, HookCapability};
use crate::model::{AgentKind, AgentTarget, HookStrategy, Scope};
use crate::paths::{base_dir, join_path, require_project_dir};

/// Copilot's base config directory differs between project and global scope.
fn copilot_dir(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    match target.scope {
        Scope::Project => Ok(join_path(&[
            &require_project_dir(env)?,
            ".github",
            "copilot",
        ])),
        Scope::Global => Ok(join_path(&[env.home_dir(), ".config", "github-copilot"])),
    }
}

/// Build the Copilot adapter.
pub fn copilot_adapter() -> AgentAdapter {
    make_adapter(AdapterSpec {
        kind: AgentKind::Copilot,
        skills_root: Box::new(|target, env| Ok(join_path(&[&copilot_dir(target, env)?, "skills"]))),
        availability_dir: Box::new(|env| join_path(&[env.home_dir(), ".config", "github-copilot"])),
        discovery_group: None,
        guidance_file: Box::new(|_fs, target, env| {
            Ok(join_path(&[
                &base_dir(target, env)?,
                ".github",
                "copilot-instructions.md",
            ]))
        }),
        hook: HookCapability::new(
            HookStrategy::JsonMerge,
            None,
            None,
            Box::new(|target, env| Ok(join_path(&[&copilot_dir(target, env)?, "hooks.json"]))),
        ),
    })
}
