//! Shared helpers for the built-in agent adapters, ported from
//! `packages/agents/src/paths.ts`.
//!
//! In the TypeScript package the adapters read the [`FsPort`] out of the host
//! environment (`fsOf(env)`), because the core `AgentAdapter` interface keeps
//! its method signatures free of an explicit filesystem parameter. Rust has no
//! structural typing to smuggle the port through, so the port is passed
//! explicitly as `&dyn FsPort` to every filesystem-backed helper and adapter
//! method. This replaces the TS `fsOf` narrowing entirely.

use skillkeeper_core::ports::{FsPort, HostEnv, PortError, PortResult};

use crate::model::{AgentTarget, DiscoveredSkill, Scope};

/// Environment variable carrying the absolute path of the active project
/// directory. The CLI/desktop wiring sets it when operating on a project-scope
/// target, since [`AgentTarget`] only carries a `project_id`, not a path.
pub const PROJECT_DIR_ENV: &str = "SKILLKEEPER_PROJECT_DIR";

/// Join path segments with a single forward slash, trimming stray slashes.
///
/// Hand-rolled forward-slash join (NOT `std::path`), matching the TS
/// `joinPath`: the first segment keeps a leading slash but drops trailing
/// slashes; every other segment has leading and trailing slashes trimmed; empty
/// segments are dropped.
pub fn join_path(segments: &[&str]) -> String {
    segments
        .iter()
        .enumerate()
        .map(|(index, segment)| {
            if index == 0 {
                segment.trim_end_matches('/')
            } else {
                segment.trim_matches('/')
            }
        })
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

/// Resolve the project directory for a project-scope target from the host
/// environment. Returns an error when it is absent, so a project-scope
/// operation never silently falls back to a wrong location.
pub fn require_project_dir(env: &dyn HostEnv) -> PortResult<String> {
    match env.env(PROJECT_DIR_ENV) {
        Some(dir) if !dir.trim().is_empty() => Ok(dir),
        _ => Err(PortError::Other(format!(
            "No project directory available: set {PROJECT_DIR_ENV} for project-scope operations"
        ))),
    }
}

/// Resolve the base directory for a target: the project directory for project
/// scope, the home directory for global scope.
pub fn base_dir(target: &AgentTarget, env: &dyn HostEnv) -> PortResult<String> {
    match target.scope {
        Scope::Project => require_project_dir(env),
        Scope::Global => Ok(env.home_dir().to_string()),
    }
}

/// List immediate subdirectories of `skills_root` that directly contain a
/// `SKILL.md`. This is the on-disk view of installed skills; deciding which of
/// them SkillKeeper did not install (the "external" ones) is the core's job.
///
/// `group` is an optional group label attached to each discovered skill (used by
/// agents that nest skills one level under a group directory).
pub fn discover_skill_dirs(
    fs: &dyn FsPort,
    skills_root: &str,
    group: Option<&str>,
) -> PortResult<Vec<DiscoveredSkill>> {
    if !fs.exists(skills_root)? {
        return Ok(Vec::new());
    }
    let mut entries = fs.list(skills_root)?;
    entries.sort();
    let mut out = Vec::new();
    for name in entries {
        let dir = join_path(&[skills_root, &name]);
        let stat = fs.stat(&dir)?;
        if stat.map(|s| s.is_directory) != Some(true) {
            continue;
        }
        if !fs.exists(&join_path(&[&dir, "SKILL.md"]))? {
            continue;
        }
        out.push(DiscoveredSkill {
            name,
            path: dir,
            group: group.map(str::to_string),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AgentKind;
    use crate::test_env::FakeEnv;
    use skillkeeper_core::testing::MemFs;

    const HOME: &str = "/home/carol";

    #[test]
    fn join_path_joins_with_single_slashes_and_trims_stray_ones() {
        assert_eq!(join_path(&["/a/", "/b/", "c"]), "/a/b/c");
    }

    #[test]
    fn join_path_drops_empty_segments() {
        assert_eq!(join_path(&["/a", "", "b"]), "/a/b");
    }

    #[test]
    fn require_project_dir_returns_configured_directory() {
        let env = FakeEnv::new(HOME).with_var(PROJECT_DIR_ENV, "/work/x");
        assert_eq!(require_project_dir(&env).unwrap(), "/work/x");
    }

    #[test]
    fn require_project_dir_errors_when_missing() {
        let env = FakeEnv::new(HOME);
        let err = require_project_dir(&env).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("project directory"));
    }

    #[test]
    fn require_project_dir_errors_when_blank() {
        let env = FakeEnv::new(HOME).with_var(PROJECT_DIR_ENV, "   ");
        let err = require_project_dir(&env).unwrap_err();
        assert!(err.to_string().to_lowercase().contains("project directory"));
    }

    #[test]
    fn base_dir_uses_home_for_global_scope() {
        let env = FakeEnv::new(HOME);
        let target = AgentTarget::global(AgentKind::Claude);
        assert_eq!(base_dir(&target, &env).unwrap(), HOME);
    }

    #[test]
    fn base_dir_uses_project_dir_for_project_scope() {
        let env = FakeEnv::new(HOME).with_var(PROJECT_DIR_ENV, "/work/y");
        let target = AgentTarget::project(AgentKind::Claude, None);
        assert_eq!(base_dir(&target, &env).unwrap(), "/work/y");
    }

    #[test]
    fn discover_skill_dirs_skips_plain_files_under_root() {
        let fs = MemFs::new()
            .with_file("/root/skills/loose-file.txt", "not a skill dir")
            .with_file("/root/skills/good/SKILL.md", "# good");
        let found = discover_skill_dirs(&fs, "/root/skills", None).unwrap();
        let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["good"]);
    }

    #[test]
    fn discover_skill_dirs_attaches_group_label_when_given() {
        let fs = MemFs::new().with_file("/root/skills/alpha/SKILL.md", "# alpha");
        let found = discover_skill_dirs(&fs, "/root/skills", Some("team")).unwrap();
        assert_eq!(
            found,
            vec![DiscoveredSkill {
                name: "alpha".to_string(),
                path: "/root/skills/alpha".to_string(),
                group: Some("team".to_string()),
            }]
        );
    }

    #[test]
    fn discover_skill_dirs_returns_empty_when_root_missing() {
        let fs = MemFs::new();
        let found = discover_skill_dirs(&fs, "/nope", None).unwrap();
        assert!(found.is_empty());
    }
}
