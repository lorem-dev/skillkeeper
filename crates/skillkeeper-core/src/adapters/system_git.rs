//! System [`GitPort`] backed by the `git` binary (Rust port of
//! `packages/core/src/git/systemGit.ts`).
//!
//! Every subcommand is spawned with an argument array via
//! [`std::process::Command`] - never a shell string - so URLs or paths cannot
//! inject shell metacharacters. Argument construction lives in the standalone
//! `build_*` helpers so it can be unit-tested without invoking `git`.
//!
//! Divergence from the TypeScript source: the Node adapter threaded an injected
//! `env` map into the subprocess. Here the spawned `git` inherits the parent
//! process environment (the common case), so no `HostEnv` is required.

use std::path::Path;
use std::process::Command;

use crate::ports::{CloneOptions, GitPort, GitRef, PortError, PortResult};

/// Build `git clone` arguments. The `--` separator guards against URLs or paths
/// that begin with a dash, and every value is a discrete argument.
pub fn build_clone_args(options: &CloneOptions) -> Vec<String> {
    let mut args = vec!["clone".to_string()];
    if let Some(filter) = &options.filter {
        args.push(format!("--filter={filter}"));
    }
    args.push("--".to_string());
    args.push(options.url.clone());
    args.push(options.destination.clone());
    args
}

/// Build `git fetch --prune` arguments.
pub fn build_fetch_args() -> Vec<String> {
    vec!["fetch".to_string(), "--prune".to_string()]
}

/// Build `git pull --ff-only` arguments.
pub fn build_pull_args() -> Vec<String> {
    vec!["pull".to_string(), "--ff-only".to_string()]
}

/// Build `git reset --hard @{u}` arguments.
pub fn build_reset_hard_args() -> Vec<String> {
    vec![
        "reset".to_string(),
        "--hard".to_string(),
        "@{u}".to_string(),
    ]
}

/// Build `git clean -fd` arguments.
pub fn build_clean_args() -> Vec<String> {
    vec!["clean".to_string(), "-fd".to_string()]
}

/// Build `git rev-parse <rev>` arguments.
pub fn build_rev_parse_args(rev: &str) -> Vec<String> {
    vec!["rev-parse".to_string(), rev.to_string()]
}

/// Build `git rev-parse --abbrev-ref HEAD` arguments (current branch name).
pub fn build_current_branch_args() -> Vec<String> {
    vec![
        "rev-parse".to_string(),
        "--abbrev-ref".to_string(),
        "HEAD".to_string(),
    ]
}

/// Build `git lfs pull` arguments.
pub fn build_lfs_pull_args() -> Vec<String> {
    vec!["lfs".to_string(), "pull".to_string()]
}

/// Build `git remote set-url origin -- <url>` arguments.
pub fn build_set_remote_url_args(url: &str) -> Vec<String> {
    vec![
        "remote".to_string(),
        "set-url".to_string(),
        "origin".to_string(),
        "--".to_string(),
        url.to_string(),
    ]
}

/// Build args listing local + origin branch short-names, one per line.
pub fn build_branch_list_args() -> Vec<String> {
    vec![
        "for-each-ref".to_string(),
        "--format=%(refname:short)".to_string(),
        "refs/heads".to_string(),
        "refs/remotes/origin".to_string(),
    ]
}

/// Build `git checkout -f <branch>` arguments (force-switch, discarding edits).
pub fn build_force_checkout_args(branch: &str) -> Vec<String> {
    vec!["checkout".to_string(), "-f".to_string(), branch.to_string()]
}

/// Normalize `git for-each-ref` short-names into a unique, sorted branch list:
/// drops the `origin/` prefix and the `origin/HEAD` symbolic ref.
pub fn parse_branch_list(stdout: &str) -> Vec<String> {
    let mut names: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for raw in stdout.split('\n') {
        let line = raw.trim();
        if line.is_empty() || line == "origin/HEAD" {
            continue;
        }
        let name = line.strip_prefix("origin/").unwrap_or(line);
        names.insert(name.to_string());
    }
    names.into_iter().collect()
}

/// Extra environment for one git invocation that also owns a resource to be
/// released once that invocation's subprocess has exited -- whichever way
/// (success, failure, or a timeout kill by the caller).
///
/// This crate has, and should keep, no concept of an SSH key or an askpass
/// token: it only needs the variables. The desktop app's `GitEnvLease`
/// implements this trait so `Drop` on the concrete type revokes whatever it
/// minted (an askpass token) at exactly the right moment -- see
/// [`SystemGit::with_env_lease`] for where that moment is.
pub trait GitEnv: Send {
    /// The environment variables to apply to this one invocation.
    fn vars(&self) -> &[(String, String)];
}

/// How [`SystemGit`] resolves its extra environment: either a plain
/// `Vec` with nothing to release ([`SystemGit::with_env`]), or a
/// [`GitEnv`] lease held for the duration of one subprocess and dropped
/// right after ([`SystemGit::with_env_lease`]).
enum EnvResolver {
    Plain(Box<dyn Fn() -> Vec<(String, String)> + Send + Sync>),
    Lease(Box<dyn Fn() -> Box<dyn GitEnv> + Send + Sync>),
}

/// A [`GitPort`] backed by the system `git` binary.
pub struct SystemGit {
    /// Resolves the git executable to spawn, evaluated per run so a configured
    /// path can change without rebuilding the port. Defaults to `"git"`.
    resolve_git_path: Box<dyn Fn() -> String + Send + Sync>,
    /// Extra environment for every git invocation, evaluated per run so the SSH
    /// key (and whether its passphrase is held) can change without rebuilding
    /// the port. Defaults to none.
    resolve_env: EnvResolver,
}

impl std::fmt::Debug for SystemGit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystemGit").finish_non_exhaustive()
    }
}

impl Default for SystemGit {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemGit {
    /// Create a port that resolves `git` on the subprocess `PATH`.
    pub fn new() -> Self {
        Self {
            resolve_git_path: Box::new(|| "git".to_string()),
            resolve_env: EnvResolver::Plain(Box::new(Vec::new)),
        }
    }

    /// Create a port with a custom git-path resolver, evaluated per invocation.
    pub fn with_git_path<F>(resolve: F) -> Self
    where
        F: Fn() -> String + Send + Sync + 'static,
    {
        Self {
            resolve_git_path: Box::new(resolve),
            resolve_env: EnvResolver::Plain(Box::new(Vec::new)),
        }
    }

    /// Add a resolver for extra environment variables, evaluated per
    /// invocation. Nothing here is released afterwards -- use
    /// [`with_env_lease`](Self::with_env_lease) when the environment owns a
    /// resource (e.g. an askpass token) that must be revoked once the
    /// invocation's subprocess has exited.
    pub fn with_env<F>(mut self, resolve: F) -> Self
    where
        F: Fn() -> Vec<(String, String)> + Send + Sync + 'static,
    {
        self.resolve_env = EnvResolver::Plain(Box::new(resolve));
        self
    }

    /// Add a resolver for a [`GitEnv`] lease, evaluated per invocation.
    ///
    /// The returned lease is held for exactly the duration of the one
    /// subprocess it was built for and dropped immediately after -- see
    /// [`run`](Self::run) -- so a concrete `GitEnv` that releases a resource
    /// on `Drop` never releases it before that subprocess could use it, and
    /// never holds it any longer than that one invocation.
    pub fn with_env_lease<F>(mut self, resolve: F) -> Self
    where
        F: Fn() -> Box<dyn GitEnv> + Send + Sync + 'static,
    {
        self.resolve_env = EnvResolver::Lease(Box::new(resolve));
        self
    }

    /// Run a git subcommand in `cwd`, returning trimmed stdout on success.
    fn run(&self, args: &[String], cwd: &str) -> PortResult<String> {
        let git = (self.resolve_git_path)();
        let mut command = Command::new(&git);
        command.args(args).current_dir(cwd);
        let lease = match &self.resolve_env {
            EnvResolver::Plain(resolve) => {
                for (key, value) in resolve() {
                    command.env(key, value);
                }
                None
            }
            EnvResolver::Lease(resolve) => {
                let lease = resolve();
                for (key, value) in lease.vars() {
                    command.env(key, value);
                }
                Some(lease)
            }
        };
        hide_console(&mut command);
        let output = command
            .output()
            .map_err(|e| PortError::Io(format!("failed to spawn {git}: {e}")))?;
        // `lease`, when present, is dropped here -- only now that `output()`
        // above has returned, i.e. only after the subprocess it was built for
        // has fully exited. Whatever a concrete `GitEnv` releases on `Drop`
        // (the desktop app's askpass token) is therefore held for exactly
        // this one invocation: never released before `ssh` could use it,
        // never leaked past it.
        drop(lease);
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(PortError::Io(format!(
                "git {} failed: {}",
                args.first().map(String::as_str).unwrap_or(""),
                stderr.trim()
            )))
        }
    }
}

/// Prevent a console window from flashing when `git` is spawned from a GUI
/// process (which has no console of its own). On Windows a spawned console
/// program otherwise gets its own window for its lifetime; with the app polling
/// git in the background (fetch/status/update checks), that reads as repeated
/// flicker. Setting `CREATE_NO_WINDOW` suppresses it. No-op on other platforms,
/// where child processes never create a console window. Output is still captured
/// via `.output()`, so nothing else changes.
#[cfg(windows)]
fn hide_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_command: &mut Command) {}

/// Directory portion of `path` as a string (`.` when there is no parent).
fn dirname(path: &str) -> String {
    match Path::new(path).parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_string_lossy().into_owned(),
        _ => ".".to_string(),
    }
}

impl GitPort for SystemGit {
    fn clone(&self, options: &CloneOptions) -> PortResult<()> {
        self.run(&build_clone_args(options), &dirname(&options.destination))?;
        if options.lfs {
            self.run(&build_lfs_pull_args(), &options.destination)?;
        }
        Ok(())
    }

    fn fetch(&self, repo_path: &str) -> PortResult<()> {
        self.run(&build_fetch_args(), repo_path).map(|_| ())
    }

    fn pull(&self, repo_path: &str) -> PortResult<()> {
        self.run(&build_pull_args(), repo_path).map(|_| ())
    }

    fn force_pull(&self, repo_path: &str) -> PortResult<()> {
        // Match upstream exactly, discarding local commits/edits and untracked
        // files, so a user-modified clone can never diverge or hit conflicts.
        self.run(&build_fetch_args(), repo_path)?;
        self.run(&build_reset_hard_args(), repo_path)?;
        self.run(&build_clean_args(), repo_path)?;
        Ok(())
    }

    fn rev_parse(&self, repo_path: &str, rev: &str) -> PortResult<GitRef> {
        let stdout = self.run(&build_rev_parse_args(rev), repo_path)?;
        Ok(GitRef {
            oid: stdout.trim().to_string(),
        })
    }

    fn current_branch(&self, repo_path: &str) -> PortResult<String> {
        let stdout = self.run(&build_current_branch_args(), repo_path)?;
        Ok(stdout.trim().to_string())
    }

    fn list_branches(&self, repo_path: &str) -> PortResult<Vec<String>> {
        let stdout = self.run(&build_branch_list_args(), repo_path)?;
        Ok(parse_branch_list(&stdout))
    }

    fn checkout(&self, repo_path: &str, branch: &str) -> PortResult<()> {
        self.run(&build_force_checkout_args(branch), repo_path)
            .map(|_| ())
    }

    fn lfs_pull(&self, repo_path: &str) -> PortResult<()> {
        self.run(&build_lfs_pull_args(), repo_path).map(|_| ())
    }

    fn set_remote_url(&self, repo_path: &str, url: &str) -> PortResult<()> {
        self.run(&build_set_remote_url_args(url), repo_path)
            .map(|_| ())
    }

    fn lfs_available(&self) -> bool {
        // `git lfs version` exits 0 only when the git-lfs extension is
        // installed; it needs no repository, so run it in the current dir.
        self.run(&["lfs".to_string(), "version".to_string()], ".")
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_args_include_filter_and_dash_guard() {
        let opts = CloneOptions {
            url: "-oops://evil".to_string(),
            destination: "/tmp/dest".to_string(),
            lfs: false,
            filter: Some("blob:none".to_string()),
        };
        assert_eq!(
            build_clone_args(&opts),
            vec![
                "clone".to_string(),
                "--filter=blob:none".to_string(),
                "--".to_string(),
                "-oops://evil".to_string(),
                "/tmp/dest".to_string(),
            ]
        );
    }

    #[test]
    fn clone_args_omit_filter_when_absent() {
        let opts = CloneOptions {
            url: "https://example.com/r.git".to_string(),
            destination: "/tmp/dest".to_string(),
            lfs: false,
            filter: None,
        };
        assert_eq!(
            build_clone_args(&opts),
            vec![
                "clone".to_string(),
                "--".to_string(),
                "https://example.com/r.git".to_string(),
                "/tmp/dest".to_string(),
            ]
        );
    }

    #[test]
    fn simple_arg_builders_match_the_ts_source() {
        assert_eq!(build_fetch_args(), vec!["fetch", "--prune"]);
        assert_eq!(build_pull_args(), vec!["pull", "--ff-only"]);
        assert_eq!(build_reset_hard_args(), vec!["reset", "--hard", "@{u}"]);
        assert_eq!(build_clean_args(), vec!["clean", "-fd"]);
        assert_eq!(build_rev_parse_args("HEAD"), vec!["rev-parse", "HEAD"]);
        assert_eq!(
            build_current_branch_args(),
            vec!["rev-parse", "--abbrev-ref", "HEAD"]
        );
        assert_eq!(build_lfs_pull_args(), vec!["lfs", "pull"]);
        assert_eq!(
            build_force_checkout_args("dev"),
            vec!["checkout", "-f", "dev"]
        );
        assert_eq!(
            build_set_remote_url_args("git@x:y.git"),
            vec!["remote", "set-url", "origin", "--", "git@x:y.git"]
        );
        assert_eq!(
            build_branch_list_args(),
            vec![
                "for-each-ref",
                "--format=%(refname:short)",
                "refs/heads",
                "refs/remotes/origin",
            ]
        );
    }

    #[test]
    fn parse_branch_list_dedups_sorts_and_strips_origin() {
        let stdout = "main\nfeature\norigin/main\norigin/HEAD\norigin/release\n\n";
        assert_eq!(
            parse_branch_list(stdout),
            vec![
                "feature".to_string(),
                "main".to_string(),
                "release".to_string()
            ]
        );
    }

    #[test]
    fn dirname_returns_parent_or_dot() {
        assert_eq!(dirname("/tmp/dest"), "/tmp");
        assert_eq!(dirname("dest"), ".");
    }

    // ---- Integration tests against a real local git repo (skipped if no git). ----

    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn run_setup(cwd: &str, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("run git setup");
        assert!(
            status.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&status.stderr)
        );
    }

    struct TempRepo {
        path: std::path::PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU32, Ordering};
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!("skillkeeper-git-{}-{}", std::process::id(), n));
            std::fs::create_dir_all(&path).expect("create temp repo dir");
            let cwd = path.to_string_lossy().into_owned();
            run_setup(&cwd, &["-c", "init.defaultBranch=main", "init"]);
            std::fs::write(path.join("file.txt"), "hello").expect("write file");
            run_setup(&cwd, &["add", "."]);
            run_setup(
                &cwd,
                &[
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-m",
                    "init",
                ],
            );
            Self { path }
        }

        fn cwd(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn rev_parse_and_current_branch_against_temp_repo() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let repo = TempRepo::new();
        let git = SystemGit::new();
        let head = git.rev_parse(&repo.cwd(), "HEAD").unwrap();
        assert_eq!(
            head.oid.len(),
            40,
            "expected a 40-char sha, got {}",
            head.oid
        );
        assert_eq!(git.current_branch(&repo.cwd()).unwrap(), "main");
    }

    #[test]
    fn list_branches_and_checkout_against_temp_repo() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let repo = TempRepo::new();
        run_setup(&repo.cwd(), &["branch", "feature"]);
        let git = SystemGit::new();

        let mut branches = git.list_branches(&repo.cwd()).unwrap();
        branches.sort();
        assert_eq!(branches, vec!["feature".to_string(), "main".to_string()]);

        git.checkout(&repo.cwd(), "feature").unwrap();
        assert_eq!(git.current_branch(&repo.cwd()).unwrap(), "feature");
    }

    #[test]
    fn injected_env_reaches_the_git_process() {
        let repo = TempRepo::new();
        // GIT_CONFIG_COUNT/KEY/VALUE is git's own env-only config channel: if the
        // injected environment did not reach the child, the value is absent.
        let git = SystemGit::new().with_env(|| {
            vec![
                ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
                (
                    "GIT_CONFIG_KEY_0".to_string(),
                    "skillkeeper.probe".to_string(),
                ),
                ("GIT_CONFIG_VALUE_0".to_string(), "present".to_string()),
            ]
        });
        let out = git
            .run(
                &["config".to_string(), "skillkeeper.probe".to_string()],
                &repo.cwd(),
            )
            .expect("config read");
        assert_eq!(out.trim(), "present");
    }

    /// A `GitEnv` lease built for `with_env_lease`: reports whether it has
    /// been released (dropped) via a shared flag, so a test can assert that
    /// happens only once its subprocess has exited.
    struct RecordingEnv {
        vars: Vec<(String, String)>,
        released: std::sync::Arc<std::sync::Mutex<bool>>,
    }

    impl GitEnv for RecordingEnv {
        fn vars(&self) -> &[(String, String)] {
            &self.vars
        }
    }

    impl Drop for RecordingEnv {
        fn drop(&mut self) {
            *self.released.lock().unwrap() = true;
        }
    }

    #[test]
    fn a_lease_envs_vars_reach_the_process_and_it_is_released_after_the_process_exits() {
        let repo = TempRepo::new();
        let released = std::sync::Arc::new(std::sync::Mutex::new(false));
        let released_for_resolver = std::sync::Arc::clone(&released);
        let git = SystemGit::new().with_env_lease(move || -> Box<dyn GitEnv> {
            assert!(
                !*released_for_resolver.lock().unwrap(),
                "a fresh lease is minted for each invocation, only after the \
                 previous one was released"
            );
            Box::new(RecordingEnv {
                vars: vec![
                    ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
                    (
                        "GIT_CONFIG_KEY_0".to_string(),
                        "skillkeeper.probe".to_string(),
                    ),
                    ("GIT_CONFIG_VALUE_0".to_string(), "present".to_string()),
                ],
                released: std::sync::Arc::clone(&released_for_resolver),
            })
        });

        assert!(
            !*released.lock().unwrap(),
            "nothing was minted or released before the first call"
        );
        let out = git
            .run(
                &["config".to_string(), "skillkeeper.probe".to_string()],
                &repo.cwd(),
            )
            .expect("config read");
        assert_eq!(out.trim(), "present");
        assert!(
            *released.lock().unwrap(),
            "the lease must be released once its subprocess has exited"
        );
    }

    #[test]
    fn rev_parse_errors_on_a_non_repo_directory() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }
        let git = SystemGit::new();
        let tmp = std::env::temp_dir();
        // A bad revision in a real (repo) dir still errors; use an empty temp dir.
        let err = git.rev_parse(&tmp.to_string_lossy(), "definitely-not-a-ref");
        assert!(err.is_err());
    }
}
