//! The pure decision table between the chosen key's state and one git
//! operation.
//!
//! Nothing here reads a file, takes a lock or spawns anything: [`KeyState`] is
//! what [`SshKeyStore::state`](super::SshKeyStore::state) folded the key file
//! and the store's contents into, and [`gate_for`] is the whole decision made
//! from it. Kept apart from the store so every caller that only needs to ask
//! "may this operation run?" can read the answer without reading a mutex.

/// Error key surfaced by [`gate_for`] and returned by
/// [`SshKeyStore::wait_for_unlock`](super::SshKeyStore::wait_for_unlock) when
/// a non-interactive caller finds the key still locked, or when an unlock in
/// progress is cancelled or times out.
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
