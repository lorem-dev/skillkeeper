//! CLI composition root (Rust port of `packages/cli/src/wiring.ts` and
//! `packages/cli/src/paths.ts`).
//!
//! [`AppPaths`] resolves the OS-specific application-data locations; [`Wiring`]
//! builds the concrete domain adapters and the agent adapter registry. The path
//! precedence and the `AppPaths` shape mirror the desktop
//! `apps/desktop/src-tauri/src/state.rs` so both front ends read and write the
//! same files.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use skillkeeper_agents::{register_builtin_agents, AdapterRegistry};
use skillkeeper_config::SkillKeeperConfig;
use skillkeeper_core::adapters::{StdFs, SystemClock, SystemGit, SystemHostEnv};
use skillkeeper_core::key_format::{sniff, KeyFormat};
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
    /// loaded config, matching the desktop wiring. It also honours
    /// `repositories.sshKeyPath` when set, without ever holding a passphrase:
    /// the CLI lets `ssh` prompt in the terminal it already owns.
    ///
    /// # Errors
    ///
    /// Returns an error when the built-in agent adapters cannot be registered.
    pub fn build(config: &SkillKeeperConfig) -> Result<Self, String> {
        let env = SystemHostEnv::new();
        let paths = AppPaths::resolve(&env);

        let git_path = config.repositories.git_path.clone();
        let ssh_key_path = config.repositories.ssh_key_path.clone();
        let git = SystemGit::with_git_path(move || git_path.clone())
            .with_env(move || git_env_for(ssh_key_path.clone()));

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

/// Whether this process has already told the user about a PuTTY key.
///
/// Process-wide, because the advice is too: it names a one-off `puttygen`
/// command to run, and it is the same command however many repositories the
/// current invocation touches.
static PUTTY_WARNED: AtomicBool = AtomicBool::new(false);

/// Whether this is the first PuTTY key this process has seen, marking it seen.
///
/// [`git_env_for`] is the `with_env` closure, so it runs once per git
/// subprocess -- an update across N repositories would otherwise print the
/// same four-line advice N times. Takes the flag as an argument rather than
/// reading the static, so the once-ness can be tested without depending on
/// what the rest of the process has already printed.
fn first_putty_warning(warned: &AtomicBool) -> bool {
    !warned.swap(true, Ordering::Relaxed)
}

/// Extra git environment for a configured SSH key, or nothing when unset. The
/// CLI holds no passphrase: `ssh` prompts in the terminal it already owns.
///
/// A PuTTY-format key yields nothing at all -- every time, not just the first.
/// `ssh -i` cannot read that format, so naming the file would turn every SSH
/// remote into an error; saying nothing leaves the user's own agent and
/// `~/.ssh/config` exactly as they were. The desktop app supports these keys
/// directly, and the warning says so, once per process.
fn git_env_for(ssh_key_path: Option<String>) -> Vec<(String, String)> {
    match ssh_key_path {
        Some(path) if !path.trim().is_empty() => {
            let path = path.trim();
            if is_putty_key(path) {
                if first_putty_warning(&PUTTY_WARNED) {
                    eprintln!(
                        "warning: {path} is a PuTTY-format key, which ssh cannot read. \
                         The SkillKeeper desktop app supports it directly; for the CLI, \
                         convert it once:\n  \
                         puttygen {path} -O private-openssh-new -o <new-key>\n  \
                         then set repositories.sshKeyPath to <new-key>."
                    );
                }
                return Vec::new();
            }
            skillkeeper_core::ssh_env::ssh_env_vars(path, None)
        }
        _ => Vec::new(),
    }
}

/// Whether the file at `path` is a PuTTY key. An unreadable file is not: the
/// key may simply be on a disk that is not mounted yet, and that case must keep
/// its existing behaviour of offering the identity and letting `ssh` decide.
fn is_putty_key(path: &str) -> bool {
    std::fs::read_to_string(path)
        .map(|text| sniff(&text) == KeyFormat::Putty)
        .unwrap_or(false)
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

    #[test]
    fn git_env_is_empty_without_a_configured_key() {
        assert!(git_env_for(None).is_empty());
    }

    #[test]
    fn git_env_points_at_the_configured_key() {
        let vars = git_env_for(Some("/home/u/.ssh/id_ed25519".to_string()));
        assert_eq!(
            vars.iter()
                .find(|(k, _)| k == "GIT_SSH_COMMAND")
                .map(|(_, v)| v.as_str()),
            Some("ssh -i /home/u/.ssh/id_ed25519")
        );
        // The CLI never has a passphrase to give; ssh asks in its own terminal.
        assert!(vars.iter().all(|(k, _)| k != "SSH_ASKPASS"));
    }

    #[test]
    fn a_putty_key_yields_no_variables() {
        // `ssh -i` cannot read a .ppk, so pointing git at one would break every
        // SSH remote. Offering nothing leaves the user's agent and ~/.ssh/config
        // to work as they always did.
        // Per-run unique: a fixed name is shared with a concurrent or crashed
        // prior run, and this one is left behind for the next.
        let dir = std::env::temp_dir().join(format!("sk-ppk-wiring-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key = dir.join("id.ppk");
        std::fs::write(
            &key,
            "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n",
        )
        .unwrap();
        // Every invocation, not just the first: only the warning is once, and
        // returning the identity on a later call would break every SSH remote.
        for _ in 0..3 {
            let vars = git_env_for(Some(key.to_string_lossy().into_owned()));
            assert!(vars.is_empty(), "expected no variables, got {vars:?}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `git_env_for` is the `with_env` closure, evaluated once per git
    /// subprocess, so an update across N repositories would print the same
    /// four-line `puttygen` advice N times. The flag is passed in rather than
    /// read from the static so this does not depend on what the rest of the
    /// process has already printed.
    #[test]
    fn the_putty_warning_is_printed_only_once_per_process() {
        let warned = AtomicBool::new(false);
        assert!(first_putty_warning(&warned));
        assert!(!first_putty_warning(&warned));
        assert!(!first_putty_warning(&warned));
    }

    #[test]
    fn a_missing_key_file_still_yields_the_identity() {
        // Unreadable is not the same as PuTTY-formatted: the key may live on a
        // disk that is not mounted yet, and the existing behaviour (offer it,
        // let ssh decide) must survive.
        let vars = git_env_for(Some("/nonexistent/id_ed25519".to_string()));
        assert!(vars.iter().any(|(k, _)| k == "GIT_SSH_COMMAND"));
    }
}
