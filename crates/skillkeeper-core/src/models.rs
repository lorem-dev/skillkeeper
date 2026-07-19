//! Domain data model for the SkillKeeper core (Rust port of
//! `packages/core/src/kernel/model.ts`, plus the resolver/install/verify/state
//! data types from `packages/core/src/skills`, `install`, and `state`).
//!
//! These are plain, framework-agnostic data types shared across the domain.
//! Every type that is persisted or serialized to JSON derives `serde` and uses
//! `#[serde(rename_all = "camelCase")]` (and, on enums, explicit value renames)
//! so the on-disk shape round-trips byte-compatibly with the TypeScript source.
//! Optional fields skip serialization when absent, matching `JSON.stringify`
//! dropping `undefined`.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Supported AI coding agents. Extended by adding a new adapter module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Copilot,
    Cursor,
    Opencode,
}

impl AgentKind {
    /// The wire/string identifier, matching the TS string-literal union
    /// (`"claude"`, `"codex"`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Copilot => "copilot",
            AgentKind::Cursor => "cursor",
            AgentKind::Opencode => "opencode",
        }
    }
}

impl fmt::Display for AgentKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Stable identity of a skill: an optional one-level group plus a name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct SkillId {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    pub name: String,
}

/// How a hook applies its edit to an agent's configuration.
///
/// - `delimited-text`: a comment-delimited region in a comment-capable file.
/// - `json-merge`: a node merged into a JSON config, tagged with an ownership
///   marker.
/// - `file`: a hook-owned standalone file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HookStrategy {
    DelimitedText,
    JsonMerge,
    File,
}

/// Parsed `SKILL.md` frontmatter. The Markdown body is documentation and is not
/// part of this record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifest {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// Relative paths (within the skill body) that must be marked executable
    /// after install. Globs are matched separately via configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executables: Option<Vec<String>>,
    /// Names of hooks declared by this skill (each maps to a `hooks/<name>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<Vec<String>>,
}

/// Where a hook writes its edit: an agent, plus either a file pattern (text and
/// file strategies) or a config key path (json-merge strategy).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTarget {
    pub agent: AgentKind,
    /// Glob or relative path of the file to edit (text and file strategies).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_pattern: Option<String>,
    /// Dotted key path inside a JSON config (json-merge strategy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
}

/// Parsed `HOOK.md` frontmatter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookManifest {
    pub name: String,
    pub target: HookTarget,
    pub strategy: HookStrategy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A hook discovered alongside a skill in a working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHook {
    pub manifest: HookManifest,
    /// Path to `hooks/<name>/HOOK.md` relative to the repo root.
    pub manifest_path: String,
    /// All hook file paths (including HOOK.md) relative to the repo root.
    pub files: Vec<String>,
}

/// A skill discovered in a checked-out working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSkill {
    pub id: SkillId,
    /// Directory containing SKILL.md, relative to the repo root.
    pub root_path: String,
    pub manifest: SkillManifest,
    /// Skill body file paths relative to the repo root, excluding everything
    /// under `hooks/`. Sorted for stable ordering.
    pub files: Vec<String>,
    pub hooks: Vec<ResolvedHook>,
}

/// Result of resolving skills from a working tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    pub skills: Vec<ResolvedSkill>,
    /// Human-readable warnings for unresolved or invalid paths.
    pub warnings: Vec<String>,
}

/// The transport used to reach a Git remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum RepositoryKind {
    Github,
    Bitbucket,
    Generic,
}

/// The transport scheme used to reach a Git remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Ssh,
    Https,
}

/// A Git remote that holds one or more skills.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub url: String,
    pub kind: RepositoryKind,
    pub transport: Transport,
    pub lfs: bool,
    pub local_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_fetched: Option<String>,
    /// User-selected branch to track; the repo is force-checked-out to it and
    /// updates apply it. Absent means the clone's default branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// The scope an install targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Project,
    Global,
}

/// A concrete (agent, scope) destination for an install.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct AgentTarget {
    pub agent: AgentKind,
    pub scope: Scope,
    /// Identifies the tracked project when scope is `project`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
}

impl AgentTarget {
    /// A global-scope target for the given agent.
    pub fn global(agent: AgentKind) -> Self {
        Self {
            agent,
            scope: Scope::Global,
            project_id: None,
        }
    }

    /// A project-scope target for the given agent.
    pub fn project(agent: AgentKind, project_id: Option<&str>) -> Self {
        Self {
            agent,
            scope: Scope::Project,
            project_id: project_id.map(str::to_string),
        }
    }
}

/// A single managed file recorded in an install manifest (and produced by
/// [`crate::hashing::hash_tree`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct ManagedFile {
    /// Path relative to the install destination root (or hashed root).
    pub rel_path: String,
    pub sha256: String,
    pub executable: bool,
}

/// One applied hook edit, recorded so it can be verified and removed precisely.
/// Tagged union discriminated by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ManagedHookEdit {
    /// A comment-delimited region in a text file.
    Delimited {
        /// Path of the edited text file, relative to the destination root.
        file: String,
        delimiter_id: String,
        sha256: String,
    },
    /// A node merged into a JSON config.
    Json {
        /// Path of the edited JSON file, relative to the destination root.
        file: String,
        /// Dotted key path of the array the node was merged into.
        key_path: String,
        marker_id: String,
        sha256: String,
    },
    /// A hook-owned standalone file.
    File {
        rel_path: String,
        sha256: String,
        executable: bool,
    },
}

/// The record of one installed skill at one agent target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub skill_id: SkillId,
    pub target: AgentTarget,
    /// Absolute destination root the files live under.
    pub destination_root: String,
    /// Source repository id, when installed from a repository.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_repo_id: Option<String>,
    /// Source repository remote URL, mirrored into the skill's `.skid.yml`. The
    /// stable identity used to match an install to a repository (across re-adds)
    /// and to decide whether an update is available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_remote: Option<String>,
    /// Source local path, when installed from a working tree.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Content hash of the installed skill body (skill-relative paths, excluding
    /// `.skid.yml`). Compared against a repository skill's hash to detect
    /// updates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// ISO-8601 install timestamp.
    pub installed_at: String,
    pub files: Vec<ManagedFile>,
    pub hook_edits: Vec<ManagedHookEdit>,
}

/// A tracked project directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub path: String,
    pub name: String,
    /// ISO-8601 timestamp.
    pub added_at: String,
}

/// Per-file or per-edit verification status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VerifyStatus {
    Ok,
    Modified,
    Missing,
    Extraneous,
}

/// Verification result for one managed file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVerification {
    pub rel_path: String,
    pub status: VerifyStatus,
}

/// Verification result for one managed hook edit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEditVerification {
    pub status: VerifyStatus,
    pub edit: ManagedHookEdit,
}

/// Full verification report for an installed skill.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    /// True only when every file and hook edit is `ok`.
    pub ok: bool,
    pub files: Vec<FileVerification>,
    pub hook_edits: Vec<HookEditVerification>,
}

/// Current on-disk state schema version, for forward migration.
pub const STATE_VERSION: i64 = 1;

/// The full persisted application state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub version: i64,
    pub repositories: Vec<Repository>,
    pub projects: Vec<Project>,
    pub installs: Vec<InstallManifest>,
}

impl AppState {
    /// A fresh, empty state at the current version.
    pub fn empty() -> Self {
        Self {
            version: STATE_VERSION,
            repositories: Vec::new(),
            projects: Vec::new(),
            installs: Vec::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::empty()
    }
}

/// Data configuration for an install or repair operation (port of the data
/// fields of `packages/core/src/install/install.ts`'s `InstallOptions`).
///
/// Divergence: the TypeScript `InstallOptions` also carries the `fs`, `adapter`,
/// `env`, and `now` ports/callbacks. Those are supplied to the install engine
/// as trait objects when it is ported in a later Phase 1 task, so they are not
/// part of this pure-data struct.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOptions {
    pub target: AgentTarget,
    /// Working-tree root the resolved skill paths are relative to.
    pub source_root: String,
    pub skill: ResolvedSkill,
    /// Whether to apply hooks (privileged; defaults to false).
    pub allow_hooks: bool,
    /// Globs (relative to the skill root) marked executable after install.
    pub executable_globs: Vec<String>,
    pub source_repo_id: Option<String>,
    /// Source repository remote URL, recorded in the skill's `.skid.yml` and
    /// manifest.
    pub source_remote: Option<String>,
    pub source_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(value).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn skill_id_round_trips_and_omits_absent_group() {
        let id = SkillId {
            group: None,
            name: "fmt".to_string(),
        };
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, r#"{"name":"fmt"}"#);
        assert_eq!(round_trip(&id), id);

        let grouped = SkillId {
            group: Some("shared".to_string()),
            name: "fmt".to_string(),
        };
        assert_eq!(round_trip(&grouped), grouped);
    }

    #[test]
    fn agent_kind_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&AgentKind::Claude).unwrap(),
            "\"claude\""
        );
        assert_eq!(
            serde_json::to_string(&AgentKind::Opencode).unwrap(),
            "\"opencode\""
        );
    }

    #[test]
    fn agent_kind_as_str_matches_serde_and_display() {
        for kind in [
            AgentKind::Claude,
            AgentKind::Codex,
            AgentKind::Copilot,
            AgentKind::Cursor,
            AgentKind::Opencode,
        ] {
            let serde_value = serde_json::to_string(&kind).unwrap();
            assert_eq!(serde_value, format!("\"{}\"", kind.as_str()));
            assert_eq!(kind.to_string(), kind.as_str());
        }
    }

    #[test]
    fn agent_target_constructors() {
        let global = AgentTarget::global(AgentKind::Claude);
        assert_eq!(
            global,
            AgentTarget {
                agent: AgentKind::Claude,
                scope: Scope::Global,
                project_id: None,
            }
        );

        let project = AgentTarget::project(AgentKind::Codex, Some("p1"));
        assert_eq!(
            project,
            AgentTarget {
                agent: AgentKind::Codex,
                scope: Scope::Project,
                project_id: Some("p1".to_string()),
            }
        );

        assert_eq!(
            AgentTarget::project(AgentKind::Cursor, None).project_id,
            None
        );
    }

    #[test]
    fn hook_strategy_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&HookStrategy::DelimitedText).unwrap(),
            "\"delimited-text\""
        );
        assert_eq!(
            serde_json::to_string(&HookStrategy::JsonMerge).unwrap(),
            "\"json-merge\""
        );
        assert_eq!(
            serde_json::to_string(&HookStrategy::File).unwrap(),
            "\"file\""
        );
    }

    #[test]
    fn resolved_skill_round_trips_with_camel_case_keys() {
        let skill = ResolvedSkill {
            id: SkillId {
                group: Some("fmt".to_string()),
                name: "prettier".to_string(),
            },
            root_path: "fmt/prettier".to_string(),
            manifest: SkillManifest {
                name: "prettier".to_string(),
                version: Some("1.2.3".to_string()),
                description: None,
                license: Some("MIT".to_string()),
                executables: Some(vec!["run.sh".to_string()]),
                hooks: None,
            },
            files: vec!["fmt/prettier/SKILL.md".to_string()],
            hooks: vec![ResolvedHook {
                manifest: HookManifest {
                    name: "on-save".to_string(),
                    target: HookTarget {
                        agent: AgentKind::Claude,
                        file_pattern: Some("*.md".to_string()),
                        key_path: None,
                    },
                    strategy: HookStrategy::DelimitedText,
                    version: None,
                    description: None,
                },
                manifest_path: "fmt/prettier/hooks/on-save/HOOK.md".to_string(),
                files: vec!["fmt/prettier/hooks/on-save/HOOK.md".to_string()],
            }],
        };
        let json = serde_json::to_string(&skill).unwrap();
        assert!(json.contains("\"rootPath\""));
        assert!(json.contains("\"manifestPath\""));
        assert!(json.contains("\"filePattern\""));
        assert_eq!(round_trip(&skill), skill);
    }

    #[test]
    fn managed_hook_edit_is_tagged_by_kind() {
        let delimited = ManagedHookEdit::Delimited {
            file: "settings".to_string(),
            delimiter_id: "abc123".to_string(),
            sha256: "deadbeef".to_string(),
        };
        let json = serde_json::to_string(&delimited).unwrap();
        assert!(json.contains("\"kind\":\"delimited\""));
        assert!(json.contains("\"delimiterId\""));
        assert_eq!(round_trip(&delimited), delimited);

        let json_edit = ManagedHookEdit::Json {
            file: "settings.json".to_string(),
            key_path: "hooks".to_string(),
            marker_id: "m1".to_string(),
            sha256: "cafe".to_string(),
        };
        let raw = serde_json::to_string(&json_edit).unwrap();
        assert!(raw.contains("\"kind\":\"json\""));
        assert!(raw.contains("\"keyPath\""));
        assert!(raw.contains("\"markerId\""));
        assert_eq!(round_trip(&json_edit), json_edit);

        let file_edit = ManagedHookEdit::File {
            rel_path: "s/hooks/x".to_string(),
            sha256: "00".to_string(),
            executable: true,
        };
        let raw = serde_json::to_string(&file_edit).unwrap();
        assert!(raw.contains("\"kind\":\"file\""));
        assert!(raw.contains("\"relPath\""));
        assert_eq!(round_trip(&file_edit), file_edit);
    }

    #[test]
    fn install_manifest_round_trips_and_omits_absent_optionals() {
        let manifest = InstallManifest {
            skill_id: SkillId {
                group: None,
                name: "fmt".to_string(),
            },
            target: AgentTarget {
                agent: AgentKind::Codex,
                scope: Scope::Global,
                project_id: None,
            },
            destination_root: "/home/u/.codex".to_string(),
            source_repo_id: Some("repo-1".to_string()),
            source_remote: None,
            source_path: None,
            content_hash: Some("abc".to_string()),
            version: None,
            installed_at: "2026-07-17T00:00:00.000Z".to_string(),
            files: vec![ManagedFile {
                rel_path: "fmt/SKILL.md".to_string(),
                sha256: "deadbeef".to_string(),
                executable: false,
            }],
            hook_edits: vec![],
        };
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(json.contains("\"skillId\""));
        assert!(json.contains("\"destinationRoot\""));
        assert!(json.contains("\"installedAt\""));
        assert!(json.contains("\"hookEdits\""));
        assert!(!json.contains("\"sourceRemote\""));
        assert!(!json.contains("\"version\""));
        assert_eq!(round_trip(&manifest), manifest);
    }

    #[test]
    fn verify_report_round_trips() {
        let report = VerifyReport {
            ok: false,
            files: vec![FileVerification {
                rel_path: "fmt/SKILL.md".to_string(),
                status: VerifyStatus::Modified,
            }],
            hook_edits: vec![HookEditVerification {
                status: VerifyStatus::Ok,
                edit: ManagedHookEdit::File {
                    rel_path: "fmt/hooks/x".to_string(),
                    sha256: "00".to_string(),
                    executable: false,
                },
            }],
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("\"hookEdits\""));
        assert!(json.contains("\"status\":\"modified\""));
        assert_eq!(round_trip(&report), report);
    }

    #[test]
    fn app_state_empty_and_round_trips() {
        let state = AppState::empty();
        assert_eq!(state.version, STATE_VERSION);
        assert!(state.repositories.is_empty());

        let populated = AppState {
            version: STATE_VERSION,
            repositories: vec![Repository {
                id: "r1".to_string(),
                name: "skills".to_string(),
                url: "git@github.com:acme/skills.git".to_string(),
                kind: RepositoryKind::Github,
                transport: Transport::Ssh,
                lfs: false,
                local_path: "/data/skills".to_string(),
                last_fetched: Some("2026-07-17T00:00:00.000Z".to_string()),
                branch: None,
            }],
            projects: vec![Project {
                id: "p1".to_string(),
                path: "/work/app".to_string(),
                name: "app".to_string(),
                added_at: "2026-07-17T00:00:00.000Z".to_string(),
            }],
            installs: vec![],
        };
        let json = serde_json::to_string(&populated).unwrap();
        assert!(json.contains("\"localPath\""));
        assert!(json.contains("\"lastFetched\""));
        assert!(json.contains("\"addedAt\""));
        assert!(json.contains("\"kind\":\"github\""));
        assert!(json.contains("\"transport\":\"ssh\""));
        assert_eq!(round_trip(&populated), populated);
    }
}
