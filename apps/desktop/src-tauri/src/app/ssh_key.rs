//! The SSH key chosen in Settings and the passphrase held for it.
//!
//! The passphrase lives here and nowhere else: not in the config, not on disk,
//! and never across the bridge to the renderer. It is zeroized when forgotten,
//! when the chosen key changes, and when the process exits -- so "one session"
//! is enforced by the fact that there is nowhere else for it to be.
//!
//! This module also owns [`gate_for`], the pure decision table that tells a
//! git operation whether it may proceed with the chosen key as-is, must show
//! the unlock prompt, or must fail outright -- and the wait/notify pair
//! ([`SshKeyStore::wait_for_unlock`] / [`SshKeyStore::notify_unlock_result`])
//! that lets a blocked operation resume the moment an unlock window resolves.

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use ssh_key::PrivateKey;
use zeroize::Zeroizing;

/// Error key surfaced by [`gate_for`] and returned by
/// [`SshKeyStore::wait_for_unlock`] when a non-interactive caller finds the
/// key still locked, or when an unlock in progress is cancelled or times out.
pub const KEY_LOCKED_ERROR: &str = "ssh.keyLocked";
/// Error key surfaced by [`gate_for`] when the configured key path no longer
/// resolves to a file.
pub const KEY_MISSING_ERROR: &str = "ssh.keyMissing";
/// Error key surfaced by [`gate_for`] when the configured key path's contents
/// are not a recognisable private key.
pub const NOT_A_KEY_ERROR: &str = "ssh.notAPrivateKey";

/// What the chosen key's file looks like right now, as far as the renderer
/// needs to know: nothing configured, gone, unusable, or usable (locked or
/// already unlocked for this session).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyState {
    /// No key path has been chosen in Settings.
    NotConfigured,
    /// A path is chosen but no file exists there.
    Missing,
    /// A path is chosen and the file exists, but it is not a private key.
    NotAKey,
    /// A private key that needs no passphrase.
    Unencrypted,
    /// A passphrase-protected private key with no passphrase held for it.
    Locked,
    /// A passphrase-protected private key with its passphrase held for the
    /// remainder of this session.
    Unlocked,
}

/// Why [`SshKeyStore::unlock`] refused a passphrase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockError {
    /// The key parsed, but decrypting it with the given passphrase failed.
    WrongPassphrase,
    /// The configured key path does not resolve to a file.
    Missing,
    /// The configured key path's contents are not a recognisable private key.
    NotAKey,
}

/// The decision [`gate_for`] hands back for one prospective git operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    /// Run the operation now; nothing to unlock.
    Proceed,
    /// Show the unlock prompt and retry once the user answers it.
    Prompt,
    /// Refuse outright, with the renderer-facing error key to show.
    Fail(&'static str),
}

/// Decide whether a git operation over `transport_is_ssh` may run as-is,
/// given the chosen key's `state` and whether the caller is `interactive` (a
/// user-initiated action, as opposed to a scheduled background check).
///
/// | transport | state           | interactive | decision                  |
/// |-----------|-----------------|-------------|---------------------------|
/// | not ssh   | any             | any         | `Proceed`                 |
/// | ssh       | `NotConfigured` | any         | `Proceed`                 |
/// | ssh       | `Unencrypted`   | any         | `Proceed`                 |
/// | ssh       | `Unlocked`      | any         | `Proceed`                 |
/// | ssh       | `Locked`        | `true`      | `Prompt`                  |
/// | ssh       | `Locked`        | `false`     | `Fail(KEY_LOCKED_ERROR)`  |
/// | ssh       | `Missing`       | any         | `Proceed`                 |
/// | ssh       | `NotAKey`       | any         | `Fail(NOT_A_KEY_ERROR)`   |
///
/// A scheduled (non-interactive) operation never resolves to `Prompt`: it
/// either proceeds or fails outright, so a background check can never pop a
/// passphrase window with nobody there to answer it.
///
/// `Missing` proceeds rather than failing, because the key is offered and not
/// enforced (see `ssh_env_vars`): with no key to offer, the right behaviour is
/// the behaviour without this feature -- `ssh` picks an identity as it always
/// did. Refusing instead breaks a repository for a reason that is often
/// temporary: a key on a removable disk, a network share, or inside a WSL
/// distribution whose virtual machine has shut itself down after a few idle
/// minutes. The lease builder leaves the environment empty for this state, so
/// nothing points `ssh` at a path that is not there, and the settings row still
/// reports the key as missing.
pub fn gate_for(transport_is_ssh: bool, state: KeyState, interactive: bool) -> Gate {
    if !transport_is_ssh {
        return Gate::Proceed;
    }
    match state {
        KeyState::NotConfigured | KeyState::Unencrypted | KeyState::Unlocked => Gate::Proceed,
        KeyState::Locked if interactive => Gate::Prompt,
        KeyState::Locked => Gate::Fail(KEY_LOCKED_ERROR),
        KeyState::Missing => Gate::Proceed,
        KeyState::NotAKey => Gate::Fail(NOT_A_KEY_ERROR),
    }
}

/// What inspecting the key file on disk found, before folding in whether a
/// passphrase happens to be held for it.
enum Inspected {
    Missing,
    NotAKey,
    Unencrypted,
    Encrypted,
    /// A legacy PEM-format encrypted key. The `ssh-key` crate cannot parse
    /// (and so cannot locally verify) this format, unlike modern OpenSSH-format
    /// keys -- see [`inspect`] for why that is still safe to accept.
    EncryptedUnverifiable,
}

/// Inspect the file at `path` and classify it, without regard to any
/// passphrase held elsewhere.
///
/// A parse failure on OpenSSH-format text is deliberately classified as
/// `Unencrypted` rather than `NotAKey`: in that format an *encrypted* key's
/// payload is opaque ciphertext, so parsing never touches the inner key
/// algorithm and succeeds whatever that algorithm is. A parse failure there
/// therefore means an unencrypted key of an algorithm this build was not
/// compiled to support -- there is nothing to unlock. Should this
/// classification ever be wrong for some exotic key, the operation degrades
/// to today's behaviour rather than hanging: with no askpass variables set,
/// `ssh` prompts inside the private pseudo-terminal, whose input and output
/// are wired to the terminal view, so the user can still answer it there.
fn inspect(path: &str) -> Inspected {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Inspected::Missing,
        Err(_) => return Inspected::NotAKey,
    };
    let Ok(text) = String::from_utf8(bytes) else {
        return Inspected::NotAKey;
    };
    match PrivateKey::from_openssh(&text) {
        Ok(key) => {
            if key.is_encrypted() {
                Inspected::Encrypted
            } else {
                Inspected::Unencrypted
            }
        }
        Err(_) if text.contains("PRIVATE KEY") => {
            if text.contains("ENCRYPTED") || text.contains("DEK-Info") {
                Inspected::EncryptedUnverifiable
            } else {
                Inspected::Unencrypted
            }
        }
        Err(_) => Inspected::NotAKey,
    }
}

/// Try to decrypt the OpenSSH-format key at `path` with `passphrase`,
/// re-reading and re-parsing it (cheaply -- a local key file) since
/// [`Inspected`] does not carry the parsed key along.
fn try_decrypt(path: &str, passphrase: &str) -> Result<(), UnlockError> {
    let text = std::fs::read_to_string(path).map_err(|_| UnlockError::Missing)?;
    let key = PrivateKey::from_openssh(&text).map_err(|_| UnlockError::NotAKey)?;
    key.decrypt(passphrase)
        .map(|_| ())
        .map_err(|_| UnlockError::WrongPassphrase)
}

/// State guarded by [`SshKeyStore`]'s single mutex.
struct Inner {
    /// The path chosen in Settings, if any.
    path: Option<String>,
    /// The passphrase held for `unlocked_for`, for the rest of this session.
    passphrase: Option<Zeroizing<String>>,
    /// The path `passphrase` was verified against; compared to `path` so a
    /// passphrase held for a since-replaced key is never mistaken as current.
    unlocked_for: Option<String>,
    /// Bumped by every [`SshKeyStore::notify_unlock_result`] call; a waiter
    /// in [`SshKeyStore::wait_for_unlock`] wakes when this no longer matches
    /// the value it started with.
    unlock_generation: u64,
    /// The result carried by the most recent generation bump.
    last_unlock_ok: bool,
}

/// Owns the chosen SSH key's path and, for at most one session, the
/// passphrase that unlocks it.
///
/// One [`Mutex`] guards all of it; nothing here does I/O while holding it --
/// [`state`](Self::state) and [`unlock`](Self::unlock) read and parse the key
/// file with the lock released, then take it again only to record the
/// outcome.
pub struct SshKeyStore {
    inner: Mutex<Inner>,
    /// Wakes [`wait_for_unlock`](Self::wait_for_unlock) callers when
    /// [`notify_unlock_result`](Self::notify_unlock_result) bumps the
    /// generation counter in `inner`.
    unlock_cvar: Condvar,
}

impl Default for SshKeyStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SshKeyStore {
    /// An empty store: no key chosen, nothing held.
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                path: None,
                passphrase: None,
                unlocked_for: None,
                unlock_generation: 0,
                last_unlock_ok: false,
            }),
            unlock_cvar: Condvar::new(),
        }
    }

    /// Change the chosen key path. Any passphrase held for a *different*
    /// path is forgotten (zeroized on drop); re-setting the same path leaves
    /// a held passphrase alone.
    pub fn set_path(&self, path: Option<String>) {
        let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
        if inner.unlocked_for != path {
            inner.passphrase = None;
            inner.unlocked_for = None;
        }
        inner.path = path;
    }

    /// The currently chosen key path, if any.
    pub fn path(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("ssh key store lock poisoned")
            .path
            .clone()
    }

    /// Inspect the chosen key file and fold in whether a passphrase is
    /// currently held for it.
    pub fn state(&self) -> KeyState {
        let (path, unlocked) = {
            let inner = self.inner.lock().expect("ssh key store lock poisoned");
            let Some(path) = inner.path.clone() else {
                return KeyState::NotConfigured;
            };
            let unlocked =
                inner.passphrase.is_some() && inner.unlocked_for.as_deref() == Some(path.as_str());
            (path, unlocked)
        };
        match inspect(&path) {
            Inspected::Missing => KeyState::Missing,
            Inspected::NotAKey => KeyState::NotAKey,
            Inspected::Unencrypted => KeyState::Unencrypted,
            Inspected::Encrypted | Inspected::EncryptedUnverifiable => {
                if unlocked {
                    KeyState::Unlocked
                } else {
                    KeyState::Locked
                }
            }
        }
    }

    /// Verify `passphrase` against the chosen key and, on success, hold it
    /// for the rest of this session.
    ///
    /// An unencrypted key or a legacy PEM key (see [`inspect`]) accepts
    /// whatever is given, since neither can be locally verified; a modern
    /// OpenSSH-format encrypted key is actually decrypted here.
    ///
    /// The path is snapshotted at the start and the actual verification (a
    /// file read, a parse, and for an encrypted key a full bcrypt-pbkdf
    /// derivation -- on the order of 100ms) runs with the lock released, so
    /// the chosen key can change mid-call. If it has by the time this is
    /// ready to record the result, the verified passphrase belongs to a key
    /// that is no longer the current one: recording it anyway would let it
    /// leak to the *new* key's askpass requests, and would break the promise
    /// (see the module doc) that a key change always drops the held
    /// passphrase. So the record (and the notification) is skipped in that
    /// case -- this unlock simply no longer applies to anything.
    pub fn unlock(&self, passphrase: &str) -> Result<(), UnlockError> {
        let Some(path) = self.path() else {
            return Err(UnlockError::Missing);
        };

        let result = match inspect(&path) {
            Inspected::Missing => Err(UnlockError::Missing),
            Inspected::NotAKey => Err(UnlockError::NotAKey),
            Inspected::Unencrypted | Inspected::EncryptedUnverifiable => Ok(()),
            Inspected::Encrypted => try_decrypt(&path, passphrase),
        };

        if result.is_ok() {
            let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
            if inner.path.as_deref() == Some(path.as_str()) {
                inner.passphrase = Some(Zeroizing::new(passphrase.to_string()));
                inner.unlocked_for = Some(path);
                drop(inner);
                self.notify_unlock_result(true);
            }
        }

        result
    }

    /// Drop any held passphrase, re-locking the key for the rest of the
    /// session (until [`unlock`](Self::unlock) succeeds again).
    pub fn forget(&self) {
        let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
        inner.passphrase = None;
        inner.unlocked_for = None;
    }

    /// The currently held passphrase, if any. Crate-internal: this is the
    /// secret provider handed to [`super::askpass::AskpassServer::start`], so
    /// it must stay cheap and non-blocking -- a lock and a clone, no I/O.
    ///
    /// Wired into a live askpass secret closure in a later task; only tests
    /// call it so far.
    ///
    /// Re-checks `unlocked_for` against the current `path` here too, not just
    /// in [`state`](Self::state): this is the one accessor that actually
    /// hands the passphrase out, so the invariant "never serve a passphrase
    /// for a key that isn't the current one" has to hold here regardless of
    /// how a mismatch could arise (see [`unlock`](Self::unlock)'s doc).
    #[allow(dead_code)]
    pub(crate) fn passphrase(&self) -> Option<String> {
        let inner = self.inner.lock().expect("ssh key store lock poisoned");
        if inner.unlocked_for != inner.path {
            return None;
        }
        inner.passphrase.as_ref().map(|p| p.as_str().to_owned())
    }

    /// Block until an unlock attempt resolves or `timeout` elapses.
    ///
    /// Returns `Ok(())` the moment [`notify_unlock_result`](Self::notify_unlock_result)
    /// fires with `true` while this call is waiting. Returns
    /// `Err(KEY_LOCKED_ERROR.to_string())` when it instead fires with `false`
    /// (the user cancelled or closed the unlock window), or when `timeout`
    /// elapses first with no notification at all.
    ///
    /// A generation counter -- bumped on every notification, rather than a
    /// plain flag checked once -- is what lets a wait that starts before the
    /// matching notify, and a notify that lands after some other wait already
    /// timed out, both resolve correctly: this call only ever reacts to a
    /// generation change that happens *after* it started waiting.
    pub fn wait_for_unlock(&self, timeout: Duration) -> Result<(), String> {
        let mut guard = self.inner.lock().expect("ssh key store lock poisoned");
        let start_generation = guard.unlock_generation;
        let deadline = Instant::now() + timeout;
        loop {
            if guard.unlock_generation != start_generation {
                return if guard.last_unlock_ok {
                    Ok(())
                } else {
                    Err(KEY_LOCKED_ERROR.to_string())
                };
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(KEY_LOCKED_ERROR.to_string());
            }
            let (next, wait_result) = self
                .unlock_cvar
                .wait_timeout(guard, remaining)
                .expect("ssh key store lock poisoned");
            guard = next;
            if wait_result.timed_out() && guard.unlock_generation == start_generation {
                return Err(KEY_LOCKED_ERROR.to_string());
            }
        }
    }

    /// Wake every [`wait_for_unlock`](Self::wait_for_unlock) call currently
    /// waiting with the result of an unlock attempt: `true` on success,
    /// `false` on cancel or unlock-window close.
    pub fn notify_unlock_result(&self, ok: bool) {
        let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
        inner.unlock_generation = inner.unlock_generation.wrapping_add(1);
        inner.last_unlock_ok = ok;
        drop(inner);
        self.unlock_cvar.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ssh_key::{rand_core::OsRng, Algorithm, LineEnding, PrivateKey};

    /// Write a fresh ed25519 key to `path`, encrypted when a passphrase is given.
    /// Generated per test run: no private key material is committed.
    fn write_key(path: &std::path::Path, passphrase: Option<&str>) {
        let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let key = match passphrase {
            Some(p) => key.encrypt(&mut OsRng, p).unwrap(),
            None => key,
        };
        std::fs::write(path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    }

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sk-sshkey-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unconfigured_is_the_default() {
        assert_eq!(SshKeyStore::new().state(), KeyState::NotConfigured);
    }

    #[test]
    fn a_plain_key_needs_no_unlocking() {
        let dir = tmp();
        let path = dir.join("plain");
        write_key(&path, None);
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Unencrypted);
    }

    #[test]
    fn an_encrypted_key_starts_locked_and_unlocks_with_the_right_passphrase() {
        let dir = tmp();
        let path = dir.join("enc");
        write_key(&path, Some("topsecret"));
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Locked);
        assert_eq!(store.unlock("wrong"), Err(UnlockError::WrongPassphrase));
        assert_eq!(store.state(), KeyState::Locked);
        assert_eq!(store.unlock("topsecret"), Ok(()));
        assert_eq!(store.state(), KeyState::Unlocked);
        assert_eq!(store.passphrase().as_deref(), Some("topsecret"));
    }

    #[test]
    fn forgetting_relocks() {
        let dir = tmp();
        let path = dir.join("enc");
        write_key(&path, Some("topsecret"));
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        store.unlock("topsecret").unwrap();
        store.forget();
        assert_eq!(store.state(), KeyState::Locked);
        assert!(store.passphrase().is_none());
    }

    #[test]
    fn choosing_a_different_key_drops_the_held_passphrase() {
        let dir = tmp();
        let first = dir.join("first");
        let second = dir.join("second");
        write_key(&first, Some("topsecret"));
        write_key(&second, Some("other"));
        let store = SshKeyStore::new();
        store.set_path(Some(first.to_string_lossy().into_owned()));
        store.unlock("topsecret").unwrap();
        store.set_path(Some(second.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Locked);
        assert!(store.passphrase().is_none());
    }

    #[test]
    fn passphrase_is_withheld_when_held_for_a_different_path_than_the_current_one() {
        // Pins the accessor-level guard directly, regardless of how a
        // mismatch between `unlocked_for` and `path` could ever arise (e.g.
        // the chosen key changing while an `unlock` verification was still
        // in flight -- see `unlock`'s doc comment): `passphrase()` must
        // never hand out a value that was verified against a key that is no
        // longer the current one.
        let store = SshKeyStore::new();
        {
            let mut inner = store.inner.lock().unwrap();
            inner.path = Some("current".to_string());
            inner.unlocked_for = Some("previous".to_string());
            inner.passphrase = Some(Zeroizing::new("stale".to_string()));
        }
        assert!(store.passphrase().is_none());
    }

    #[test]
    fn a_vanished_or_bogus_file_is_reported_as_such() {
        let dir = tmp();
        let store = SshKeyStore::new();
        store.set_path(Some(dir.join("nope").to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Missing);

        let junk = dir.join("junk.txt");
        std::fs::write(&junk, b"just some text\n").unwrap();
        store.set_path(Some(junk.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::NotAKey);
        assert_eq!(store.unlock("x"), Err(UnlockError::NotAKey));
    }

    #[test]
    fn a_legacy_pem_key_is_accepted_without_local_verification() {
        // Old-format encrypted PEM keys cannot be parsed by the ssh-key crate.
        // They must still be usable: the passphrase is taken as given and the
        // first real error comes from ssh itself.
        let dir = tmp();
        let path = dir.join("legacy");
        std::fs::write(
            &path,
            b"-----BEGIN RSA PRIVATE KEY-----\n\
              Proc-Type: 4,ENCRYPTED\n\
              DEK-Info: AES-128-CBC,0123456789ABCDEF\n\n\
              bogusbase64\n\
              -----END RSA PRIVATE KEY-----\n",
        )
        .unwrap();
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Locked);
        assert_eq!(store.unlock("anything"), Ok(()));
        assert_eq!(store.state(), KeyState::Unlocked);
    }

    #[test]
    fn the_gate_only_prompts_for_user_initiated_ssh_work() {
        // Not an SSH remote: nothing to unlock, whatever the key state.
        assert_eq!(gate_for(false, KeyState::Locked, true), Gate::Proceed);
        // No key configured: today's behaviour, the system agent decides.
        assert_eq!(gate_for(true, KeyState::NotConfigured, true), Gate::Proceed);
        assert_eq!(gate_for(true, KeyState::Unencrypted, true), Gate::Proceed);
        assert_eq!(gate_for(true, KeyState::Unlocked, false), Gate::Proceed);
        // Locked: ask, but only when the user asked for this operation. A
        // scheduled update check must never pop a passphrase window.
        assert_eq!(gate_for(true, KeyState::Locked, true), Gate::Prompt);
        assert_eq!(
            gate_for(true, KeyState::Locked, false),
            Gate::Fail("ssh.keyLocked")
        );
        // A key that cannot be read right now (a network share, a stopped WSL
        // distribution) must not break the repository: with nothing to offer,
        // ssh chooses an identity exactly as it would without this feature.
        assert_eq!(gate_for(true, KeyState::Missing, true), Gate::Proceed);
        assert_eq!(gate_for(true, KeyState::Missing, false), Gate::Proceed);
        assert_eq!(
            gate_for(true, KeyState::NotAKey, true),
            Gate::Fail("ssh.notAPrivateKey")
        );
    }

    #[test]
    fn a_cancelled_unlock_wakes_a_waiter_with_key_locked() {
        let store = std::sync::Arc::new(SshKeyStore::new());
        let waiter = std::sync::Arc::clone(&store);
        let handle = std::thread::spawn(move || waiter.wait_for_unlock(Duration::from_secs(5)));

        // Give the waiter time to actually start waiting before the notify,
        // so this also exercises "wait started before notify".
        std::thread::sleep(Duration::from_millis(100));
        store.notify_unlock_result(false);

        // `Err(KEY_LOCKED_ERROR)` is also what a plain 5s timeout would
        // return, so the join is timed too: the assertion below only passes
        // if the waiter was actually woken by the notify, not merely
        // outlasted by this test's patience.
        let before_join = Instant::now();
        let result = handle.join().expect("waiter thread must not panic");
        assert_eq!(result, Err(KEY_LOCKED_ERROR.to_string()));
        assert!(
            before_join.elapsed() < Duration::from_secs(1),
            "the waiter must be woken by the notify, not by the 5s timeout"
        );
    }

    #[test]
    fn a_successful_unlock_wakes_a_waiter_with_ok() {
        let store = std::sync::Arc::new(SshKeyStore::new());
        let waiter = std::sync::Arc::clone(&store);
        let handle = std::thread::spawn(move || waiter.wait_for_unlock(Duration::from_secs(5)));

        std::thread::sleep(Duration::from_millis(100));
        store.notify_unlock_result(true);

        let result = handle.join().expect("waiter thread must not panic");
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn a_wait_with_no_notification_expires_instead_of_hanging() {
        let store = SshKeyStore::new();
        let result = store.wait_for_unlock(Duration::from_millis(50));
        assert_eq!(result, Err(KEY_LOCKED_ERROR.to_string()));
    }

    #[test]
    fn a_late_notify_after_a_timed_out_wait_does_not_affect_a_later_wait() {
        let store = SshKeyStore::new();
        // This wait times out on its own; nothing ever notifies it.
        assert_eq!(
            store.wait_for_unlock(Duration::from_millis(50)),
            Err(KEY_LOCKED_ERROR.to_string())
        );

        // A "late" notify, arriving only after the above already gave up.
        store.notify_unlock_result(true);

        // A fresh wait must react to a *new* generation only. If it instead
        // treated the stale bump above as its own signal, it would resolve
        // immediately with `Ok(())` (matching that bump's `true`) instead of
        // genuinely waiting out its own timeout with `Err`; nothing notifies
        // this second wait at all, so only a correct, generation-scoped
        // implementation gets this right.
        let start = Instant::now();
        let result = store.wait_for_unlock(Duration::from_millis(100));
        assert_eq!(result, Err(KEY_LOCKED_ERROR.to_string()));
        assert!(
            start.elapsed() >= Duration::from_millis(90),
            "a fresh wait must not resolve instantly from a stale generation bump"
        );
    }
}
