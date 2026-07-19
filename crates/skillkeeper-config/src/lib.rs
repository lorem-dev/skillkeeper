//! SkillKeeper user configuration (Rust port of `packages/config`).
//!
//! Provides the section schemas ([`schema`]), their defaults
//! ([`default_config`]), and graceful load/save of `config.yaml`
//! ([`load_config`], [`save_config`]). Loading never errors: an invalid section
//! degrades to its default and records a warning (see [`LoadConfigResult`]).

pub mod load;
pub mod schema;

pub use load::{load_config, save_config, LoadConfigResult, SectionValidity, Validity};
pub use schema::{
    default_config, AgentKind, AgentsConfig, Animations, ExecutablesConfig, GeneralConfig,
    HookConsentPolicy, Language, McpConfig, McpPreset, McpTransport, NotificationsConfig,
    ProjectsConfig, RepositoriesConfig, Section, SecurityConfig, SkillKeeperConfig, Theme,
    UpdatesConfig, UpdatesMode, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, SECTIONS,
};
