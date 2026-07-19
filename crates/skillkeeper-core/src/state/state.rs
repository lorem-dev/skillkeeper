//! Application state store (Rust port of `packages/core/src/state/state.ts`).
//!
//! SkillKeeper keeps its own bookkeeping - tracked repositories, tracked
//! projects, and install manifests with file hashes - in a JSON state file
//! written only by SkillKeeper. Writes are atomic (temp file then rename). This
//! module is pure over an injected [`FsPort`] so it is testable with the
//! in-memory fake.
//!
//! Divergence from the TypeScript source: `loadState` returns a `Promise` that
//! rejects with a `StateError` on a corrupt/ill-shaped file. To preserve that
//! throwing behavior (which the ported tests assert), [`load_state`] returns
//! `Result<AppState, StateError>` rather than a bare `AppState`. A missing file
//! still yields [`empty_state`]. Because the serde deserializer validates every
//! element, this port is slightly stricter than the TypeScript `hasStateShape`
//! (which only checks that the top-level arrays exist).

use thiserror::Error;

use crate::models::AppState;
use crate::ports::FsPort;

/// Raised when a state file exists but cannot be parsed or has a bad shape.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct StateError(pub String);

/// A fresh, empty state at the current version.
pub fn empty_state() -> AppState {
    AppState::empty()
}

/// Whether a parsed JSON value has the top-level state shape (a numeric
/// `version` and the three required arrays), mirroring the TypeScript
/// `hasStateShape` guard.
fn has_state_shape(value: &serde_json::Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.get("version").is_some_and(serde_json::Value::is_number)
        && obj
            .get("repositories")
            .is_some_and(serde_json::Value::is_array)
        && obj.get("projects").is_some_and(serde_json::Value::is_array)
        && obj.get("installs").is_some_and(serde_json::Value::is_array)
}

/// Load the state file. Returns a fresh empty state when the file does not
/// exist; returns [`StateError`] when it exists but is not valid state.
///
/// # Errors
///
/// Returns [`StateError`] on invalid JSON, an unexpected shape, or an
/// underlying read failure.
pub fn load_state(fs: &dyn FsPort, path: &str) -> Result<AppState, StateError> {
    if !fs.exists(path).map_err(|e| StateError(e.to_string()))? {
        return Ok(empty_state());
    }
    let raw = fs.read_file(path).map_err(|e| StateError(e.to_string()))?;
    let parsed: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|_| StateError(format!("State file is not valid JSON: {path}")))?;
    if !has_state_shape(&parsed) {
        return Err(StateError(format!(
            "State file has an unexpected shape: {path}"
        )));
    }
    serde_json::from_value(parsed)
        .map_err(|_| StateError(format!("State file has an unexpected shape: {path}")))
}

/// Persist state atomically (write to a temp file, then rename into place).
///
/// # Errors
///
/// Returns [`StateError`] on a serialization or underlying write/rename
/// failure.
pub fn save_state(fs: &dyn FsPort, path: &str, state: &AppState) -> Result<(), StateError> {
    let temp_path = format!("{path}.tmp");
    let json = serde_json::to_string_pretty(state).map_err(|e| StateError(e.to_string()))?;
    fs.write_file(&temp_path, &format!("{json}\n"))
        .map_err(|e| StateError(e.to_string()))?;
    fs.rename(&temp_path, path)
        .map_err(|e| StateError(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Project, Repository, RepositoryKind, Transport, STATE_VERSION};
    use crate::ports::{FileStat, FsPort, PortError, PortResult};
    use crate::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";

    /// Which single filesystem operation the [`FaultyFs`] should fail; every
    /// other operation delegates to the in-memory fake.
    #[derive(Clone, Copy)]
    enum Fault {
        None,
        Exists,
        Read,
        Write,
        Rename,
    }

    /// An [`FsPort`] that injects one failure, for exercising the error-mapping
    /// paths in [`load_state`] and [`save_state`].
    struct FaultyFs {
        inner: MemFs,
        fault: Fault,
    }

    impl FaultyFs {
        fn new(fault: Fault) -> Self {
            Self {
                inner: MemFs::new(),
                fault,
            }
        }
    }

    impl FsPort for FaultyFs {
        fn read_file(&self, path: &str) -> PortResult<String> {
            if matches!(self.fault, Fault::Read) {
                return Err(PortError::Io("read failed".to_string()));
            }
            self.inner.read_file(path)
        }
        fn write_file(&self, path: &str, content: &str) -> PortResult<()> {
            if matches!(self.fault, Fault::Write) {
                return Err(PortError::Io("write failed".to_string()));
            }
            self.inner.write_file(path, content)
        }
        fn list(&self, path: &str) -> PortResult<Vec<String>> {
            self.inner.list(path)
        }
        fn stat(&self, path: &str) -> PortResult<Option<FileStat>> {
            self.inner.stat(path)
        }
        fn exists(&self, path: &str) -> PortResult<bool> {
            if matches!(self.fault, Fault::Exists) {
                return Err(PortError::Io("exists failed".to_string()));
            }
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
            if matches!(self.fault, Fault::Rename) {
                return Err(PortError::Io("rename failed".to_string()));
            }
            self.inner.rename(from, to)
        }
    }

    fn sample_repository() -> Repository {
        Repository {
            id: "r1".to_string(),
            name: "skills".to_string(),
            url: "git@github.com:acme/skills.git".to_string(),
            kind: RepositoryKind::Github,
            transport: Transport::Ssh,
            lfs: true,
            local_path: "/data/repos/r1".to_string(),
            last_fetched: None,
            branch: None,
        }
    }

    #[test]
    fn returns_a_fresh_empty_state_when_the_file_does_not_exist() {
        let fs = MemFs::new();
        let state = load_state(&fs, STATE_PATH).unwrap();
        assert_eq!(state, empty_state());
        assert_eq!(state.version, STATE_VERSION);
    }

    #[test]
    fn round_trips_an_empty_state() {
        let fs = MemFs::new();
        save_state(&fs, STATE_PATH, &empty_state()).unwrap();
        assert_eq!(load_state(&fs, STATE_PATH).unwrap(), empty_state());
    }

    #[test]
    fn round_trips_populated_state() {
        let fs = MemFs::new();
        let state = AppState {
            version: STATE_VERSION,
            repositories: vec![sample_repository()],
            projects: vec![Project {
                id: "p1".to_string(),
                path: "/work/app".to_string(),
                name: "app".to_string(),
                added_at: "2026-06-27T00:00:00.000Z".to_string(),
            }],
            installs: vec![],
        };
        save_state(&fs, STATE_PATH, &state).unwrap();
        assert_eq!(load_state(&fs, STATE_PATH).unwrap(), state);
    }

    #[test]
    fn writes_atomically_with_no_leftover_temp_file() {
        let fs = MemFs::new();
        save_state(&fs, STATE_PATH, &empty_state()).unwrap();
        assert!(!fs.exists(&format!("{STATE_PATH}.tmp")).unwrap());
        assert!(fs.exists(STATE_PATH).unwrap());
    }

    #[test]
    fn errors_on_invalid_json() {
        let fs = MemFs::new();
        fs.write_file(STATE_PATH, "not json{").unwrap();
        assert!(load_state(&fs, STATE_PATH).is_err());
    }

    #[test]
    fn errors_on_an_unexpected_shape() {
        let fs = MemFs::new();
        fs.write_file(STATE_PATH, "{\"version\":1}").unwrap();
        assert!(load_state(&fs, STATE_PATH).is_err());
    }

    #[test]
    fn errors_when_the_json_is_a_primitive_not_an_object() {
        let fs = MemFs::new();
        fs.write_file(STATE_PATH, "42").unwrap();
        assert!(load_state(&fs, STATE_PATH).is_err());
    }

    #[test]
    fn errors_when_a_json_array_is_used_instead_of_an_object() {
        let fs = MemFs::new();
        fs.write_file(STATE_PATH, "[]").unwrap();
        assert!(load_state(&fs, STATE_PATH).is_err());
    }

    #[test]
    fn errors_when_a_required_top_level_array_has_the_wrong_type() {
        // `version` is numeric and all keys are present, but `repositories` is a
        // string rather than an array, so the shape guard rejects it.
        let fs = MemFs::new();
        fs.write_file(
            STATE_PATH,
            r#"{"version":1,"repositories":"nope","projects":[],"installs":[]}"#,
        )
        .unwrap();
        let err = load_state(&fs, STATE_PATH).unwrap_err();
        assert!(err.0.contains("unexpected shape"));
    }

    #[test]
    fn errors_when_the_shape_is_valid_but_an_element_is_malformed() {
        // Passes the top-level shape guard (numeric version, three arrays) but
        // a repository entry is missing required fields, so element-level
        // deserialization fails.
        let fs = MemFs::new();
        fs.write_file(
            STATE_PATH,
            r#"{"version":1,"repositories":[{"id":"r1"}],"projects":[],"installs":[]}"#,
        )
        .unwrap();
        let err = load_state(&fs, STATE_PATH).unwrap_err();
        assert!(err.0.contains("unexpected shape"));
    }

    #[test]
    fn load_state_surfaces_an_exists_failure() {
        let fs = FaultyFs::new(Fault::Exists);
        assert!(load_state(&fs, STATE_PATH).is_err());
    }

    #[test]
    fn load_state_surfaces_a_read_failure() {
        let fs = FaultyFs::new(Fault::Read);
        // Seed the file so the existence check passes and the read is reached.
        fs.inner.write_file(STATE_PATH, "{}").unwrap();
        assert!(load_state(&fs, STATE_PATH).is_err());
    }

    #[test]
    fn save_state_surfaces_a_write_failure() {
        let fs = FaultyFs::new(Fault::Write);
        assert!(save_state(&fs, STATE_PATH, &empty_state()).is_err());
    }

    #[test]
    fn save_state_surfaces_a_rename_failure() {
        let fs = FaultyFs::new(Fault::Rename);
        assert!(save_state(&fs, STATE_PATH, &empty_state()).is_err());
    }

    #[test]
    fn faulty_fs_delegates_non_failing_operations() {
        // Covers the passthrough methods so the test double is a faithful
        // `FsPort` when no fault is injected.
        let fs = FaultyFs::new(Fault::None);
        fs.write_file("/d/a.txt", "hi").unwrap();
        assert_eq!(fs.read_file("/d/a.txt").unwrap(), "hi");
        assert!(fs.exists("/d/a.txt").unwrap());
        assert_eq!(fs.list("/d").unwrap(), vec!["a.txt".to_string()]);
        assert!(fs.stat("/d/a.txt").unwrap().unwrap().is_file);
        fs.chmod("/d/a.txt", true).unwrap();
        assert!(fs.stat("/d/a.txt").unwrap().unwrap().executable);
        fs.mkdir("/e").unwrap();
        fs.rename("/d/a.txt", "/d/b.txt").unwrap();
        assert!(fs.exists("/d/b.txt").unwrap());
        fs.remove("/d/b.txt").unwrap();
        fs.remove_dir_if_empty("/e").unwrap();
        assert!(!fs.exists("/e").unwrap());
    }
}
