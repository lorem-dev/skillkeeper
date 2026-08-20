//! Tauri command surface.
//!
//! Each command is a thin `#[tauri::command]` wrapper over a plain function that
//! takes `&AppContext`, so the domain logic is exercised directly in unit tests
//! (a `tauri::State` is awkward to construct). Command names mirror the existing
//! Electron IPC channels (dots replaced by underscores) for a mechanical
//! frontend rewire in Phase 4.

pub mod app_update;
pub mod config;
pub mod dialog;
pub mod editors;
pub mod mcp;
pub mod onboarding;
pub mod projects;
pub mod repositories;
pub mod skills;
pub mod ssh_key;
pub mod state_read;
pub mod terminal;
pub mod window;

use std::sync::Arc;

use tauri::State;

use crate::state::AppContext;

/// Run a blocking closure against the shared [`AppContext`] on the runtime's
/// blocking thread pool, off the async worker threads.
///
/// Every command body is synchronous (git subprocesses, PTY marker waits,
/// filesystem and native-config writes). Running that directly inside an
/// `async fn` command occupies one of the runtime's bounded async worker
/// threads for the whole operation; enough concurrent heavy commands -- or one
/// blocked on the [`GitQueue`](crate::pty) mutex -- can exhaust the pool and
/// stall every unrelated command, re-freezing the UI. `spawn_blocking` moves the
/// work to the large blocking pool so a slow op only ties up a throwaway thread.
///
/// The context is shared as `Arc<AppContext>` so a cheap handle can be moved
/// into the `'static` closure.
pub(crate) async fn blocking<T, F>(ctx: &State<'_, Arc<AppContext>>, f: F) -> Result<T, String>
where
    F: FnOnce(&AppContext) -> T + Send + 'static,
    T: Send + 'static,
{
    let ctx = Arc::clone(ctx.inner());
    tauri::async_runtime::spawn_blocking(move || f(&ctx))
        .await
        .map_err(|e| e.to_string())
}

/// Phase 2 acceptance test: an end-to-end drive of the command surface against a
/// hermetic [`test_support::TempAppData`]. Kept inside the crate because
/// `TempAppData`/`AppContext` are not reachable from an external `tests/` file.
#[cfg(test)]
mod integration;

#[cfg(test)]
pub(crate) mod test_support {
    //! Shared test fixtures: a throwaway app-data directory wired into an
    //! [`AppContext`], removed on drop, plus a generator for the private SSH
    //! keys the ssh-key tests need.

    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use skillkeeper_core::adapters::SystemHostEnv;
    use ssh_key::{rand_core::OsRng, Algorithm, LineEnding, PrivateKey};

    use crate::state::{AppContext, AppPaths};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// A unique temporary app-data dir and an [`AppContext`] pointed at it.
    pub struct TempAppData {
        dir: PathBuf,
        pub ctx: AppContext,
    }

    impl TempAppData {
        /// Create a fresh temp dir and build a context around it.
        pub fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "skillkeeper-test-{}-{}-{}",
                std::process::id(),
                nanos,
                n
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let paths = AppPaths {
                config_yaml: dir.join("config.yaml").to_string_lossy().into_owned(),
                state_json: dir.join("state.json").to_string_lossy().into_owned(),
                app_update_json: dir.join("app-update.json").to_string_lossy().into_owned(),
                repositories_dir: dir.join("repositories").to_string_lossy().into_owned(),
            };
            // Point the host home at an isolated dir so global-scope agent
            // paths (~/.codex, ~/.claude, ...) never touch the real home.
            let home = dir.join("home");
            std::fs::create_dir_all(&home).unwrap();
            let env = SystemHostEnv::with_home(home.to_string_lossy().into_owned());
            let ctx = AppContext::with_paths(env, paths).unwrap();
            Self { dir, ctx }
        }

        /// The throwaway app-data directory itself, for tests that need to put
        /// a file next to the config (see [`write_key`]).
        pub fn dir(&self) -> &Path {
            &self.dir
        }
    }

    /// Write a fresh ed25519 private key to `dir/name`, encrypted when a
    /// passphrase is given, and return its absolute path.
    ///
    /// Generated per test run, so no private key material is committed.
    pub fn write_key(dir: &Path, name: &str, passphrase: Option<&str>) -> String {
        let path = dir.join(name);
        let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let key = match passphrase {
            Some(p) => key.encrypt(&mut OsRng, p).unwrap(),
            None => key,
        };
        std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        path.to_string_lossy().into_owned()
    }

    impl Drop for TempAppData {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}
