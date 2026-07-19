//! Cursor adapter. Ported from `packages/agents/src/cursor.ts`.
//!
//! - Skills: project `<project>/.cursor/skills/<name>/`, global
//!   `~/.cursor/skills/<name>/`.
//! - Hooks: `json-merge` into `<base>/.cursor/settings.json` under `hooks`.

use skillkeeper_core::ports::{HostEnv, PortResult};

use crate::adapter::{make_adapter, AdapterSpec, AgentAdapter, HookCapability};
use crate::model::{AgentKind, AgentTarget, HookStrategy};
use crate::paths::{base_dir, join_path};

fn cursor_dir(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    Ok(join_path(&[&base_dir(target, env)?, ".cursor"]))
}

/// Build the Cursor adapter.
pub fn cursor_adapter() -> AgentAdapter {
    make_adapter(AdapterSpec {
        kind: AgentKind::Cursor,
        skills_root: Box::new(|target, env| Ok(join_path(&[&cursor_dir(target, env)?, "skills"]))),
        availability_dir: Box::new(|env| join_path(&[env.home_dir(), ".cursor"])),
        discovery_group: None,
        guidance_file: Box::new(|fs, target, env| {
            // Prefer an existing legacy .cursorrules; otherwise the modern rules file.
            let base = base_dir(target, env)?;
            let legacy = join_path(&[&base, ".cursorrules"]);
            if fs.exists(&legacy)? {
                return Ok(legacy);
            }
            Ok(join_path(&[&base, ".cursor", "rules", "skillkeeper.mdc"]))
        }),
        hook: HookCapability::new(
            HookStrategy::JsonMerge,
            None,
            None,
            Box::new(|target, env| Ok(join_path(&[&cursor_dir(target, env)?, "settings.json"]))),
        ),
    })
}
