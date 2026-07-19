//! Content hashing for skill bodies (Rust port of
//! `packages/core/src/kernel/hashing.ts`).
//!
//! All digests are lowercase hex SHA-256 and match the TypeScript output
//! byte-for-byte: strings are hashed as their UTF-8 bytes, and the content-hash
//! line format (`relPath\0sha256`, sorted, joined by `\n`) is preserved.

use sha2::{Digest, Sha256};

use crate::models::{InstallManifest, ManagedFile, ResolvedSkill};
use crate::ports::{FsPort, PortResult};

/// Name of the SkillKeeper identity file, excluded from content hashing.
pub const SKID_FILE: &str = ".skid.yml";

/// A `(relPath, sha256)` pair fed into [`content_hash`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashEntry {
    pub rel_path: String,
    pub sha256: String,
}

/// Basename of a skill-relative path.
fn base_name(rel_path: &str) -> &str {
    match rel_path.rfind('/') {
        Some(idx) => &rel_path[idx + 1..],
        None => rel_path,
    }
}

/// Compute the lowercase hex SHA-256 digest of the given raw bytes.
pub fn sha256_bytes(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    hex::encode(hasher.finalize())
}

/// Compute the lowercase hex SHA-256 digest of the given UTF-8 text.
pub fn sha256(content: &str) -> String {
    sha256_bytes(content.as_bytes())
}

/// Hash a set of files under a root directory into [`ManagedFile`] records,
/// sorted by `rel_path` for stable, deterministic output.
///
/// Paths are joined with a forward slash (`{root}/{rel_path}`), mirroring the
/// hand-rolled TypeScript path join.
pub fn hash_tree(
    fs: &dyn FsPort,
    root: &str,
    rel_paths: &[&str],
) -> crate::ports::PortResult<Vec<ManagedFile>> {
    let mut sorted: Vec<&str> = rel_paths.to_vec();
    sorted.sort_unstable();
    let mut out = Vec::with_capacity(sorted.len());
    for rel_path in sorted {
        let full = format!("{root}/{rel_path}");
        let content = fs.read_file(&full)?;
        let stat = fs.stat(&full)?;
        out.push(ManagedFile {
            rel_path: rel_path.to_string(),
            sha256: sha256(&content),
            executable: stat.map(|s| s.executable).unwrap_or(false),
        });
    }
    Ok(out)
}

/// Content hash of a skill body: a single SHA-256 over the sorted,
/// skill-relative `relPath\0sha256` lines, ignoring the executable bit and
/// excluding the `.skid.yml` identity file. `rel_path` MUST already be relative
/// to the skill directory so identical content yields an identical hash
/// everywhere.
pub fn content_hash(entries: &[HashEntry]) -> String {
    let mut lines: Vec<String> = entries
        .iter()
        .filter(|e| base_name(&e.rel_path) != SKID_FILE)
        .map(|e| format!("{}\0{}", e.rel_path, e.sha256))
        .collect();
    lines.sort();
    sha256(&lines.join("\n"))
}

/// Content hash over a manifest's managed files, stripping the leading
/// `<skill name>/` install-dir prefix from each `rel_path` before hashing.
fn files_content_hash(skill_name: &str, files: &[ManagedFile]) -> String {
    let prefix = format!("{skill_name}/");
    let entries: Vec<HashEntry> = files
        .iter()
        .map(|f| HashEntry {
            rel_path: f
                .rel_path
                .strip_prefix(&prefix)
                .unwrap_or(&f.rel_path)
                .to_string(),
            sha256: f.sha256.clone(),
        })
        .collect();
    content_hash(&entries)
}

/// Content hash of an installed skill from its manifest. Strips the leading
/// `<skill name>/` install-dir prefix from each managed file's `rel_path`
/// before hashing. Port of `manifestContentHash` in `kernel/hashing.ts`.
pub fn manifest_content_hash(manifest: &InstallManifest) -> String {
    files_content_hash(&manifest.skill_id.name, &manifest.files)
}

/// Content hash of a resolved (working-tree) skill's body. Reads each body file
/// through `fs` and hashes by skill-relative path (the `root_path` prefix
/// stripped). Port of `resolvedContentHash` in `kernel/hashing.ts`.
pub fn resolved_content_hash(
    fs: &dyn FsPort,
    source_root: &str,
    resolved: &ResolvedSkill,
) -> PortResult<String> {
    let prefix_len = resolved.root_path.len() + 1;
    let mut entries: Vec<HashEntry> = Vec::with_capacity(resolved.files.len());
    for rel in &resolved.files {
        let within = &rel[prefix_len..];
        let content = fs.read_file(&format!("{source_root}/{rel}"))?;
        entries.push(HashEntry {
            rel_path: within.to_string(),
            sha256: sha256(&content),
        });
    }
    Ok(content_hash(&entries))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentKind, AgentTarget, Scope, SkillId, SkillManifest};
    use crate::testing::MemFs;

    // Known SHA-256 of the ASCII string "abc".
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    // Known SHA-256 of the empty input.
    const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    #[test]
    fn hashes_a_known_string_to_the_canonical_hex_digest() {
        assert_eq!(sha256("abc"), ABC_SHA256);
    }

    #[test]
    fn hashes_the_empty_string() {
        assert_eq!(sha256(""), EMPTY_SHA256);
    }

    #[test]
    fn hashes_bytes_identically_to_the_equivalent_string() {
        assert_eq!(sha256_bytes("abc".as_bytes()), ABC_SHA256);
    }

    #[test]
    fn hash_tree_returns_managed_files_sorted_by_rel_path() {
        let fs = MemFs::new()
            .with_file("/root/b.txt", "abc")
            .with_file("/root/a.txt", "")
            .with_file("/root/sub/c.txt", "abc");
        let result = hash_tree(&fs, "/root", &["b.txt", "a.txt", "sub/c.txt"]).unwrap();
        assert_eq!(
            result,
            vec![
                ManagedFile {
                    rel_path: "a.txt".to_string(),
                    sha256: EMPTY_SHA256.to_string(),
                    executable: false,
                },
                ManagedFile {
                    rel_path: "b.txt".to_string(),
                    sha256: ABC_SHA256.to_string(),
                    executable: false,
                },
                ManagedFile {
                    rel_path: "sub/c.txt".to_string(),
                    sha256: ABC_SHA256.to_string(),
                    executable: false,
                },
            ]
        );
    }

    #[test]
    fn hash_tree_reflects_the_executable_bit() {
        let fs = MemFs::new().with_file("/root/run.sh", "abc");
        fs.chmod("/root/run.sh", true).unwrap();
        let result = hash_tree(&fs, "/root", &["run.sh"]).unwrap();
        assert!(result[0].executable);
    }

    #[test]
    fn hash_tree_returns_empty_for_no_paths() {
        let fs = MemFs::new();
        assert_eq!(hash_tree(&fs, "/root", &[]).unwrap(), vec![]);
    }

    #[test]
    fn content_hash_excludes_skid_and_is_order_independent() {
        let a = vec![
            HashEntry {
                rel_path: "b.txt".to_string(),
                sha256: ABC_SHA256.to_string(),
            },
            HashEntry {
                rel_path: "a.txt".to_string(),
                sha256: EMPTY_SHA256.to_string(),
            },
        ];
        let b = vec![
            HashEntry {
                rel_path: "a.txt".to_string(),
                sha256: EMPTY_SHA256.to_string(),
            },
            HashEntry {
                rel_path: "b.txt".to_string(),
                sha256: ABC_SHA256.to_string(),
            },
        ];
        assert_eq!(content_hash(&a), content_hash(&b));

        // Adding a .skid.yml entry (at any depth) does not change the hash.
        let mut with_skid = a.clone();
        with_skid.push(HashEntry {
            rel_path: ".skid.yml".to_string(),
            sha256: ABC_SHA256.to_string(),
        });
        with_skid.push(HashEntry {
            rel_path: "nested/.skid.yml".to_string(),
            sha256: EMPTY_SHA256.to_string(),
        });
        assert_eq!(content_hash(&a), content_hash(&with_skid));
    }

    #[test]
    fn content_hash_matches_explicit_line_format() {
        let entries = vec![HashEntry {
            rel_path: "a.txt".to_string(),
            sha256: EMPTY_SHA256.to_string(),
        }];
        let expected = sha256(&format!("a.txt\0{EMPTY_SHA256}"));
        assert_eq!(content_hash(&entries), expected);
    }

    fn manifest_with_files(name: &str, files: Vec<ManagedFile>) -> InstallManifest {
        InstallManifest {
            skill_id: SkillId {
                group: None,
                name: name.to_string(),
            },
            target: AgentTarget {
                agent: AgentKind::Claude,
                scope: Scope::Global,
                project_id: None,
            },
            destination_root: "/dest".to_string(),
            source_repo_id: None,
            source_remote: None,
            source_path: None,
            content_hash: None,
            version: None,
            installed_at: "2026-07-17T00:00:00.000Z".to_string(),
            files,
            hook_edits: vec![],
        }
    }

    #[test]
    fn manifest_content_hash_strips_skill_name_prefix() {
        let manifest = manifest_with_files(
            "mySkill",
            vec![
                ManagedFile {
                    rel_path: "mySkill/a.txt".to_string(),
                    sha256: EMPTY_SHA256.to_string(),
                    executable: false,
                },
                ManagedFile {
                    rel_path: "mySkill/b.txt".to_string(),
                    sha256: ABC_SHA256.to_string(),
                    executable: false,
                },
            ],
        );
        let stripped = vec![
            HashEntry {
                rel_path: "a.txt".to_string(),
                sha256: EMPTY_SHA256.to_string(),
            },
            HashEntry {
                rel_path: "b.txt".to_string(),
                sha256: ABC_SHA256.to_string(),
            },
        ];
        assert_eq!(manifest_content_hash(&manifest), content_hash(&stripped));
    }

    #[test]
    fn resolved_content_hash_hashes_skill_relative_body() {
        let fs = MemFs::new()
            .with_file("/src/fmt/prettier/SKILL.md", "abc")
            .with_file("/src/fmt/prettier/run.sh", "");
        let resolved = ResolvedSkill {
            id: SkillId {
                group: Some("fmt".to_string()),
                name: "prettier".to_string(),
            },
            root_path: "fmt/prettier".to_string(),
            manifest: SkillManifest {
                name: "prettier".to_string(),
                version: None,
                description: None,
                license: None,
                executables: None,
                hooks: None,
            },
            files: vec![
                "fmt/prettier/SKILL.md".to_string(),
                "fmt/prettier/run.sh".to_string(),
            ],
            hooks: vec![],
        };
        let expected = content_hash(&[
            HashEntry {
                rel_path: "SKILL.md".to_string(),
                sha256: ABC_SHA256.to_string(),
            },
            HashEntry {
                rel_path: "run.sh".to_string(),
                sha256: EMPTY_SHA256.to_string(),
            },
        ]);
        assert_eq!(
            resolved_content_hash(&fs, "/src", &resolved).unwrap(),
            expected
        );
    }
}
