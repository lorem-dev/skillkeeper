//! Real filesystem [`FsPort`] backed by `std::fs` (Rust port of
//! `packages/core/src/kernel/nodeFs.ts`).
//!
//! This is the production counterpart to the in-memory [`crate::testing::MemFs`]
//! fake. Writes are atomic: content is written to a sibling temp file and then
//! renamed into place. All paths are UTF-8 and use the platform separator as
//! interpreted by [`std::path`].

use std::fs;
use std::io;
use std::path::Path;

use crate::ports::{FileStat, FsPort, PortError, PortResult};

/// Owner-executable permission bit (`0o100`).
#[cfg(unix)]
const OWNER_EXEC: u32 = 0o100;

/// A [`FsPort`] backed by the real filesystem via `std::fs`.
#[derive(Debug, Clone, Copy, Default)]
pub struct StdFs;

impl StdFs {
    /// Create a new real filesystem port.
    pub fn new() -> Self {
        Self
    }
}

/// Map an `io::Error` to a [`PortError`], tagging missing paths as `NotFound`.
fn map_err(path: &str, err: io::Error) -> PortError {
    if err.kind() == io::ErrorKind::NotFound {
        PortError::NotFound(path.to_string())
    } else {
        PortError::Io(format!("{path}: {err}"))
    }
}

/// Read the owner-executable bit from file metadata (always false off unix).
#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & OWNER_EXEC != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}

impl FsPort for StdFs {
    fn read_file(&self, path: &str) -> PortResult<String> {
        fs::read_to_string(path).map_err(|e| map_err(path, e))
    }

    fn write_file(&self, path: &str, content: &str) -> PortResult<()> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| map_err(&parent.to_string_lossy(), e))?;
            }
        }
        // Atomic write: temp file in the same directory, then rename over target.
        let temp = format!("{path}.tmp");
        fs::write(&temp, content).map_err(|e| map_err(&temp, e))?;
        fs::rename(&temp, path).map_err(|e| {
            // Best-effort cleanup of the temp file on a failed rename.
            let _ = fs::remove_file(&temp);
            map_err(path, e)
        })
    }

    fn list(&self, path: &str) -> PortResult<Vec<String>> {
        let entries = fs::read_dir(path).map_err(|e| map_err(path, e))?;
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| map_err(path, e))?;
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        Ok(names)
    }

    fn stat(&self, path: &str) -> PortResult<Option<FileStat>> {
        match fs::symlink_metadata(path) {
            Ok(meta) => Ok(Some(FileStat {
                is_file: meta.is_file(),
                is_directory: meta.is_dir(),
                executable: is_executable(&meta),
                size: meta.len(),
            })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(map_err(path, e)),
        }
    }

    fn exists(&self, path: &str) -> PortResult<bool> {
        Ok(Path::new(path).exists())
    }

    fn mkdir(&self, path: &str) -> PortResult<()> {
        fs::create_dir_all(path).map_err(|e| map_err(path, e))
    }

    fn remove(&self, path: &str) -> PortResult<()> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(map_err(path, e)),
        }
    }

    fn remove_dir_if_empty(&self, path: &str) -> PortResult<()> {
        // Portable "no-op when missing or non-empty": probe the directory first
        // rather than relying on a specific NotEmpty error kind.
        match fs::read_dir(path) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Ok(());
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(map_err(path, e)),
        }
        match fs::remove_dir(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(map_err(path, e)),
        }
    }

    #[cfg(unix)]
    fn chmod(&self, path: &str, executable: bool) -> PortResult<()> {
        use std::os::unix::fs::PermissionsExt;
        let meta = fs::metadata(path).map_err(|e| map_err(path, e))?;
        let mut perms = meta.permissions();
        let mode = perms.mode();
        let next = if executable {
            mode | OWNER_EXEC
        } else {
            mode & !OWNER_EXEC
        };
        perms.set_mode(next);
        fs::set_permissions(path, perms).map_err(|e| map_err(path, e))
    }

    #[cfg(not(unix))]
    fn chmod(&self, path: &str, _executable: bool) -> PortResult<()> {
        // No owner-executable bit on Windows; verify the path exists to match the
        // unix branch's failure behavior, then no-op.
        fs::metadata(path).map_err(|e| map_err(path, e))?;
        Ok(())
    }

    fn rename(&self, from: &str, to: &str) -> PortResult<()> {
        if let Some(parent) = Path::new(to).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent).map_err(|e| map_err(&parent.to_string_lossy(), e))?;
            }
        }
        fs::rename(from, to).map_err(|e| map_err(from, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A unique temp directory that removes itself on drop.
    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-stdfs-{}-{}", std::process::id(), n));
            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn join(&self, rel: &str) -> String {
            self.path.join(rel).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn write_creates_parents_and_reads_back() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        let p = dir.join("a/b/c.txt");
        fs.write_file(&p, "hello").unwrap();
        assert_eq!(fs.read_file(&p).unwrap(), "hello");
        // The temp sibling from the atomic write is gone.
        assert!(!Path::new(&format!("{p}.tmp")).exists());
    }

    #[test]
    fn write_overwrites_existing_atomically() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        let p = dir.join("f.txt");
        fs.write_file(&p, "one").unwrap();
        fs.write_file(&p, "two").unwrap();
        assert_eq!(fs.read_file(&p).unwrap(), "two");
    }

    #[test]
    fn read_missing_is_not_found() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        assert!(matches!(
            fs.read_file(&dir.join("nope")).unwrap_err(),
            PortError::NotFound(_)
        ));
    }

    #[test]
    fn list_returns_immediate_entry_names() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        fs.write_file(&dir.join("d/a.txt"), "1").unwrap();
        fs.write_file(&dir.join("d/sub/b.txt"), "2").unwrap();
        let mut names = fs.list(&dir.join("d")).unwrap();
        names.sort();
        assert_eq!(names, vec!["a.txt".to_string(), "sub".to_string()]);
    }

    #[test]
    fn stat_distinguishes_file_dir_and_missing() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        fs.write_file(&dir.join("a.txt"), "abc").unwrap();
        let file = fs.stat(&dir.join("a.txt")).unwrap().unwrap();
        assert!(file.is_file && !file.is_directory && file.size == 3);
        let d = fs.stat(&dir.join("")).unwrap().unwrap();
        assert!(d.is_directory && !d.is_file);
        assert!(fs.stat(&dir.join("missing")).unwrap().is_none());
    }

    #[test]
    fn exists_reflects_presence() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        assert!(!fs.exists(&dir.join("x")).unwrap());
        fs.write_file(&dir.join("x"), "1").unwrap();
        assert!(fs.exists(&dir.join("x")).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn chmod_toggles_the_executable_bit() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        let p = dir.join("run.sh");
        fs.write_file(&p, "#!/bin/sh").unwrap();
        assert!(!fs.stat(&p).unwrap().unwrap().executable);
        fs.chmod(&p, true).unwrap();
        assert!(fs.stat(&p).unwrap().unwrap().executable);
        fs.chmod(&p, false).unwrap();
        assert!(!fs.stat(&p).unwrap().unwrap().executable);
    }

    #[test]
    fn remove_is_a_no_op_when_missing() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        fs.remove(&dir.join("gone")).unwrap();
        fs.write_file(&dir.join("f"), "1").unwrap();
        fs.remove(&dir.join("f")).unwrap();
        assert!(!fs.exists(&dir.join("f")).unwrap());
    }

    #[test]
    fn remove_dir_if_empty_only_when_empty_or_missing() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        fs.remove_dir_if_empty(&dir.join("missing")).unwrap();
        fs.mkdir(&dir.join("d")).unwrap();
        fs.write_file(&dir.join("d/a.txt"), "1").unwrap();
        fs.remove_dir_if_empty(&dir.join("d")).unwrap();
        assert!(fs.exists(&dir.join("d")).unwrap());
        fs.remove(&dir.join("d/a.txt")).unwrap();
        fs.remove_dir_if_empty(&dir.join("d")).unwrap();
        assert!(!fs.exists(&dir.join("d")).unwrap());
    }

    #[test]
    fn rename_moves_and_creates_destination_parent() {
        let dir = TempDir::new();
        let fs = StdFs::new();
        fs.write_file(&dir.join("from.txt"), "data").unwrap();
        fs.rename(&dir.join("from.txt"), &dir.join("nested/to.txt"))
            .unwrap();
        assert!(!fs.exists(&dir.join("from.txt")).unwrap());
        assert_eq!(fs.read_file(&dir.join("nested/to.txt")).unwrap(), "data");
    }
}
