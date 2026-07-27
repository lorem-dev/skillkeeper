//! Decide the extra git environment for the chosen SSH key.
//!
//! [`git_env`] is the one entry point the repository commands call before every
//! git invocation. It never blocks and never fails: with no key chosen, or one
//! this session cannot currently use with a passphrase, it returns an empty
//! vector and git behaves exactly as it does without this feature. Only when
//! the key is unlocked does it start the askpass server (once per app session,
//! via the `AppContext`-held `OnceLock`) and mint a fresh single-use token.

use std::sync::{Arc, OnceLock};

use skillkeeper_core::ssh_env::{ssh_env_vars, AskpassRef};

use super::askpass::AskpassServer;
use super::ssh_key::{KeyState, SshKeyStore};
use crate::state::AppContext;

/// The extra environment git needs for the chosen key, if any.
///
/// Thin wrapper over [`env_from`] used by the command layer, so the resolver
/// wired into `SystemGit` (see `state.rs`) does not need to capture a whole
/// `AppContext`.
pub fn git_env(ctx: &AppContext) -> Vec<(String, String)> {
    env_from(&ctx.ssh_key, &ctx.askpass)
}

/// The real decision, taking only what it needs so the `SystemGit` env
/// resolver can hold just these two handles rather than the whole
/// `AppContext`.
///
/// - No key chosen, or the file is missing/not a key: no extra environment.
/// - An unencrypted key, or a locked encrypted one: just point `ssh` at it.
///   `Locked` intentionally offers no askpass -- there is no passphrase to
///   hand over, and `ssh` falls back to prompting in whichever terminal the
///   git process is attached to.
/// - Unlocked: point `ssh` at the key AND start (once per session) an askpass
///   helper backed by the store's held passphrase, with a fresh single-use
///   token for this one invocation.
pub(crate) fn env_from(
    ssh_key: &Arc<SshKeyStore>,
    askpass: &Arc<OnceLock<AskpassServer>>,
) -> Vec<(String, String)> {
    match ssh_key.state() {
        KeyState::NotConfigured | KeyState::Missing | KeyState::NotAKey => Vec::new(),
        KeyState::Unencrypted | KeyState::Locked => match ssh_key.path() {
            Some(path) => ssh_env_vars(&path, None),
            None => Vec::new(),
        },
        KeyState::Unlocked => match ssh_key.path() {
            Some(path) => unlocked_env(&path, ssh_key, askpass),
            None => Vec::new(),
        },
    }
}

/// Build the environment for an unlocked key: the askpass server (started on
/// first use) plus a fresh token. Degrades to the plain key-only environment
/// -- never hangs, never panics -- when the running binary's own path cannot
/// be read or the server fails to start, so the operation fails with an
/// ordinary `ssh` error (or prompts in the terminal) instead.
fn unlocked_env(
    path: &str,
    ssh_key: &Arc<SshKeyStore>,
    askpass: &Arc<OnceLock<AskpassServer>>,
) -> Vec<(String, String)> {
    let Ok(exe) = std::env::current_exe() else {
        return ssh_env_vars(path, None);
    };
    let Some(helper) = exe.to_str() else {
        return ssh_env_vars(path, None);
    };
    let Some(server) = get_or_start_askpass(askpass, ssh_key) else {
        return ssh_env_vars(path, None);
    };
    let token = server.mint_token();
    ssh_env_vars(
        path,
        Some(AskpassRef {
            helper,
            endpoint: server.endpoint(),
            token: &token,
        }),
    )
}

/// Return the session's askpass server, starting it on first use.
///
/// `AskpassServer::start` can fail and `OnceLock` has no stable fallible
/// `get_or_try_init`, so a failed start is not recorded: `None` is returned and
/// the very next git invocation tries again rather than being stuck degraded
/// for the rest of the session over what may have been a transient failure.
/// A race between two callers both finding it unset resolves via `set`: the
/// loser's server is simply dropped and everyone reads the winner's.
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

    #[test]
    fn no_configured_key_means_no_extra_environment() {
        let app = TempAppData::new();
        assert!(git_env(&app.ctx).is_empty());
    }

    #[test]
    fn a_plain_key_is_passed_without_askpass() {
        let app = TempAppData::new();
        let path = write_plain_key(&app);
        app.ctx.ssh_key.set_path(Some(path.clone()));
        let vars = git_env(&app.ctx);
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
        let first = git_env(&app.ctx);
        let second = git_env(&app.ctx);
        let token = |v: &Vec<(String, String)>| {
            v.iter()
                .find(|(k, _)| k == skillkeeper_core::ssh_env::ASKPASS_TOKEN_ENV)
                .map(|(_, t)| t.clone())
                .expect("token")
        };
        assert_ne!(token(&first), token(&second), "tokens are single-use");
        assert!(first
            .iter()
            .any(|(k, v)| k == "SSH_ASKPASS_REQUIRE" && v == "force"));
    }

    #[test]
    fn a_locked_key_still_points_at_the_key_but_offers_no_passphrase() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        app.ctx.ssh_key.set_path(Some(path));
        let vars = git_env(&app.ctx);
        assert!(vars.iter().any(|(k, _)| k == "GIT_SSH_COMMAND"));
        assert!(vars.iter().all(|(k, _)| k != "SSH_ASKPASS"));
    }
}
