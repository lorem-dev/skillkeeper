//! Claude adapter: the reference implementation, supporting BOTH skills and
//! hooks. Ported from `packages/agents/src/claude.ts`.
//!
//! - Skills live under `<base>/.claude/skills/<name>/`, where `<base>` is the
//!   project directory (project scope) or the user home directory (global
//!   scope).
//! - Hooks use the `json-merge` strategy into `<base>/.claude/settings.json`.
//! - External discovery lists skill directories under the skills root that
//!   directly contain `SKILL.md`.

use skillkeeper_core::ports::{FsPort, HostEnv, PortResult};

use crate::adapter::{AgentAdapter, HookCapability};
use crate::model::{AgentKind, AgentTarget, HookStrategy};
use crate::paths::{base_dir, discover_skill_dirs, join_path};

/// `<base>/.claude` for the given target.
fn claude_dir(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    Ok(join_path(&[&base_dir(target, env)?, ".claude"]))
}

/// `<base>/.claude/skills` for the given target.
fn skills_root(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    Ok(join_path(&[&claude_dir(target, env)?, "skills"]))
}

/// Build the Claude adapter.
pub fn claude_adapter() -> AgentAdapter {
    AgentAdapter::new(
        AgentKind::Claude,
        // Claude is usable when the user-level `.claude` directory exists.
        Box::new(|fs, env| fs.exists(&join_path(&[env.home_dir(), ".claude"]))),
        Box::new(|target, env| skills_root(target, env)),
        Box::new(|fs: &dyn FsPort, target, env| {
            // Prefer an existing top-level CLAUDE.md; otherwise the .claude/ one.
            let base = base_dir(target, env)?;
            let top = join_path(&[&base, "CLAUDE.md"]);
            if fs.exists(&top)? {
                return Ok(top);
            }
            Ok(join_path(&[&base, ".claude", "CLAUDE.md"]))
        }),
        Box::new(|fs, target, env| discover_skill_dirs(fs, &skills_root(target, env)?, None)),
        Some(HookCapability::new(
            HookStrategy::JsonMerge,
            None,
            None,
            Box::new(|target, env| Ok(join_path(&[&claude_dir(target, env)?, "settings.json"]))),
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_env::FakeEnv;
    use skillkeeper_core::ports::PortError;
    use skillkeeper_core::testing::MemFs;

    const HOME: &str = "/home/alice";
    const PROJECT: &str = "/work/my-project";

    fn env_with_project() -> FakeEnv {
        FakeEnv::new(HOME).with_var(crate::paths::PROJECT_DIR_ENV, PROJECT)
    }

    fn project_target() -> AgentTarget {
        AgentTarget::project(AgentKind::Claude, Some("p1"))
    }

    fn global_target() -> AgentTarget {
        AgentTarget::global(AgentKind::Claude)
    }

    #[test]
    fn identifies_as_the_claude_agent() {
        assert_eq!(claude_adapter().kind, AgentKind::Claude);
    }

    #[test]
    fn destination_root_project_scope() {
        let root = claude_adapter()
            .destination_root(&project_target(), &env_with_project())
            .unwrap();
        assert_eq!(root, format!("{PROJECT}/.claude/skills"));
    }

    #[test]
    fn destination_root_global_scope() {
        let root = claude_adapter()
            .destination_root(&global_target(), &env_with_project())
            .unwrap();
        assert_eq!(root, format!("{HOME}/.claude/skills"));
    }

    #[test]
    fn destination_root_rejects_project_scope_without_project_dir() {
        let env = FakeEnv::new(HOME);
        let err = claude_adapter()
            .destination_root(&project_target(), &env)
            .unwrap_err();
        assert!(matches!(err, PortError::Other(_)));
        assert!(err.to_string().to_lowercase().contains("project directory"));
    }

    #[test]
    fn hook_uses_json_merge_strategy() {
        let adapter = claude_adapter();
        assert_eq!(
            adapter.hook_support.as_ref().unwrap().strategy,
            HookStrategy::JsonMerge
        );
    }

    #[test]
    fn hook_resolves_project_settings_json() {
        let adapter = claude_adapter();
        let file = adapter
            .hook_support
            .as_ref()
            .unwrap()
            .resolve_target_file(&project_target(), &env_with_project())
            .unwrap();
        assert_eq!(file, format!("{PROJECT}/.claude/settings.json"));
    }

    #[test]
    fn hook_resolves_global_settings_json() {
        let adapter = claude_adapter();
        let file = adapter
            .hook_support
            .as_ref()
            .unwrap()
            .resolve_target_file(&global_target(), &env_with_project())
            .unwrap();
        assert_eq!(file, format!("{HOME}/.claude/settings.json"));
    }

    #[test]
    fn is_available_true_when_claude_dir_exists() {
        let fs = MemFs::new().with_file(&format!("{HOME}/.claude/settings.json"), "{}");
        assert!(claude_adapter()
            .is_available(&fs, &env_with_project())
            .unwrap());
    }

    #[test]
    fn is_available_false_when_claude_dir_absent() {
        let fs = MemFs::new();
        assert!(!claude_adapter()
            .is_available(&fs, &env_with_project())
            .unwrap());
    }

    #[test]
    fn guidance_file_prefers_existing_top_level() {
        let fs = MemFs::new().with_file(&format!("{PROJECT}/CLAUDE.md"), "# top");
        let file = claude_adapter()
            .guidance_file(&fs, &project_target(), &env_with_project())
            .unwrap();
        assert_eq!(file, format!("{PROJECT}/CLAUDE.md"));
    }

    #[test]
    fn guidance_file_falls_back_to_dot_claude() {
        let fs = MemFs::new();
        let file = claude_adapter()
            .guidance_file(&fs, &project_target(), &env_with_project())
            .unwrap();
        assert_eq!(file, format!("{PROJECT}/.claude/CLAUDE.md"));
    }

    #[test]
    fn discover_installed_finds_skill_dirs_with_skill_md() {
        let fs = MemFs::new()
            .with_file(
                &format!("{PROJECT}/.claude/skills/external-skill/SKILL.md"),
                "# external",
            )
            .with_file(
                &format!("{PROJECT}/.claude/skills/external-skill/run.sh"),
                "echo hi",
            )
            .with_file(
                &format!("{PROJECT}/.claude/skills/another/SKILL.md"),
                "# another",
            );
        let found = claude_adapter()
            .discover_installed(&fs, &project_target(), &env_with_project())
            .unwrap();
        let mut names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, ["another", "external-skill"]);
        let ext = found.iter().find(|s| s.name == "external-skill").unwrap();
        assert_eq!(ext.path, format!("{PROJECT}/.claude/skills/external-skill"));
        assert_eq!(ext.group, None);
    }

    #[test]
    fn discover_installed_ignores_dirs_without_skill_md() {
        let fs = MemFs::new()
            .with_file(&format!("{PROJECT}/.claude/skills/real/SKILL.md"), "# real")
            .with_file(
                &format!("{PROJECT}/.claude/skills/not-a-skill/notes.txt"),
                "hello",
            );
        let found = claude_adapter()
            .discover_installed(&fs, &project_target(), &env_with_project())
            .unwrap();
        let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["real"]);
    }

    #[test]
    fn discover_installed_empty_when_skills_dir_missing() {
        let fs = MemFs::new();
        let found = claude_adapter()
            .discover_installed(&fs, &global_target(), &env_with_project())
            .unwrap();
        assert!(found.is_empty());
    }
}
