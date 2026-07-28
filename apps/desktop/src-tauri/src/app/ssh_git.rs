//! Decide the extra git environment for the chosen SSH key.
//!
//! [`git_env_lease`] is the one entry point the repository commands call
//! before every git invocation. It never blocks and never fails: with no key
//! chosen, or one this session cannot currently use with a passphrase, it
//! returns an empty [`GitEnvLease`] and git behaves exactly as it does without
//! this feature. Only when the key is unlocked does it start the askpass
//! server (once per app session) and mint a token.
//!
//! A token's lifetime is one git invocation, not one prompt -- an LFS clone's
//! smudge filter opens its own `ssh`, which asks askpass again with the same
//! token, so the token must still answer. [`GitEnvLease`] is what makes that
//! lifetime concrete: it owns the token alongside the environment variables
//! that name it, and revokes the token when dropped. The PTY layer
//! (`TerminalManager::run_git_with_env`) is responsible for minting the lease
//! only once an invocation has actually entered its queued slot, and for
//! holding it until that invocation's git subprocess has exited -- see that
//! function's doc for why the ordering matters.

use std::sync::{Arc, OnceLock};

use skillkeeper_core::ssh_env::{ssh_env_vars, AskpassRef};

use super::askpass::AskpassServer;
use super::ssh_key::{KeyState, SshKeyStore};
use crate::state::AppContext;

/// A borrowed environment for exactly one git invocation.
///
/// When the invocation needed an askpass token, this lease owns it: dropping
/// the lease revokes the token (see [`AskpassServer::revoke_token`]), so a
/// token never outlives the one invocation it was minted for, regardless of
/// how that invocation ends (success, failure, or a timeout kill). A lease
/// built for a plain key (no askpass needed) or for no key at all carries
/// nothing to revoke and drops as a no-op.
pub struct GitEnvLease {
    vars: Vec<(String, String)>,
    revoke: Option<(Arc<OnceLock<AskpassServer>>, String)>,
}

impl GitEnvLease {
    /// No extra environment: the no-key-configured, missing, not-a-key, or
    /// current-exe/askpass-unavailable degraded cases.
    pub fn empty() -> Self {
        Self {
            vars: Vec::new(),
            revoke: None,
        }
    }

    /// The environment variables this invocation should run git with. Empty
    /// exactly when [`empty`](Self::empty) built this lease.
    pub fn vars(&self) -> &[(String, String)] {
        &self.vars
    }
}

impl Drop for GitEnvLease {
    fn drop(&mut self) {
        if let Some((askpass, token)) = self.revoke.take() {
            // The `OnceLock` is only ever populated, never cleared, so a
            // server this lease itself minted a token from is still there.
            if let Some(server) = askpass.get() {
                server.revoke_token(&token);
            }
        }
    }
}

/// The lease for the chosen key's current state, ready to hand to
/// `TerminalManager::run_git_with_env`'s `make_env` parameter.
///
/// Thin wrapper over [`lease_from`] used by the command layer, so the
/// `make_env` closure built in `commands::repositories` does not need to
/// capture anything beyond the `AppContext` it already borrows.
pub fn git_env_lease(ctx: &AppContext) -> GitEnvLease {
    lease_from(&ctx.ssh_key, &ctx.askpass)
}

/// Plain-`Vec` environment for the headless `SystemGit` fallback (used before
/// the terminal has ever started, and in tests): built in `state.rs` from the
/// bare `ssh_key`/`askpass` handles, since `AppContext` does not exist yet at
/// that point, and consumed by
/// `skillkeeper_core::adapters::SystemGit::with_env`'s resolver, which only
/// knows `Vec<(String, String)>` -- `skillkeeper-core` has, and should have,
/// no concept of a lease or of askpass.
///
/// Deliberately does NOT revoke the token an unlocked key's environment
/// carries. `SystemGit::run` is one synchronous call: the resolver returns
/// its `Vec` and control returns to `skillkeeper-core` *before* the
/// subprocess that will actually hand the token to `ssh` is even spawned, so
/// there is no point after which this function could revoke without doing so
/// too early -- before `ssh` ever gets to use it, which would be worse than
/// not revoking at all. Instead:
/// - An invocation that never actually asks askpass for the passphrase leaves
///   its token to expire on the ordinary TTL backstop, same as an abandoned
///   queued-path token.
/// - An invocation that DOES use it keeps that one token alive in memory for
///   the rest of the process (the "used" exemption in `prune_expired`), a
///   bounded, same-process leak the queued PTY path does not have.
///
/// This is an acceptable trade because the path is narrow: it only runs
/// before the terminal's first `terminal:start` (a brief app-startup window)
/// or in headless/test contexts. Every later, interactive git operation goes
/// through the queued PTY path instead (see `commands::repositories`'s
/// `run_git_op`/`clone_op`/`force_pull_op`, gated on `ctx.terminal.is_started()`,
/// which -- once the terminal has started -- stays true for the rest of that
/// session), so the leak cannot accumulate per operation the way an
/// un-revoked queued-path token could; at most a handful of entries persist
/// for one process's lifetime.
pub(crate) fn vars_from(
    ssh_key: &Arc<SshKeyStore>,
    askpass: &Arc<OnceLock<AskpassServer>>,
) -> Vec<(String, String)> {
    let lease = lease_from(ssh_key, askpass);
    let vars = lease.vars().to_vec();
    // See the doc comment above: revoking on drop here would revoke before
    // the subprocess that needs the token has even been spawned.
    std::mem::forget(lease);
    vars
}

/// The real decision, taking only what it needs so callers can hold just
/// these two handles rather than the whole `AppContext`.
///
/// - No key chosen, or the file is missing/not a key: no extra environment.
/// - An unencrypted key, or a locked encrypted one: just point `ssh` at it.
///   `Locked` intentionally offers no askpass -- there is no passphrase to
///   hand over, and with no `SSH_ASKPASS*` set, `ssh` prompts in whichever
///   terminal the git subprocess is attached to (the private pseudo-terminal
///   on this path, whose input/output the renderer's terminal view is wired
///   to -- the user can answer it there, the same as the in-shell path).
/// - Unlocked: point `ssh` at the key AND start (once per session) an askpass
///   helper backed by the store's held passphrase, with a token fresh for
///   this one invocation.
pub(crate) fn lease_from(
    ssh_key: &Arc<SshKeyStore>,
    askpass: &Arc<OnceLock<AskpassServer>>,
) -> GitEnvLease {
    match ssh_key.state() {
        KeyState::NotConfigured | KeyState::Missing | KeyState::NotAKey => GitEnvLease::empty(),
        KeyState::Unencrypted | KeyState::Locked => match ssh_key.path() {
            Some(path) => GitEnvLease {
                vars: ssh_env_vars(&path, None),
                revoke: None,
            },
            None => GitEnvLease::empty(),
        },
        KeyState::Unlocked => match ssh_key.path() {
            Some(path) => unlocked_lease(&path, ssh_key, askpass),
            None => GitEnvLease::empty(),
        },
    }
}

/// Build the lease for an unlocked key: the askpass server (started on first
/// use) plus a token owned by the returned lease. Degrades to the plain
/// key-only environment -- never hangs, never panics -- when the running
/// binary's own path cannot be read or the server fails to start, so the
/// operation fails with an ordinary `ssh` error (or prompts in the terminal)
/// instead.
fn unlocked_lease(
    path: &str,
    ssh_key: &Arc<SshKeyStore>,
    askpass: &Arc<OnceLock<AskpassServer>>,
) -> GitEnvLease {
    let plain = || GitEnvLease {
        vars: ssh_env_vars(path, None),
        revoke: None,
    };
    let Ok(exe) = std::env::current_exe() else {
        return plain();
    };
    let Some(helper) = exe.to_str() else {
        return plain();
    };
    let Some(server) = get_or_start_askpass(askpass, ssh_key) else {
        return plain();
    };
    let token = server.mint_token();
    let vars = ssh_env_vars(
        path,
        Some(AskpassRef {
            helper,
            endpoint: server.endpoint(),
            token: &token,
        }),
    );
    GitEnvLease {
        vars,
        revoke: Some((Arc::clone(askpass), token)),
    }
}

/// Return the session's askpass server, starting it on first use.
///
/// `AskpassServer::start` can fail and `OnceLock` has no stable fallible
/// `get_or_try_init`, so a failed start is not recorded: `None` is returned and
/// the very next git invocation tries again rather than being stuck degraded
/// for the rest of the session over what may have been a transient failure.
/// A race between two callers both finding it unset resolves via `set`: the
/// loser's server is simply dropped.
fn get_or_start_askpass<'a>(
    askpass: &'a Arc<OnceLock<AskpassServer>>,
    ssh_key: &Arc<SshKeyStore>,
) -> Option<&'a AskpassServer> {
    if let Some(server) = askpass.get() {
        return Some(server);
    }
    let store = Arc::clone(ssh_key);
    let server = AskpassServer::start(Arc::new(move || store.passphrase())).ok()?;
    let _ = askpass.set(server);
    askpass.get()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;
    use ssh_key::{rand_core::OsRng, Algorithm, LineEnding, PrivateKey};
    use std::path::Path;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Write a fresh, unencrypted ed25519 key inside the app's temp data dir.
    /// Generated per test run: no private key material is committed.
    fn write_plain_key(app: &TempAppData) -> String {
        write_key(app, "plain_key", None)
    }

    /// Write a fresh ed25519 key encrypted with `passphrase` inside the app's
    /// temp data dir.
    fn write_encrypted_key(app: &TempAppData, passphrase: &str) -> String {
        write_key(app, "encrypted_key", Some(passphrase))
    }

    fn write_key(app: &TempAppData, file_name: &str, passphrase: Option<&str>) -> String {
        let dir = Path::new(&app.ctx.paths.config_yaml)
            .parent()
            .expect("config_yaml has a parent")
            .to_path_buf();
        let path = dir.join(file_name);
        let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let key = match passphrase {
            Some(p) => key.encrypt(&mut OsRng, p).unwrap(),
            None => key,
        };
        std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The askpass token carried by a lease's vars.
    fn token_of(lease: &GitEnvLease) -> String {
        lease
            .vars()
            .iter()
            .find(|(k, _)| k == skillkeeper_core::ssh_env::ASKPASS_TOKEN_ENV)
            .map(|(_, v)| v.clone())
            .expect("token")
    }

    /// Whether a usable `git` binary is on PATH (the queue-ordering test below
    /// drives a real `TerminalManager`/shell/git subprocess).
    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn no_configured_key_means_no_extra_environment() {
        let app = TempAppData::new();
        assert!(git_env_lease(&app.ctx).vars().is_empty());
    }

    #[test]
    fn a_plain_key_is_passed_without_askpass() {
        let app = TempAppData::new();
        let path = write_plain_key(&app);
        app.ctx.ssh_key.set_path(Some(path.clone()));
        let lease = git_env_lease(&app.ctx);
        let vars = lease.vars();
        assert_eq!(
            vars.iter()
                .find(|(k, _)| k == "GIT_SSH_COMMAND")
                .map(|(_, v)| v.as_str()),
            Some(format!("ssh -i \"{path}\" -o IdentitiesOnly=yes").as_str())
        );
        assert!(vars.iter().all(|(k, _)| k != "SSH_ASKPASS"));
    }

    #[test]
    fn an_unlocked_key_adds_askpass_and_a_fresh_token_each_time() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        app.ctx.ssh_key.set_path(Some(path));
        app.ctx.ssh_key.unlock("topsecret").unwrap();
        let first = git_env_lease(&app.ctx);
        let second = git_env_lease(&app.ctx);
        assert_ne!(
            token_of(&first),
            token_of(&second),
            "each invocation's lease mints its own token"
        );
        assert!(first
            .vars()
            .iter()
            .any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v == "force"));
    }

    #[test]
    fn a_locked_key_still_points_at_the_key_but_offers_no_passphrase() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        app.ctx.ssh_key.set_path(Some(path));
        let lease = git_env_lease(&app.ctx);
        let vars = lease.vars();
        assert!(vars.iter().any(|(k, _)| k == "GIT_SSH_COMMAND"));
        assert!(vars.iter().all(|(k, _)| k != "SSH_ASKPASS"));
    }

    /// The whole point of `GitEnvLease` owning its token: once the lease that
    /// minted it is dropped, the token must stop answering, even though the
    /// askpass server itself keeps running for the rest of the session.
    #[test]
    fn dropping_the_lease_revokes_its_token() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        app.ctx.ssh_key.set_path(Some(path));
        app.ctx.ssh_key.unlock("topsecret").unwrap();

        let lease = git_env_lease(&app.ctx);
        let token = token_of(&lease);
        let endpoint = app
            .ctx
            .askpass
            .get()
            .expect("askpass server started by the lease above")
            .endpoint()
            .to_string();

        assert_eq!(
            AskpassServer::debug_fetch(&endpoint, &token, "Enter passphrase: "),
            Some("topsecret".to_string()),
            "the token must be live while the lease is held"
        );

        drop(lease);

        assert_eq!(
            AskpassServer::debug_fetch(&endpoint, &token, "Enter passphrase: "),
            None,
            "dropping the lease must revoke its token"
        );
    }

    /// Proves the ordering the PTY layer relies on: a second, queued
    /// invocation's environment (and thus its token) is not minted until the
    /// first invocation -- make_env, dispatch, and subprocess included -- has
    /// fully finished and released the queue. Regression test for the token-
    /// expiring-before-use failure: minting ahead of the queue would let a
    /// long-running first invocation age out a second invocation's token
    /// before it ever reached `ssh`.
    #[test]
    fn a_second_queued_invocations_env_is_minted_only_after_the_first_finishes() {
        if !git_available() {
            eprintln!("skipping: git not available");
            return;
        }

        let app = Arc::new(TempAppData::new());
        let path = write_encrypted_key(&app, "topsecret");
        app.ctx.ssh_key.set_path(Some(path));
        app.ctx.ssh_key.unlock("topsecret").unwrap();

        let rx = app
            .ctx
            .terminal
            .take_events()
            .expect("events available once");
        std::thread::spawn(move || while rx.recv().is_ok() {});
        if app.ctx.terminal.start(80, 24).is_err() {
            eprintln!("skipping: shell spawn failed");
            return;
        }

        let cwd = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();

        let order: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (entered_tx, entered_rx) = mpsc::channel::<()>();

        let app1 = Arc::clone(&app);
        let order1 = Arc::clone(&order);
        let cwd1 = cwd.clone();
        let first = std::thread::spawn(move || {
            let make_env = || {
                let lease = git_env_lease(&app1.ctx);
                order1
                    .lock()
                    .unwrap()
                    .push(format!("first:{}", token_of(&lease)));
                let _ = entered_tx.send(());
                // Stand in for a long-running git subprocess: held here until
                // the test explicitly releases it, well past when the second
                // invocation below has queued up behind it.
                let _ = release_rx.recv();
                lease
            };
            let _ =
                app1.ctx
                    .terminal
                    .run_git_with_env(&cwd1, &["--version".to_string()], &make_env);
        });

        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("first invocation must enter its queued slot");

        let app2 = Arc::clone(&app);
        let order2 = Arc::clone(&order);
        let cwd2 = cwd.clone();
        let second = std::thread::spawn(move || {
            let make_env = || {
                let lease = git_env_lease(&app2.ctx);
                order2
                    .lock()
                    .unwrap()
                    .push(format!("second:{}", token_of(&lease)));
                lease
            };
            let _ =
                app2.ctx
                    .terminal
                    .run_git_with_env(&cwd2, &["--version".to_string()], &make_env);
        });

        // Give the second call time to actually reach (and block on) the
        // queue's mutex before releasing the first -- otherwise a fast second
        // call could slip in before the first even blocks, and the ordering
        // assertion below would pass for the wrong reason.
        std::thread::sleep(Duration::from_millis(200));
        let _ = release_tx.send(());

        first
            .join()
            .expect("first invocation thread must not panic");
        second
            .join()
            .expect("second invocation thread must not panic");

        let seen = order.lock().unwrap();
        assert_eq!(seen.len(), 2, "both invocations must have minted an env");
        assert!(seen[0].starts_with("first:"), "seen: {seen:?}");
        assert!(seen[1].starts_with("second:"), "seen: {seen:?}");
        let first_token = seen[0].strip_prefix("first:").unwrap();
        let second_token = seen[1].strip_prefix("second:").unwrap();
        assert_ne!(
            first_token, second_token,
            "each queued invocation mints its own token"
        );
    }
}
