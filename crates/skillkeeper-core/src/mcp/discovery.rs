//! Which directories of a checked-out repository may hold an `mcp.yml`.
//!
//! A preset file sits either at the repository root (no group) or in a group
//! directory, where the directory's path relative to the root becomes the
//! preset's group. Group directories are derived from the skills that actually
//! resolved: a directory only counts as a group when it leads to a real skill,
//! so a stray `mcp.yml` in an unrelated tree contributes nothing.
//!
//! Both front ends need the same answer and previously each derived it from
//! `root_path`'s first segment, which capped presets at one group level.

use crate::models::ResolvedSkill;
use crate::skills::group_path;

/// The repository-relative directories that may hold a group-scoped `mcp.yml`:
/// every ancestor directory of every resolved skill, deduplicated.
///
/// Ordered shallowest first, then alphabetically, so both front ends list
/// presets in the same stable order. The repository root is NOT included --
/// callers read it separately, because a root preset carries no group at all.
pub fn preset_group_dirs(skills: &[ResolvedSkill]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for skill in skills {
        for dir in group_path::ancestors(&skill.root_path) {
            if !out.contains(&dir) {
                out.push(dir);
            }
        }
    }
    out.sort_by(|a, b| {
        group_path::depth(a)
            .cmp(&group_path::depth(b))
            .then_with(|| a.cmp(b))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SkillId, SkillManifest};

    /// A resolved skill at `root_path`. Only `root_path` matters here; the rest
    /// is the minimum the struct requires.
    fn skill(root_path: &str) -> ResolvedSkill {
        ResolvedSkill {
            id: SkillId {
                group: None,
                name: "x".to_string(),
            },
            root_path: root_path.to_string(),
            manifest: SkillManifest {
                name: "x".to_string(),
                version: None,
                description: None,
                license: None,
                executables: None,
                hooks: None,
            },
            files: Vec::new(),
            hooks: Vec::new(),
        }
    }

    #[test]
    fn a_repository_of_flat_skills_has_no_group_dirs() {
        assert!(preset_group_dirs(&[skill("one"), skill("two")]).is_empty());
    }

    #[test]
    fn lists_every_ancestor_of_every_skill_shallowest_first() {
        let dirs = preset_group_dirs(&[skill("a/b/c/deep"), skill("z/flat")]);

        assert_eq!(dirs, vec!["a", "z", "a/b", "a/b/c"]);
    }

    #[test]
    fn deduplicates_a_directory_shared_by_two_skills() {
        let dirs = preset_group_dirs(&[skill("a/b/one"), skill("a/b/two"), skill("a/three")]);

        assert_eq!(dirs, vec!["a", "a/b"]);
    }
}
