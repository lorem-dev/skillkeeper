//! Tauri composition root.
//!
//! [`AppPaths`] resolves the OS-specific application-data locations (a port of
//! the CLI `packages/cli/src/paths.ts`), and [`AppContext`] wires the concrete
//! domain adapters, the resolved paths, a state-write lock, and the agent
//! adapter registry into a single value that becomes Tauri managed state.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use skillkeeper_agents::{register_builtin_agents, AdapterRegistry};
use skillkeeper_core::adapters::{StdFs, SystemClock, SystemGit, SystemHostEnv};
use skillkeeper_core::ports::HostEnv;

use crate::app::watcher::ConfigWatcher;
use crate::pty::{resolve_shell, TerminalManager};

/// OS-specific application-data paths for SkillKeeper.
///
/// Precedence mirrors the CLI `appDataDir`:
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

/// The wired-up domain dependencies shared by every command.
///
/// Held as Tauri managed state; commands borrow it via `tauri::State`.
pub struct AppContext {
    /// Real filesystem port.
    pub fs: StdFs,
    /// Subprocess git port (wired now; consumed by later-wave repository
    /// commands).
    #[allow(dead_code)]
    pub git: SystemGit,
    /// System clock port (wired now; consumed by later-wave mutating commands).
    #[allow(dead_code)]
    pub clock: SystemClock,
    /// Host environment port (home dir, platform, env vars).
    pub env: SystemHostEnv,
    /// Resolved application-data paths.
    pub paths: AppPaths,
    /// Serializes state-file writes across concurrent commands.
    pub state_lock: Mutex<()>,
    /// Registered agent adapters (wired now; consumed by later-wave skill/mcp
    /// commands).
    #[allow(dead_code)]
    pub registry: AdapterRegistry,
    /// Polls `config.yaml` for external edits and re-baselines after a
    /// self-write from `config_set`.
    pub config_watcher: ConfigWatcher,
    /// Persistent interactive PTY shell. Internally synchronised, so it lives
    /// here directly; the reader thread's output is pumped to the frontend in
    /// `lib.rs` setup via its event receiver.
    pub terminal: TerminalManager,
}

impl AppContext {
    /// Build the composition root, resolving paths from the real environment.
    ///
    /// # Errors
    ///
    /// Returns an error when the built-in agent adapters cannot be registered.
    pub fn new() -> Result<Self, String> {
        let env = SystemHostEnv::new();
        let paths = AppPaths::resolve(&env);
        Self::with_paths(env, paths)
    }

    /// Build the composition root with an explicit environment and paths.
    ///
    /// Used by tests to point the context at a fresh temporary app-data dir.
    ///
    /// # Errors
    ///
    /// Returns an error when the built-in agent adapters cannot be registered.
    pub fn with_paths(env: SystemHostEnv, paths: AppPaths) -> Result<Self, String> {
        let mut registry = AdapterRegistry::new();
        register_builtin_agents(&mut registry).map_err(|e| e.to_string())?;
        let config_watcher = ConfigWatcher::new(paths.config_yaml.clone());
        // Wire the interactive shell: platform-appropriate login shell, launched
        // in the host home dir with the host process environment inherited.
        let shell = resolve_shell(
            env.platform(),
            env.env("COMSPEC").as_deref(),
            env.env("SHELL").as_deref(),
        );
        let terminal = TerminalManager::new(
            shell,
            env.home_dir().to_string(),
            std::env::vars().collect(),
        );
        Ok(Self {
            fs: StdFs::new(),
            git: SystemGit::new(),
            clock: SystemClock::new(),
            env,
            paths,
            state_lock: Mutex::new(()),
            registry,
            config_watcher,
            terminal,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// Minimal [`HostEnv`] double for path-resolution tests.
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
}
