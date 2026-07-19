//! Install verification and repair (Rust port of
//! `packages/core/src/install/verify.ts`).
//!
//! [`verify_install`] re-hashes every managed file and hook edit and classifies
//! each as `ok`, `modified`, or `missing` (plus `extraneous` for unrecorded
//! files in a managed directory), read-only. [`repair_install`] re-applies from
//! source to fix drift by reinstalling the skill to its recorded state.

use std::collections::HashSet;

use crate::hashing::sha256;
use crate::hooks::json::{canonical_json, find_owned_node};
use crate::hooks::region::extract_region;
use crate::install::install::{install_skill, HookSupport};
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

    for (rel_path, expected) in &recorded {
        let abs = format!("{dest_root}/{rel_path}");
        if !fs.exists(&abs)? {
            files.push(FileVerification {
                rel_path: rel_path.clone(),
                status: VerifyStatus::Missing,
            });
            continue;
        }
        let actual = sha256(&fs.read_file(&abs)?);
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
    let mut managed_dirs: Vec<&str> = Vec::new();
    for (rel, _) in &recorded {
        let dir = top_dir(rel);
        if !managed_dirs.contains(&dir) {
            managed_dirs.push(dir);
        }
    }
    let recorded_keys: HashSet<&str> = recorded.iter().map(|(k, _)| k.as_str()).collect();
    for dir in managed_dirs {
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

/// Repair a drifted install by reinstalling the skill to its recorded state.
/// Hooks are reapplied only when `opts.allow_hooks` is set (re-consent).
/// Mutating and always explicit. The prior `manifest` is accepted to mirror the
/// TypeScript `RepairOptions`; the returned manifest reflects the freshly
/// written state.
pub fn repair_install(
    fs: &dyn FsPort,
    opts: &InstallOptions,
    dest_root: &str,
    hook_support: Option<&HookSupport>,
    now_ms: i64,
    _manifest: &InstallManifest,
) -> PortResult<InstallManifest> {
    install_skill(fs, opts, dest_root, hook_support, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentKind, AgentTarget, ResolvedSkill, Scope};
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

    // --- repair ---

    #[test]
    fn repair_restores_a_missing_file_to_its_recorded_hash() {
        let (fs, manifest) = setup_body_install();
        fs.remove("/dest/s/data.txt").unwrap();
        assert!(!verify_install(&fs, &manifest).unwrap().ok);

        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        repair_install(&fs, &opts, "/dest", None, NOW, &manifest).unwrap();
        assert_eq!(fs.read_file("/dest/s/data.txt").unwrap(), "original\n");
        assert!(verify_install(&fs, &manifest).unwrap().ok);
    }

    #[test]
    fn repair_restores_a_hand_modified_file_to_recorded_content() {
        let (fs, manifest) = setup_body_install();
        fs.write_file("/dest/s/data.txt", "tampered\n").unwrap();
        let opts = make_opts(only_skill(&fs, "repo"), Scope::Global);
        repair_install(&fs, &opts, "/dest", None, NOW, &manifest).unwrap();
        assert_eq!(fs.read_file("/dest/s/data.txt").unwrap(), "original\n");
    }
}
