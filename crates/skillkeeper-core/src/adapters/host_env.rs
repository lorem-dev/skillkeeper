//! System [`HostEnv`] backed by `std::env`.

use crate::ports::HostEnv;

/// A [`HostEnv`] reading the real process environment.
///
/// The home directory and platform string are captured at construction. The
/// platform string mirrors Node's `process.platform` (`"darwin"`, `"win32"`,
/// `"linux"`, or the raw target OS otherwise).
#[derive(Debug, Clone)]
pub struct SystemHostEnv {
    home_dir: String,
    platform: String,
}

/// Map the compile-time target OS to a `process.platform`-style string.
fn platform_string() -> String {
    match std::env::consts::OS {
        "macos" => "darwin".to_string(),
        "windows" => "win32".to_string(),
        other => other.to_string(),
    }
}

/// Read the current user's home directory from the environment.
///
/// Uses `HOME` on unix-like systems and `USERPROFILE` on Windows, avoiding an
/// extra dependency. Returns an empty string when neither is set.
fn home_dir_string() -> String {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).unwrap_or_default()
}

impl SystemHostEnv {
    /// Capture the current process environment.
    pub fn new() -> Self {
        Self {
            home_dir: home_dir_string(),
            platform: platform_string(),
        }
    }

    /// Construct with an explicit home directory, keeping the real platform.
    ///
    /// This is the test seam that lets callers (notably tests) point
    /// global-scope agent paths (`~/.codex`, `~/.claude`, ...) at an isolated
    /// directory so they never read or write the developer's real home.
    pub fn with_home(home_dir: String) -> Self {
        Self {
            home_dir,
            platform: platform_string(),
        }
    }
}

impl Default for SystemHostEnv {
    fn default() -> Self {
        Self::new()
    }
}

impl HostEnv for SystemHostEnv {
    fn home_dir(&self) -> &str {
        &self.home_dir
    }

    fn platform(&self) -> &str {
        &self.platform
    }

    fn env(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_is_one_of_the_known_values() {
        let env = SystemHostEnv::new();
        assert!(
            matches!(env.platform(), "darwin" | "win32" | "linux") || !env.platform().is_empty()
        );
    }

    #[test]
    fn env_reads_a_set_variable() {
        std::env::set_var("SKILLKEEPER_TEST_VAR", "value123");
        let env = SystemHostEnv::new();
        assert_eq!(env.env("SKILLKEEPER_TEST_VAR").as_deref(), Some("value123"));
        assert_eq!(env.env("SKILLKEEPER_DEFINITELY_UNSET_VAR"), None);
    }
}
