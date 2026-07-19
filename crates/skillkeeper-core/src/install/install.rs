//! Install/uninstall engine (Rust port of
//! `packages/core/src/install/install.ts`).
//!
//! Copy a resolved skill's body into an agent destination, apply its hook edits
//! (delimited-text via [`crate::hooks::region`], json-merge via
//! [`crate::hooks::json`], or hook-owned standalone files), set executable bits,
//! compute content hashes, and produce an [`InstallManifest`].
//!
//! Divergences from the TypeScript source, which took the `fs`, `adapter`,
//! `env`, and `now` dependencies through its `InstallOptions`:
//!
//! - The engine must not depend on the `skillkeeper-agents` crate, so the
//!   adapter-resolved values are passed in directly: the destination root as a
//!   string argument and the hook capability as [`HookSupport`] (the adapter's
//!   `HookCapability` with its `resolveTargetFile` already resolved to a single
//!   `target_file`, exactly the injectable shape the TS `applyHook` consumes).
//! - The injectable clock is passed as an epoch-millis argument (`now_ms`),
//!   matching the [`crate::ports::Clock`] shape, and formatted to an ISO-8601
//!   timestamp via the shared [`crate::time::iso_from_millis`] helper (no
//!   date-library dependency).
//! - The tiny glob matcher (`matchesAny` from `kernel/glob.ts`) is the shared
//!   [`crate::glob`] helper, also used by `skills::resolver`.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::glob::matches_any;
use crate::hashing::{content_hash, hash_tree, sha256, HashEntry, SKID_FILE};
use crate::hooks::json::{
    canonical_json, encapsulate_foreign_markers, merge_hook_node, remove_hook_node, MergeOptions,
    MARKER_FIELD,
};
use crate::hooks::region::{
    encapsulate_foreign_delimiters, insert_region, remove_region, wrap_region, InsertMode,
    WrapRegionOptions,
};
use crate::models::{
    HookStrategy, InstallManifest, InstallOptions, ManagedFile, ManagedHookEdit, ResolvedHook,
    SkillId,
};
use crate::ports::{FsPort, PortError, PortResult};
use crate::skills::skid::{serialize_skid, SkidFile, SKID_SCHEMA};
use crate::time::iso_from_millis;

/// The adapter-resolved hook capability for a target (port of the data fields of
/// `HookCapability` from `packages/core/src/adapters/adapter.ts`, with the
/// `resolveTargetFile(target, env)` callback already resolved to `target_file`).
#[derive(Debug, Clone)]
pub struct HookSupport {
    pub strategy: HookStrategy,
    /// The config file a hook edits (used by delimited-text and json-merge).
    pub target_file: String,
    /// Comment token for the `delimited-text` strategy (defaults to `#`).
    pub comment_token: Option<String>,
    /// Closing comment token for languages that need one (for example `-->`).
    pub comment_close: Option<String>,
}

/// Short, stable label from a hook's identity: `<group>/<name>:<hookName>` (or
/// `<name>:<hookName>` when the skill has no group).
fn hook_label(id: &SkillId, hook_name: &str) -> String {
    let prefix = match &id.group {
        None => id.name.clone(),
        Some(group) => format!("{group}/{}", id.name),
    };
    format!("{prefix}:{hook_name}")
}

/// Short, stable id derived from a hook's full label (first 12 hex digits).
fn hook_id(id: &SkillId, hook_name: &str) -> String {
    sha256(&hook_label(id, hook_name))[..12].to_string()
}

/// The payload file a hook ships (first non-`HOOK.md` file), if any.
fn hook_payload_path(hook: &ResolvedHook) -> Option<&str> {
    hook.files
        .iter()
        .map(String::as_str)
        .find(|f| *f != hook.manifest_path)
}

/// Strip a single trailing newline, mirroring `raw.replace(/\n$/, '')`.
fn strip_trailing_newline(raw: &str) -> &str {
    raw.strip_suffix('\n').unwrap_or(raw)
}

/// Copy body files into the destination, returning recorded [`ManagedFile`]s.
fn copy_body(
    fs: &dyn FsPort,
    opts: &InstallOptions,
    dest_root: &str,
) -> PortResult<Vec<ManagedFile>> {
    let skill = &opts.skill;
    let skill_dir_name = &skill.id.name;
    let declared: HashSet<&str> = skill
        .manifest
        .executables
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(String::as_str)
        .collect();
    let prefix_len = skill.root_path.len() + 1;

    // Any `.skid.yml` in the source is dropped from the body; install_skill
    // writes its own authoritative identity file afterwards.
    let body: Vec<&String> = skill
        .files
        .iter()
        .filter(|rel| &rel[prefix_len..] != SKID_FILE)
        .collect();

    for rel in &body {
        let within = &rel[prefix_len..];
        let dest_rel = format!("{skill_dir_name}/{within}");
        let content = fs.read_file(&format!("{}/{rel}", opts.source_root))?;
        fs.write_file(&format!("{dest_root}/{dest_rel}"), &content)?;
        if declared.contains(within) || matches_any(within, &opts.executable_globs) {
            fs.chmod(&format!("{dest_root}/{dest_rel}"), true)?;
        }
    }

    let dest_rel_paths: Vec<String> = body
        .iter()
        .map(|rel| format!("{skill_dir_name}/{}", &rel[prefix_len..]))
        .collect();
    let refs: Vec<&str> = dest_rel_paths.iter().map(String::as_str).collect();
    hash_tree(fs, dest_root, &refs)
}

/// Apply one hook edit, returning the recorded [`ManagedHookEdit`], or `None`.
fn apply_hook(
    fs: &dyn FsPort,
    opts: &InstallOptions,
    dest_root: &str,
    hook: &ResolvedHook,
    support: &HookSupport,
) -> PortResult<Option<ManagedHookEdit>> {
    let skill = &opts.skill;
    let payload_path = hook_payload_path(hook);
    let id = hook_id(&skill.id, &hook.manifest.name);
    let label = hook_label(&skill.id, &hook.manifest.name);

    match support.strategy {
        HookStrategy::DelimitedText => {
            let target_file = &support.target_file;
            let raw = match payload_path {
                None => String::new(),
                Some(p) => fs.read_file(&format!("{}/{p}", opts.source_root))?,
            };
            let content = encapsulate_foreign_delimiters(strip_trailing_newline(&raw));
            let block = wrap_region(&WrapRegionOptions {
                comment_token: support
                    .comment_token
                    .clone()
                    .unwrap_or_else(|| "#".to_string()),
                comment_close: support.comment_close.clone(),
                delimiter_id: id.clone(),
                label,
                version: hook.manifest.version.clone(),
                content,
            });
            let existing = if fs.exists(target_file)? {
                fs.read_file(target_file)?
            } else {
                String::new()
            };
            let next = insert_region(&existing, &block, InsertMode::Append);
            fs.write_file(target_file, &next)?;
            Ok(Some(ManagedHookEdit::Delimited {
                file: target_file.clone(),
                delimiter_id: id,
                sha256: sha256(&block),
            }))
        }
        HookStrategy::JsonMerge => {
            let target_file = &support.target_file;
            let key_path = hook
                .manifest
                .target
                .key_path
                .clone()
                .unwrap_or_else(|| "hooks".to_string());
            let raw_node = match payload_path {
                None => "{}".to_string(),
                Some(p) => fs.read_file(&format!("{}/{p}", opts.source_root))?,
            };
            let parsed: Value = serde_json::from_str(&encapsulate_foreign_markers(&raw_node))
                .map_err(|e| PortError::Other(e.to_string()))?;
            let node = parsed.as_object().cloned().unwrap_or_default();
            let existing = if fs.exists(target_file)? {
                fs.read_file(target_file)?
            } else {
                "{}".to_string()
            };
            let next = merge_hook_node(
                &existing,
                &key_path,
                node.clone(),
                &MergeOptions {
                    marker_id: id.clone(),
                    label: label.clone(),
                },
            )
            .map_err(|e| PortError::Other(e.to_string()))?;
            fs.write_file(target_file, &next)?;
            // Hash the canonical owned node (marker included) so verify can
            // recompute it from the file and detect manual edits.
            let mut owned = node;
            owned.insert(
                MARKER_FIELD.to_string(),
                json!({ "id": id, "label": label }),
            );
            let node_hash = sha256(&canonical_json(&Value::Object(owned)));
            Ok(Some(ManagedHookEdit::Json {
                file: target_file.clone(),
                key_path,
                marker_id: id,
                sha256: node_hash,
            }))
        }
        HookStrategy::File => {
            // Copy the payload as a hook-owned standalone file.
            let Some(payload_path) = payload_path else {
                return Ok(None);
            };
            let hooks_prefix = format!("{}/hooks/", skill.root_path);
            let within = &payload_path[hooks_prefix.len()..];
            let dest_rel = format!("{}/hooks/{within}", skill.id.name);
            let content = fs.read_file(&format!("{}/{payload_path}", opts.source_root))?;
            fs.write_file(&format!("{dest_root}/{dest_rel}"), &content)?;
            Ok(Some(ManagedHookEdit::File {
                rel_path: dest_rel,
                sha256: sha256(&content),
                executable: false,
            }))
        }
    }
}

/// Install a skill body (and, only when `allow_hooks` is true and the target
/// supports hooks, its hooks) into `dest_root`. Returns the [`InstallManifest`]
/// recording every managed file and hook edit.
///
/// `now_ms` is epoch milliseconds for the install timestamp (injectable clock).
pub fn install_skill(
    fs: &dyn FsPort,
    opts: &InstallOptions,
    dest_root: &str,
    hook_support: Option<&HookSupport>,
    now_ms: i64,
) -> PortResult<InstallManifest> {
    let skill = &opts.skill;
    let body_files = copy_body(fs, opts, dest_root)?;

    // Content hash over skill-relative body paths (dest prefix stripped), stable
    // across install locations and comparable to a repository skill's hash.
    let skill_dir_name = &skill.id.name;
    let prefix_len = skill_dir_name.len() + 1;
    let entries: Vec<HashEntry> = body_files
        .iter()
        .map(|f| HashEntry {
            rel_path: f.rel_path[prefix_len..].to_string(),
            sha256: f.sha256.clone(),
        })
        .collect();
    let hash = content_hash(&entries);

    // Write our authoritative identity file, then record it as a managed file so
    // uninstall removes it and verify checks it.
    let skid_rel = format!("{skill_dir_name}/{SKID_FILE}");
    let skid_text = serialize_skid(&SkidFile {
        schema: SKID_SCHEMA,
        remote: opts.source_remote.clone(),
        name: skill.id.name.clone(),
        group: skill.id.group.clone(),
        version: hash.clone(),
    });
    fs.write_file(&format!("{dest_root}/{skid_rel}"), &skid_text)?;
    let mut files = body_files;
    files.push(ManagedFile {
        rel_path: skid_rel,
        sha256: sha256(&skid_text),
        executable: false,
    });
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));

    let mut hook_edits: Vec<ManagedHookEdit> = Vec::new();
    if opts.allow_hooks {
        if let Some(support) = hook_support {
            for hook in &skill.hooks {
                if let Some(edit) = apply_hook(fs, opts, dest_root, hook, support)? {
                    hook_edits.push(edit);
                }
            }
        }
    }

    Ok(InstallManifest {
        skill_id: skill.id.clone(),
        target: opts.target.clone(),
        destination_root: dest_root.to_string(),
        source_repo_id: opts.source_repo_id.clone(),
        source_remote: opts.source_remote.clone(),
        source_path: opts.source_path.clone(),
        content_hash: Some(hash),
        version: skill.manifest.version.clone(),
        installed_at: iso_from_millis(now_ms),
        files,
        hook_edits,
    })
}

/// Directory portion of a relative path, or `""` when there is none.
fn dir_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[..idx],
        None => "",
    }
}

/// Remove a file, then prune now-empty ancestor directories up to `dest_root`.
fn remove_and_prune(fs: &dyn FsPort, dest_root: &str, rel_path: &str) -> PortResult<()> {
    fs.remove(&format!("{dest_root}/{rel_path}"))?;
    let mut dir = dir_of(rel_path).to_string();
    while !dir.is_empty() {
        fs.remove_dir_if_empty(&format!("{dest_root}/{dir}"))?;
        dir = dir_of(&dir).to_string();
    }
    Ok(())
}

/// Uninstall a skill: remove every recorded body file (pruning empty dirs) and
/// every recorded hook edit by its kind. Never touches unowned files or regions.
pub fn uninstall_skill(fs: &dyn FsPort, manifest: &InstallManifest) -> PortResult<()> {
    let dest_root = &manifest.destination_root;
    for file in &manifest.files {
        remove_and_prune(fs, dest_root, &file.rel_path)?;
    }
    for edit in &manifest.hook_edits {
        match edit {
            ManagedHookEdit::Delimited {
                file, delimiter_id, ..
            } => {
                if fs.exists(file)? {
                    let next = remove_region(&fs.read_file(file)?, delimiter_id);
                    fs.write_file(file, &next)?;
                }
            }
            ManagedHookEdit::Json {
                file, marker_id, ..
            } => {
                if fs.exists(file)? {
                    let next = remove_hook_node(&fs.read_file(file)?, marker_id)
                        .map_err(|e| PortError::Other(e.to_string()))?;
                    fs.write_file(file, &next)?;
                }
            }
            ManagedHookEdit::File { rel_path, .. } => {
                remove_and_prune(fs, dest_root, rel_path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentKind, AgentTarget, ResolvedSkill, Scope};
    use crate::skills::resolver::resolve_skills;
    use crate::testing::MemFs;

    const NOW: i64 = 1000;

    fn skill_md(name: &str, extra: &str) -> String {
        format!("---\nname: {name}\n{extra}---\nbody\n")
    }

    fn only_skill(fs: &MemFs, repo_root: &str) -> ResolvedSkill {
        let mut result = resolve_skills(fs, repo_root);
        assert!(!result.skills.is_empty(), "no skill resolved");
        result.skills.remove(0)
    }

    fn make_opts(skill: ResolvedSkill, scope: Scope) -> InstallOptions {
        InstallOptions {
            target: AgentTarget {
                agent: AgentKind::Claude,
                scope,
                project_id: None,
            },
            source_root: "repo".to_string(),
            skill,
            allow_hooks: false,
            executable_globs: Vec::new(),
            source_repo_id: None,
            source_remote: None,
            source_path: None,
        }
    }

    fn delimited_support(target_file: &str) -> HookSupport {
        HookSupport {
            strategy: HookStrategy::DelimitedText,
            target_file: target_file.to_string(),
            comment_token: Some("#".to_string()),
            comment_close: None,
        }
    }

    fn json_support(target_file: &str) -> HookSupport {
        HookSupport {
            strategy: HookStrategy::JsonMerge,
            target_file: target_file.to_string(),
            comment_token: None,
            comment_close: None,
        }
    }

    fn file_support(target_file: &str) -> HookSupport {
        HookSupport {
            strategy: HookStrategy::File,
            target_file: target_file.to_string(),
            comment_token: None,
            comment_close: None,
        }
    }

    // --- body ---

    #[test]
    fn copies_body_files_records_hashes_and_skips_hooks_by_default() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file("repo/s/run.sh", "#!/bin/sh\necho hi\n")
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n",
            );
        let skill = only_skill(&fs, "repo");
        let opts = make_opts(skill, Scope::Global);
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();

        assert_eq!(fs.read_file("/dest/s/SKILL.md").unwrap(), skill_md("s", ""));
        assert_eq!(
            fs.read_file("/dest/s/run.sh").unwrap(),
            "#!/bin/sh\necho hi\n"
        );
        assert!(!fs.exists("/dest/s/hooks/HOOK.md").unwrap());

        let mut paths: Vec<String> = manifest.files.iter().map(|f| f.rel_path.clone()).collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                "s/.skid.yml".to_string(),
                "s/SKILL.md".to_string(),
                "s/run.sh".to_string(),
            ]
        );
        assert!(fs.exists("/dest/s/.skid.yml").unwrap());
        let sh = manifest
            .files
            .iter()
            .find(|f| f.rel_path == "s/run.sh")
            .unwrap();
        assert_eq!(sh.sha256, sha256("#!/bin/sh\necho hi\n"));
        assert!(manifest.hook_edits.is_empty());
    }

    #[test]
    fn applies_exec_bit_to_declared_executables_and_glob_matches() {
        let fs = MemFs::new()
            .with_file(
                "repo/s/SKILL.md",
                &skill_md("s", "executables:\n  - run.sh\n"),
            )
            .with_file("repo/s/run.sh", "x\n")
            .with_file("repo/s/bin/tool", "y\n")
            .with_file("repo/s/notexec.txt", "z\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Global);
        opts.executable_globs = vec!["bin/**".to_string()];
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();

        assert!(fs.stat("/dest/s/run.sh").unwrap().unwrap().executable);
        assert!(fs.stat("/dest/s/bin/tool").unwrap().unwrap().executable);
        assert!(!fs.stat("/dest/s/notexec.txt").unwrap().unwrap().executable);
        assert!(
            manifest
                .files
                .iter()
                .find(|f| f.rel_path == "s/run.sh")
                .unwrap()
                .executable
        );
        assert!(
            manifest
                .files
                .iter()
                .find(|f| f.rel_path == "s/bin/tool")
                .unwrap()
                .executable
        );
    }

    #[test]
    fn records_source_repo_id_version_and_timestamp() {
        let fs = MemFs::new().with_file("repo/s/SKILL.md", &skill_md("s", "version: 2.0.0\n"));
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Global);
        opts.source_repo_id = Some("repo-1".to_string());
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();
        assert_eq!(manifest.version.as_deref(), Some("2.0.0"));
        assert_eq!(manifest.source_repo_id.as_deref(), Some("repo-1"));
        assert_eq!(manifest.installed_at, "1970-01-01T00:00:01.000Z");
        assert_eq!(manifest.destination_root, "/dest");
    }

    // --- hooks (delimited-text) ---

    #[test]
    fn does_not_write_a_hook_edit_when_allow_hooks_is_false() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n  filePattern: AGENTS.md\n---\n",
            )
            .with_file("repo/s/hooks/snippet.txt", "export PATH=x\n")
            .with_file("/proj/AGENTS.md", "user content\n");
        let skill = only_skill(&fs, "repo");
        let opts = make_opts(skill, Scope::Project);
        let support = delimited_support("/proj/AGENTS.md");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        assert!(manifest.hook_edits.is_empty());
        assert_eq!(fs.read_file("/proj/AGENTS.md").unwrap(), "user content\n");
    }

    #[test]
    fn inserts_a_delimited_region_and_records_the_edit_when_allowed() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n  filePattern: AGENTS.md\n---\n",
            )
            .with_file("repo/s/hooks/snippet.txt", "export PATH=x\n")
            .with_file("/proj/AGENTS.md", "user content\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = delimited_support("/proj/AGENTS.md");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        assert_eq!(manifest.hook_edits.len(), 1);
        match &manifest.hook_edits[0] {
            ManagedHookEdit::Delimited {
                file, delimiter_id, ..
            } => {
                assert_eq!(file, "/proj/AGENTS.md");
                assert!(!delimiter_id.is_empty());
            }
            other => panic!("expected delimited, got {other:?}"),
        }
        let written = fs.read_file("/proj/AGENTS.md").unwrap();
        assert!(written.contains("user content"));
        assert!(written.contains("skillkeeper:hook"));
        assert!(written.contains("export PATH=x"));
    }

    // --- hooks (json-merge) ---

    #[test]
    fn merges_a_json_node_with_a_marker_and_preserves_the_user_entry() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.PreToolUse\n---\n",
            )
            .with_file(
                "repo/s/hooks/node.json",
                r#"{"matcher":"Edit","hooks":[{"command":"sk"}]}"#,
            )
            .with_file(
                "/proj/.claude/settings.json",
                r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"command":"user"}]}]}}"#,
            );
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = json_support("/proj/.claude/settings.json");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        assert_eq!(manifest.hook_edits.len(), 1);
        match &manifest.hook_edits[0] {
            ManagedHookEdit::Json {
                key_path,
                marker_id,
                ..
            } => {
                assert_eq!(key_path, "hooks.PreToolUse");
                assert!(!marker_id.is_empty());
            }
            other => panic!("expected json, got {other:?}"),
        }
        let parsed: Value =
            serde_json::from_str(&fs.read_file("/proj/.claude/settings.json").unwrap()).unwrap();
        let arr = parsed["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["hooks"][0]["command"], json!("user"));
        let owned = arr.iter().find(|e| e.get(MARKER_FIELD).is_some()).unwrap();
        assert_eq!(owned["matcher"], json!("Edit"));
    }

    // --- hook edge cases ---

    #[test]
    fn delimited_hook_with_no_payload_no_comment_token_and_fresh_target() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n",
            );
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        // No comment token -> defaults to '#'. Target file does not exist.
        let support = HookSupport {
            strategy: HookStrategy::DelimitedText,
            target_file: "/proj/fresh/AGENTS.md".to_string(),
            comment_token: None,
            comment_close: None,
        };
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        assert!(matches!(
            manifest.hook_edits[0],
            ManagedHookEdit::Delimited { .. }
        ));
        let written = fs.read_file("/proj/fresh/AGENTS.md").unwrap();
        assert!(written.starts_with("# >>> skillkeeper:hook"));
    }

    #[test]
    fn json_hook_with_no_payload_and_default_key_path_into_a_fresh_file() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n---\n",
            );
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = json_support("/proj/fresh/settings.json");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        match &manifest.hook_edits[0] {
            ManagedHookEdit::Json { key_path, .. } => assert_eq!(key_path, "hooks"),
            other => panic!("expected json, got {other:?}"),
        }
        let parsed: Value =
            serde_json::from_str(&fs.read_file("/proj/fresh/settings.json").unwrap()).unwrap();
        assert!(parsed["hooks"].is_array());
    }

    #[test]
    fn file_hook_with_no_payload_records_no_edit() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n---\n",
            );
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = file_support("/proj/x");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        assert!(manifest.hook_edits.is_empty());
    }

    #[test]
    fn uses_a_group_qualified_label_for_hooks_of_a_grouped_skill() {
        let fs = MemFs::new()
            .with_file("repo/grp/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/grp/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/grp/s/hooks/snippet.txt", "gen\n")
            .with_file("/proj/AGENTS.md", "top\n");
        let skill = only_skill(&fs, "repo");
        assert_eq!(
            skill.id,
            SkillId {
                group: Some("grp".to_string()),
                name: "s".to_string()
            }
        );
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = delimited_support("/proj/AGENTS.md");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        let written = fs.read_file("/proj/AGENTS.md").unwrap();
        assert!(written.contains("skillkeeper:hook grp/s:h"));
        assert_eq!(manifest.hook_edits.len(), 1);
    }

    #[test]
    fn records_no_hook_edits_when_allowed_but_no_hook_support() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/s/hooks/snippet.txt", "gen\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();
        assert!(manifest.hook_edits.is_empty());
    }

    // --- uninstall ---

    #[test]
    fn uninstall_removes_body_files_prunes_dirs_and_leaves_unowned() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file("repo/s/lib/util.js", "x\n")
            .with_file("/dest/unrelated.txt", "keep me\n");
        let skill = only_skill(&fs, "repo");
        let opts = make_opts(skill, Scope::Global);
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();
        assert!(fs.exists("/dest/s/SKILL.md").unwrap());
        uninstall_skill(&fs, &manifest).unwrap();
        assert!(!fs.exists("/dest/s/SKILL.md").unwrap());
        assert!(!fs.exists("/dest/s/lib/util.js").unwrap());
        assert!(!fs.exists("/dest/s").unwrap());
        assert_eq!(fs.read_file("/dest/unrelated.txt").unwrap(), "keep me\n");
    }

    #[test]
    fn uninstall_removes_a_delimited_region_leaving_surrounding_text() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/s/hooks/snippet.txt", "gen\n")
            .with_file("/proj/AGENTS.md", "top\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = delimited_support("/proj/AGENTS.md");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        uninstall_skill(&fs, &manifest).unwrap();
        let after = fs.read_file("/proj/AGENTS.md").unwrap();
        assert!(after.contains("top"));
        assert!(!after.contains("skillkeeper:hook"));
    }

    #[test]
    fn uninstall_removes_a_json_node_leaving_the_user_entry() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.PreToolUse\n---\n",
            )
            .with_file("repo/s/hooks/node.json", r#"{"matcher":"Edit"}"#)
            .with_file(
                "/proj/.claude/settings.json",
                r#"{"hooks":{"PreToolUse":[{"matcher":"Bash"}]}}"#,
            );
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = json_support("/proj/.claude/settings.json");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        uninstall_skill(&fs, &manifest).unwrap();
        let parsed: Value =
            serde_json::from_str(&fs.read_file("/proj/.claude/settings.json").unwrap()).unwrap();
        let arr = parsed["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matcher"], json!("Bash"));
    }

    #[test]
    fn uninstall_removes_hook_owned_standalone_files_for_file_strategy() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n  filePattern: hook.sh\n---\n",
            )
            .with_file("repo/s/hooks/hook.sh", "#!/bin/sh\n")
            .with_file("/proj/.config", "");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = file_support("/proj/hooks-dir");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        let file_edit = manifest
            .hook_edits
            .iter()
            .find(|e| matches!(e, ManagedHookEdit::File { .. }))
            .unwrap();
        let ManagedHookEdit::File { rel_path, .. } = file_edit else {
            unreachable!()
        };
        assert!(fs.exists(&format!("/dest/{rel_path}")).unwrap());
        let rel_path = rel_path.clone();
        uninstall_skill(&fs, &manifest).unwrap();
        assert!(!fs.exists(&format!("/dest/{rel_path}")).unwrap());
    }

    #[test]
    fn uninstall_tolerates_a_deleted_delimited_target_file() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/s/hooks/snippet.txt", "gen\n")
            .with_file("/proj/AGENTS.md", "top\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = delimited_support("/proj/AGENTS.md");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        fs.remove("/proj/AGENTS.md").unwrap();
        assert!(uninstall_skill(&fs, &manifest).is_ok());
    }

    #[test]
    fn uninstall_tolerates_a_deleted_json_target_file() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", &skill_md("s", ""))
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.E\n---\n",
            )
            .with_file("repo/s/hooks/node.json", r#"{"v":1}"#)
            .with_file("/proj/settings.json", "{}");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = json_support("/proj/settings.json");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        fs.remove("/proj/settings.json").unwrap();
        assert!(uninstall_skill(&fs, &manifest).is_ok());
    }
}
