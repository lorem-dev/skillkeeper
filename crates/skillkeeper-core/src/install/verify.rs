//! Install verification and repair (Rust port of
//! `packages/core/src/install/verify.ts`).
//!
//! [`verify_install`] re-hashes every managed file and hook edit and classifies
//! each as `ok`, `modified`, or `missing` (plus `extraneous` for unrecorded
//! files in a managed directory), read-only. [`repair_install`] re-applies from
//! source to fix drift by reinstalling the skill to its recorded state.

use std::collections::HashSet;

use crate::hashing::{sha256, sha256_bytes};
use crate::hooks::json::{canonical_json, find_owned_node};
use crate::hooks::region::extract_region;
use crate::install::install::{install_skill, remove_and_prune, HookSupport};
use crate::models::{
    FileVerification, HookEditVerification, InstallManifest, InstallOptions, ManagedHookEdit,
    VerifyReport, VerifyStatus,
};
use crate::ports::{FsPort, PortError, PortResult};

/// Top-level directory segment of a relative path.
fn top_dir(rel: &str) -> &str {
    match rel.find('/') {
        Some(idx) => &rel[..idx],
        None => rel,
    }
}

/// Recursively list files under `root/rel`, returning paths relative to `root`.
fn list_files_rec(fs: &dyn FsPort, root: &str, rel: &str) -> PortResult<Vec<String>> {
    let mut out = Vec::new();
    let abs = format!("{root}/{rel}");
    if !fs.exists(&abs)? {
        return Ok(out);
    }
    for entry in fs.list(&abs)? {
        let child_rel = format!("{rel}/{entry}");
        let stat = fs.stat(&format!("{root}/{child_rel}"))?;
        match stat {
            Some(s) if s.is_directory => out.extend(list_files_rec(fs, root, &child_rel)?),
            Some(s) if s.is_file => out.push(child_rel),
            _ => {}
        }
    }
    Ok(out)
}

/// Insert or overwrite a `(rel_path, sha256)` pair, preserving first-seen order
/// (mirrors the insertion order of the TypeScript `Map`).
fn record_put(recorded: &mut Vec<(String, String)>, key: String, value: String) {
    if let Some(entry) = recorded.iter_mut().find(|(k, _)| *k == key) {
        entry.1 = value;
    } else {
        recorded.push((key, value));
    }
}

/// Every `(rel_path, sha256)` the manifest records under its destination root:
/// body files plus `file`-kind hook edits, which are tracked as managed files.
/// First-seen order is preserved.
fn recorded_entries(manifest: &InstallManifest) -> Vec<(String, String)> {
    let mut recorded: Vec<(String, String)> = Vec::new();
    for f in &manifest.files {
        record_put(&mut recorded, f.rel_path.clone(), f.sha256.clone());
    }
    for e in &manifest.hook_edits {
        if let ManagedHookEdit::File {
            rel_path, sha256, ..
        } = e
        {
            record_put(&mut recorded, rel_path.clone(), sha256.clone());
        }
    }
    recorded
}

/// The distinct top-level directories under the destination root that a
/// manifest's recorded paths occupy. These bound every scan and every removal:
/// nothing outside them is ever read or deleted.
fn managed_dirs(recorded: &[(String, String)]) -> Vec<&str> {
    let mut dirs: Vec<&str> = Vec::new();
    for (rel, _) in recorded {
        let dir = top_dir(rel);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// Classify a non-`file` hook edit by re-hashing its region or owned node.
fn verify_hook_edit(fs: &dyn FsPort, edit: &ManagedHookEdit) -> PortResult<VerifyStatus> {
    match edit {
        ManagedHookEdit::Delimited {
            file,
            delimiter_id,
            sha256: expected,
        } => {
            if !fs.exists(file)? {
                return Ok(VerifyStatus::Missing);
            }
            match extract_region(&fs.read_file(file)?, delimiter_id) {
                None => Ok(VerifyStatus::Missing),
                Some(block) => Ok(if sha256(&block) == *expected {
                    VerifyStatus::Ok
                } else {
                    VerifyStatus::Modified
                }),
            }
        }
        ManagedHookEdit::Json {
            file,
            marker_id,
            sha256: expected,
            ..
        } => {
            if !fs.exists(file)? {
                return Ok(VerifyStatus::Missing);
            }
            let node = find_owned_node(&fs.read_file(file)?, marker_id)
                .map_err(|e| PortError::Other(e.to_string()))?;
            match node {
                None => Ok(VerifyStatus::Missing),
                Some(node) => Ok(if sha256(&canonical_json(&node)) == *expected {
                    VerifyStatus::Ok
                } else {
                    VerifyStatus::Modified
                }),
            }
        }
        ManagedHookEdit::File { .. } => {
            unreachable!("file-kind hook edits are verified as managed files")
        }
    }
}

/// Recompute hashes for every managed file and hook edit and compare them to the
/// recorded manifest. Read-only. Reports `ok`, `modified`, `missing` per file
/// and hook edit, plus `extraneous` for unrecorded files in a managed directory.
pub fn verify_install(fs: &dyn FsPort, manifest: &InstallManifest) -> PortResult<VerifyReport> {
    let dest_root = &manifest.destination_root;
    let mut files: Vec<FileVerification> = Vec::new();

    // File-kind hook edits are verified together with body files.
    let recorded = recorded_entries(manifest);

    for (rel_path, expected) in &recorded {
        let abs = format!("{dest_root}/{rel_path}");
        if !fs.exists(&abs)? {
            files.push(FileVerification {
                rel_path: rel_path.clone(),
                status: VerifyStatus::Missing,
            });
            continue;
        }
        // Bytes: an installed body file is whatever the skill shipped, and
        // reading it as text would report a binary asset as unverifiable
        // rather than as intact.
        let actual = sha256_bytes(&fs.read_bytes(&abs)?);
        files.push(FileVerification {
            rel_path: rel_path.clone(),
            status: if actual == *expected {
                VerifyStatus::Ok
            } else {
                VerifyStatus::Modified
            },
        });
    }

    // Detect extraneous files in each managed top-level directory.
    let recorded_keys: HashSet<&str> = recorded.iter().map(|(k, _)| k.as_str()).collect();
    for dir in managed_dirs(&recorded) {
        for rel in list_files_rec(fs, dest_root, dir)? {
            if !recorded_keys.contains(rel.as_str()) {
                files.push(FileVerification {
                    rel_path: rel,
                    status: VerifyStatus::Extraneous,
                });
            }
        }
    }

    let mut hook_edits: Vec<HookEditVerification> = Vec::new();
    for edit in &manifest.hook_edits {
        if matches!(edit, ManagedHookEdit::File { .. }) {
            continue; // handled as a file above
        }
        let status = verify_hook_edit(fs, edit)?;
        hook_edits.push(HookEditVerification {
            edit: edit.clone(),
            status,
        });
    }

    let ok = files.iter().all(|f| f.status == VerifyStatus::Ok)
        && hook_edits.iter().all(|h| h.status == VerifyStatus::Ok);
    Ok(VerifyReport {
        ok,
        files,
        hook_edits,
    })
}

/// Whether a manifest-relative path is safe to scan or delete under a
/// destination root.
///
/// A destination path is built from `skill.id.name`, which comes from `SKILL.md`
/// frontmatter or a `skillkeeper.repo.yaml` entry - third-party content from a
/// cloned repository, validated only as "a non-empty string". A name of `..` or
/// `/etc` therefore reaches this code, and `top_dir` would hand back `..` or the
/// empty string, which resolves *outside* the destination root once a real
/// filesystem walks it. Writing there is bad; deleting there is unacceptable, so
/// every path is checked before it is scanned or removed.
///
/// Requires a relative path whose every segment is an ordinary name: no leading
/// separator, no empty/`.`/`..` segment, and no backslash (a Windows separator
/// that would otherwise slip past the `/`-based segmentation).
fn is_safe_rel_path(rel: &str) -> bool {
    if rel.is_empty() || rel.starts_with('/') || rel.contains('\\') {
        return false;
    }
    rel.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Delete files under `manifest`'s managed directories that neither the manifest
/// nor `protected` records, pruning directories that become empty. Returns the
/// removed paths, in scan order.
///
/// Reinstalling overwrites recorded files but never removes unrecorded ones, so
/// without this step a repaired install still verifies as `extraneous`.
///
/// Two things bound the deletion, because a skill's destination directory is
/// **not** exclusively its own - it is named after the skill alone (the group is
/// part of the id, not the path), so `code-review` and `team/code-review` share
/// one directory, and the agent's skills root also holds sibling skills and the
/// MCP ledgers:
///
/// - `protected` lists paths owned by something else that must survive: files
///   recorded by other installs under the same root, and hook-owned files from
///   the prior manifest that a no-consent repair did not rewrite.
/// - [`is_safe_rel_path`] rejects any recorded path that could escape
///   `dest_root`; an unsafe path contributes no scan directory, so a malformed
///   manifest prunes nothing instead of walking out of the tree.
fn prune_extraneous(
    fs: &dyn FsPort,
    dest_root: &str,
    manifest: &InstallManifest,
    protected: &HashSet<&str>,
) -> PortResult<Vec<String>> {
    let recorded = recorded_entries(manifest);
    let recorded_keys: HashSet<&str> = recorded.iter().map(|(k, _)| k.as_str()).collect();
    let mut removed = Vec::new();
    for dir in managed_dirs(&recorded) {
        if !is_safe_rel_path(dir) {
            continue;
        }
        for rel in list_files_rec(fs, dest_root, dir)? {
            if recorded_keys.contains(rel.as_str()) || protected.contains(rel.as_str()) {
                continue;
            }
            if !is_safe_rel_path(&rel) {
                continue;
            }
            remove_and_prune(fs, dest_root, &rel)?;
            removed.push(rel);
        }
    }
    Ok(removed)
}

/// The outcome of a repair: the freshly written manifest plus the unrecorded
/// files that were deleted to make the install verify clean.
#[derive(Debug, Clone)]
pub struct RepairOutcome {
    pub manifest: InstallManifest,
    /// Destination-relative paths removed as `extraneous`. Callers report these:
    /// repair is the one operation that deletes files the user may have put
    /// there by hand, so it must not do so silently.
    pub removed: Vec<String>,
}

/// Repair a drifted install by reinstalling the skill to its recorded state.
/// Hooks are reapplied only when `opts.allow_hooks` is set (re-consent).
/// Mutating and always explicit.
///
/// Restores `missing` and `modified` files by reinstalling, then removes
/// `extraneous` ones so the install verifies clean afterwards.
///
/// `manifest` is the prior recorded state. `other_installs` are the manifests of
/// every *other* install sharing `dest_root`; their recorded files are protected
/// from pruning. Passing them is not optional bookkeeping: a destination
/// directory is named after the skill alone, so two skills with the same name
/// from different groups or repositories occupy the same directory, and pruning
/// without this list would delete the other skill's files and leave its manifest
/// claiming they are present.
///
/// A stale directory recorded only by `manifest` (after a rename) is left alone,
/// since another skill may legitimately occupy it now.
pub fn repair_install(
    fs: &dyn FsPort,
    opts: &InstallOptions,
    dest_root: &str,
    hook_support: Option<&HookSupport>,
    now_ms: i64,
    manifest: &InstallManifest,
    other_installs: &[InstallManifest],
) -> PortResult<RepairOutcome> {
    let next = install_skill(fs, opts, dest_root, hook_support, now_ms)?;

    // Files owned by a co-located install, plus this skill's own hook-owned
    // files from before the repair. Without the latter, a repair run without
    // `--allow-hooks` produces a manifest with no hook edits and would then
    // delete the very payload it just declined to touch.
    let mut protected_owned: Vec<String> = Vec::new();
    for other in other_installs {
        if other.destination_root != dest_root {
            continue;
        }
        for (rel, _) in recorded_entries(other) {
            protected_owned.push(rel);
        }
    }
    if !opts.allow_hooks {
        for edit in &manifest.hook_edits {
            if let ManagedHookEdit::File { rel_path, .. } = edit {
                protected_owned.push(rel_path.clone());
            }
        }
    }
    let protected: HashSet<&str> = protected_owned.iter().map(String::as_str).collect();

    let removed = prune_extraneous(fs, dest_root, &next, &protected)?;
    Ok(RepairOutcome {
        manifest: next,
        removed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentKind, AgentTarget, ManagedFile, ResolvedSkill, Scope, SkillId};
    use crate::skills::resolver::resolve_skills;
    use crate::testing::MemFs;

    const NOW: i64 = 1000;

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
            strategy: crate::models::HookStrategy::DelimitedText,
            target_file: target_file.to_string(),
            comment_token: Some("#".to_string()),
            comment_close: None,
        }
    }

    fn json_support(target_file: &str) -> HookSupport {
        HookSupport {
            strategy: crate::models::HookStrategy::JsonMerge,
            target_file: target_file.to_string(),
            comment_token: None,
            comment_close: None,
        }
    }

    fn file_support(target_file: &str) -> HookSupport {
        HookSupport {
            strategy: crate::models::HookStrategy::File,
            target_file: target_file.to_string(),
            comment_token: None,
            comment_close: None,
        }
    }

    /// Body-only install used by the file verification and repair tests.
    fn setup_body_install() -> (MemFs, InstallManifest) {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\nbody\n")
            .with_file("repo/s/data.txt", "original\n")
            .with_file("repo/s/keep.txt", "keep\n");
        let skill = only_skill(&fs, "repo");
        let opts = make_opts(skill, Scope::Global);
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();
        (fs, manifest)
    }

    // --- files ---

    #[test]
    fn reports_ok_when_nothing_changed() {
        let (fs, manifest) = setup_body_install();
        let report = verify_install(&fs, &manifest).unwrap();
        assert!(report.ok);
        assert!(report.files.iter().all(|f| f.status == VerifyStatus::Ok));
        assert!(report.hook_edits.is_empty());
    }

    #[test]
    fn flags_a_hand_edited_file_as_modified() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/data.txt", "tampered\n").unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        assert!(!report.ok);
        let entry = report
            .files
            .iter()
            .find(|f| f.rel_path == "s/data.txt")
            .unwrap();
        assert_eq!(entry.status, VerifyStatus::Modified);
    }

    #[test]
    fn flags_a_deleted_file_as_missing() {
        let (fs, manifest) = setup_body_install();
        fs.remove("/dest/s/data.txt").unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        assert!(!report.ok);
        let entry = report
            .files
            .iter()
            .find(|f| f.rel_path == "s/data.txt")
            .unwrap();
        assert_eq!(entry.status, VerifyStatus::Missing);
    }

    #[test]
    fn flags_an_unrecorded_file_in_a_managed_dir_as_extraneous() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/sneaked.txt", "extra\n").unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        assert!(!report.ok);
        let entry = report
            .files
            .iter()
            .find(|f| f.rel_path == "s/sneaked.txt")
            .unwrap();
        assert_eq!(entry.status, VerifyStatus::Extraneous);
    }

    #[test]
    fn detects_extraneous_files_nested_in_subdirectories() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/nested/deep/sneaked.txt", "extra\n")
            .unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        let entry = report
            .files
            .iter()
            .find(|f| f.rel_path == "s/nested/deep/sneaked.txt")
            .unwrap();
        assert_eq!(entry.status, VerifyStatus::Extraneous);
    }

    #[test]
    fn reports_missing_without_crashing_when_the_whole_dir_is_gone() {
        let (fs, manifest) = setup_body_install();
        for f in &manifest.files {
            fs.remove(&format!("/dest/{}", f.rel_path)).unwrap();
        }
        let report = verify_install(&fs, &manifest).unwrap();
        assert!(report
            .files
            .iter()
            .all(|f| f.status == VerifyStatus::Missing));
        assert!(!report
            .files
            .iter()
            .any(|f| f.status == VerifyStatus::Extraneous));
    }

    // --- hook edits ---

    fn install_delimited_hook() -> (MemFs, InstallManifest) {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\n")
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
        (fs, manifest)
    }

    #[test]
    fn reports_ok_then_modified_for_a_delimited_region() {
        let (fs, manifest) = install_delimited_hook();
        let ok_report = verify_install(&fs, &manifest).unwrap();
        assert_eq!(ok_report.hook_edits[0].status, VerifyStatus::Ok);

        let file = fs.read_file("/proj/AGENTS.md").unwrap();
        fs.write_file("/proj/AGENTS.md", &file.replace("gen", "hacked"))
            .unwrap();
        let bad_report = verify_install(&fs, &manifest).unwrap();
        assert!(!bad_report.ok);
        assert_eq!(bad_report.hook_edits[0].status, VerifyStatus::Modified);
    }

    #[test]
    fn reports_missing_when_the_delimited_region_was_removed() {
        let (fs, manifest) = install_delimited_hook();
        fs.write_file("/proj/AGENTS.md", "top\n").unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        assert_eq!(report.hook_edits[0].status, VerifyStatus::Missing);
    }

    #[test]
    fn reports_missing_for_a_delimited_edit_when_the_file_is_gone() {
        let (fs, manifest) = install_delimited_hook();
        fs.remove("/proj/AGENTS.md").unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        assert_eq!(report.hook_edits[0].status, VerifyStatus::Missing);
    }

    fn install_json_hook() -> (MemFs, InstallManifest) {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\n")
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
        (fs, manifest)
    }

    #[test]
    fn reports_missing_for_a_json_edit_when_node_or_file_gone() {
        let (fs, manifest) = install_json_hook();
        // Node removed but file present.
        fs.write_file("/proj/settings.json", "{}").unwrap();
        assert_eq!(
            verify_install(&fs, &manifest).unwrap().hook_edits[0].status,
            VerifyStatus::Missing
        );
        // Whole file gone.
        fs.remove("/proj/settings.json").unwrap();
        assert_eq!(
            verify_install(&fs, &manifest).unwrap().hook_edits[0].status,
            VerifyStatus::Missing
        );
    }

    #[test]
    fn reports_modified_for_a_tampered_json_node() {
        let (fs, manifest) = install_json_hook();
        let ok_report = verify_install(&fs, &manifest).unwrap();
        assert_eq!(ok_report.hook_edits[0].status, VerifyStatus::Ok);

        let mut parsed: serde_json::Value =
            serde_json::from_str(&fs.read_file("/proj/settings.json").unwrap()).unwrap();
        parsed["hooks"]["E"][0]["v"] = serde_json::json!(999);
        fs.write_file("/proj/settings.json", &parsed.to_string())
            .unwrap();
        let bad_report = verify_install(&fs, &manifest).unwrap();
        assert_eq!(bad_report.hook_edits[0].status, VerifyStatus::Modified);
    }

    #[test]
    fn treats_a_file_strategy_edit_as_a_managed_file_in_the_report() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\n")
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/s/hooks/hook.sh", "#!/bin/sh\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = file_support("/proj/x");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        let report = verify_install(&fs, &manifest).unwrap();
        // The file-kind edit is verified as a file, not in hook_edits.
        assert!(report.hook_edits.is_empty());
        let file_edit = manifest
            .hook_edits
            .iter()
            .find(|e| matches!(e, ManagedHookEdit::File { .. }))
            .unwrap();
        let ManagedHookEdit::File { rel_path, .. } = file_edit else {
            unreachable!()
        };
        assert!(report
            .files
            .iter()
            .any(|f| &f.rel_path == rel_path && f.status == VerifyStatus::Ok));
    }

    #[test]
    fn verifies_a_binary_body_file_as_intact() {
        let png: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE];
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\nbody\n")
            .with_bytes("repo/s/icon.png", png);
        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();

        let report = verify_install(&fs, &manifest).unwrap();
        assert!(report.ok, "{report:?}");
    }

    #[test]
    fn reports_a_changed_binary_body_file_as_modified() {
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\nbody\n")
            .with_bytes("repo/s/icon.png", &[0x89, 0x50]);
        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let manifest = install_skill(&fs, &opts, "/dest", None, NOW).unwrap();
        fs.write_bytes("/dest/s/icon.png", &[0x89, 0x51]).unwrap();

        let report = verify_install(&fs, &manifest).unwrap();
        assert!(report
            .files
            .iter()
            .any(|f| f.rel_path == "s/icon.png" && f.status == VerifyStatus::Modified));
    }

    // --- repair ---

    #[test]
    fn repair_restores_a_missing_file_to_its_recorded_hash() {
        let (fs, manifest) = setup_body_install();
        fs.remove("/dest/s/data.txt").unwrap();
        assert!(!verify_install(&fs, &manifest).unwrap().ok);

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[]).unwrap();
        assert_eq!(fs.read_file("/dest/s/data.txt").unwrap(), "original\n");
        assert!(verify_install(&fs, &manifest).unwrap().ok);
    }

    #[test]
    fn repair_restores_a_hand_modified_file_to_recorded_content() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/data.txt", "tampered\n").unwrap();
        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[]).unwrap();
        assert_eq!(fs.read_file("/dest/s/data.txt").unwrap(), "original\n");
    }

    #[test]
    fn repair_removes_an_extraneous_file() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/sneaked.txt", "extra\n").unwrap();
        assert!(!verify_install(&fs, &manifest).unwrap().ok);

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let next = repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[])
            .unwrap()
            .manifest;
        assert!(!fs.exists("/dest/s/sneaked.txt").unwrap());
        assert!(verify_install(&fs, &next).unwrap().ok);
    }

    #[test]
    fn repair_removes_a_nested_extraneous_file_and_prunes_its_directories() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/nested/deep/sneaked.txt", "extra\n")
            .unwrap();

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let next = repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[])
            .unwrap()
            .manifest;
        assert!(!fs.exists("/dest/s/nested/deep/sneaked.txt").unwrap());
        // The directories the extraneous file created are pruned too, so nothing
        // is left behind as an empty shell.
        assert!(!fs.exists("/dest/s/nested/deep").unwrap());
        assert!(!fs.exists("/dest/s/nested").unwrap());
        // Recorded files survive, and the skill directory itself is kept.
        assert_eq!(fs.read_file("/dest/s/data.txt").unwrap(), "original\n");
        assert!(verify_install(&fs, &next).unwrap().ok);
    }

    #[test]
    fn repair_leaves_files_outside_the_managed_directory_alone() {
        let (fs, manifest) = setup_body_install();
        // A sibling skill's directory and a file at the skills root: both live
        // under dest_root but outside this skill's managed directory.
        fs.write_file("/dest/other-skill/SKILL.md", "---\nname: other\n---\n")
            .unwrap();
        fs.write_file("/dest/.skmcp.yml", "schema: 1\n").unwrap();

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[]).unwrap();
        assert!(fs.exists("/dest/other-skill/SKILL.md").unwrap());
        assert!(fs.exists("/dest/.skmcp.yml").unwrap());
    }

    #[test]
    fn repair_removes_a_file_the_source_no_longer_ships() {
        let (fs, manifest) = setup_body_install();
        // keep.txt was installed and recorded; now the source drops it, so a
        // reinstall no longer writes it and it becomes extraneous on disk.
        fs.remove("repo/s/keep.txt").unwrap();
        assert!(fs.exists("/dest/s/keep.txt").unwrap());

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let next = repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[])
            .unwrap()
            .manifest;
        assert!(!fs.exists("/dest/s/keep.txt").unwrap());
        assert!(!next.files.iter().any(|f| f.rel_path == "s/keep.txt"));
        assert!(verify_install(&fs, &next).unwrap().ok);
    }

    #[test]
    fn is_safe_rel_path_rejects_escapes_and_accepts_ordinary_paths() {
        for ok in ["s/SKILL.md", "s/lib/util.js", "s/hooks/hook.sh", "a"] {
            assert!(is_safe_rel_path(ok), "{ok} should be safe");
        }
        for bad in [
            "",
            "..",
            "../evil/SKILL.md",
            "/abs/SKILL.md",
            "./x/SKILL.md",
            "s/../../etc/passwd",
            "s//SKILL.md",
            "s\\..\\evil",
        ] {
            assert!(!is_safe_rel_path(bad), "{bad} should be rejected");
        }
    }

    #[test]
    fn repair_prunes_nothing_when_a_recorded_path_escapes_the_destination_root() {
        // A skill name of `..` comes straight from SKILL.md frontmatter, which is
        // validated only as "non-empty". Its recorded paths would resolve above
        // dest_root, so pruning must refuse to walk there at all.
        let (fs, mut manifest) = setup_body_install();
        for f in manifest.files.iter_mut() {
            f.rel_path = format!("../{}", f.rel_path);
        }
        fs.write_file("/outside.txt", "must survive\n").unwrap();

        let removed = prune_extraneous(&fs, "/dest", &manifest, &HashSet::new()).unwrap();
        assert!(removed.is_empty(), "{removed:?}");
        assert!(fs.exists("/outside.txt").unwrap());
    }

    /// The same escape, against the REAL filesystem.
    ///
    /// [`MemFs`] never resolves `..` or `.`, so it reports the escaped path as
    /// absent and the memory-backed test above would pass even with no guard at
    /// all. Only `StdFs` lets the OS resolve the path, which is where the danger
    /// actually lives.
    #[test]
    fn prune_never_escapes_the_destination_root_on_a_real_filesystem() {
        use crate::adapters::std_fs::StdFs;
        use std::sync::atomic::{AtomicU32, Ordering};

        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let base =
            std::env::temp_dir().join(format!("skillkeeper-prune-{}-{}", std::process::id(), n));
        let dest_root = base.join("skills");
        std::fs::create_dir_all(dest_root.join("s")).expect("create dest");
        std::fs::write(dest_root.join("s/SKILL.md"), "body\n").expect("write skill");
        // A bystander next to the skills root, reachable only by escaping it.
        std::fs::write(base.join("precious.txt"), "must survive\n").expect("write bystander");

        let fs = StdFs;
        let dest = dest_root.to_string_lossy().into_owned();
        for hostile in ["../precious.txt", "..", "/etc/hosts", "./precious.txt"] {
            let manifest = InstallManifest {
                skill_id: SkillId {
                    group: None,
                    name: "s".to_string(),
                },
                target: AgentTarget {
                    agent: AgentKind::Claude,
                    scope: Scope::Global,
                    project_id: None,
                },
                destination_root: dest.clone(),
                source_repo_id: None,
                source_remote: None,
                source_path: None,
                content_hash: None,
                version: None,
                installed_at: String::new(),
                files: vec![ManagedFile {
                    rel_path: hostile.to_string(),
                    sha256: String::new(),
                    executable: false,
                }],
                hook_edits: Vec::new(),
            };
            let removed = prune_extraneous(&fs, &dest, &manifest, &HashSet::new()).unwrap();
            assert!(removed.is_empty(), "{hostile}: pruned {removed:?}");
            assert!(
                base.join("precious.txt").exists(),
                "{hostile}: deleted a file outside the destination root"
            );
            assert!(
                dest_root.join("s/SKILL.md").exists(),
                "{hostile}: deleted an unrelated skill file"
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn repair_keeps_files_recorded_by_a_co_located_install() {
        // Destination directories are named after the skill alone, so `code-review`
        // and `team/code-review` share one. Repairing either must not delete the
        // other's files.
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/other-owned.txt", "owned elsewhere\n")
            .unwrap();
        let mut other = manifest.clone();
        other.files = vec![ManagedFile {
            rel_path: "s/other-owned.txt".to_string(),
            sha256: sha256("owned elsewhere\n"),
            executable: false,
        }];

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let outcome = repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[other]).unwrap();
        assert!(fs.exists("/dest/s/other-owned.txt").unwrap());
        assert!(outcome.removed.is_empty(), "{:?}", outcome.removed);
    }

    #[test]
    fn repair_ignores_a_co_located_install_at_a_different_root() {
        // Only installs sharing this destination root protect anything.
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/stray.txt", "x\n").unwrap();
        let mut elsewhere = manifest.clone();
        elsewhere.destination_root = "/other-root".to_string();
        elsewhere.files = vec![ManagedFile {
            rel_path: "s/stray.txt".to_string(),
            sha256: sha256("x\n"),
            executable: false,
        }];

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let outcome =
            repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[elsewhere]).unwrap();
        assert!(!fs.exists("/dest/s/stray.txt").unwrap());
        assert_eq!(outcome.removed, vec!["s/stray.txt".to_string()]);
    }

    #[test]
    fn repair_reports_every_file_it_removed() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/a.txt", "x\n").unwrap();
        fs.write_file("/dest/s/nested/b.txt", "x\n").unwrap();

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        let mut removed = repair_install(&fs, &opts, "/dest", None, NOW, &manifest, &[])
            .unwrap()
            .removed;
        removed.sort();
        assert_eq!(
            removed,
            vec!["s/a.txt".to_string(), "s/nested/b.txt".to_string()]
        );
    }

    #[test]
    fn repair_without_consent_keeps_a_previously_installed_hook_file() {
        // Without --allow-hooks the fresh manifest records no hook edits, so the
        // hook's payload would look extraneous. It must survive: the run declined
        // to touch hooks, and said so.
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\n")
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/s/hooks/hook.sh", "#!/bin/sh\n");
        let skill = only_skill(&fs, "repo");
        let mut consented = make_opts(skill.clone(), Scope::Project);
        consented.allow_hooks = true;
        let support = file_support("/proj/x");
        let manifest = install_skill(&fs, &consented, "/dest", Some(&support), NOW).unwrap();
        assert!(fs.exists("/dest/s/hooks/hook.sh").unwrap());

        let no_consent = make_opts(skill, Scope::Project);
        let outcome = repair_install(&fs, &no_consent, "/dest", None, NOW, &manifest, &[]).unwrap();
        assert!(
            fs.exists("/dest/s/hooks/hook.sh").unwrap(),
            "a no-consent repair must not delete the hook payload it declined to rewrite"
        );
        assert!(outcome.removed.is_empty(), "{:?}", outcome.removed);
    }

    #[test]
    fn repair_keeps_a_hook_owned_standalone_file() {
        // A `file`-strategy hook edit is recorded as a managed file, so pruning
        // must not treat it as extraneous.
        let fs = MemFs::new()
            .with_file("repo/s/SKILL.md", "---\nname: s\n---\n")
            .with_file(
                "repo/s/hooks/HOOK.md",
                "---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n---\n",
            )
            .with_file("repo/s/hooks/hook.sh", "#!/bin/sh\n");
        let skill = only_skill(&fs, "repo");
        let mut opts = make_opts(skill, Scope::Project);
        opts.allow_hooks = true;
        let support = file_support("/proj/x");
        let manifest = install_skill(&fs, &opts, "/dest", Some(&support), NOW).unwrap();
        assert!(fs.exists("/dest/s/hooks/hook.sh").unwrap());

        let next = repair_install(&fs, &opts, "/dest", Some(&support), NOW, &manifest, &[])
            .unwrap()
            .manifest;
        assert!(fs.exists("/dest/s/hooks/hook.sh").unwrap());
        assert!(verify_install(&fs, &next).unwrap().ok);
    }
}
