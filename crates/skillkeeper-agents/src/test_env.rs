//! A minimal in-memory [`HostEnv`] for the crate's unit tests, mirroring the
//! plain `{ homeDir, platform, env }` objects the TypeScript tests build.

use std::collections::HashMap;

use skillkeeper_core::ports::HostEnv;

/// Test-only host environment with a fixed home dir and a variable map.
pub struct FakeEnv {
    home: String,
    platform: String,
    vars: HashMap<String, String>,
}

impl FakeEnv {
    /// A new environment rooted at `home`, on the `linux` platform, with no
    /// variables set.
    pub fn new(home: &str) -> Self {
        Self {
            home: home.to_string(),
            platform: "linux".to_string(),
            vars: HashMap::new(),
        }
    }

    /// Builder: set an environment variable.
    pub fn with_var(mut self, key: &str, value: &str) -> Self {
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
