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
//! that name it, and revokes the token when dropped. `GitEnvLease` implements
//! `skillkeeper_core::adapters::GitEnv`, so BOTH git routes share one rule for
//! when that drop happens, without `skillkeeper-core` ever learning what an
//! askpass token is:
//! - The PTY layer (`TerminalManager::run_git_with_env`) takes a `make_env`
//!   closure, calls it only once an invocation has actually entered its
//!   queued slot (see that function's doc for why the ordering matters), and
//!   holds the returned lease until that invocation's git subprocess exits.
//! - The headless `SystemGit` fallback (`ctx.git`, wired in `state.rs` via
//!   `SystemGit::with_env_lease`) resolves and holds the lease inside
//!   `SystemGit::run` itself, dropping it right after its one synchronous
//!   subprocess call returns -- so this route revokes its token too, not just
//!   the queued PTY route.

use std::sync::{Arc, OnceLock};

use skillkeeper_core::ssh_env::{ssh_env_vars, AskpassRef};

use super::askpass::{AskpassServer, Refusal, RetiredReason};
use super::ssh_agent::AgentKeyStatus;
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

    /// Add `-v` to the `ssh` this lease runs, so the terminal shows which
    /// identities were offered and whether the askpass helper was consulted.
    ///
    /// A no-op for a lease that sets no `GIT_SSH_COMMAND` (no key chosen, or a
    /// path that cannot be expressed): there is no `ssh` of ours to make verbose,
    /// and inventing one would change which key git uses.
    fn verbose(mut self) -> Self {
        for (key, value) in &mut self.vars {
            if key == "GIT_SSH_COMMAND" {
                if let Some(rest) = value.strip_prefix("ssh ") {
                    *value = format!("ssh -v {rest}");
                }
            }
        }
        self
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

impl skillkeeper_core::adapters::GitEnv for GitEnvLease {
    fn vars(&self) -> &[(String, String)] {
        &self.vars
    }
}

/// Run one git invocation in the terminal with the chosen key's environment,
/// and report an askpass refusal as the reason it failed.
///
/// The single funnel for the PTY git route, so every repository operation gets
/// that explanation. It is needed because `ssh` gives the same account of two
/// quite different failures -- `Permission denied (publickey)`, with no mention
/// of askpass -- whether the helper answered nothing or the host rejected a key
/// it did read. The server records which of those happened
/// ([`AskpassServer::take_refusal`]); this is where that record is read, while
/// it still belongs to the invocation that just failed.
///
/// A refusal is only ever substituted for a FAILED invocation: a successful one
/// may legitimately have had a request refused along the way (`ssh` trying a
/// second identity, say) and must not be reported as broken.
pub fn run_git_in_terminal(ctx: &AppContext, cwd: &str, args: &[String]) -> Result<String, String> {
    let result = ctx
        .terminal
        .run_git_with_env(cwd, args, &|| git_env_lease(ctx));
    let refusal = ctx.askpass.get().and_then(AskpassServer::take_refusal);
    match result {
        Ok(output) => Ok(output),
        Err(error) => {
            drop_a_key_the_agent_no_longer_holds(ctx);
            Err(refusal.map_or(error, |r| refusal_error(&r).to_string()))
        }
    }
}

/// After a failed git invocation, correct the store if the agent has let go of
/// the PuTTY key it records as loaded.
///
/// The agent can drop our key without telling anyone -- `ssh-add -D`, the
/// 12-hour TTL expiring mid-session, an agent restart -- and the store would go
/// on reporting [`KeyState::PuttyInAgent`], so the gate would go on saying
/// `Proceed` and every operation would fail the same way with no way back but
/// re-selecting the key. A failed invocation is the cue to check.
///
/// The agent is ASKED rather than the error string read. It is worth saying why,
/// because inferring from the text is the obvious thing to write and it cannot
/// work here: the error this arm receives is built by the PTY layer and is only
/// ever `git exited with code N` (`pty::manager`), since git's own stderr goes
/// to the terminal scrollback rather than into the returned string. A
/// `Permission denied (publickey)` test against it is dead code that reads like
/// a working guard.
///
/// Costs one `ssh-add -L` per FAILED invocation while a PuTTY key is loaded.
/// Everyone else pays a lock and a clone: with no key recorded there is nothing
/// to correct, so that test comes before the one that reads the key file.
fn drop_a_key_the_agent_no_longer_holds(ctx: &AppContext) {
    drop_stale_putty_record(ctx, super::ssh_agent::key_status);
}

/// The rule above, with asking the agent as a parameter so the decision can be
/// tested without one.
///
/// Only [`AgentKeyStatus::Absent`] clears the record, and that is the whole
/// point of the three states: an agent that could not be reached for a moment,
/// or an `ssh-add` briefly unresolvable, answers
/// [`Unknown`](AgentKeyStatus::Unknown), and acting on that would evict a key
/// that is loaded and working -- costing the user a passphrase they already
/// gave, for a git failure that had nothing to do with the key.
fn drop_stale_putty_record(ctx: &AppContext, ask: impl Fn(&str) -> AgentKeyStatus) {
    let Some(public_line) = ctx.ssh_key.putty_public_line() else {
        return;
    };
    if ctx.ssh_key.state() != KeyState::PuttyInAgent {
        return;
    }
    if ask(&public_line) == AgentKeyStatus::Absent {
        ctx.ssh_key.unload_putty();
    }
}

/// The renderer-facing code for a refusal.
///
/// One code per cause, deliberately: they call for different things from the
/// user (confirm a host key, unlock the key again, retry) and point at different
/// faults if they turn out to be ours, so flattening them into a single "the
/// helper is unavailable" message would throw away the diagnosis the refusal
/// record exists to make.
fn refusal_error(refusal: &Refusal) -> &'static str {
    match refusal {
        Refusal::NotAPassphrase(_) => "ssh.hostKeyPrompt",
        // Minted here, then retired before the request arrived: nothing is
        // wrong with the key or the passphrase, and the operation is worth
        // repeating.
        Refusal::RetiredToken(RetiredReason::Expired) => "ssh.askpassExpired",
        Refusal::RetiredToken(RetiredReason::Revoked) => "ssh.askpassStale",
        // Never minted by this server: a leftover environment from an earlier
        // run of the app, which a fresh operation replaces.
        Refusal::UnknownToken => "ssh.askpassStale",
        Refusal::NoPassphraseHeld => "ssh.askpassForgotten",
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
    let lease = lease_for_state(ssh_key, askpass);
    match std::env::var(SSH_VERBOSE_ENV) {
        Ok(value) if verbosity_requested(&value) => lease.verbose(),
        _ => lease,
    }
}

/// Environment variable that turns on `ssh -v` for every git invocation the app
/// makes with the chosen key.
///
/// A diagnostic, not a feature: `Permission denied (publickey)` looks the same
/// whether the askpass helper failed to answer or the host simply does not
/// accept the key, and only `ssh`'s own trace separates the two. Start the app
/// with this set and the terminal shows which it is.
pub const SSH_VERBOSE_ENV: &str = "SKILLKEEPER_SSH_VERBOSE";

/// Whether `value` (the raw variable) asks for verbosity. Anything but empty,
/// `0` and `false` does, so the usual spellings all work.
fn verbosity_requested(value: &str) -> bool {
    let value = value.trim();
    !(value.is_empty() || value == "0" || value.eq_ignore_ascii_case("false"))
}

/// The state-driven decision, before the verbosity switch above is applied.
fn lease_for_state(
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
        // A PuTTY key is in the agent, not in a file ssh can read: naming it
        // with `-i` would break every operation, and there is no passphrase to
        // answer an askpass request with. An empty lease is exactly right --
        // it is the "let ssh use what it has" case.
        KeyState::PuttyInAgent
        | KeyState::PuttyLocked
        | KeyState::PuttyUnencrypted
        | KeyState::PuttyNoAgent => GitEnvLease::empty(),
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
    use crate::commands::test_support::{write_key, TempAppData};
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::Duration;

    /// Every refusal reaches the renderer as a code it can translate -- never as
    /// a raw prompt from `ssh` or the remote host, which is what the
    /// non-passphrase case carries.
    #[test]
    fn every_refusal_maps_to_a_translatable_code() {
        assert_eq!(
            refusal_error(&Refusal::NotAPassphrase(
                "Are you sure you want to continue connecting?".to_string()
            )),
            "ssh.hostKeyPrompt"
        );
        assert_eq!(
            refusal_error(&Refusal::RetiredToken(RetiredReason::Expired)),
            "ssh.askpassExpired"
        );
        assert_eq!(
            refusal_error(&Refusal::RetiredToken(RetiredReason::Revoked)),
            "ssh.askpassStale"
        );
        assert_eq!(refusal_error(&Refusal::UnknownToken), "ssh.askpassStale");
        assert_eq!(
            refusal_error(&Refusal::NoPassphraseHeld),
            "ssh.askpassForgotten"
        );
    }

    /// Only an agent that ANSWERED, and did not list our key, may clear the
    /// record.
    ///
    /// The other two answers are the defect this pins: an agent that cannot be
    /// reached for a moment, or an `ssh-add` briefly unresolvable, must not
    /// evict a key that is loaded and working -- the user would be asked for a
    /// passphrase they already gave.
    #[test]
    fn a_record_is_cleared_only_by_an_answer_that_does_not_list_the_key() {
        // A public line of the right shape whose blob is nothing any real agent
        // could be holding.
        const LOADED: &str =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfake0000000000000000000000000000000 skillkeeper";

        let app = TempAppData::new();
        let path = app.dir().join("loaded.ppk");
        std::fs::write(&path, crate::app::ppk::fixtures::ED25519_V3_PLAIN).unwrap();
        let path = path.to_string_lossy().into_owned();
        app.ctx.ssh_key.set_path(Some(path.clone()));
        app.ctx
            .ssh_key
            .record_putty_loaded(path, LOADED.to_string());
        assert_eq!(app.ctx.ssh_key.state(), KeyState::PuttyInAgent);

        drop_stale_putty_record(&app.ctx, |_| AgentKeyStatus::Unknown);
        assert_eq!(
            app.ctx.ssh_key.state(),
            KeyState::PuttyInAgent,
            "an agent that could not be asked must not cost the user the key"
        );

        drop_stale_putty_record(&app.ctx, |_| AgentKeyStatus::Held);
        assert_eq!(
            app.ctx.ssh_key.state(),
            KeyState::PuttyInAgent,
            "the agent still has it: the failure was something else"
        );

        drop_stale_putty_record(&app.ctx, |_| AgentKeyStatus::Absent);
        assert_ne!(
            app.ctx.ssh_key.state(),
            KeyState::PuttyInAgent,
            "the agent answered and our key was not there: the record is stale"
        );
    }

    /// The diagnostic switch reads as on for the spellings a user would try and
    /// off for the ones that mean "no" -- an exported `=0` must not quietly turn
    /// tracing on for the rest of the session.
    #[test]
    fn the_verbosity_switch_reads_the_usual_spellings() {
        for on in ["1", "true", "yes", " 1 "] {
            assert!(verbosity_requested(on), "{on:?} should enable tracing");
        }
        for off in ["", "  ", "0", "false", "FALSE"] {
            assert!(!verbosity_requested(off), "{off:?} should leave it off");
        }
    }

    /// Verbosity is added to OUR ssh invocation and nothing else: the key stays
    /// exactly as it was, and a lease with no command of ours is left alone
    /// rather than given one.
    #[test]
    fn verbosity_only_touches_our_own_ssh_command() {
        let lease = GitEnvLease {
            vars: vec![
                ("GIT_SSH_COMMAND".to_string(), "ssh -i /k".to_string()),
                ("SSH_ASKPASS".to_string(), "/helper".to_string()),
            ],
            revoke: None,
        }
        .verbose();
        assert_eq!(
            lease.vars(),
            [
                ("GIT_SSH_COMMAND".to_string(), "ssh -v -i /k".to_string()),
                ("SSH_ASKPASS".to_string(), "/helper".to_string()),
            ]
        );
        assert!(GitEnvLease::empty().verbose().vars().is_empty());
    }

    /// Write a fresh, unencrypted ed25519 key inside the app's temp data dir.
    fn write_plain_key(app: &TempAppData) -> String {
        write_key(app.dir(), "plain_key", None)
    }

    /// Write a fresh ed25519 key encrypted with `passphrase` inside the app's
    /// temp data dir.
    fn write_encrypted_key(app: &TempAppData, passphrase: &str) -> String {
        write_key(app.dir(), "encrypted_key", Some(passphrase))
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
            Some(format!("ssh -i {path}").as_str())
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

    /// A PuTTY key never reaches `ssh` as a file: `ssh -i` cannot read the
    /// format, so naming it would break every operation the moment one is
    /// chosen, whatever the key's state.
    #[test]
    fn a_putty_key_is_never_named_on_the_ssh_command_line() {
        // A public line of the right shape whose blob is nothing any real
        // agent could be holding.
        const LOADED: &str =
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfake0000000000000000000000000000000 skillkeeper";

        let app = TempAppData::new();
        for (name, contents) in [
            ("plain.ppk", crate::app::ppk::fixtures::ED25519_V3_PLAIN),
            ("enc.ppk", crate::app::ppk::fixtures::ED25519_V3_ENC),
        ] {
            let path = app.dir().join(name);
            std::fs::write(&path, contents).unwrap();
            app.ctx
                .ssh_key
                .set_path(Some(path.to_string_lossy().into_owned()));
            assert!(
                git_env_lease(&app.ctx).vars().is_empty(),
                "{name} must leave the environment alone"
            );
        }

        // And the state git actually runs in with a PuTTY key: loaded into the
        // agent, where `ssh` finds it without being told anything. The two
        // cases above leave the environment empty because the key is unusable;
        // this one leaves it empty even though the key works, which is the
        // property that matters. `record_putty_loaded` is the only way to
        // reach it without an agent -- see its doc comment.
        let path = app.dir().join("plain.ppk").to_string_lossy().into_owned();
        app.ctx.ssh_key.set_path(Some(path.clone()));
        app.ctx
            .ssh_key
            .record_putty_loaded(path, LOADED.to_string());
        assert_eq!(app.ctx.ssh_key.state(), KeyState::PuttyInAgent);
        assert!(
            git_env_lease(&app.ctx).vars().is_empty(),
            "a loaded PuTTY key must leave the environment alone too"
        );
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

    /// Proves the property the PTY layer relies on: a second, queued
    /// invocation's `make_env` does not run while it is still merely
    /// *waiting* for the queue -- i.e. while a first invocation is still
    /// holding it. Regression test for the token-expiring-before-use
    /// failure: minting ahead of the queue would let a long-running first
    /// invocation age out a second invocation's token before it ever
    /// reached `ssh`. (Which invocation's token is which is already covered
    /// by `an_unlocked_key_adds_askpass_and_a_fresh_token_each_time`; this
    /// test is purely about ordering, so it logs plain markers instead.)
    ///
    /// The one assertion that matters is taken BEFORE the first invocation
    /// is released, not after both finish: `GitQueue::run` releases its
    /// mutex guard as part of returning from the closure, which happens
    /// before the first invocation's own thread gets to run its very next
    /// statement -- so any assertion comparing "first has returned" against
    /// "second has started" from OUTSIDE the queued closure is racing the
    /// scheduler and can flip under load (confirmed empirically: this test
    /// used to push a `"first:returned"` marker right after
    /// `run_git_with_env` returned and assert it preceded `"second:..."`;
    /// stress runs at `--test-threads=16` reproduced `["first:make_env",
    /// "second:make_env", "first:returned"]`, i.e. thread 2 got scheduled
    /// and ran its whole queued turn before thread 1's very next line ran).
    /// The snapshot below sidesteps that entirely by never comparing
    /// anything that happens after the mutex is released: while the release
    /// signal has not been sent yet, the first invocation's `make_env` is
    /// still blocked on `release_rx.recv()` *inside* the queued closure, so
    /// the queue's mutex is still held no matter how any thread is
    /// scheduled -- the second invocation's `make_env` (which has no delay
    /// of its own) simply cannot have run yet. A single unavoidable timing
    /// assumption remains (the sleep below gives the second invocation a
    /// real chance to misbehave before the snapshot), but nothing about
    /// which of two already-independent events the scheduler picks first.
    #[test]
    fn a_second_queued_invocations_make_env_waits_for_the_first_to_finish() {
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

        let order: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (entered_tx, entered_rx) = mpsc::channel::<()>();

        let app1 = Arc::clone(&app);
        let order1 = Arc::clone(&order);
        let cwd1 = cwd.clone();
        let first = std::thread::spawn(move || {
            let make_env = || {
                let lease = git_env_lease(&app1.ctx);
                order1.lock().unwrap().push("first:make_env");
                let _ = entered_tx.send(());
                // Stand in for a long-running git subprocess: held here,
                // still INSIDE the queued closure (so the queue's mutex is
                // still held), until the test explicitly releases it, well
                // past when the second invocation below has queued up
                // behind it.
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
                order2.lock().unwrap().push("second:make_env");
                lease
            };
            let _ =
                app2.ctx
                    .terminal
                    .run_git_with_env(&cwd2, &["--version".to_string()], &make_env);
        });

        // Give the second call time to actually reach (and block on) the
        // queue's mutex before releasing the first -- a real chance for the
        // regression to misbehave, not a substitute for the check below.
        std::thread::sleep(Duration::from_millis(200));

        // The whole test: taken BEFORE the first invocation is released, so
        // the first invocation's make_env is still blocked inside the
        // queued closure (the queue's mutex is still held) no matter what
        // the scheduler has done with either thread since. The second
        // invocation's make_env has had a full 200ms to run if nothing were
        // gating it, so seeing only the first's marker here is possible
        // only because the queue itself is still blocking it.
        assert_eq!(
            *order.lock().unwrap(),
            vec!["first:make_env"],
            "the second invocation's make_env must not run before the first is released"
        );

        let _ = release_tx.send(());

        first
            .join()
            .expect("first invocation thread must not panic");
        second
            .join()
            .expect("second invocation thread must not panic");

        // Both threads are joined here, so there is no more concurrency left
        // to race: this is just confirming both invocations actually ran,
        // in whichever relative order the scheduler picked after release --
        // that order is not part of what this test is proving.
        let seen = order.lock().unwrap().clone();
        assert_eq!(seen.len(), 2, "both invocations must have run: {seen:?}");
        assert!(seen.contains(&"first:make_env"), "seen: {seen:?}");
        assert!(seen.contains(&"second:make_env"), "seen: {seen:?}");
    }
}
