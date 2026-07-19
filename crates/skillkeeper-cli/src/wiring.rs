//! CLI composition root (Rust port of `packages/cli/src/wiring.ts` and
//! `packages/cli/src/paths.ts`).
//!
//! [`AppPaths`] resolves the OS-specific application-data locations; [`Wiring`]
//! builds the concrete domain adapters and the agent adapter registry. The path
//! precedence and the `AppPaths` shape mirror the desktop
//! `apps/desktop/src-tauri/src/state.rs` so both front ends read and write the
//! same files.

use std::path::{Path, PathBuf};

use skillkeeper_agents::{register_builtin_agents, AdapterRegistry};
use skillkeeper_config::SkillKeeperConfig;
use skillkeeper_core::adapters::{StdFs, SystemClock, SystemGit, SystemHostEnv};
use skillkeeper_core::ports::HostEnv;

/// OS-specific application-data paths for SkillKeeper.
///
/// Precedence mirrors the CLI `appDataDir` (`paths.ts`) and the desktop
/// `AppPaths`:
///   Windows:     `%APPDATA%\skillkeeper`, or `~/.config/skillkeeper`
///   Linux/macOS: `$XDG_CONFIG_HOME/skillkeeper`, or `~/.config/skillkeeper`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// Absolute path to `config.yaml`.
    pub config_yaml: String,
    /// Absolute path to `state.json`.
    pub state_json: String,
    /// Absolute path to the directory holding repository clones.
    pub repositories_dir: String,
}

/// Resolve the SkillKeeper application-data directory for the current host.
fn app_data_dir(env: &dyn HostEnv) -> PathBuf {
    if env.platform() == "win32" {
        if let Some(appdata) = env.env("APPDATA") {
            if !appdata.trim().is_empty() {
                return Path::new(&appdata).join("skillkeeper");
            }
        }
    } else if let Some(xdg) = env.env("XDG_CONFIG_HOME") {
        if !xdg.trim().is_empty() {
            return Path::new(&xdg).join("skillkeeper");
        }
    }
    Path::new(env.home_dir())
        .join(".config")
        .join("skillkeeper")
}

impl AppPaths {
    /// Resolve every application-data path from the given host environment.
    pub fn resolve(env: &dyn HostEnv) -> Self {
        let base = app_data_dir(env);
        Self {
            config_yaml: base.join("config.yaml").to_string_lossy().into_owned(),
            state_json: base.join("state.json").to_string_lossy().into_owned(),
            repositories_dir: base.join("repositories").to_string_lossy().into_owned(),
        }
    }
}

/// The wired-up real ports and infrastructure for one CLI run.
///
/// Divergence from `wiring.ts`: there is no `Translator`. The Rust CLI is
/// English-only (see `messages.rs`), so no i18n port is wired.
pub struct Wiring {
    /// Real filesystem port.
    pub fs: StdFs,
    /// Subprocess git port, resolving the git binary from config.
    pub git: SystemGit,
    /// System clock port (source of install/fetch timestamps).
    pub clock: SystemClock,
    /// Host environment port (home dir, platform, env vars).
    pub env: SystemHostEnv,
    /// Registered agent adapters (consumed by the skill/mcp commands).
    pub registry: AdapterRegistry,
    /// The loaded configuration (source of `executables.globs` and the manual
    /// MCP presets in `mcp.servers`).
    pub config: SkillKeeperConfig,
    /// Resolved application-data paths.
    pub paths: AppPaths,
}

impl Wiring {
    /// Build a fully-wired set of real ports for a CLI run.
    ///
    /// The git port resolves its executable from `repositories.gitPath` in the
    /// loaded config, matching the desktop wiring.
    ///
    /// # Errors
    ///
    /// Returns an error when the built-in agent adapters cannot be registered.
    pub fn build(config: &SkillKeeperConfig) -> Result<Self, String> {
        let env = SystemHostEnv::new();
        let paths = AppPaths::resolve(&env);

        let git_path = config.repositories.git_path.clone();
        let git = SystemGit::with_git_path(move || git_path.clone());

        let mut registry = AdapterRegistry::new();
        register_builtin_agents(&mut registry).map_err(|e| e.to_string())?;

        Ok(Self {
            fs: StdFs::new(),
            git,
            clock: SystemClock::new(),
            env,
            registry,
            config: config.clone(),
            paths,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Minimal [`HostEnv`] double for path-resolution tests. Mirrors the double
    /// used in the desktop `state.rs` tests.
    struct FakeEnv {
        home: String,
        platform: String,
        vars: BTreeMap<String, String>,
    }

    impl FakeEnv {
        fn new(home: &str, platform: &str) -> Self {
            Self {
                home: home.to_string(),
                platform: platform.to_string(),
                vars: BTreeMap::new(),
            }
        }

        fn with_var(mut self, key: &str, value: &str) -> Self {
            self.vars.insert(key.to_string(), value.to_string());
            self
        }
    }

    impl HostEnv for FakeEnv {
        fn home_dir(&self) -> &str {
            &self.home
        }
        fn platform(&self) -> &str {
            &self.platform
        }
        fn env(&self, key: &str) -> Option<String> {
            self.vars.get(key).cloned()
        }
    }

    #[test]
    fn resolves_windows_appdata() {
        let env = FakeEnv::new("C:\\Users\\bob", "win32")
            .with_var("APPDATA", "C:\\Users\\bob\\AppData\\Roaming");
        let paths = AppPaths::resolve(&env);
        assert!(paths.config_yaml.contains("skillkeeper"));
        assert!(paths.config_yaml.ends_with("config.yaml"));
        assert!(paths.state_json.ends_with("state.json"));
        assert!(paths.repositories_dir.ends_with("repositories"));
    }

    #[test]
    fn resolves_xdg_config_home_on_unix() {
        let env = FakeEnv::new("/home/bob", "linux").with_var("XDG_CONFIG_HOME", "/home/bob/.xdg");
        let paths = AppPaths::resolve(&env);
        assert_eq!(paths.config_yaml, "/home/bob/.xdg/skillkeeper/config.yaml");
        assert_eq!(paths.state_json, "/home/bob/.xdg/skillkeeper/state.json");
        assert_eq!(
            paths.repositories_dir,
            "/home/bob/.xdg/skillkeeper/repositories"
        );
    }

    #[test]
    fn falls_back_to_home_config_when_no_env_var() {
        let env = FakeEnv::new("/home/bob", "linux");
        let paths = AppPaths::resolve(&env);
        assert_eq!(
            paths.config_yaml,
            "/home/bob/.config/skillkeeper/config.yaml"
        );
    }

    #[test]
    fn ignores_blank_env_var() {
        let env = FakeEnv::new("/home/bob", "linux").with_var("XDG_CONFIG_HOME", "   ");
        let paths = AppPaths::resolve(&env);
        assert_eq!(
            paths.config_yaml,
            "/home/bob/.config/skillkeeper/config.yaml"
        );
    }

    #[test]
    fn windows_falls_back_to_home_config_when_appdata_blank() {
        let env = FakeEnv::new("C:\\Users\\bob", "win32").with_var("APPDATA", "");
        let paths = AppPaths::resolve(&env);
        assert!(paths.config_yaml.contains(".config"));
        assert!(paths.config_yaml.ends_with("config.yaml"));
    }
}
