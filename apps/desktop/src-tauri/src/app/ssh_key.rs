//! The SSH key chosen in Settings and the passphrase held for it.
//!
//! The passphrase lives here and nowhere else: not in the config, not on disk,
//! and never across the bridge to the renderer. It is zeroized when forgotten,
//! when the chosen key changes, and when the process exits -- so "one session"
//! is enforced by the fact that there is nowhere else for it to be.
//!
//! A PuTTY-format key holds nothing at all: `ssh` cannot read that format, so
//! [`SshKeyStore::load_putty`] decrypts it, converts it in memory and hands it
//! to the session's ssh-agent, keeping only the public line needed to take it
//! back out again ([`SshKeyStore::unload_putty`]). The passphrase is used and
//! dropped -- there is no per-invocation decryption left for anything to need
//! it for.
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

use crate::app::ppk::parse::PpkError;

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
/// Error key surfaced when a PuTTY key is chosen but no ssh-agent is available
/// to hold it. The only state the export action exists for.
pub const PUTTY_NEEDS_AGENT_ERROR: &str = "ssh.puttyNeedsAgent";
/// Error key for a PuTTY key whose algorithm cannot be re-encoded (ssh-dss).
pub const PUTTY_UNSUPPORTED_ERROR: &str = "ssh.puttyUnsupportedAlgorithm";
/// Error key for a PuTTY key whose MAC does not match without a passphrase in
/// play: the file is corrupt.
pub const PUTTY_DAMAGED_ERROR: &str = "ssh.puttyDamaged";
/// Error key for an export that could not be written or re-encrypted.
pub const EXPORT_FAILED_ERROR: &str = "ssh.puttyExportFailed";

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
    /// A PuTTY key with a passphrase, not yet in the agent.
    PuttyLocked,
    /// A PuTTY key with no passphrase, not yet in the agent.
    PuttyUnencrypted,
    /// A PuTTY key this session loaded into the agent.
    PuttyInAgent,
    /// A PuTTY key with no agent to hold it, which is the one thing it needs.
    PuttyNoAgent,
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
    /// The key's algorithm cannot be re-encoded for OpenSSH (ssh-dss).
    Unsupported,
    /// The key file's MAC does not match with no passphrase in play: it is
    /// corrupt, and no passphrase will fix it.
    Damaged,
    /// The key was read and converted, but the agent would not take it:
    /// `ssh-add` is missing, the socket named by `SSH_AUTH_SOCK` has no live
    /// agent behind it, or the agent refused. Distinct from [`NotAKey`](Self::NotAKey)
    /// because nothing is wrong with the key -- `is_available` only checks that
    /// a socket is NAMED, so this is a steady state on a machine with a stale
    /// or forwarded socket and no usable `ssh-add`, not a corner case.
    AgentUnavailable,
}

/// The one table from a PPK failure to an unlock failure: every caller that
/// reports a PPK failure to the user -- [`SshKeyStore::load_putty`] and the
/// export path in `commands::ssh_key` alike -- comes through here, and then
/// through that module's `unlock_error_key`, so there is one table from
/// [`PpkError`] and one from [`UnlockError`] rather than three that merely
/// agree today.
///
/// Not the universal mapping, though: two sites deliberately collapse any PPK
/// failure to [`NOT_A_KEY_ERROR`] instead of routing through here. [`inspect`]
/// only asks whether the file is a readable key at all, and `begin_export`'s
/// up-front read only asks whether a passphrase is needed -- neither is
/// reporting an unlock, and both are coarse on purpose.
impl From<PpkError> for UnlockError {
    fn from(error: PpkError) -> Self {
        match error {
            PpkError::WrongPassphrase => Self::WrongPassphrase,
            // These two are why `UnlockError` grows: flattening them into
            // `NotAKey` would tell a user with a DSA key or a corrupt file
            // to go looking for a problem that is not theirs.
            PpkError::UnsupportedAlgorithm => Self::Unsupported,
            PpkError::Damaged => Self::Damaged,
            // Everything structural reads the same to a user: the file is not
            // a key this build can use. Named rather than caught by a `_`, so
            // a new `PpkError` has to be decided about here.
            PpkError::NotPpk
            | PpkError::UnsupportedVersion
            | PpkError::Malformed
            | PpkError::UnsupportedEncryption => Self::NotAKey,
        }
    }
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
    /// Load the key into the agent and then run the operation. Unlike
    /// [`Gate::Prompt`] this asks the user nothing, so it is valid for a
    /// scheduled operation too.
    LoadIntoAgent,
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
/// | ssh       | `PuttyNoAgent`  | any         | `Fail(PUTTY_NEEDS_AGENT_ERROR)` |
/// | ssh       | `PuttyUnencrypted` | any      | `LoadIntoAgent`           |
/// | ssh       | `PuttyInAgent`  | any         | `Proceed`                 |
/// | ssh       | `PuttyLocked`   | `true`      | `Prompt`                  |
/// | ssh       | `PuttyLocked`   | `false`     | `Fail(KEY_LOCKED_ERROR)`  |
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
        KeyState::PuttyNoAgent => Gate::Fail(PUTTY_NEEDS_AGENT_ERROR),
        KeyState::PuttyUnencrypted => Gate::LoadIntoAgent,
        KeyState::PuttyInAgent => Gate::Proceed,
        KeyState::PuttyLocked if interactive => Gate::Prompt,
        KeyState::PuttyLocked => Gate::Fail(KEY_LOCKED_ERROR),
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
    /// A PuTTY-format key, with whether it carries a passphrase.
    Putty {
        encrypted: bool,
    },
}

/// The PEM line width `ssh-encoding` hard-codes -- for its DECODER as well as
/// its encoder, which is what makes the rewrap below necessary.
const PEM_LINE_WIDTH: usize = 70;

/// The only PEM label [`PrivateKey::from_openssh`] accepts.
const OPENSSH_PEM_BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_PEM_END: &str = "-----END OPENSSH PRIVATE KEY-----";

/// Rewrap an OpenSSH-format PEM body to the 70 columns `ssh-key` insists on,
/// leaving anything that is not one alone.
///
/// `ssh-encoding` uses one hard-coded `PEM_LINE_WIDTH` for both directions, so
/// `ssh-key` reads only 70-column PEM -- which is what OpenSSH itself writes.
/// `puttygen -O private-openssh-new` writes **64** columns, and that is exactly
/// the command this project's own CLI warning tells users to run. Without this,
/// such a key never parses: [`inspect`] falls through to the legacy-PEM branch,
/// where an OpenSSH-format encrypted key (whose body carries neither
/// `ENCRYPTED` nor `DEK-Info`, both being legacy-PEM headers) is classified
/// `Unencrypted`. Git still works, because `ssh` reads the file itself, but the
/// app never offers to hold the passphrase.
///
/// Layout only: the base64 body is passed through character for character, so
/// a body that is not valid base64 still fails in the parser rather than here.
fn normalize_openssh_pem(text: &str) -> std::borrow::Cow<'_, str> {
    let mut body = String::new();
    let mut in_body = false;
    let mut terminated = false;
    for line in text.lines() {
        let line = line.trim();
        if line == OPENSSH_PEM_BEGIN {
            in_body = true;
        } else if line == OPENSSH_PEM_END {
            terminated = in_body;
            break;
        } else if in_body {
            body.push_str(line);
        }
    }
    if !terminated {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(body.len() + OPENSSH_PEM_BEGIN.len() * 2 + 8);
    out.push_str(OPENSSH_PEM_BEGIN);
    out.push('\n');
    for (i, ch) in body.chars().enumerate() {
        if i > 0 && i % PEM_LINE_WIDTH == 0 {
            out.push('\n');
        }
        out.push(ch);
    }
    out.push('\n');
    out.push_str(OPENSSH_PEM_END);
    out.push('\n');
    std::borrow::Cow::Owned(out)
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
    if skillkeeper_core::key_format::sniff(&text) == skillkeeper_core::key_format::KeyFormat::Putty
    {
        // Only the container is read here: whether it is encrypted is a header
        // field, and no key material is touched until the user asks for it.
        return match crate::app::ppk::parse::parse(&text) {
            Ok(file) => Inspected::Putty {
                encrypted: file.is_encrypted(),
            },
            Err(_) => Inspected::NotAKey,
        };
    }
    match PrivateKey::from_openssh(normalize_openssh_pem(&text).as_ref()) {
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

/// Fold what [`inspect`] found on disk together with what the store holds and
/// whether an ssh-agent is available into the one state the renderer and the
/// gate both read.
///
/// | inspected              | unlocked | putty_loaded | agent | state              |
/// |------------------------|----------|--------------|-------|--------------------|
/// | `Missing`              | any      | any          | any   | `Missing`          |
/// | `NotAKey`              | any      | any          | any   | `NotAKey`          |
/// | `Unencrypted`          | any      | any          | any   | `Unencrypted`      |
/// | `Encrypted`            | `true`   | any          | any   | `Unlocked`         |
/// | `Encrypted`            | `false`  | any          | any   | `Locked`           |
/// | `EncryptedUnverifiable`| `true`   | any          | any   | `Unlocked`         |
/// | `EncryptedUnverifiable`| `false`  | any          | any   | `Locked`           |
/// | `Putty`                | any      | `true`       | any   | `PuttyInAgent`     |
/// | `Putty`                | any      | `false`      | `false` | `PuttyNoAgent`   |
/// | `Putty { encrypted: true }`  | any | `false`     | `true`  | `PuttyLocked`    |
/// | `Putty { encrypted: false }` | any | `false`     | `true`  | `PuttyUnencrypted` |
///
/// Pure, and every input is a parameter -- including `agent`, which
/// [`state`](SshKeyStore::state) supplies from
/// [`ssh_agent::is_available`](super::ssh_agent::is_available). That is what
/// makes each row above testable exactly, rather than as an "or" of whatever
/// the machine running the test happens to have.
fn classify(inspected: Inspected, unlocked: bool, putty_loaded: bool, agent: bool) -> KeyState {
    match inspected {
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
        // Order matters: a key already in the agent stays reported as such
        // even if agent detection flickers.
        Inspected::Putty { encrypted } => {
            if putty_loaded {
                KeyState::PuttyInAgent
            } else if !agent {
                KeyState::PuttyNoAgent
            } else if encrypted {
                KeyState::PuttyLocked
            } else {
                KeyState::PuttyUnencrypted
            }
        }
    }
}

/// Try to decrypt the OpenSSH-format key at `path` with `passphrase`,
/// re-reading and re-parsing it (cheaply -- a local key file) since
/// [`Inspected`] does not carry the parsed key along.
fn try_decrypt(path: &str, passphrase: &str) -> Result<(), UnlockError> {
    let text = std::fs::read_to_string(path).map_err(|_| UnlockError::Missing)?;
    let key = PrivateKey::from_openssh(normalize_openssh_pem(&text).as_ref())
        .map_err(|_| UnlockError::NotAKey)?;
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
    /// The public key line of the PuTTY key this session put in the agent, and
    /// the path it was loaded for. Public material only -- the private half
    /// left this process the moment it was piped to `ssh-add`.
    putty_public: Option<String>,
    putty_loaded_for: Option<String>,
    /// Bumped by every [`SshKeyStore::notify_unlock_result`] call; a waiter
    /// in [`SshKeyStore::wait_for_unlock`] wakes when this no longer matches
    /// the value it started with.
    unlock_generation: u64,
    /// The result carried by the most recent generation bump.
    last_unlock_ok: bool,
    /// An export the user has asked for, waiting for the unlock window to
    /// supply the passphrase. Cleared when it is taken, when the chosen path
    /// changes, and whenever the window it was parked for is answered by a
    /// cancel or a close rather than a submitted passphrase.
    pending_export: Option<PendingExport>,
}

/// The source path and destination of an export waiting on a passphrase.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingExport {
    /// The key path this export was started for. Checked against the
    /// store's current path before the export runs (see
    /// [`SshKeyStore::take_pending_export`]), so a slot left over from a key
    /// that has since changed is inert rather than exporting -- or being
    /// asked to export -- the wrong key.
    source: String,
    /// Where the converted key should be written.
    dest: String,
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
                putty_public: None,
                putty_loaded_for: None,
                unlock_generation: 0,
                last_unlock_ok: false,
                pending_export: None,
            }),
            unlock_cvar: Condvar::new(),
        }
    }

    /// Change the chosen key path. Any passphrase held for a *different*
    /// path is forgotten (zeroized on drop), and a PuTTY key loaded for a
    /// different path is taken back out of the agent; re-setting the same path
    /// leaves both alone.
    pub fn set_path(&self, path: Option<String>) {
        // Read, decide, release -- then unload with the lock down, because
        // [`unload_putty`](Self::unload_putty) takes it again and spawns
        // `ssh-add`. Nothing else here can change `putty_loaded_for` in the
        // gap: only a load or another `set_path` does, and either way the
        // outcome is the same key ending up out of the agent.
        let stale_in_agent = {
            let inner = self.inner.lock().expect("ssh key store lock poisoned");
            inner.putty_loaded_for.is_some() && inner.putty_loaded_for != path
        };
        if stale_in_agent {
            self.unload_putty();
        }
        let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
        if inner.unlocked_for != path {
            inner.passphrase = None;
            inner.unlocked_for = None;
        }
        // A pending export is tied to the key it was started for, not to
        // whether an OpenSSH passphrase happens to be held -- any actual path
        // change invalidates it, independently of the check above.
        if inner.path != path {
            inner.pending_export = None;
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

    /// Record where the next successful passphrase entry should export
    /// `source` to.
    pub fn set_pending_export(&self, source: String, dest: String) {
        self.inner
            .lock()
            .expect("ssh key store lock poisoned")
            .pending_export = Some(PendingExport { source, dest });
    }

    /// Take the pending export, if it still applies to the currently chosen
    /// path, leaving none behind either way.
    ///
    /// A passphrase answers exactly one export: a second attempt has to be
    /// asked for again ([`set_pending_export`](Self::set_pending_export) is
    /// what parks a fresh one). A slot whose source no longer matches the
    /// chosen key is stale -- the key changed after Convert was clicked but
    /// before the window was answered -- and is discarded here rather than
    /// honoured, so a later, unrelated passphrase can never be spent
    /// exporting a key that is no longer the current one.
    pub fn take_pending_export(&self) -> Option<(String, String)> {
        let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
        let pending = inner.pending_export.take()?;
        (inner.path.as_deref() == Some(pending.source.as_str()))
            .then_some((pending.source, pending.dest))
    }

    /// Drop a pending export without regard to whether it still applies.
    ///
    /// Used when the window it was waiting on is answered by a cancel or a
    /// close instead of a submitted passphrase, and when raising that window
    /// failed outright -- neither leaves a slot for a later, unrelated
    /// passphrase to be spent on.
    pub fn clear_pending_export(&self) {
        self.inner
            .lock()
            .expect("ssh key store lock poisoned")
            .pending_export = None;
    }

    /// Whether a pending export is currently parked. Test-only: the field is
    /// private to this module.
    #[cfg(test)]
    pub(crate) fn has_pending_export(&self) -> bool {
        self.inner
            .lock()
            .expect("ssh key store lock poisoned")
            .pending_export
            .is_some()
    }

    /// Inspect the chosen key file and fold in whether a passphrase is
    /// currently held for it.
    ///
    /// The file read and the agent probe both run with the lock released;
    /// [`classify`] is the pure fold over what they found.
    pub fn state(&self) -> KeyState {
        let (path, unlocked, putty_loaded) = {
            let inner = self.inner.lock().expect("ssh key store lock poisoned");
            let Some(path) = inner.path.clone() else {
                return KeyState::NotConfigured;
            };
            let unlocked =
                inner.passphrase.is_some() && inner.unlocked_for.as_deref() == Some(path.as_str());
            let putty_loaded = inner.putty_public.is_some()
                && inner.putty_loaded_for.as_deref() == Some(path.as_str());
            (path, unlocked, putty_loaded)
        };
        classify(
            inspect(&path),
            unlocked,
            putty_loaded,
            crate::app::ssh_agent::is_available(),
        )
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
            // A PuTTY key is never unlocked this way: [`load_putty`](Self::load_putty)
            // is its unlock, and holding a passphrase for it here is exactly the
            // retention the agent path exists to avoid. The command layer routes
            // by state, so reaching this means the chosen file stopped being the
            // OpenSSH key the prompt was raised for while it was up.
            Inspected::Putty { .. } => Err(UnlockError::NotAKey),
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

    /// Drop any held passphrase and take this session's PuTTY key back out of
    /// the agent, re-locking the key for the rest of the session (until
    /// [`unlock`](Self::unlock) or [`load_putty`](Self::load_putty) succeeds
    /// again).
    ///
    /// Both halves, so the padlock in Settings means the same thing whichever
    /// format the chosen key is in.
    pub fn forget(&self) {
        {
            let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
            inner.passphrase = None;
            inner.unlocked_for = None;
        }
        // Outside the block above: this takes the lock itself and then spawns
        // `ssh-add`, neither of which may happen with the lock held.
        self.unload_putty();
    }

    /// Decrypt the chosen PuTTY key with `passphrase`, convert it, and put it
    /// in the agent for this session.
    ///
    /// The passphrase is used and dropped: unlike the OpenSSH path, nothing
    /// needs it again, because `ssh` gets the key from the agent rather than
    /// from a file it has to decrypt per invocation.
    ///
    /// # Errors
    ///
    /// [`UnlockError::Missing`] when the file is gone, [`UnlockError::NotAKey`]
    /// when it is not a PuTTY key at all, [`UnlockError::WrongPassphrase`], [`UnlockError::Unsupported`] for an
    /// algorithm with no OpenSSH form, [`UnlockError::Damaged`] for a file
    /// whose MAC does not match with no passphrase in play, and
    /// [`UnlockError::AgentUnavailable`] when the key converted but `ssh-add`
    /// would not take it. No part of the key or the passphrase appears in any
    /// of them.
    pub fn load_putty(&self, passphrase: &str) -> Result<(), UnlockError> {
        let Some(path) = self.path() else {
            return Err(UnlockError::Missing);
        };
        // Every expensive step -- the read, the Argon2 derivation, the
        // `ssh-add` subprocess -- runs with the lock down; only the outcome is
        // recorded under it.
        let text = std::fs::read_to_string(&path).map_err(|_| UnlockError::Missing)?;
        let file = crate::app::ppk::parse::parse(&text).map_err(|_| UnlockError::NotAKey)?;
        let converted =
            crate::app::ppk::convert::convert(&file, passphrase).map_err(UnlockError::from)?;
        crate::app::ssh_agent::add_from_memory(
            &converted.openssh,
            crate::app::ssh_agent::AGENT_KEY_TTL_SECS,
        )
        .map_err(|_| UnlockError::AgentUnavailable)?;
        // The private half is done with: it went down the pipe and the
        // `Zeroizing` copy is dropped here with the rest of `converted`.
        let public_line = converted.public_line;

        // The chosen key can change while the conversion runs (an Argon2
        // derivation is not instant), and a key loaded for a path that is no
        // longer current must not be recorded as the current one.
        let orphaned = {
            let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
            if inner.path.as_deref() == Some(path.as_str()) {
                inner.putty_public = Some(public_line);
                inner.putty_loaded_for = Some(path);
                None
            } else {
                Some(public_line)
            }
        };
        match orphaned {
            // Recorded, so this unlock applies to the current key: release
            // whatever was waiting on it. Inside the guard, like `unlock`'s
            // own notify -- the branch below recorded nothing and succeeded at
            // nothing the waiters care about.
            None => self.notify_unlock_result(true),
            // Nothing records this key now, so nothing could ever remove it:
            // without this, key material would sit in the agent until the
            // 12-hour TTL expired, outliving the session that put it there.
            // Outside the lock, as every agent call is.
            Some(line) => {
                let _ = crate::app::ssh_agent::remove(&line);
            }
        }
        Ok(())
    }

    /// The public line of the PuTTY key this session put in the agent, if one
    /// is recorded.
    ///
    /// Public material only, and the one thing needed to ask the agent whether
    /// it still holds that key (see [`super::ssh_agent::key_status`]). Cheap and
    /// non-blocking, like every accessor here: a lock and a clone, no I/O.
    pub(crate) fn putty_public_line(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("ssh key store lock poisoned")
            .putty_public
            .clone()
    }

    /// Record `public_line` as loaded for `path`, without an agent to load it
    /// into.
    ///
    /// Test-only: the fields are private to this module, so this is the only
    /// way a test outside it (the git-failure path's, in `ssh_git`) can set up
    /// a store that reports [`KeyState::PuttyInAgent`].
    #[cfg(test)]
    pub(crate) fn record_putty_loaded(&self, path: String, public_line: String) {
        let mut inner = self.inner.lock().expect("ssh key store lock poisoned");
        inner.putty_public = Some(public_line);
        inner.putty_loaded_for = Some(path);
    }

    /// Take this session's PuTTY key back out of the agent, if one is there.
    ///
    /// Best-effort: an agent that is gone, or a key that already expired, is
    /// the outcome this asks for.
    pub fn unload_putty(&self) {
        let public = {
            // Deliberately not `expect`: this runs on the exit paths, one of
            // which is inside an Objective-C termination frame on macOS where
            // unwinding a panic is undefined. Taking the guard from a poisoned
            // lock still gets the key out, which is the whole point of the
            // call, and the two fields read here are plain `Option<String>`s
            // that no panic can leave half-written.
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.putty_loaded_for = None;
            inner.putty_public.take()
        };
        if let Some(line) = public {
            let _ = crate::app::ssh_agent::remove(&line);
        }
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
    fn choosing_a_different_key_drops_a_pending_export() {
        let store = SshKeyStore::new();
        store.set_path(Some("first".to_string()));
        store.set_pending_export("first".to_string(), "dest".to_string());
        store.set_path(Some("second".to_string()));
        assert!(
            !store.has_pending_export(),
            "an export parked for a key that is no longer chosen must not linger"
        );
    }

    #[test]
    fn a_pending_export_whose_source_no_longer_matches_the_chosen_key_is_ignored() {
        // Mirrors `passphrase_is_withheld_when_held_for_a_different_path_than_the_current_one`
        // directly at the `Inner` level: regardless of how a slot surviving a
        // key change could ever arise, `take_pending_export` must never hand
        // one back for a source that is no longer the chosen key.
        let store = SshKeyStore::new();
        {
            let mut inner = store.inner.lock().unwrap();
            inner.path = Some("current".to_string());
            inner.pending_export = Some(PendingExport {
                source: "previous".to_string(),
                dest: "dest".to_string(),
            });
        }
        assert_eq!(store.take_pending_export(), None);
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
    fn a_putty_key_without_an_agent_fails_with_its_own_code() {
        assert_eq!(
            gate_for(true, KeyState::PuttyNoAgent, true),
            Gate::Fail(PUTTY_NEEDS_AGENT_ERROR)
        );
        assert_eq!(
            gate_for(true, KeyState::PuttyNoAgent, false),
            Gate::Fail(PUTTY_NEEDS_AGENT_ERROR)
        );
    }

    #[test]
    fn an_unencrypted_putty_key_loads_without_a_prompt() {
        // No window is involved, so a scheduled check may do this on its own.
        assert_eq!(
            gate_for(true, KeyState::PuttyUnencrypted, true),
            Gate::LoadIntoAgent
        );
        assert_eq!(
            gate_for(true, KeyState::PuttyUnencrypted, false),
            Gate::LoadIntoAgent
        );
    }

    #[test]
    fn a_locked_putty_key_prompts_only_for_a_user() {
        assert_eq!(gate_for(true, KeyState::PuttyLocked, true), Gate::Prompt);
        assert_eq!(
            gate_for(true, KeyState::PuttyLocked, false),
            Gate::Fail(KEY_LOCKED_ERROR)
        );
    }

    #[test]
    fn a_loaded_putty_key_proceeds() {
        assert_eq!(gate_for(true, KeyState::PuttyInAgent, false), Gate::Proceed);
    }

    #[test]
    fn no_putty_state_affects_a_non_ssh_transport() {
        for state in [
            KeyState::PuttyLocked,
            KeyState::PuttyUnencrypted,
            KeyState::PuttyInAgent,
            KeyState::PuttyNoAgent,
        ] {
            assert_eq!(gate_for(false, state, false), Gate::Proceed);
        }
    }

    /// Every PPK failure's unlock failure, in the one table that decides it.
    ///
    /// The mapping used to be written out three times -- here, in the export
    /// path and in the renderer-key table -- with nothing keeping them in
    /// step. Now they are one table each, and this pins the first.
    #[test]
    fn every_ppk_failure_maps_to_an_unlock_failure() {
        let table = [
            (PpkError::WrongPassphrase, UnlockError::WrongPassphrase),
            (PpkError::UnsupportedAlgorithm, UnlockError::Unsupported),
            (PpkError::Damaged, UnlockError::Damaged),
            (PpkError::NotPpk, UnlockError::NotAKey),
            (PpkError::UnsupportedVersion, UnlockError::NotAKey),
            (PpkError::Malformed, UnlockError::NotAKey),
            (PpkError::UnsupportedEncryption, UnlockError::NotAKey),
        ];
        for (ppk, expected) in table {
            assert_eq!(UnlockError::from(ppk), expected, "{ppk:?}");
        }
    }

    /// Every row of the state fold, asserted exactly.
    ///
    /// `state` folds in whether this machine happens to run an ssh-agent, so
    /// a test that went through it could only ever assert an "or" of the four
    /// PuTTY states -- and would pass whether the code worked or not. Every
    /// input is a parameter here, so nothing is left to the environment, and
    /// every [`Inspected`] and every [`KeyState`] is named: a new variant of
    /// either has to be decided about in this table.
    #[test]
    fn the_state_fold_answers_every_row_exactly() {
        // (inspected, unlocked, putty_loaded, agent) -> state
        let rows = [
            // A file that is gone or unreadable answers the same whatever is
            // held for it.
            (Inspected::Missing, false, false, false, KeyState::Missing),
            (Inspected::Missing, true, true, true, KeyState::Missing),
            (Inspected::NotAKey, false, false, false, KeyState::NotAKey),
            (Inspected::NotAKey, true, true, true, KeyState::NotAKey),
            // A key with no passphrase is never "unlocked": there was nothing
            // to unlock, whatever a stale flag might say.
            (
                Inspected::Unencrypted,
                false,
                false,
                false,
                KeyState::Unencrypted,
            ),
            (
                Inspected::Unencrypted,
                true,
                true,
                true,
                KeyState::Unencrypted,
            ),
            (Inspected::Encrypted, false, false, false, KeyState::Locked),
            (Inspected::Encrypted, true, false, false, KeyState::Unlocked),
            // A legacy PEM key cannot be verified locally, but it locks and
            // unlocks exactly like a modern one.
            (
                Inspected::EncryptedUnverifiable,
                false,
                false,
                false,
                KeyState::Locked,
            ),
            (
                Inspected::EncryptedUnverifiable,
                true,
                false,
                false,
                KeyState::Unlocked,
            ),
            // A PuTTY key in the agent stays reported as such even if agent
            // detection flickers, and whether it carries a passphrase no
            // longer matters once it is loaded.
            (
                Inspected::Putty { encrypted: true },
                false,
                true,
                false,
                KeyState::PuttyInAgent,
            ),
            (
                Inspected::Putty { encrypted: false },
                false,
                true,
                false,
                KeyState::PuttyInAgent,
            ),
            (
                Inspected::Putty { encrypted: true },
                false,
                true,
                true,
                KeyState::PuttyInAgent,
            ),
            (
                Inspected::Putty { encrypted: false },
                false,
                true,
                true,
                KeyState::PuttyInAgent,
            ),
            // No agent to hold it: the one thing a PuTTY key needs, and the
            // state the export action exists for.
            (
                Inspected::Putty { encrypted: true },
                false,
                false,
                false,
                KeyState::PuttyNoAgent,
            ),
            (
                Inspected::Putty { encrypted: false },
                false,
                false,
                false,
                KeyState::PuttyNoAgent,
            ),
            // An agent, but the key is not in it yet.
            (
                Inspected::Putty { encrypted: true },
                false,
                false,
                true,
                KeyState::PuttyLocked,
            ),
            (
                Inspected::Putty { encrypted: false },
                false,
                false,
                true,
                KeyState::PuttyUnencrypted,
            ),
            // A held OpenSSH passphrase says nothing about a PuTTY key: the
            // PuTTY path never records one (see `unlock`).
            (
                Inspected::Putty { encrypted: true },
                true,
                false,
                true,
                KeyState::PuttyLocked,
            ),
            (
                Inspected::Putty { encrypted: false },
                true,
                false,
                true,
                KeyState::PuttyUnencrypted,
            ),
        ];
        for (inspected, unlocked, putty_loaded, agent, expected) in rows {
            assert_eq!(
                classify(inspected, unlocked, putty_loaded, agent),
                expected,
                "unlocked={unlocked} putty_loaded={putty_loaded} agent={agent} \
                 must classify as {expected:?}"
            );
        }
    }

    #[test]
    fn loading_a_putty_key_keeps_no_passphrase() {
        // The whole point of the agent path: after loading, there is nothing
        // left in this process to leak.
        let dir = tmp();
        let path = dir.join("k.ppk");
        std::fs::write(&path, crate::app::ppk::fixtures::ED25519_V3_PLAIN).unwrap();
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        // The exact state is `classify`'s to answer (see the table above);
        // what a real file pins here is the other half -- that an unencrypted
        // `.ppk` is read as a PuTTY key carrying no passphrase, and that
        // nothing about it is ever held.
        assert!(matches!(
            inspect(&path.to_string_lossy()),
            Inspected::Putty { encrypted: false }
        ));
        assert!(store.passphrase().is_none());
    }

    #[test]
    fn an_encrypted_putty_file_is_read_as_encrypted() {
        let dir = tmp();
        let path = dir.join("enc.ppk");
        std::fs::write(&path, crate::app::ppk::fixtures::ED25519_V3_ENC).unwrap();
        assert!(matches!(
            inspect(&path.to_string_lossy()),
            Inspected::Putty { encrypted: true }
        ));
    }

    /// A file that starts with a PuTTY header but is not a readable key is
    /// unusable, not "locked": nothing here can ever be unlocked.
    #[test]
    fn a_truncated_putty_file_is_not_a_key() {
        let dir = tmp();
        let path = dir.join("truncated.ppk");
        std::fs::write(&path, b"PuTTY-User-Key-File-3: ssh-ed25519\n").unwrap();
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::NotAKey);
    }

    /// Re-wrap an OpenSSH PEM body to 64 columns: what
    /// `puttygen -O private-openssh-new` writes.
    fn rewrap_to_64(text: &str) -> String {
        let mut body = String::new();
        for line in text.lines() {
            if line.starts_with("-----") {
                continue;
            }
            body.push_str(line.trim());
        }
        let mut out = String::from("-----BEGIN OPENSSH PRIVATE KEY-----\n");
        for (i, ch) in body.chars().enumerate() {
            if i > 0 && i % 64 == 0 {
                out.push('\n');
            }
            out.push(ch);
        }
        out.push_str("\n-----END OPENSSH PRIVATE KEY-----\n");
        out
    }

    /// `ssh-encoding` hard-codes a 70-column PEM width for its decoder as well
    /// as its encoder, so a key written at 64 columns does not parse. Without
    /// normalization such a key falls through to the legacy-PEM branch, where
    /// an OpenSSH-format encrypted key -- whose body says neither `ENCRYPTED`
    /// nor `DEK-Info` -- is classified `Unencrypted`: git still works, because
    /// `ssh` reads the file itself, but the app never offers to hold its
    /// passphrase.
    #[test]
    fn a_64_column_encrypted_key_is_still_seen_as_encrypted() {
        let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
            .unwrap()
            .encrypt(&mut OsRng, "topsecret")
            .unwrap();
        let narrow = rewrap_to_64(&key.to_openssh(LineEnding::LF).unwrap());
        assert!(
            PrivateKey::from_openssh(&narrow).is_err(),
            "the 70-column decoder is what this normalization exists for"
        );

        let dir = tmp();
        let path = dir.join("enc64");
        std::fs::write(&path, narrow.as_bytes()).unwrap();
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Locked);
        // And the unlock path reads it too, or the settings row would offer a
        // passphrase box that always answers "not a private key".
        assert_eq!(store.unlock("wrong"), Err(UnlockError::WrongPassphrase));
        assert_eq!(store.unlock("topsecret"), Ok(()));
        assert_eq!(store.state(), KeyState::Unlocked);
    }

    /// The same, against real `puttygen -O private-openssh-new` output -- the
    /// very command the CLI's own warning tells users to run, on a key that
    /// really is encrypted.
    #[test]
    fn a_64_column_puttygen_key_reads_as_the_key_it_is() {
        let raw = crate::app::ppk::fixtures::ED25519_V3_ENC_OPENSSH;
        assert!(PrivateKey::from_openssh(raw).is_err());
        assert!(PrivateKey::from_openssh(normalize_openssh_pem(raw).as_ref()).is_ok());

        let dir = tmp();
        let path = dir.join("puttygen64");
        std::fs::write(&path, raw.as_bytes()).unwrap();
        let store = SshKeyStore::new();
        store.set_path(Some(path.to_string_lossy().into_owned()));
        assert_eq!(store.state(), KeyState::Locked);
        assert_eq!(
            store.unlock(crate::app::ppk::fixtures::PASSPHRASE),
            Ok(()),
            "the passphrase must actually verify against puttygen's own output"
        );
        assert_eq!(store.state(), KeyState::Unlocked);
    }

    /// Normalization is for PEM-shaped OpenSSH keys only: a legacy PEM key and
    /// anything that is not a key at all must reach the parser unchanged.
    #[test]
    fn normalizing_leaves_everything_but_an_openssh_pem_alone() {
        let legacy = "-----BEGIN RSA PRIVATE KEY-----\nbogus\n-----END RSA PRIVATE KEY-----\n";
        assert_eq!(normalize_openssh_pem(legacy).as_ref(), legacy);
        assert_eq!(
            normalize_openssh_pem("just some text\n").as_ref(),
            "just some text\n"
        );
        // A begin line with no end line is not a body this can rewrap.
        let unterminated = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n";
        assert_eq!(normalize_openssh_pem(unterminated).as_ref(), unterminated);
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
