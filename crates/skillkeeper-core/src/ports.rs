//! Injected I/O ports for the SkillKeeper domain core.
//!
//! The domain performs no direct `std::fs` or subprocess I/O. Every side effect
//! goes through one of these traits, which keeps the core unit-testable with the
//! in-memory fakes in [`crate::testing`]. Ports are synchronous: the domain is
//! not concurrency-hot, and blocking I/O avoids async coloring across the port
//! boundary. Ported from `packages/core/src/kernel/ports.ts`.

use thiserror::Error;

/// Error surface shared by all ports.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum PortError {
    /// The requested path or ref does not exist.
    #[error("not found: {0}")]
    NotFound(String),
    /// An underlying I/O or subprocess failure, with a human-readable message.
    #[error("io error: {0}")]
    Io(String),
    /// Any other failure carrying a message.
    #[error("{0}")]
    Other(String),
}

/// Convenience alias for port results.
pub type PortResult<T> = Result<T, PortError>;

/// File metadata returned by [`FsPort::stat`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileStat {
    pub is_file: bool,
    pub is_directory: bool,
    /// True when the owner-executable bit is set.
    pub executable: bool,
    pub size: u64,
}

/// Minimal filesystem abstraction. All paths are absolute (or resolved by the
/// caller before use). Reads and writes are UTF-8 text.
pub trait FsPort {
    /// Read a file as UTF-8 text. Errors if it does not exist.
    fn read_file(&self, path: &str) -> PortResult<String>;
    /// Write a file as UTF-8 text, creating parent directories as needed.
    fn write_file(&self, path: &str, content: &str) -> PortResult<()>;
    /// List the immediate entry names of a directory. Errors if missing.
    fn list(&self, path: &str) -> PortResult<Vec<String>>;
    /// Stat a path, or return `None` when it does not exist.
    fn stat(&self, path: &str) -> PortResult<Option<FileStat>>;
    /// True when the path exists.
    fn exists(&self, path: &str) -> PortResult<bool>;
    /// Create a directory and any missing parents.
    fn mkdir(&self, path: &str) -> PortResult<()>;
    /// Remove a file. No-op when it does not exist.
    fn remove(&self, path: &str) -> PortResult<()>;
    /// Remove a directory only when it is empty. No-op when missing.
    fn remove_dir_if_empty(&self, path: &str) -> PortResult<()>;
    /// Set or clear the owner-executable bit.
    fn chmod(&self, path: &str, executable: bool) -> PortResult<()>;
    /// Rename (move) a path. Used for atomic temp-then-rename writes.
    fn rename(&self, from: &str, to: &str) -> PortResult<()>;
}

/// Result of a Git rev-parse style lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRef {
    /// The resolved object id (commit hash).
    pub oid: String,
}

/// Options for a clone operation.
#[derive(Debug, Clone)]
pub struct CloneOptions {
    pub url: String,
    pub destination: String,
    /// When true, run `git lfs` steps after clone.
    pub lfs: bool,
    /// Optional partial-clone filter, for example `blob:none`.
    pub filter: Option<String>,
}

/// Abstraction over the system `git` binary. The production implementation
/// shells out via argument arrays (never a shell string).
pub trait GitPort {
    fn clone(&self, options: &CloneOptions) -> PortResult<()>;
    fn fetch(&self, repo_path: &str) -> PortResult<()>;
    /// Fast-forward only pull.
    fn pull(&self, repo_path: &str) -> PortResult<()>;
    /// Force the working tree to match upstream (fetch + `reset --hard @{u}` +
    /// `clean -fd`).
    fn force_pull(&self, repo_path: &str) -> PortResult<()>;
    /// Resolve a revision to an oid.
    fn rev_parse(&self, repo_path: &str, rev: &str) -> PortResult<GitRef>;
    /// Current branch name (`HEAD` if detached).
    fn current_branch(&self, repo_path: &str) -> PortResult<String>;
    /// Unique, sorted local + origin branch names (origin/ prefix and HEAD
    /// dropped).
    fn list_branches(&self, repo_path: &str) -> PortResult<Vec<String>>;
    /// Force-switch to a branch, discarding local edits.
    fn checkout(&self, repo_path: &str, branch: &str) -> PortResult<()>;
    /// Run `git lfs pull`.
    fn lfs_pull(&self, repo_path: &str) -> PortResult<()>;
    /// Point the `origin` remote at a new URL.
    fn set_remote_url(&self, repo_path: &str, url: &str) -> PortResult<()>;
}

/// Host environment values the adapters and ports need.
pub trait HostEnv {
    /// Absolute path to the current user's home directory.
    fn home_dir(&self) -> &str;
    /// Platform identifier, mirroring `process.platform`
    /// (`"darwin"`, `"win32"`, `"linux"`).
    fn platform(&self) -> &str;
    /// Look up an environment variable.
    fn env(&self, key: &str) -> Option<String>;
}

/// Injectable clock so timer logic is deterministic under test.
pub trait Clock {
    /// Current time in epoch milliseconds.
    fn now(&self) -> i64;
}
