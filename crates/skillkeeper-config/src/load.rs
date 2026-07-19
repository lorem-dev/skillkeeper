//! Load/save of `config.yaml` (Rust port of `packages/config/src/load.ts`).
//!
//! Loading is graceful: `load_config` never errors. Each section is validated
//! independently; an invalid section is replaced by its default, its validity
//! flag is set to `Invalid`, and a warning is recorded. A YAML parse failure
//! marks every section invalid.

use serde::de::DeserializeOwned;
use serde_yaml_ng::{Mapping, Value};

use skillkeeper_core::ports::{FsPort, PortError, PortResult};

use crate::schema::{
    default_config, AgentsConfig, ExecutablesConfig, GeneralConfig, McpConfig, NotificationsConfig,
    ProjectsConfig, RepositoriesConfig, Section, SecurityConfig, SkillKeeperConfig, UpdatesConfig,
    MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, SECTIONS,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/// Validity of a single config section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/",
        rename_all = "lowercase"
    )
)]
pub enum Validity {
    Valid,
    Invalid,
}

/// Per-section validity indicator (mirrors the TS `SectionValidity` record).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
pub struct SectionValidity {
    pub general: Validity,
    pub updates: Validity,
    pub agents: Validity,
    pub executables: Validity,
    pub security: Validity,
    pub notifications: Validity,
    pub repositories: Validity,
    pub projects: Validity,
    pub mcp: Validity,
}

impl SectionValidity {
    fn all_valid() -> Self {
        Self {
            general: Validity::Valid,
            updates: Validity::Valid,
            agents: Validity::Valid,
            executables: Validity::Valid,
            security: Validity::Valid,
            notifications: Validity::Valid,
            repositories: Validity::Valid,
            projects: Validity::Valid,
            mcp: Validity::Valid,
        }
    }

    fn set(&mut self, section: Section, value: Validity) {
        match section {
            Section::General => self.general = value,
            Section::Updates => self.updates = value,
            Section::Agents => self.agents = value,
            Section::Executables => self.executables = value,
            Section::Security => self.security = value,
            Section::Notifications => self.notifications = value,
            Section::Repositories => self.repositories = value,
            Section::Projects => self.projects = value,
            Section::Mcp => self.mcp = value,
        }
    }

    /// True when every section is valid.
    pub fn all(&self, value: Validity) -> bool {
        SECTIONS.iter().all(|s| self.get(*s) == value)
    }

    /// Read the validity of a single section.
    pub fn get(&self, section: Section) -> Validity {
        match section {
            Section::General => self.general,
            Section::Updates => self.updates,
            Section::Agents => self.agents,
            Section::Executables => self.executables,
            Section::Security => self.security,
            Section::Notifications => self.notifications,
            Section::Repositories => self.repositories,
            Section::Projects => self.projects,
            Section::Mcp => self.mcp,
        }
    }
}

/// Result of loading a config file.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
pub struct LoadConfigResult {
    /// The resolved configuration. Invalid sections are replaced by defaults.
    pub config: SkillKeeperConfig,
    /// Per-section validity indicator.
    pub validity: SectionValidity,
    /// Human-readable warnings, one per invalid section.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Per-section validation
// ---------------------------------------------------------------------------

/// Extra, range/length-style validation that `serde` cannot express on its own.
trait Validate {
    fn is_valid(&self) -> bool {
        true
    }
}

impl Validate for GeneralConfig {}
impl Validate for AgentsConfig {}
impl Validate for ExecutablesConfig {}
impl Validate for SecurityConfig {}
impl Validate for NotificationsConfig {}
impl Validate for RepositoriesConfig {}

impl Validate for UpdatesConfig {
    fn is_valid(&self) -> bool {
        (MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&self.interval_minutes)
    }
}

impl Validate for ProjectsConfig {
    fn is_valid(&self) -> bool {
        (MIN_INTERVAL_MINUTES..=MAX_INTERVAL_MINUTES).contains(&self.check_interval_minutes)
    }
}

impl Validate for McpConfig {
    fn is_valid(&self) -> bool {
        self.servers
            .iter()
            .all(|s| !s.id.is_empty() && !s.name.is_empty())
    }
}

/// Validate one section of a raw parsed mapping.
///
/// Mirrors the TS `validateSection(schema, raw ?? {})`: a missing or null
/// section value is treated as an empty mapping (so every field falls back to
/// its default). Returns `None` on a deserialize or validation failure.
fn validate_section<T>(raw: Option<&Value>) -> Option<T>
where
    T: DeserializeOwned + Validate,
{
    let value = match raw {
        Some(v) if !v.is_null() => v.clone(),
        _ => Value::Mapping(Mapping::new()),
    };
    let parsed: T = serde_yaml_ng::from_value(value).ok()?;
    if parsed.is_valid() {
        Some(parsed)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// load_config
// ---------------------------------------------------------------------------

/// Load `config.yaml` from `path` using the given [`FsPort`].
///
/// - If the file does not exist, returns full defaults (all sections valid).
/// - Each section is validated independently. An invalid section is replaced in
///   the returned `config` by its default value; the raw file on disk is left
///   untouched.
/// - A warning is appended to `warnings` for every invalid section.
///
/// This function never returns an error: a missing/unreadable file or an
/// unparseable YAML document degrades to defaults rather than failing.
pub fn load_config(fs: &dyn FsPort, path: &str) -> LoadConfigResult {
    let mut config = default_config();
    let mut validity = SectionValidity::all_valid();
    let mut warnings: Vec<String> = Vec::new();

    // File missing (or existence check failed) -> full defaults, all valid.
    if !fs.exists(path).unwrap_or(false) {
        return LoadConfigResult {
            config,
            validity,
            warnings,
        };
    }

    // Unreadable despite existing -> treat like missing (defaults, all valid).
    let text = match fs.read_file(path) {
        Ok(t) => t,
        Err(_) => {
            return LoadConfigResult {
                config,
                validity,
                warnings,
            };
        }
    };

    // Parse YAML. If YAML itself is invalid, treat every section as invalid.
    let raw: Value = match serde_yaml_ng::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            for section in SECTIONS {
                validity.set(section, Validity::Invalid);
                warnings.push(format!(
                    "Config section \"{}\" is invalid (YAML parse error); using defaults.",
                    section.as_str()
                ));
            }
            return LoadConfigResult {
                config,
                validity,
                warnings,
            };
        }
    };

    // Only a top-level mapping carries sections; anything else -> empty.
    let empty = Mapping::new();
    let map = match &raw {
        Value::Mapping(m) => m,
        _ => &empty,
    };

    macro_rules! load_section {
        ($section:expr, $field:ident, $ty:ty) => {{
            let key = $section.as_str();
            match validate_section::<$ty>(map.get(key)) {
                Some(parsed) => config.$field = parsed,
                None => {
                    validity.set($section, Validity::Invalid);
                    warnings.push(format!(
                        "Config section \"{}\" is invalid; using defaults.",
                        key
                    ));
                }
            }
        }};
    }

    load_section!(Section::General, general, GeneralConfig);
    load_section!(Section::Updates, updates, UpdatesConfig);
    load_section!(Section::Agents, agents, AgentsConfig);
    load_section!(Section::Executables, executables, ExecutablesConfig);
    load_section!(Section::Security, security, SecurityConfig);
    load_section!(Section::Notifications, notifications, NotificationsConfig);
    load_section!(Section::Repositories, repositories, RepositoriesConfig);
    load_section!(Section::Projects, projects, ProjectsConfig);
    load_section!(Section::Mcp, mcp, McpConfig);

    LoadConfigResult {
        config,
        validity,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// save_config
// ---------------------------------------------------------------------------

/// Atomically write `config` to `path` as YAML.
///
/// Writes to a `.tmp` sibling first, then renames to the final path so a crash
/// mid-write cannot leave a partial file.
pub fn save_config(fs: &dyn FsPort, path: &str, config: &SkillKeeperConfig) -> PortResult<()> {
    let yaml = serde_yaml_ng::to_string(config)
        .map_err(|e| PortError::Other(format!("failed to serialize config: {e}")))?;
    let tmp = format!("{path}.tmp");
    fs.write_file(&tmp, &yaml)?;
    fs.rename(&tmp, path)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{AgentKind, HookConsentPolicy, Language, McpPreset, McpTransport, Theme};
    use skillkeeper_core::testing::MemFs;
    use std::cell::RefCell;

    const CONFIG_PATH: &str = "/home/user/.config/skillkeeper/config.yaml";

    const VALID_YAML: &str = r#"general:
  language: de
  theme: dark
  defaultEditor: code

updates:
  mode: scheduled
  intervalMinutes: 12
  checkOnStartup: true

agents:
  enabled:
    - claude
    - codex
  overrides:
    claude:
      skillsDir: ~/.custom/skills

executables:
  globs:
    - "*.sh"
    - "bin/*"

security:
  hookConsentPolicy: always-ask

notifications:
  enabled: true

repositories:
  gitPath: /usr/bin/git

mcp:
  servers:
    - id: abc123
      name: github
      type: stdio
      command: npx
      args:
        - "-y"
        - "@modelcontextprotocol/server-github"
"#;

    fn mem(path: &str, content: &str) -> MemFs {
        MemFs::new().with_file(path, content)
    }

    #[test]
    fn loads_a_fully_valid_file_with_all_sections_valid() {
        let fs = mem(CONFIG_PATH, VALID_YAML);
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.config.general.language, Language::De);
        assert_eq!(result.config.updates.interval_minutes, 12);
        assert_eq!(
            result.config.agents.enabled,
            vec![AgentKind::Claude, AgentKind::Codex]
        );
        assert_eq!(
            result.config.executables.globs,
            vec!["*.sh".to_string(), "bin/*".to_string()]
        );
        assert_eq!(
            result.config.security.hook_consent_policy,
            HookConsentPolicy::AlwaysAsk
        );
        assert!(result.config.notifications.enabled);
        assert_eq!(result.config.repositories.git_path, "/usr/bin/git");
        assert_eq!(
            result.config.mcp.servers,
            vec![McpPreset {
                id: "abc123".to_string(),
                name: "github".to_string(),
                r#type: McpTransport::Stdio,
                url: None,
                headers: None,
                command: Some("npx".to_string()),
                args: Some(vec![
                    "-y".to_string(),
                    "@modelcontextprotocol/server-github".to_string()
                ]),
                env: None,
                rules: None,
            }]
        );

        assert!(result.validity.all(Validity::Valid));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn replaces_invalid_section_with_default_and_adds_warning() {
        let bad_yaml = r#"general:
  language: de

updates:
  mode: manual
  intervalMinutes: -999

agents:
  enabled:
    - claude

executables:
  globs: []

security:
  hookConsentPolicy: always-ask

notifications:
  enabled: false
"#;
        let fs = mem(CONFIG_PATH, bad_yaml);
        let result = load_config(&fs, CONFIG_PATH);

        // Invalid section falls back to default.
        assert_eq!(result.validity.updates, Validity::Invalid);
        assert_eq!(
            result.config.updates.interval_minutes,
            default_config().updates.interval_minutes
        );

        // Other sections remain as parsed.
        assert_eq!(result.validity.general, Validity::Valid);
        assert_eq!(result.config.general.language, Language::De);
        assert_eq!(result.validity.agents, Validity::Valid);
        assert_eq!(result.validity.executables, Validity::Valid);
        assert_eq!(result.validity.security, Validity::Valid);
        assert_eq!(result.validity.notifications, Validity::Valid);
        assert_eq!(result.validity.repositories, Validity::Valid);

        // A warning is added for the invalid section.
        assert!(!result.warnings.is_empty());
        assert!(result.warnings.iter().any(|w| w.contains("updates")));

        // The file on disk is NOT rewritten.
        let raw = fs.read_file(CONFIG_PATH).unwrap();
        assert!(raw.contains("intervalMinutes: -999"));
    }

    #[test]
    fn returns_full_defaults_when_file_does_not_exist() {
        let fs = MemFs::new();
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.config, default_config());
        assert!(result.validity.all(Validity::Valid));
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn handles_completely_invalid_yaml_all_sections_invalid() {
        let fs = mem(CONFIG_PATH, "general: [invalid yaml structure");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.config, default_config());
        assert!(result.validity.all(Validity::Invalid));
        assert!(!result.warnings.is_empty());
    }

    #[test]
    fn handles_file_with_only_one_section() {
        let fs = mem(CONFIG_PATH, "general:\n  language: ru\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.general, Validity::Valid);
        assert_eq!(result.config.general.language, Language::Ru);

        // Missing sections get defaults and are marked valid.
        assert_eq!(result.validity.updates, Validity::Valid);
        assert_eq!(result.config.updates, default_config().updates);
    }

    #[test]
    fn marks_general_invalid_when_language_unknown() {
        let fs = mem(CONFIG_PATH, "general:\n  language: klingon\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.general, Validity::Invalid);
        assert_eq!(result.config.general, default_config().general);
        assert!(result.warnings.iter().any(|w| w.contains("general")));
    }

    #[test]
    fn marks_agents_invalid_when_enabled_has_unknown_kind() {
        let fs = mem(CONFIG_PATH, "agents:\n  enabled:\n    - unknownagent\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.agents, Validity::Invalid);
        assert_eq!(result.config.agents, default_config().agents);
        assert!(result.warnings.iter().any(|w| w.contains("agents")));
    }

    #[test]
    fn marks_executables_invalid_when_globs_not_array() {
        let fs = mem(CONFIG_PATH, "executables:\n  globs: not-an-array\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.executables, Validity::Invalid);
        assert_eq!(result.config.executables, default_config().executables);
        assert!(result.warnings.iter().any(|w| w.contains("executables")));
    }

    #[test]
    fn marks_security_invalid_when_policy_unknown() {
        let fs = mem(CONFIG_PATH, "security:\n  hookConsentPolicy: never-ask\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.security, Validity::Invalid);
        assert_eq!(result.config.security, default_config().security);
        assert!(result.warnings.iter().any(|w| w.contains("security")));
    }

    #[test]
    fn marks_notifications_invalid_when_enabled_not_boolean() {
        let fs = mem(CONFIG_PATH, "notifications:\n  enabled: \"yes\"\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.notifications, Validity::Invalid);
        assert_eq!(result.config.notifications, default_config().notifications);
        assert!(result.warnings.iter().any(|w| w.contains("notifications")));
    }

    #[test]
    fn handles_top_level_array_by_using_defaults() {
        let fs = mem(CONFIG_PATH, "- item1\n- item2\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.config, default_config());
        assert!(result.validity.all(Validity::Valid));
    }

    #[test]
    fn defaults_repositories_git_path_to_git() {
        let fs = MemFs::new();
        let result = load_config(&fs, "/does/not/exist.yaml");
        assert_eq!(result.config.repositories.git_path, "git");
        assert_eq!(result.validity.repositories, Validity::Valid);
    }

    #[test]
    fn defaults_theme_to_system() {
        let fs = MemFs::new();
        let result = load_config(&fs, "/does/not/exist.yaml");
        assert_eq!(result.config.general.theme, Theme::System);
    }

    #[test]
    fn marks_repositories_invalid_when_git_path_not_string() {
        let fs = mem(CONFIG_PATH, "repositories:\n  gitPath: 123\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.repositories, Validity::Invalid);
        assert_eq!(result.config.repositories, default_config().repositories);
        assert!(result.warnings.iter().any(|w| w.contains("repositories")));
    }

    #[test]
    fn marks_general_invalid_when_theme_unknown() {
        let fs = mem(CONFIG_PATH, "general:\n  theme: neon\n");
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.general, Validity::Invalid);
        assert_eq!(result.config.general, default_config().general);
        assert!(result.warnings.iter().any(|w| w.contains("general")));
    }

    #[test]
    fn defaults_mcp_to_empty_servers_list() {
        let fs = MemFs::new();
        let result = load_config(&fs, "/does/not/exist.yaml");
        assert!(result.config.mcp.servers.is_empty());
        assert_eq!(result.validity.mcp, Validity::Valid);
    }

    #[test]
    fn loads_valid_mcp_section_with_manual_preset() {
        let yaml = r#"mcp:
  servers:
    - id: preset-1
      name: weather
      type: http
      url: "https://example.com/mcp"
      headers:
        Authorization: "Bearer {token}"
"#;
        let fs = mem(CONFIG_PATH, yaml);
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.mcp, Validity::Valid);
        let mut headers = std::collections::BTreeMap::new();
        headers.insert("Authorization".to_string(), "Bearer {token}".to_string());
        assert_eq!(
            result.config.mcp.servers,
            vec![McpPreset {
                id: "preset-1".to_string(),
                name: "weather".to_string(),
                r#type: McpTransport::Http,
                url: Some("https://example.com/mcp".to_string()),
                headers: Some(headers),
                command: None,
                args: None,
                env: None,
                rules: None,
            }]
        );
    }

    #[test]
    fn marks_mcp_invalid_when_preset_missing_id() {
        let yaml = r#"mcp:
  servers:
    - name: weather
      type: http
      url: "https://example.com/mcp"
"#;
        let fs = mem(CONFIG_PATH, yaml);
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.mcp, Validity::Invalid);
        assert_eq!(result.config.mcp, default_config().mcp);
        assert!(result.warnings.iter().any(|w| w.contains("mcp")));
    }

    #[test]
    fn marks_mcp_invalid_when_preset_has_unknown_transport() {
        let yaml = r#"mcp:
  servers:
    - id: preset-1
      name: weather
      type: websocket
"#;
        let fs = mem(CONFIG_PATH, yaml);
        let result = load_config(&fs, CONFIG_PATH);

        assert_eq!(result.validity.mcp, Validity::Invalid);
        assert_eq!(result.config.mcp, default_config().mcp);
        assert!(result.warnings.iter().any(|w| w.contains("mcp")));
    }

    #[test]
    fn save_writes_valid_yaml_that_can_be_read_back() {
        let fs = MemFs::new();
        save_config(&fs, CONFIG_PATH, &default_config()).unwrap();

        let result = load_config(&fs, CONFIG_PATH);
        assert_eq!(result.config, default_config());
        assert!(result.validity.all(Validity::Valid));
    }

    /// Wraps a [`MemFs`], recording every `rename` call, to assert atomicity.
    struct TrackingFs {
        inner: MemFs,
        renames: RefCell<Vec<(String, String)>>,
    }

    impl FsPort for TrackingFs {
        fn read_file(&self, path: &str) -> PortResult<String> {
            self.inner.read_file(path)
        }
        fn write_file(&self, path: &str, content: &str) -> PortResult<()> {
            self.inner.write_file(path, content)
        }
        fn list(&self, path: &str) -> PortResult<Vec<String>> {
            self.inner.list(path)
        }
        fn stat(&self, path: &str) -> PortResult<Option<skillkeeper_core::ports::FileStat>> {
            self.inner.stat(path)
        }
        fn exists(&self, path: &str) -> PortResult<bool> {
            self.inner.exists(path)
        }
        fn mkdir(&self, path: &str) -> PortResult<()> {
            self.inner.mkdir(path)
        }
        fn remove(&self, path: &str) -> PortResult<()> {
            self.inner.remove(path)
        }
        fn remove_dir_if_empty(&self, path: &str) -> PortResult<()> {
            self.inner.remove_dir_if_empty(path)
        }
        fn chmod(&self, path: &str, executable: bool) -> PortResult<()> {
            self.inner.chmod(path, executable)
        }
        fn rename(&self, from: &str, to: &str) -> PortResult<()> {
            self.renames
                .borrow_mut()
                .push((from.to_string(), to.to_string()));
            self.inner.rename(from, to)
        }
    }

    #[test]
    fn save_uses_atomic_rename() {
        let fs = TrackingFs {
            inner: MemFs::new(),
            renames: RefCell::new(Vec::new()),
        };

        save_config(&fs, CONFIG_PATH, &default_config()).unwrap();

        let renames = fs.renames.borrow();
        assert_eq!(renames.len(), 1);
        let (from, to) = &renames[0];
        assert_eq!(to, CONFIG_PATH);
        assert_ne!(from, CONFIG_PATH);
    }
}
