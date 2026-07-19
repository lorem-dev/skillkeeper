//! Skill resolution from a checked-out working tree (Rust port of
//! `packages/core/src/skills/resolver.ts`).
//!
//! Three schemes are supported, in precedence order:
//!
//! 1. **repo-config** (`skillkeeper.repo.yaml` at the repo root is
//!    authoritative): explicit skill list, or auto-detection filtered by
//!    include/exclude globs.
//! 2. **flat** (scheme 1): a directory at depth 1 directly containing
//!    `SKILL.md`.
//! 3. **grouped** (scheme 2): a directory at depth 2 directly containing
//!    `SKILL.md`, whose parent becomes the skill group.
//!
//! A directory is a skill if and only if it directly contains `SKILL.md`; the
//! `hooks/` subdirectory is reserved and never scanned for skill bodies. A
//! `SKILL.md` nested deeper than depth 2 (and not declared in config) yields an
//! unresolved-path warning.
//!
//! The TypeScript resolver parses manifests via a zod-backed `manifest.ts`
//! helper. That module is not yet ported; this port parses `SKILL.md`/`HOOK.md`
//! frontmatter through the existing [`crate::frontmatter`] module and
//! deserializes into the existing [`SkillManifest`]/[`HookManifest`] models.
//! The `matchesAny` glob matcher is the shared [`crate::glob`] helper, also used
//! by the install engine.

use serde_yaml_ng::Value;

use crate::frontmatter::split_frontmatter;
use crate::glob::matches_any;
use crate::models::{
    HookManifest, ResolveResult, ResolvedHook, ResolvedSkill, SkillId, SkillManifest,
};
use crate::ports::{FsPort, PortResult};
use crate::skills::repo_config::parse_repo_config;

const SKILL_FILE: &str = "SKILL.md";
const HOOK_FILE: &str = "HOOK.md";
const HOOKS_DIR: &str = "hooks";
const REPO_CONFIG: &str = "skillkeeper.repo.yaml";

/// Directories that hold a direct `SKILL.md`, plus those nested too deep.
struct SkillDirs {
    dirs: Vec<String>,
    too_deep: Vec<String>,
}

/// Recursively list every file path under `rel` (relative to `repo_root`),
/// returning paths relative to `repo_root`. Directories themselves are not
/// returned.
fn list_files_rec(fs: &dyn FsPort, repo_root: &str, rel: &str) -> PortResult<Vec<String>> {
    let mut out = Vec::new();
    let abs = if rel.is_empty() {
        repo_root.to_string()
    } else {
        format!("{repo_root}/{rel}")
    };
    for entry in fs.list(&abs)? {
        let child_rel = if rel.is_empty() {
            entry.clone()
        } else {
            format!("{rel}/{entry}")
        };
        let stat = fs.stat(&format!("{repo_root}/{child_rel}"))?;
        match stat {
            Some(s) if s.is_directory => out.extend(list_files_rec(fs, repo_root, &child_rel)?),
            Some(s) if s.is_file => out.push(child_rel),
            _ => {}
        }
    }
    Ok(out)
}

/// Walk the tree collecting directories that directly contain `SKILL.md`,
/// separating those within `max_depth` from those nested too deep.
fn find_skill_dirs(fs: &dyn FsPort, repo_root: &str, max_depth: usize) -> SkillDirs {
    let mut acc = SkillDirs {
        dirs: Vec::new(),
        too_deep: Vec::new(),
    };
    walk(fs, repo_root, "", 0, max_depth, &mut acc);
    acc
}

fn walk(
    fs: &dyn FsPort,
    repo_root: &str,
    rel: &str,
    depth: usize,
    max_depth: usize,
    acc: &mut SkillDirs,
) {
    let abs = if rel.is_empty() {
        repo_root.to_string()
    } else {
        format!("{repo_root}/{rel}")
    };
    let entries = match fs.list(&abs) {
        Ok(e) => e,
        Err(_) => return,
    };
    // A directory directly containing SKILL.md is a skill (unless it is a
    // reserved hooks directory, handled by the caller skipping descent).
    if entries.iter().any(|e| e == SKILL_FILE) {
        if depth >= 1 && depth <= max_depth {
            acc.dirs.push(rel.to_string());
        } else if depth > max_depth {
            acc.too_deep.push(rel.to_string());
        }
        // Do not descend into a skill's own subtree looking for more skills.
        return;
    }
    for entry in entries {
        let child_rel = if rel.is_empty() {
            entry.clone()
        } else {
            format!("{rel}/{entry}")
        };
        let stat = fs.stat(&format!("{repo_root}/{child_rel}")).ok().flatten();
        if let Some(s) = stat {
            if s.is_directory {
                // hooks/ is reserved and never scanned for skill bodies.
                if entry == HOOKS_DIR {
                    continue;
                }
                walk(fs, repo_root, &child_rel, depth + 1, max_depth, acc);
            }
        }
    }
}

/// Build the [`SkillId`] for an auto-detected skill directory.
fn auto_skill_id(root_path: &str) -> SkillId {
    let parts: Vec<&str> = root_path.split('/').collect();
    if parts.len() == 2 {
        SkillId {
            group: Some(parts[0].to_string()),
            name: parts[1].to_string(),
        }
    } else {
        SkillId {
            group: None,
            name: parts[0].to_string(),
        }
    }
}

/// Extract the frontmatter data for a manifest, defaulting an absent block to
/// an empty mapping (mirroring the TypeScript `data ?? {}`).
fn manifest_data(md: &str) -> Result<Value, String> {
    let fm = split_frontmatter(md).map_err(|e| e.to_string())?;
    Ok(fm
        .data
        .unwrap_or_else(|| Value::Mapping(Default::default())))
}

/// Parse `SKILL.md` frontmatter into a [`SkillManifest`].
fn parse_skill_manifest(md: &str) -> Result<SkillManifest, String> {
    let manifest: SkillManifest =
        serde_yaml_ng::from_value(manifest_data(md)?).map_err(|e| e.to_string())?;
    if manifest.name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    Ok(manifest)
}

/// Parse `HOOK.md` frontmatter into a [`HookManifest`].
fn parse_hook_manifest(md: &str) -> Result<HookManifest, String> {
    let manifest: HookManifest =
        serde_yaml_ng::from_value(manifest_data(md)?).map_err(|e| e.to_string())?;
    if manifest.name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    Ok(manifest)
}

/// Resolve the hooks declared under a skill's `hooks/` directory.
fn resolve_hooks(
    fs: &dyn FsPort,
    repo_root: &str,
    skill_root: &str,
    warnings: &mut Vec<String>,
) -> PortResult<Vec<ResolvedHook>> {
    let hooks_rel = format!("{skill_root}/{HOOKS_DIR}");
    if !fs.exists(&format!("{repo_root}/{hooks_rel}"))? {
        return Ok(Vec::new());
    }
    let all_files = list_files_rec(fs, repo_root, &hooks_rel)?;
    let hook_suffix = format!("/{HOOK_FILE}");
    let manifest_paths: Vec<String> = all_files
        .iter()
        .filter(|f| f.ends_with(&hook_suffix))
        .cloned()
        .collect();
    let mut hooks = Vec::new();

    for manifest_path in manifest_paths {
        // The hook owns its directory subtree: the directory of the HOOK.md.
        let hook_dir = &manifest_path[..manifest_path.len() - HOOK_FILE.len() - 1];
        let text = fs.read_file(&format!("{repo_root}/{manifest_path}"))?;
        let manifest = match parse_hook_manifest(&text) {
            Ok(m) => m,
            Err(e) => {
                warnings.push(format!("Skipping invalid {manifest_path}: {e}"));
                continue;
            }
        };
        let dir_prefix = format!("{hook_dir}/");
        let mut files: Vec<String> = all_files
            .iter()
            .filter(|f| **f == manifest_path || f.starts_with(&dir_prefix))
            .cloned()
            .collect();
        files.sort();
        hooks.push(ResolvedHook {
            manifest,
            manifest_path,
            files,
        });
    }
    Ok(hooks)
}

/// Build a [`ResolvedSkill`] from a directory known to contain `SKILL.md`.
/// Returns `Ok(None)` (with a warning appended) when the manifest is invalid.
fn build_skill(
    fs: &dyn FsPort,
    repo_root: &str,
    root_path: &str,
    id: SkillId,
    warnings: &mut Vec<String>,
) -> PortResult<Option<ResolvedSkill>> {
    let manifest = match fs
        .read_file(&format!("{repo_root}/{root_path}/{SKILL_FILE}"))
        .map_err(|e| e.to_string())
        .and_then(|text| parse_skill_manifest(&text))
    {
        Ok(m) => m,
        Err(e) => {
            warnings.push(format!("Skipping invalid {root_path}/{SKILL_FILE}: {e}"));
            return Ok(None);
        }
    };
    let all = list_files_rec(fs, repo_root, root_path)?;
    let hooks_prefix = format!("{root_path}/{HOOKS_DIR}/");
    let mut body: Vec<String> = all
        .into_iter()
        .filter(|f| !f.starts_with(&hooks_prefix))
        .collect();
    body.sort();
    let hooks = resolve_hooks(fs, repo_root, root_path, warnings)?;
    Ok(Some(ResolvedSkill {
        id,
        root_path: root_path.to_string(),
        manifest,
        files: body,
        hooks,
    }))
}

/// Resolve skills declared or auto-detected under `skillkeeper.repo.yaml`
/// (scheme 3).
fn resolve_from_config(
    fs: &dyn FsPort,
    repo_root: &str,
    config_text: &str,
    warnings: &mut Vec<String>,
) -> Vec<ResolvedSkill> {
    let config = match parse_repo_config(config_text) {
        Ok(c) => c,
        Err(err) => {
            warnings.push(format!("Ignoring {REPO_CONFIG}: {}", err.message));
            return Vec::new();
        }
    };

    let mut skills = Vec::new();
    let default_group = config.defaults.as_ref().and_then(|d| d.group.clone());

    if let Some(entries) = config.skills.as_ref().filter(|s| !s.is_empty()) {
        for entry in entries {
            let skill_md = format!("{repo_root}/{}/{SKILL_FILE}", entry.path);
            if !fs.exists(&skill_md).unwrap_or(false) {
                warnings.push(format!(
                    "Declared skill path \"{}\" has no {SKILL_FILE}",
                    entry.path
                ));
                continue;
            }
            let placeholder = SkillId {
                group: None,
                name: "placeholder".to_string(),
            };
            let base = match build_skill(fs, repo_root, &entry.path, placeholder, warnings) {
                Ok(Some(b)) => b,
                _ => continue,
            };
            let group = entry.group.clone().or_else(|| default_group.clone());
            let name = entry
                .name
                .clone()
                .unwrap_or_else(|| base.manifest.name.clone());
            let id = SkillId { group, name };
            skills.push(ResolvedSkill { id, ..base });
        }
        return skills;
    }

    // No explicit list: auto-detect, then apply include/exclude filters.
    let SkillDirs { dirs, .. } = find_skill_dirs(fs, repo_root, 2);
    for dir in dirs {
        if let Some(include) = config.include.as_ref() {
            if !matches_any(&dir, include) {
                continue;
            }
        }
        if let Some(exclude) = config.exclude.as_ref() {
            if matches_any(&dir, exclude) {
                continue;
            }
        }
        let base = match build_skill(fs, repo_root, &dir, auto_skill_id(&dir), warnings) {
            Ok(Some(b)) => b,
            _ => continue,
        };
        let group = base.id.group.clone().or_else(|| default_group.clone());
        let id = SkillId {
            group,
            name: base.id.name.clone(),
        };
        skills.push(ResolvedSkill { id, ..base });
    }
    skills
}

/// Resolve all skills in a checked-out repository working tree.
///
/// Precedence: if `skillkeeper.repo.yaml` is present at the repo root it is
/// authoritative (scheme 3). Otherwise skills are auto-detected by locating
/// `SKILL.md` at depth 1 (scheme 1, flat) or depth 2 (scheme 2, grouped).
pub fn resolve_skills(fs: &dyn FsPort, repo_root: &str) -> ResolveResult {
    let mut warnings: Vec<String> = Vec::new();

    let config_path = format!("{repo_root}/{REPO_CONFIG}");
    if fs.exists(&config_path).unwrap_or(false) {
        let text = fs.read_file(&config_path).unwrap_or_default();
        let skills = resolve_from_config(fs, repo_root, &text, &mut warnings);
        return ResolveResult { skills, warnings };
    }

    let SkillDirs { dirs, too_deep } = find_skill_dirs(fs, repo_root, 2);
    let mut skills = Vec::new();
    for dir in dirs {
        if let Ok(Some(skill)) =
            build_skill(fs, repo_root, &dir, auto_skill_id(&dir), &mut warnings)
        {
            skills.push(skill);
        }
    }
    for deep in too_deep {
        warnings.push(format!(
            "Unresolved {SKILL_FILE} at \"{deep}\": nesting is deeper than a single group; \
             declare it in {REPO_CONFIG} to install it."
        ));
    }
    ResolveResult { skills, warnings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MemFs;

    fn skill_md(name: &str) -> String {
        format!("---\nname: {name}\n---\n# {name}\n")
    }

    fn hook_md(name: &str) -> String {
        hook_md_agent(name, "codex")
    }

    fn hook_md_agent(name: &str, agent: &str) -> String {
        format!(
            "---\nname: {name}\nstrategy: delimited-text\ntarget:\n  agent: {agent}\n  filePattern: AGENTS.md\n---\n"
        )
    }

    // --- scheme 1 (flat) ---

    #[test]
    fn resolves_a_flat_skill_with_body_files_and_one_hook() {
        let fs = MemFs::new()
            .with_file("repo/mySkill/SKILL.md", &skill_md("mySkill"))
            .with_file("repo/mySkill/run.sh", "#!/bin/sh\n")
            .with_file("repo/mySkill/lib/util.js", "export {};\n")
            .with_file("repo/mySkill/hooks/HOOK.md", &hook_md("mySkill-hook"))
            .with_file("repo/mySkill/hooks/snippet.txt", "content\n");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.warnings, Vec::<String>::new());
        assert_eq!(result.skills.len(), 1);
        let skill = &result.skills[0];
        assert_eq!(
            skill.id,
            SkillId {
                group: None,
                name: "mySkill".to_string()
            }
        );
        assert_eq!(skill.root_path, "mySkill");
        assert_eq!(
            skill.files,
            vec![
                "mySkill/SKILL.md".to_string(),
                "mySkill/lib/util.js".to_string(),
                "mySkill/run.sh".to_string(),
            ]
        );
        assert_eq!(skill.hooks.len(), 1);
        let hook = &skill.hooks[0];
        assert_eq!(hook.manifest.name, "mySkill-hook");
        assert_eq!(hook.manifest_path, "mySkill/hooks/HOOK.md");
        assert_eq!(
            hook.files,
            vec![
                "mySkill/hooks/HOOK.md".to_string(),
                "mySkill/hooks/snippet.txt".to_string(),
            ]
        );
    }

    #[test]
    fn resolves_multiple_flat_skills() {
        let fs = MemFs::new()
            .with_file("repo/a/SKILL.md", &skill_md("a"))
            .with_file("repo/b/SKILL.md", &skill_md("b"));
        let result = resolve_skills(&fs, "repo");
        let mut names: Vec<String> = result.skills.iter().map(|s| s.id.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["a".to_string(), "b".to_string()]);
    }

    // --- scheme 2 (grouped) ---

    #[test]
    fn resolves_a_grouped_skill_with_the_group_set() {
        let fs = MemFs::new()
            .with_file("repo/group/mySkill/SKILL.md", &skill_md("mySkill"))
            .with_file("repo/group/mySkill/file.txt", "x\n");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.warnings, Vec::<String>::new());
        assert_eq!(result.skills.len(), 1);
        assert_eq!(
            result.skills[0].id,
            SkillId {
                group: Some("group".to_string()),
                name: "mySkill".to_string()
            }
        );
        assert_eq!(result.skills[0].root_path, "group/mySkill");
    }

    #[test]
    fn does_not_treat_a_group_directory_itself_as_a_skill() {
        let fs = MemFs::new()
            .with_file("repo/group/one/SKILL.md", &skill_md("one"))
            .with_file("repo/group/two/SKILL.md", &skill_md("two"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 2);
        assert!(result
            .skills
            .iter()
            .all(|s| s.id.group.as_deref() == Some("group")));
    }

    // --- scheme 3 (repo config) ---

    #[test]
    fn uses_explicit_skill_paths_overriding_auto_detection() {
        let fs = MemFs::new()
            .with_file(
                "repo/skillkeeper.repo.yaml",
                "version: 1\nskills:\n  - path: declared/here\n    name: explicit-name\n    group: g\n",
            )
            .with_file("repo/declared/here/SKILL.md", &skill_md("ignored-by-override"))
            .with_file("repo/declared/here/data.txt", "x\n")
            .with_file("repo/auto/SKILL.md", &skill_md("auto"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.warnings, Vec::<String>::new());
        assert_eq!(result.skills.len(), 1);
        assert_eq!(
            result.skills[0].id,
            SkillId {
                group: Some("g".to_string()),
                name: "explicit-name".to_string()
            }
        );
        assert_eq!(result.skills[0].root_path, "declared/here");
    }

    #[test]
    fn applies_the_default_group_and_falls_back_to_the_manifest_name() {
        let fs = MemFs::new()
            .with_file(
                "repo/skillkeeper.repo.yaml",
                "version: 1\ndefaults:\n  group: shared\nskills:\n  - path: x/y\n",
            )
            .with_file("repo/x/y/SKILL.md", &skill_md("manifest-name"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(
            result.skills[0].id,
            SkillId {
                group: Some("shared".to_string()),
                name: "manifest-name".to_string()
            }
        );
    }

    #[test]
    fn yields_a_group_less_id_when_neither_entry_nor_defaults_set_a_group() {
        let fs = MemFs::new()
            .with_file(
                "repo/skillkeeper.repo.yaml",
                "version: 1\nskills:\n  - path: x/y\n",
            )
            .with_file("repo/x/y/SKILL.md", &skill_md("plain"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(
            result.skills[0].id,
            SkillId {
                group: None,
                name: "plain".to_string()
            }
        );
    }

    #[test]
    fn applies_a_default_group_to_an_auto_detected_flat_skill_in_config_mode() {
        let fs = MemFs::new()
            .with_file(
                "repo/skillkeeper.repo.yaml",
                "version: 1\ndefaults:\n  group: shared\ninclude:\n  - \"solo/**\"\n",
            )
            .with_file("repo/solo/SKILL.md", &skill_md("solo"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(
            result.skills[0].id,
            SkillId {
                group: Some("shared".to_string()),
                name: "solo".to_string()
            }
        );
    }

    #[test]
    fn keeps_the_detected_group_for_grouped_skills_in_config_auto_detect_mode() {
        let fs = MemFs::new()
            .with_file(
                "repo/skillkeeper.repo.yaml",
                "version: 1\ninclude:\n  - \"g/**\"\n",
            )
            .with_file("repo/g/inner/SKILL.md", &skill_md("inner"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(
            result.skills[0].id,
            SkillId {
                group: Some("g".to_string()),
                name: "inner".to_string()
            }
        );
    }

    #[test]
    fn warns_when_a_declared_path_has_no_skill_md() {
        let fs = MemFs::new().with_file(
            "repo/skillkeeper.repo.yaml",
            "version: 1\nskills:\n  - path: missing/dir\n",
        );
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 0);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("missing/dir"));
    }

    #[test]
    fn reports_a_warning_when_the_repo_config_is_invalid() {
        let fs = MemFs::new().with_file("repo/skillkeeper.repo.yaml", "skills: []");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 0);
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("skillkeeper.repo.yaml")));
    }

    #[test]
    fn honors_include_and_exclude_globs_in_config_mode() {
        let fs = MemFs::new()
            .with_file(
                "repo/skillkeeper.repo.yaml",
                "version: 1\ninclude:\n  - \"keep/**\"\nexclude:\n  - \"keep/no/**\"\n",
            )
            .with_file("repo/keep/yes/SKILL.md", &skill_md("yes"))
            .with_file("repo/keep/no/SKILL.md", &skill_md("no"))
            .with_file("repo/drop/me/SKILL.md", &skill_md("dropped"));
        let result = resolve_skills(&fs, "repo");
        let names: Vec<String> = result.skills.iter().map(|s| s.id.name.clone()).collect();
        assert_eq!(names, vec!["yes".to_string()]);
    }

    // --- reserved hooks and depth warnings ---

    #[test]
    fn never_counts_files_under_hooks_as_skill_body_files() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s"))
            .with_file("repo/s/hooks/HOOK.md", &hook_md("h"))
            .with_file("repo/s/hooks/deep/nested.txt", "x\n");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills[0].files, vec!["s/SKILL.md".to_string()]);
        let mut hook_files = result.skills[0].hooks[0].files.clone();
        hook_files.sort();
        assert_eq!(
            hook_files,
            vec![
                "s/hooks/HOOK.md".to_string(),
                "s/hooks/deep/nested.txt".to_string(),
            ]
        );
    }

    #[test]
    fn does_not_treat_a_hooks_directory_as_a_skill_even_with_stray_skill_md() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s"))
            .with_file("repo/s/hooks/SKILL.md", &skill_md("should-not-resolve"))
            .with_file("repo/s/hooks/HOOK.md", &hook_md("h"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].id.name, "s");
    }

    #[test]
    fn emits_an_unresolved_path_warning_for_a_three_level_deep_skill_md() {
        let fs = MemFs::new().with_file("repo/group/sub/tooDeep/SKILL.md", &skill_md("tooDeep"));
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 0);
        assert_eq!(result.warnings.len(), 1);
        assert!(result.warnings[0].contains("group/sub/tooDeep"));
    }

    #[test]
    fn resolves_shallow_skills_while_warning_about_a_sibling_that_is_too_deep() {
        let fs = MemFs::new()
            .with_file("repo/ok/SKILL.md", &skill_md("ok"))
            .with_file("repo/a/b/c/SKILL.md", &skill_md("deep"));
        let result = resolve_skills(&fs, "repo");
        let names: Vec<String> = result.skills.iter().map(|s| s.id.name.clone()).collect();
        assert_eq!(names, vec!["ok".to_string()]);
        assert_eq!(result.warnings.len(), 1);
    }

    #[test]
    fn handles_an_invalid_skill_md_by_surfacing_a_warning_not_throwing() {
        let fs = MemFs::new().with_file("repo/bad/SKILL.md", "---\nversion: 1\n---\n");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 0);
        assert!(result.warnings.iter().any(|w| w.contains("bad/SKILL.md")));
    }

    #[test]
    fn skips_a_malformed_hook_md_with_a_warning_but_keeps_the_skill() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s"))
            .with_file("repo/s/hooks/HOOK.md", "---\nstrategy: nope\n---\n");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].hooks.len(), 0);
        assert!(result.warnings.iter().any(|w| w.contains("HOOK.md")));
    }

    #[test]
    fn returns_nothing_for_an_empty_repository() {
        let fs = MemFs::new().with_file("repo/.keep", "");
        let result = resolve_skills(&fs, "repo");
        assert_eq!(result.skills.len(), 0);
        assert_eq!(result.warnings, Vec::<String>::new());
    }

    #[test]
    fn returns_nothing_when_the_repo_root_does_not_exist() {
        let fs = MemFs::new().with_file("other/file.txt", "x");
        let result = resolve_skills(&fs, "does-not-exist");
        assert_eq!(result.skills.len(), 0);
        assert_eq!(result.warnings, Vec::<String>::new());
    }

    #[test]
    fn supports_multiple_named_hooks_under_hooks_name_hook_md() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s"))
            .with_file("repo/s/hooks/one/HOOK.md", &hook_md("one"))
            .with_file("repo/s/hooks/one/a.txt", "x\n")
            .with_file("repo/s/hooks/two/HOOK.md", &hook_md("two"));
        let result = resolve_skills(&fs, "repo");
        let hooks = &result.skills[0].hooks;
        let mut names: Vec<String> = hooks.iter().map(|h| h.manifest.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["one".to_string(), "two".to_string()]);
        let one = hooks.iter().find(|h| h.manifest.name == "one").unwrap();
        let mut one_files = one.files.clone();
        one_files.sort();
        assert_eq!(
            one_files,
            vec![
                "s/hooks/one/HOOK.md".to_string(),
                "s/hooks/one/a.txt".to_string(),
            ]
        );
    }

    #[test]
    fn resolves_a_hook_with_a_non_default_agent() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s"))
            .with_file(
                "repo/s/hooks/HOOK.md",
                &hook_md_agent("claude-hook", "claude"),
            );
        let result = resolve_skills(&fs, "repo");
        assert_eq!(
            result.skills[0].hooks[0].manifest.target.agent,
            crate::models::AgentKind::Claude
        );
    }
}
