//! Shared test doubles for the CLI unit tests.
//!
//! Kept hermetic: no test touches the real filesystem, git binary, or wall
//! clock. `FakeGit` records calls and returns programmed results; `FixedClock`
//! returns a constant epoch-millis value.

#![cfg(test)]

use std::cell::RefCell;
use std::collections::HashSet;

use skillkeeper_core::ports::{Clock, CloneOptions, GitPort, GitRef, PortError, PortResult};

/// A [`GitPort`] double for tests. Only the methods the CLI commands call carry
/// meaningful behavior; the rest are inert.
pub struct FakeGit {
    /// Oid returned for `rev-parse HEAD`.
    pub head: String,
    /// Oid returned for `rev-parse @{upstream}`.
    pub upstream: String,
    /// When true, `fetch` fails.
    pub fetch_fails: bool,
    /// When true, `clone` fails.
    pub clone_fails: bool,
    /// Repo paths whose `pull` should fail.
    pub pull_fails: HashSet<String>,
    /// Records human-readable call descriptions in order.
    pub calls: RefCell<Vec<String>>,
}

impl FakeGit {
    /// A git double where HEAD and upstream agree (no repo-level update).
    pub fn up_to_date() -> Self {
        Self {
            head: "aaaa".to_string(),
            upstream: "aaaa".to_string(),
            fetch_fails: false,
            clone_fails: false,
            pull_fails: HashSet::new(),
            calls: RefCell::new(Vec::new()),
        }
    }

    /// A git double where HEAD and upstream diverge (a repo-level update).
    pub fn behind() -> Self {
        Self {
            head: "aaaa".to_string(),
            upstream: "bbbb".to_string(),
            ..Self::up_to_date()
        }
    }

    fn record(&self, call: impl Into<String>) {
        self.calls.borrow_mut().push(call.into());
    }
}

impl GitPort for FakeGit {
    fn clone(&self, options: &CloneOptions) -> PortResult<()> {
        self.record(format!("clone {} -> {}", options.url, options.destination));
        if self.clone_fails {
            return Err(PortError::Io("clone failed".to_string()));
        }
        Ok(())
    }

    fn fetch(&self, repo_path: &str) -> PortResult<()> {
        self.record(format!("fetch {repo_path}"));
        if self.fetch_fails {
            return Err(PortError::Io("fetch failed".to_string()));
        }
        Ok(())
    }

    fn pull(&self, repo_path: &str) -> PortResult<()> {
        self.record(format!("pull {repo_path}"));
        if self.pull_fails.contains(repo_path) {
            return Err(PortError::Io("pull failed".to_string()));
        }
        Ok(())
    }

    fn force_pull(&self, repo_path: &str) -> PortResult<()> {
        self.record(format!("force_pull {repo_path}"));
        Ok(())
    }

    fn rev_parse(&self, repo_path: &str, rev: &str) -> PortResult<GitRef> {
        self.record(format!("rev_parse {repo_path} {rev}"));
        let oid = if rev == "HEAD" {
            self.head.clone()
        } else {
            self.upstream.clone()
        };
        Ok(GitRef { oid })
    }

    fn current_branch(&self, _repo_path: &str) -> PortResult<String> {
        Ok("main".to_string())
    }

    fn list_branches(&self, _repo_path: &str) -> PortResult<Vec<String>> {
        Ok(vec!["main".to_string()])
    }

    fn checkout(&self, _repo_path: &str, _branch: &str) -> PortResult<()> {
        Ok(())
    }

    fn lfs_pull(&self, _repo_path: &str) -> PortResult<()> {
        Ok(())
    }

    fn set_remote_url(&self, _repo_path: &str, _url: &str) -> PortResult<()> {
        Ok(())
    }
}

/// A [`Clock`] that always returns a fixed epoch-millis value.
pub struct FixedClock(pub i64);

impl Clock for FixedClock {
    fn now(&self) -> i64 {
        self.0
    }
}
