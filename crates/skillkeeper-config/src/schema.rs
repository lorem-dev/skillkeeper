//! Config section schemas (Rust port of `packages/config/src/schema.ts`).
//!
//! Each section is a `serde` struct. Fields carry per-field defaults so that a
//! missing field (or an entirely absent section) resolves to the same default
//! as the TypeScript zod schemas. Enums use `serde` renaming to match the exact
//! YAML string values. Range/length constraints that `serde` cannot express are
//! enforced by the `Validate` impls in `crate::load`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_yaml_ng::Value;

// ---------------------------------------------------------------------------
// Shared interval bounds
// ---------------------------------------------------------------------------

/// Minimum for an interval, in minutes.
pub const MIN_INTERVAL_MINUTES: u32 = 1;
/// Maximum for an interval, in minutes (23 hours).
pub const MAX_INTERVAL_MINUTES: u32 = 23 * 60;

// ---------------------------------------------------------------------------
// Section: general
// ---------------------------------------------------------------------------

/// Display language. Mirrors the TS `language` enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "kebab-case")]
pub enum Language {
    En,
    De,
    Ru,
    Uk,
    Be,
    Fr,
    Ja,
    ZhCn,
    Pl,
    SrCyrl,
    SrLatn,
    ZhTw,
    Es,
    Pt,
    Ko,
    It,
}

/// UI theme preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

/// Entrance/exit animation speed across the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum Animations {
    Fast,
    Normal,
    Off,
}

/// General section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct GeneralConfig {
    /// Display language. Defaults to English.
    #[serde(default = "default_language")]
    pub language: Language,
    /// UI theme preference.
    #[serde(default = "default_theme")]
    pub theme: Theme,
    /// Entrance/exit animation speed across the UI.
    #[serde(default = "default_animations")]
    pub animations: Animations,
    /// Shell command used to open files in the user's editor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_editor: Option<String>,
}

fn default_language() -> Language {
    Language::En
}
fn default_theme() -> Theme {
    Theme::System
}
fn default_animations() -> Animations {
    Animations::Normal
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            language: default_language(),
            theme: default_theme(),
            animations: default_animations(),
            default_editor: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Section: updates
// ---------------------------------------------------------------------------

/// When to check for skill and repository updates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatesMode {
    Manual,
    OnStartup,
    Scheduled,
}

/// Updates section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesConfig {
    /// When to check for skill and repository updates.
    #[serde(default = "default_updates_mode")]
    pub mode: UpdatesMode,
    /// How often to check (minutes) when mode is "scheduled". 1 min .. 23 h.
    #[serde(default = "default_interval_minutes")]
    pub interval_minutes: u32,
    /// For "scheduled" mode: also run a check on startup.
    #[serde(default)]
    pub check_on_startup: bool,
}

fn default_updates_mode() -> UpdatesMode {
    UpdatesMode::OnStartup
}
fn default_interval_minutes() -> u32 {
    12 * 60
}

impl Default for UpdatesConfig {
    fn default() -> Self {
        Self {
            mode: default_updates_mode(),
            interval_minutes: default_interval_minutes(),
            check_on_startup: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Section: projects
// ---------------------------------------------------------------------------

/// Projects section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsConfig {
    /// How often to re-check tracked project folders (minutes). 1 min .. 23 h.
    #[serde(default = "default_check_interval_minutes")]
    pub check_interval_minutes: u32,
}

fn default_check_interval_minutes() -> u32 {
    1
}

impl Default for ProjectsConfig {
    fn default() -> Self {
        Self {
            check_interval_minutes: default_check_interval_minutes(),
        }
    }
}

// ---------------------------------------------------------------------------
// Section: agents
// ---------------------------------------------------------------------------

/// Supported agent kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
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

/// Agents section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct AgentsConfig {
    /// Which agent kinds to activate. Defaults to all supported kinds.
    #[serde(default = "default_enabled_agents")]
    pub enabled: Vec<AgentKind>,
    /// Per-agent overrides. Free-form records for forward compatibility.
    #[serde(default)]
    #[cfg_attr(test, ts(type = "Record<string, Record<string, unknown>>"))]
    pub overrides: BTreeMap<String, BTreeMap<String, Value>>,
}

fn default_enabled_agents() -> Vec<AgentKind> {
    vec![
        AgentKind::Claude,
        AgentKind::Codex,
        AgentKind::Copilot,
        AgentKind::Cursor,
        AgentKind::Opencode,
    ]
}

impl Default for AgentsConfig {
    fn default() -> Self {
        Self {
            enabled: default_enabled_agents(),
            overrides: BTreeMap::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Section: executables
// ---------------------------------------------------------------------------

/// Executables section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct ExecutablesConfig {
    /// Glob patterns; files matching any pattern get +x after install.
    #[serde(default)]
    pub globs: Vec<String>,
}

// ---------------------------------------------------------------------------
// Section: security
// ---------------------------------------------------------------------------

/// How SkillKeeper asks for hook-install consent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "kebab-case")]
pub enum HookConsentPolicy {
    AlwaysAsk,
}

/// Security section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct SecurityConfig {
    /// How SkillKeeper asks for hook-install consent.
    #[serde(default = "default_hook_consent_policy")]
    pub hook_consent_policy: HookConsentPolicy,
}

fn default_hook_consent_policy() -> HookConsentPolicy {
    HookConsentPolicy::AlwaysAsk
}

impl Default for SecurityConfig {
    fn default() -> Self {
        Self {
            hook_consent_policy: default_hook_consent_policy(),
        }
    }
}

// ---------------------------------------------------------------------------
// Section: notifications
// ---------------------------------------------------------------------------

/// Notifications section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsConfig {
    /// Whether to display system notifications (desktop only).
    #[serde(default = "default_notifications_enabled")]
    pub enabled: bool,
}

fn default_notifications_enabled() -> bool {
    true
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            enabled: default_notifications_enabled(),
        }
    }
}

// ---------------------------------------------------------------------------
// Section: repositories
// ---------------------------------------------------------------------------

/// Repositories section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct RepositoriesConfig {
    /// Path to the git executable used for repository operations.
    #[serde(default = "default_git_path")]
    pub git_path: String,
}

fn default_git_path() -> String {
    "git".to_string()
}

impl Default for RepositoriesConfig {
    fn default() -> Self {
        Self {
            git_path: default_git_path(),
        }
    }
}

// ---------------------------------------------------------------------------
// Section: mcp
// ---------------------------------------------------------------------------

/// Transport type of an MCP server preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// A manually-defined MCP server preset. Mirrors the TS `mcpPresetSchema`.
///
/// `id`, `name` and `type` are required; `id` and `name` must be non-empty
/// (enforced by the `Validate` impl in `crate::load`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct McpPreset {
    pub id: String,
    pub name: String,
    pub r#type: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<String>,
}

/// MCP section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    /// Manually-defined MCP server presets.
    #[serde(default)]
    pub servers: Vec<McpPreset>,
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/// All config sections combined.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/config/"
    )
)]
pub struct SkillKeeperConfig {
    pub general: GeneralConfig,
    pub updates: UpdatesConfig,
    pub agents: AgentsConfig,
    pub executables: ExecutablesConfig,
    pub security: SecurityConfig,
    pub notifications: NotificationsConfig,
    pub repositories: RepositoriesConfig,
    pub projects: ProjectsConfig,
    pub mcp: McpConfig,
}

/// Full configuration with all sections at their default values.
pub fn default_config() -> SkillKeeperConfig {
    SkillKeeperConfig::default()
}

// ---------------------------------------------------------------------------
// Section identifiers
// ---------------------------------------------------------------------------

/// A config section name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Section {
    General,
    Updates,
    Agents,
    Executables,
    Security,
    Notifications,
    Repositories,
    Projects,
    Mcp,
}

impl Section {
    /// The section's YAML key / display name.
    pub fn as_str(self) -> &'static str {
        match self {
            Section::General => "general",
            Section::Updates => "updates",
            Section::Agents => "agents",
            Section::Executables => "executables",
            Section::Security => "security",
            Section::Notifications => "notifications",
            Section::Repositories => "repositories",
            Section::Projects => "projects",
            Section::Mcp => "mcp",
        }
    }
}

/// All section names in a stable order.
pub const SECTIONS: [Section; 9] = [
    Section::General,
    Section::Updates,
    Section::Agents,
    Section::Executables,
    Section::Security,
    Section::Notifications,
    Section::Repositories,
    Section::Projects,
    Section::Mcp,
];
