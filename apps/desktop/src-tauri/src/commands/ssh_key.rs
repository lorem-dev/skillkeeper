//! SSH key commands: choosing the key, unlocking it, and the gate that decides
//! when an operation has to ask.
//!
//! Channel mapping (dots replaced by underscores, matching the rest of the
//! command surface):
//!   `sshKey:state`        -> `ssh_key_state`
//!   `sshKey:select`       -> `ssh_key_select`
//!   `sshKey:clear`        -> `ssh_key_clear`
//!   `sshKey:prompt`       -> `ssh_key_prompt`
//!   `sshKey:unlock`       -> `ssh_key_unlock`
//!   `sshKey:forget`       -> `ssh_key_forget`
//!   `sshKey:cancelUnlock` -> `ssh_key_cancel_unlock`
//!
//! The passphrase crosses the bridge in exactly one direction, once: as the
//! argument of [`ssh_key_unlock`]. It is never returned, never logged, and
//! never part of an error -- every key-related failure is one of the stable
//! codes the renderer translates ([`WRONG_PASSPHRASE_ERROR`] and the
//! [`crate::app::ssh_key`] exports), never a message from `ssh`, the window
//! system, or the key parser.
//!
//! Two entry points raise the unlock window, and no others:
//!
//! - [`require_unlocked`] is the gate the repository commands call before any
//!   git work that may touch the chosen key. It raises the prompt and waits
//!   for the answer, and it does so only for work the user just asked for --
//!   [`gate_for`] encodes that rule, so a scheduled update check can never pop
//!   a passphrase prompt with nobody there to answer it.
//! - [`prompt`] is Settings asking outright, so a key can be unlocked when it
//!   is chosen rather than at the next clone. Same decision, same window, but
//!   it returns as soon as the window is up.
//!
//! Both go through [`open_unlock_window`], so there is only ever one prompt:
//! whichever arrives second joins the first rather than opening its own.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use skillkeeper_core::ports::HostEnv;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use zeroize::Zeroizing;

use crate::app::ssh_key::{
    gate_for, Gate, KeyState, UnlockError, EXPORT_FAILED_ERROR, KEY_LOCKED_ERROR,
    KEY_MISSING_ERROR, NOT_A_KEY_ERROR, PUTTY_DAMAGED_ERROR, PUTTY_NEEDS_AGENT_ERROR,
    PUTTY_UNSUPPORTED_ERROR,
};
use crate::state::AppContext;

use super::blocking;

/// Label of the unlock window. The renderer keys its unlock page off this, and
/// `capabilities/default.json` must list it -- capabilities are per-window, so
/// without that entry the window cannot invoke anything.
pub const UNLOCK_WINDOW_LABEL: &str = "ssh-unlock";

/// Event emitted when an operation is blocked on a locked key, carrying the
/// key path so the prompt can show which key it is asking about.
pub const UNLOCK_REQUIRED_EVENT: &str = "ssh:unlockRequired";

/// Event emitted once each time the unlock prompt resolves -- by a successful
/// unlock, a Cancel, or the window closing.
///
/// The counterpart to [`UNLOCK_REQUIRED_EVENT`], and the only way a view that
/// is not the prompt itself can learn that the prompt is over: the answer is
/// given in the prompt's own window, and window lifecycle events do not cross
/// windows. Carries a single boolean and nothing else -- a listener that wants
/// detail re-reads [`ssh_key_state`].
pub const UNLOCK_RESOLVED_EVENT: &str = "ssh:unlockResolved";

/// Error key surfaced when the passphrase given to [`unlock`] does not decrypt
/// the chosen key.
///
/// Lives here rather than alongside the others in [`crate::app::ssh_key`]
/// because it is the one code no gate decision can produce: only an actual
/// unlock attempt can.
pub const WRONG_PASSPHRASE_ERROR: &str = "ssh.wrongPassphrase";

/// Message key for the unlock window's title. Absent from the catalogs until
/// the renderer strings land, and [`unlock_window_title`] falls back to
/// English until then.
const UNLOCK_TITLE_KEY: &str = "ssh.unlock.title";

/// English title used while `ssh.unlock.title` is missing from the catalogs.
const UNLOCK_TITLE_FALLBACK: &str = "Unlock SSH key";

/// How long a blocked operation waits for the unlock window before giving up
/// with [`KEY_LOCKED_ERROR`].
///
/// Long enough that fetching a passphrase from a password manager is not a
/// race, short enough that a forgotten window cannot pin a blocking-pool
/// thread for the rest of the session.
pub const UNLOCK_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How long a blocked operation parks before re-reading the key state and the
/// prompt's answered flag for itself.
///
/// This is the cost of a signal that never reached a particular waiter, not
/// the normal wake-up latency -- a notification that does arrive wakes it
/// immediately. Short enough to be imperceptible, long enough that a prompt
/// left up for ten minutes costs a couple of thousand cheap checks, not a spin.
const UNLOCK_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The unlock prompt currently on record: the flag it sets once it has been
/// answered, by an unlock, a Cancel, or a close.
///
/// Also the lock that serializes raising the prompt, so a burst of blocked
/// operations produces exactly one window (see [`open_unlock_window`]).
static UNLOCK_PROMPT: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// The chosen key as the renderer sees it: the path, and what inspecting it
/// found. Never carries the passphrase.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyDto {
    /// The chosen key path, already `~`-expanded, or `None` when no key is
    /// configured.
    pub path: Option<String>,
    /// What the key file looks like right now.
    pub state: KeyState,
}

/// Payload of [`UNLOCK_REQUIRED_EVENT`].
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnlockRequired {
    /// The key the prompt is asking about; empty only in the impossible case
    /// of the key being cleared between the gate and the emit.
    path: String,
}

/// Payload of [`UNLOCK_RESOLVED_EVENT`].
///
/// Deliberately just the boolean: no path, and certainly no key material. A
/// resolution is a cue to re-read, not a carrier of state.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnlockResolved {
    /// Whether the chosen key came out of this usable.
    unlocked: bool,
}

/// Tell every window that the unlock prompt has resolved.
///
/// Non-fatal like the announce: a listener that misses it is one re-read
/// behind, which is not worth failing an operation over.
fn emit_resolved(app: &AppHandle, unlocked: bool) {
    let _ = app.emit(UNLOCK_RESOLVED_EVENT, UnlockResolved { unlocked });
}

/// Expand a leading `~` against `home`, so a hand-edited config value of
/// `~/.ssh/id_ed25519` resolves to a real file instead of classifying as
/// [`KeyState::Missing`].
///
/// Both separators are accepted because the config file is hand-editable on
/// every platform; anything else is returned unchanged.
fn expand_home(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_string();
    }
    match path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        Some(rest) => Path::new(home).join(rest).to_string_lossy().into_owned(),
        None => path.to_string(),
    }
}

/// Point the store at the key path recorded in the config, expanding a leading
/// `~`.
///
/// The single funnel from "a path in the config file" to "the path the store
/// uses", called at startup and after every config write, so the two can never
/// disagree over whether `~` was expanded -- a disagreement would look like a
/// key change to [`SshKeyStore::set_path`](crate::app::ssh_key::SshKeyStore::set_path)
/// and needlessly drop the held passphrase.
pub fn seed_store(ctx: &AppContext, path: Option<String>) {
    ctx.ssh_key
        .set_path(path.map(|p| expand_home(&p, ctx.env.home_dir())));
}

/// The chosen key and its current state.
pub fn state(ctx: &AppContext) -> SshKeyDto {
    SshKeyDto {
        path: ctx.ssh_key.path(),
        state: ctx.ssh_key.state(),
    }
}

/// Record `path` as the chosen key: persist it to the config and point the
/// store at it.
///
/// # Errors
///
/// Returns [`KEY_MISSING_ERROR`] for a blank path, [`NOT_A_KEY_ERROR`] for one
/// that cannot be used (see below), or the config writer's message when the
/// file cannot be written.
pub fn select(ctx: &AppContext, path: String) -> Result<SshKeyDto, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(KEY_MISSING_ERROR.to_string());
    }
    // A double quote cannot be expressed in `GIT_SSH_COMMAND`, so
    // `ssh_env_vars` returns no environment at all for such a path
    // (`skillkeeper_core::ssh_env`). Accepting it would report a perfectly
    // healthy `Unlocked` key in the UI while every git operation silently fell
    // back to the default agent identity -- the exact failure this feature
    // exists to prevent -- so refuse it here instead.
    if trimmed.contains('"') {
        return Err(NOT_A_KEY_ERROR.to_string());
    }
    // Stored expanded, so every reader of the config -- this app and the CLI
    // alike -- sees a path it can open directly.
    write_path(ctx, Some(expand_home(trimmed, ctx.env.home_dir())))?;
    Ok(state(ctx))
}

/// Forget the chosen key entirely: drop it from the config, from the store,
/// and drop any passphrase held for it.
///
/// # Errors
///
/// Returns the config writer's message when the file cannot be written.
pub fn clear(ctx: &AppContext) -> Result<SshKeyDto, String> {
    write_path(ctx, None)?;
    // Redundant with `set_path(None)` today, but this is the operation whose
    // whole point is that nothing is left behind; say so explicitly.
    ctx.ssh_key.forget();
    Ok(state(ctx))
}

/// Persist `path` as `repositories.sshKeyPath` and bring the store in step.
///
/// Re-baselines the config watcher to the just-written file, exactly as
/// `config_set` does, so this self-write is not echoed back to the renderer as
/// an external `config:changed` event.
fn write_path(ctx: &AppContext, path: Option<String>) -> Result<(), String> {
    let mut config = super::config::load(ctx).config;
    config.repositories.ssh_key_path = path.clone();
    super::config::save(ctx, &config)?;
    ctx.config_watcher.note_written(&ctx.fs);
    ctx.ssh_key.set_path(path);
    Ok(())
}

/// Verify `passphrase` against the chosen key and hold it for this session.
///
/// One of the two points a prompt resolves at: on success `resolved(true)`
/// runs, which in the app emits [`UNLOCK_RESOLVED_EVENT`]. It is a parameter
/// so the rule can be tested without a window system, and so the emit stays
/// where the `AppHandle` naturally is.
///
/// # Errors
///
/// Returns [`WRONG_PASSPHRASE_ERROR`], [`KEY_MISSING_ERROR`],
/// [`NOT_A_KEY_ERROR`], or [`KEY_LOCKED_ERROR`] when the passphrase verified
/// but the chosen key changed underneath it (see the body), plus, for a PuTTY
/// key, [`PUTTY_NEEDS_AGENT_ERROR`], [`PUTTY_UNSUPPORTED_ERROR`] and
/// [`PUTTY_DAMAGED_ERROR`]. Nothing is announced on any of those paths. The
/// passphrase itself never appears in the error.
pub fn unlock(ctx: &AppContext, passphrase: String, resolved: impl Fn(bool)) -> Result<(), String> {
    // Scrubbed when this call returns: the store keeps its own zeroizing copy,
    // and this one -- the last hop of the value that came over the bridge --
    // must not outlive the call that used it.
    let passphrase = Zeroizing::new(passphrase);

    // A pending export claims this passphrase: the user asked to convert the
    // key, and the window they just answered was raised for that, not for an
    // agent load.
    if let Some(dest) = ctx.ssh_key.take_pending_export() {
        let source = ctx
            .ssh_key
            .path()
            .ok_or_else(|| KEY_MISSING_ERROR.to_string())?;
        let outcome = finish_export(ctx, &source, &dest, &passphrase);
        // The window is waiting on a resolution either way; without this a
        // failed export would leave it up with nothing happening.
        resolved(outcome.is_ok());
        return outcome;
    }

    match unlock_route(ctx.ssh_key.state()) {
        UnlockRoute::Refuse(code) => return Err(code.to_string()),
        UnlockRoute::LoadIntoAgent => load_into_agent(ctx, &passphrase)?,
        UnlockRoute::HoldPassphrase => ctx
            .ssh_key
            .unlock(&passphrase)
            .map_err(unlock_error_key)
            .map_err(str::to_string)?,
        // Nothing to do, and nothing to check by hand: the state re-read below
        // is what confirms the key really is usable.
        UnlockRoute::AlreadyUsable => {}
    }
    // `SshKeyStore::unlock` reports success for a passphrase it verified, but
    // records nothing if the chosen key changed while it was verifying -- so
    // `Ok` alone does not mean the key is usable now. Report what the store
    // actually ended up in, or the renderer would close the prompt on a
    // success that never happened.
    if let Some(code) = state_error_key(ctx.ssh_key.state()) {
        return Err(code.to_string());
    }
    // Only here, past that re-read: the key really is usable, so this is a
    // resolution worth telling every view about.
    resolved(true);
    Ok(())
}

/// Drop the held passphrase, re-locking the key for the rest of the session.
pub fn forget(ctx: &AppContext) {
    ctx.ssh_key.forget();
}

/// Release whatever operation is waiting on the unlock window: the window's
/// Cancel button.
///
/// Marks the prompt spent through the same [`dismiss_prompt`] the window's
/// close handler uses, so a Cancel followed (as the renderer does) by closing
/// the window dismisses once, announces once, and notifies once.
pub fn cancel_unlock(ctx: &AppContext, resolved: impl Fn(bool)) {
    let live = live_prompt();
    match live.as_deref() {
        Some(answered) => {
            dismiss_prompt(answered, &ctx.ssh_key, resolved);
        }
        // No prompt on record -- a defensive call from the renderer, or one
        // racing the very first build. Release any waiter anyway, but announce
        // nothing: there is no prompt here that resolved, and announcing
        // outside the answered-flag guard is the one way to say it twice.
        None => ctx.ssh_key.notify_unlock_result(false),
    }
}

/// The renderer-facing error key for an [`UnlockError`].
///
/// The one table: every reporting site for an unlock failure -- the passphrase
/// path and the PuTTY load path alike -- goes through here.
fn unlock_error_key(error: UnlockError) -> &'static str {
    match error {
        UnlockError::WrongPassphrase => WRONG_PASSPHRASE_ERROR,
        UnlockError::Missing => KEY_MISSING_ERROR,
        UnlockError::NotAKey => NOT_A_KEY_ERROR,
        UnlockError::Unsupported => PUTTY_UNSUPPORTED_ERROR,
        UnlockError::Damaged => PUTTY_DAMAGED_ERROR,
        // Nothing is wrong with the key: it read, decrypted and converted. The
        // agent is the missing piece, and the export action exists for exactly
        // this.
        UnlockError::AgentUnavailable => PUTTY_NEEDS_AGENT_ERROR,
    }
}

/// What answering the unlock window means for the chosen key.
///
/// The two acts are quite different -- an OpenSSH key has its passphrase
/// verified and held for the session, while a PuTTY key is decrypted, converted
/// and handed to the agent with the passphrase dropped after -- so which one a
/// passphrase is spent on is a decision in its own right, kept pure and matched
/// exhaustively rather than left to a catch-all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UnlockRoute {
    /// Verify the passphrase against the key file and hold it for the session.
    HoldPassphrase,
    /// Decrypt and convert the key and put it in the agent; hold nothing.
    LoadIntoAgent,
    /// The key is already usable; the answer changes nothing.
    AlreadyUsable,
    /// Refuse, with the renderer-facing code to report.
    Refuse(&'static str),
}

/// Which act answering the window means for a key in `state`.
fn unlock_route(state: KeyState) -> UnlockRoute {
    match state {
        // Every OpenSSH-format case, including the ones the store answers with
        // an error of its own (a path that is gone, a file that is not a key):
        // it owns those messages and reports them the same way it always has.
        KeyState::NotConfigured
        | KeyState::Missing
        | KeyState::NotAKey
        | KeyState::Unencrypted
        | KeyState::Locked
        | KeyState::Unlocked => UnlockRoute::HoldPassphrase,
        KeyState::PuttyLocked | KeyState::PuttyUnencrypted => UnlockRoute::LoadIntoAgent,
        // Already in the agent: the OpenSSH path would inspect the file, find a
        // PPK and report it as not a private key -- about a key that is working.
        // Reachable from a double-submit on the unlock window, whose first
        // answer loaded the key.
        KeyState::PuttyInAgent => UnlockRoute::AlreadyUsable,
        // No agent to load into: `load_putty` would fail with a code about the
        // key, when the missing piece is the agent.
        KeyState::PuttyNoAgent => UnlockRoute::Refuse(PUTTY_NEEDS_AGENT_ERROR),
    }
}

/// Put the chosen PuTTY key in the session agent, which is what "unlocking" it
/// means: `ssh` cannot read the format at all, so there is no file to point it
/// at (see [`crate::app::ssh_key::SshKeyStore::load_putty`]).
fn load_into_agent(ctx: &AppContext, passphrase: &str) -> Result<(), String> {
    ctx.ssh_key
        .load_putty(passphrase)
        .map_err(unlock_error_key)
        .map_err(str::to_string)
}

/// The error key for a key state that cannot be used right now, or `None` when
/// the state is fine to proceed with.
///
/// `NotConfigured` maps to [`KEY_LOCKED_ERROR`] rather than to `Ok`: reaching
/// this from [`unlock`] means the key was cleared out from under an unlock
/// that had already succeeded, which is a failed unlock from the prompt's
/// point of view, not a usable key.
fn state_error_key(state: KeyState) -> Option<&'static str> {
    match state {
        KeyState::Unencrypted | KeyState::Unlocked => None,
        KeyState::Missing => Some(KEY_MISSING_ERROR),
        KeyState::NotAKey => Some(NOT_A_KEY_ERROR),
        KeyState::Locked | KeyState::NotConfigured => Some(KEY_LOCKED_ERROR),
        // A PuTTY key is usable exactly when the agent holds it: `ssh` cannot
        // read the file, so one that is merely readable is not yet ready --
        // even the unencrypted one, which needs no passphrase but does need
        // the load.
        KeyState::PuttyInAgent => None,
        KeyState::PuttyLocked | KeyState::PuttyUnencrypted => Some(KEY_LOCKED_ERROR),
        KeyState::PuttyNoAgent => Some(PUTTY_NEEDS_AGENT_ERROR),
    }
}

/// Whether the key can be used for git work right now.
///
/// The single definition of "usable", shared by the gate's wait loop, the
/// window's close handler and [`unlock`]'s result check, so none of them can
/// drift from the others -- an unencrypted key is just as usable as an
/// unlocked one.
fn key_is_usable(state: KeyState) -> bool {
    state_error_key(state).is_none()
}

/// Mark a prompt answered and, if that answer was a dismissal, release the
/// operations waiting behind it. Returns whether this call was the one that
/// answered it.
///
/// Idempotent by design: Cancel and the window's `Destroyed` event both land
/// here for a cancelled prompt, and a second dismissal would be a live round
/// fired into whatever started waiting in the meantime.
///
/// The other point a prompt resolves at, so `resolved` runs here too -- inside
/// the answered-flag guard, which is what makes "once per resolution" true for
/// the announcement as well as for the notification. It is told what the key
/// actually came out as rather than a flat `false`, since a window closed
/// after a successful unlock is still a resolution and the truth about it is
/// what a listener wants.
fn dismiss_prompt(
    answered: &AtomicBool,
    store: &crate::app::ssh_key::SshKeyStore,
    resolved: impl Fn(bool),
) -> bool {
    if answered.swap(true, Ordering::AcqRel) {
        return false;
    }
    let usable = key_is_usable(store.state());
    // Nothing to release when the prompt did its job: the successful unlock
    // has already woken everyone waiting.
    if !usable {
        store.notify_unlock_result(false);
    }
    resolved(usable);
    true
}

/// The prompt currently on record, if any.
fn live_prompt() -> Option<Arc<AtomicBool>> {
    UNLOCK_PROMPT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// Make sure the chosen key is usable before an operation that needs it.
///
/// A locked key blocks only work the user just asked for: a scheduled update
/// check must never raise a passphrase window on its own. Called BEFORE the git
/// queue and before the state lock, so a waiting prompt never holds either.
///
/// MUST run on the blocking pool (every command body already does, via
/// [`super::blocking`]): this parks the calling thread for as long as the
/// prompt is up, and `WebviewWindowBuilder::build` dispatches to the main
/// thread and waits for it -- calling either from the main thread would
/// deadlock the whole app.
///
/// # Errors
///
/// Returns one of [`KEY_LOCKED_ERROR`], [`KEY_MISSING_ERROR`] or
/// [`NOT_A_KEY_ERROR`] when the operation must not run, including when the
/// user cancels the prompt, closes it, or leaves it unanswered for
/// [`UNLOCK_TIMEOUT`]. Never a raw window-system message: the renderer only
/// ever receives a code it can translate.
pub fn require_unlocked(
    app: &AppHandle,
    ctx: &AppContext,
    is_ssh: bool,
    interactive: bool,
) -> Result<(), String> {
    match gate_for(is_ssh, ctx.ssh_key.state(), interactive) {
        Gate::Proceed => Ok(()),
        Gate::Fail(code) => Err(code.to_string()),
        // No passphrase to ask for, so no window and no waiting: an unencrypted
        // PuTTY key just needs to be in the agent before `ssh` runs.
        Gate::LoadIntoAgent => load_into_agent(ctx, ""),
        Gate::Prompt => wait_for_usable_key(ctx, Instant::now() + UNLOCK_TIMEOUT, || {
            open_unlock_window(app, ctx)
        }),
    }
}

/// Raise the unlock prompt because the user asked for it, and return without
/// waiting for an answer.
///
/// The Settings entry point: choosing an encrypted key, or pressing Unlock on
/// a locked one, should get the passphrase verified there and then rather than
/// at the next clone. Nothing in Settings is blocked on the answer, so unlike
/// [`require_unlocked`] this does not park -- it puts the window up and
/// returns.
///
/// It is otherwise the same act, so it makes the same decision the same way:
/// [`gate_for`] as a user-initiated SSH operation. A key that needs no
/// passphrase is a no-op returning `Ok` -- there is nothing to ask about, and
/// the caller has already been told as much by the [`KeyState`] it holds. A
/// key whose file is gone or unusable is the one case worth interrupting for,
/// and reports the same code the git path would.
///
/// MUST run on the blocking pool, for the same reason as [`require_unlocked`]:
/// building the window dispatches to the main thread and waits for it.
///
/// # Errors
///
/// Returns [`KEY_MISSING_ERROR`], [`NOT_A_KEY_ERROR`] or [`KEY_LOCKED_ERROR`]
/// when the prompt could not be raised, and [`PUTTY_NEEDS_AGENT_ERROR`] for a
/// PuTTY key with no agent to load it into -- the one thing no window can fix.
/// Never a raw window-system message.
pub fn prompt(app: &AppHandle, ctx: &AppContext) -> Result<(), String> {
    raise_prompt(
        ctx.ssh_key.state(),
        || load_into_agent(ctx, ""),
        || open_unlock_window(app, ctx),
    )
}

/// The decision half of [`prompt`], with raising the window and loading the
/// agent as parameters so it can be tested without a window system or an agent.
///
/// `raise` is [`open_unlock_window`], which joins the prompt already on screen
/// rather than building a second one and announces it only if it can still be
/// answered -- so a prompt raised here and a prompt raised by a blocked git
/// operation are always the same window, with the same answered flag, whoever
/// got there first.
///
/// `load` is [`load_into_agent`]: a user pressing Unlock on an unencrypted
/// PuTTY key is asking for the one thing that key needs, and answering that
/// with silence would leave every operation failing for want of a load nobody
/// ever triggers.
fn raise_prompt(
    state: KeyState,
    load: impl FnOnce() -> Result<(), String>,
    raise: impl FnOnce() -> Result<Arc<AtomicBool>, String>,
) -> Result<(), String> {
    // A git operation over a key it cannot read carries on without one (the key
    // is offered, not enforced), but a user pressing Unlock is asking about the
    // key itself, and answering that with silence would be wrong -- so an
    // unreadable file is reported here even though the gate lets git through.
    match state {
        KeyState::Missing => return Err(KEY_MISSING_ERROR.to_string()),
        KeyState::NotAKey => return Err(NOT_A_KEY_ERROR.to_string()),
        _ => {}
    }
    // `true, true`: this IS the user asking about the SSH key, so the decision
    // is the ssh-transport, interactive one -- the same row of the table a
    // user-initiated clone over SSH would take.
    match gate_for(true, state, true) {
        Gate::Proceed => Ok(()),
        Gate::Fail(code) => Err(code.to_string()),
        Gate::LoadIntoAgent => load(),
        Gate::Prompt => raise().map(|_| ()),
    }
}

/// Raise a prompt and block until the key is usable, the prompt is dismissed,
/// or `deadline` passes.
///
/// Polling rather than a single park, because neither of the two signals this
/// waits on is reliably delivered as a notification:
///
/// - An unlock changes the key state without necessarily notifying *this*
///   waiter. [`SshKeyStore::wait_for_unlock`](crate::app::ssh_key::SshKeyStore::wait_for_unlock)
///   only reacts to notifications that arrive after it starts waiting, and
///   reaching it means first reading the key file (a full filesystem
///   round-trip on a cold cache or a network-mounted home). A notification
///   landing inside that window used to cost the whole timeout; now it costs
///   at most one [`UNLOCK_POLL_INTERVAL`], because every round re-reads the
///   state itself rather than trusting the notification.
/// - A dismissal changes no key state at all, so it cannot be observed by
///   re-reading. The prompt's `answered` flag is what carries it, and it is
///   re-read on the same schedule.
///
/// `join_prompt` is a parameter so the loop can be tested without a window
/// system; [`require_unlocked`] passes [`open_unlock_window`].
fn wait_for_usable_key(
    ctx: &AppContext,
    deadline: Instant,
    mut join_prompt: impl FnMut() -> Result<Arc<AtomicBool>, String>,
) -> Result<(), String> {
    // The prompt this operation is waiting on. Joined once and then kept: a
    // dismissal must end this wait, not reopen the window the user just
    // dismissed.
    let mut joined: Option<Arc<AtomicBool>> = None;
    loop {
        if key_is_usable(ctx.ssh_key.state()) {
            return Ok(());
        }
        if joined.as_ref().is_some_and(|p| p.load(Ordering::Acquire)) {
            // Cancelled or closed: nobody is going to answer this.
            return Err(KEY_LOCKED_ERROR.to_string());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(KEY_LOCKED_ERROR.to_string());
        }
        let slice = UNLOCK_POLL_INTERVAL.min(remaining);
        match joined {
            // Parks until an unlock, a dismissal, or the slice expires --
            // whichever comes first. No lock is held across this.
            Some(_) => {
                let _ = ctx.ssh_key.wait_for_unlock(slice);
            }
            None => {
                let prompt = join_prompt()?;
                if prompt.load(Ordering::Acquire) {
                    // Joined a prompt that was answered while this call was on
                    // its way to it -- a window mid-teardown. Let the teardown
                    // finish and ask for a fresh prompt rather than parking
                    // behind one nobody can answer.
                    std::thread::sleep(slice);
                } else {
                    joined = Some(prompt);
                }
            }
        }
    }
}

/// The unlock window's title, translated when the catalogs know the key.
///
/// The native translator returns the key unchanged for a msgid no catalog has,
/// which would put a dotted key in the title bar; until the renderer strings
/// land, fall back to English instead.
fn unlock_window_title(app: &AppHandle) -> String {
    let lang = crate::app::menu::current_lang(app);
    let translated = crate::app::i18n::Translator::for_lang(&lang).t(UNLOCK_TITLE_KEY);
    if translated == UNLOCK_TITLE_KEY {
        UNLOCK_TITLE_FALLBACK.to_string()
    } else {
        translated
    }
}

/// Whether a prompt on record can still be joined: it needs a window on
/// screen to go with it.
///
/// A recorded prompt whose window is gone is stale (the window was destroyed
/// after being answered), and a window with no recorded prompt is one this
/// process cannot have built -- neither is joinable, and both mean "build".
fn joinable(recorded: Option<&Arc<AtomicBool>>, window_exists: bool) -> bool {
    recorded.is_some() && window_exists
}

/// Whether a window-builder failure means a prompt is already on screen.
fn is_label_taken(error: &tauri::Error) -> bool {
    matches!(
        error,
        tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_)
    )
}

/// Raise (or join) the small window that asks for the passphrase, then
/// announce which key it is asking about. Returns the prompt's `answered`
/// flag, which whoever is waiting watches for a dismissal.
///
/// Joining the prompt already on screen rather than building a second one
/// keeps a burst of blocked operations to a single window; each of them waits
/// on the same store, and one successful unlock releases them all.
///
/// # Errors
///
/// Returns [`KEY_LOCKED_ERROR`] when the window cannot be created, never the
/// window system's own message: this failure reaches the renderer through
/// [`require_unlocked`], which owes it a translatable code.
fn open_unlock_window(app: &AppHandle, ctx: &AppContext) -> Result<Arc<AtomicBool>, String> {
    join_and_announce(
        || join_or_build_prompt(app, ctx),
        || announce_prompt(app, ctx),
    )
}

/// Get hold of the prompt and, unless it has already been answered, announce
/// it. Returns the prompt either way.
///
/// The two halves are parameters so the rule between them can be tested
/// without a window system. That rule matters because a waiter re-asks every
/// [`UNLOCK_POLL_INTERVAL`] until it adopts a prompt, and a prompt that was
/// answered but whose window is still on screen is never adopted: announcing
/// on every one of those rounds would have a window nobody can answer
/// stealing the focus four times a second, and would fire thousands of
/// [`UNLOCK_REQUIRED_EVENT`]s at the renderer, for as long as the teardown
/// lingered.
fn join_and_announce(
    join: impl FnOnce() -> Result<Arc<AtomicBool>, String>,
    announce: impl FnOnce(),
) -> Result<Arc<AtomicBool>, String> {
    let prompt = join()?;
    if !prompt.load(Ordering::Acquire) {
        announce();
    }
    Ok(prompt)
}

/// Take the focus for the prompt window and tell the app which key it is
/// asking about.
///
/// The emit is deliberately not fatal, and deliberately after the window
/// exists: a failed emit would otherwise abandon a passphrase window on
/// screen with nobody waiting behind it. Nothing is lost by it -- the prompt
/// paints its first frame from [`ssh_key_state`], and this event only tells an
/// already-open prompt that a further operation is now waiting on it too. It
/// goes app-wide so the main window can react as well.
fn announce_prompt(app: &AppHandle, ctx: &AppContext) {
    if let Some(window) = app.get_webview_window(UNLOCK_WINDOW_LABEL) {
        let _ = window.set_focus();
    }
    let path = ctx.ssh_key.path().unwrap_or_default();
    let _ = app.emit(UNLOCK_REQUIRED_EVENT, UnlockRequired { path });
}

/// The prompt on screen, building one if there is none.
///
/// # Errors
///
/// Returns [`KEY_LOCKED_ERROR`] when the window cannot be created.
fn join_or_build_prompt(app: &AppHandle, ctx: &AppContext) -> Result<Arc<AtomicBool>, String> {
    // Held across the check-and-build and nothing else -- never across the
    // wait. Without it, a burst of blocked operations ("update all" over three
    // SSH repositories) would all find no window, all build one, and every
    // loser would fail on a label collision instead of joining the one prompt
    // that won.
    let mut recorded = UNLOCK_PROMPT.lock().unwrap_or_else(|e| e.into_inner());
    let on_screen = app.get_webview_window(UNLOCK_WINDOW_LABEL).is_some();
    let joined = recorded
        .clone()
        .filter(|_| joinable(recorded.as_ref(), on_screen));
    match joined {
        Some(prompt) => Ok(prompt),
        None => {
            let prompt = build_unlock_window(app, ctx)?;
            *recorded = Some(Arc::clone(&prompt));
            Ok(prompt)
        }
    }
}

/// Build the unlock window and wire its close handler. Returns the new
/// prompt's `answered` flag.
///
/// # Errors
///
/// Returns [`KEY_LOCKED_ERROR`] when the window cannot be created.
fn build_unlock_window(app: &AppHandle, ctx: &AppContext) -> Result<Arc<AtomicBool>, String> {
    let answered = Arc::new(AtomicBool::new(false));
    let mut builder = WebviewWindowBuilder::new(
        app,
        UNLOCK_WINDOW_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title(unlock_window_title(app))
    // The size the window opens at, before its own content has been measured:
    // the renderer reports the height its layout actually needs and the window
    // follows (`window_fit_content_height`), since the hint names a key path of
    // unknown length. Starting a little short means that first adjustment grows
    // the window rather than shrinking it over content already on screen.
    .inner_size(460.0, 260.0)
    .resizable(false)
    .center()
    .focused(true);
    // Parented to the main window so the OS keeps the prompt in front of the
    // app it belongs to, the same reason the native pickers in
    // `commands::dialog` are parented.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|_| unlock_window_failed())?;
    }
    let window = match builder.build() {
        Ok(window) => window,
        // Belt and braces behind the mutex in `open_unlock_window`: a taken
        // label means a prompt IS on screen, so join it rather than turning a
        // working prompt into a failed operation. The flag returned here is
        // never set by that window's handler, so such a waiter falls back to
        // polling the key state until the deadline.
        Err(e) if is_label_taken(&e) => return Ok(answered),
        Err(_) => return Err(unlock_window_failed()),
    };

    // A closed window must never leave a git operation hanging: the Cancel
    // button routes through `ssh_key_cancel_unlock`, and this catches every
    // other way the window can go away (the close button, the window menu, the
    // app tearing it down). `dismiss_prompt` makes the two idempotent.
    let store = Arc::clone(&ctx.ssh_key);
    let answered_on_close = Arc::clone(&answered);
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            dismiss_prompt(&answered_on_close, &store, |unlocked| {
                emit_resolved(&handle, unlocked)
            });
        }
    });
    Ok(answered)
}

/// The code an operation gets when the prompt could not be raised: the key is
/// locked and there is now no way to ask about it.
fn unlock_window_failed() -> String {
    KEY_LOCKED_ERROR.to_string()
}

/// `sshKey:state` -- the chosen key and what inspecting it found.
#[tauri::command]
pub async fn ssh_key_state(ctx: State<'_, Arc<AppContext>>) -> Result<SshKeyDto, String> {
    blocking(&ctx, state).await
}

/// `sshKey:select` -- choose `path` as the key, persist it, and report the new
/// state.
#[tauri::command]
pub async fn ssh_key_select(
    ctx: State<'_, Arc<AppContext>>,
    path: String,
) -> Result<SshKeyDto, String> {
    blocking(&ctx, move |c| select(c, path)).await?
}

/// `sshKey:clear` -- unchoose the key and forget its passphrase.
#[tauri::command]
pub async fn ssh_key_clear(ctx: State<'_, Arc<AppContext>>) -> Result<SshKeyDto, String> {
    blocking(&ctx, clear).await?
}

/// `sshKey:prompt` -- raise the unlock window on demand and return at once.
///
/// For Settings: choosing an encrypted key, or pressing Unlock on a locked
/// one, gets the passphrase verified while the user is still there. Resolves
/// as soon as the window is up -- the answer arrives through
/// [`ssh_key_unlock`] from that window, and [`UNLOCK_RESOLVED_EVENT`] is what
/// tells Settings to re-read [`ssh_key_state`].
///
/// Joins the prompt an operation may already be waiting behind rather than
/// opening a second one.
#[tauri::command]
pub async fn ssh_key_prompt(app: AppHandle, ctx: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&ctx, move |c| prompt(&app, c)).await?
}

/// `sshKey:unlock` -- verify `passphrase` and hold it for this session.
///
/// The one place a passphrase crosses the bridge, and only inbound. A success
/// emits [`UNLOCK_RESOLVED_EVENT`] app-wide, so views other than the prompt
/// itself learn the prompt is over.
#[tauri::command]
pub async fn ssh_key_unlock(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
    passphrase: String,
) -> Result<(), String> {
    blocking(&ctx, move |c| {
        unlock(c, passphrase, |unlocked| emit_resolved(&app, unlocked))
    })
    .await?
}

/// `sshKey:forget` -- drop the held passphrase without unchoosing the key.
#[tauri::command]
pub async fn ssh_key_forget(ctx: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&ctx, forget).await
}

/// `sshKey:cancelUnlock` -- the unlock window's Cancel: fail whatever is
/// waiting on it rather than leaving it to time out.
///
/// Emits [`UNLOCK_RESOLVED_EVENT`] app-wide, once, however the window then
/// goes away.
#[tauri::command]
pub async fn ssh_key_cancel_unlock(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    blocking(&ctx, move |c| {
        cancel_unlock(c, |unlocked| emit_resolved(&app, unlocked))
    })
    .await
}

/// Start converting the chosen PuTTY key into an OpenSSH key at `dest`.
///
/// An unencrypted key is converted here and now. An encrypted one needs its
/// passphrase, which this app asks for in exactly one place -- so the
/// destination is parked on the store and the existing unlock window is
/// raised; [`unlock`] finishes the job when the passphrase arrives. The window
/// is raised directly rather than through [`prompt`], because the state this
/// exists for (`PuttyNoAgent`) is one the gate deliberately fails.
#[tauri::command]
pub async fn ssh_key_begin_export(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
    dest: String,
) -> Result<SshKeyDto, String> {
    blocking(&ctx, move |c| {
        let source = c
            .ssh_key
            .path()
            .ok_or_else(|| KEY_MISSING_ERROR.to_string())?;
        if c.ssh_key.state() == KeyState::PuttyUnencrypted {
            finish_export(c, &source, &dest, "")?;
            return Ok(state(c));
        }
        c.ssh_key.set_pending_export(Some(dest));
        open_unlock_window(&app, c)?;
        Ok(state(c))
    })
    .await?
}

/// Write the converted key and switch to it. Shared by the immediate path
/// above and the after-the-passphrase path in [`unlock`].
fn finish_export(
    ctx: &AppContext,
    source: &str,
    dest: &str,
    passphrase: &str,
) -> Result<(), String> {
    if Path::new(dest).exists() {
        // The save dialog already asked about replacing it; honouring that
        // answer is the only way to write where the user pointed.
        std::fs::remove_file(dest).map_err(|_| EXPORT_FAILED_ERROR.to_string())?;
    }
    let written = export_openssh(source, dest, passphrase)?;
    write_path(ctx, Some(written.to_string_lossy().into_owned()))
}

/// Convert the PuTTY key at `source` into an OpenSSH key at `dest`, encrypted
/// with the same passphrase.
///
/// The escape hatch for a machine with no ssh-agent -- notably Windows, where
/// the OpenSSH agent service ships disabled. Everything about it is explicit:
/// the user asks for it, picks the destination, and types the passphrase.
/// What lands on disk is encrypted whenever the source was; an unencrypted
/// PuTTY key is written unencrypted rather than given an invented passphrase.
///
/// Split from the command so it can be tested without a window system.
fn export_openssh(source: &str, dest: &str, passphrase: &str) -> Result<PathBuf, String> {
    let text = std::fs::read_to_string(source).map_err(|_| KEY_MISSING_ERROR.to_string())?;
    let file = crate::app::ppk::parse::parse(&text).map_err(|_| NOT_A_KEY_ERROR.to_string())?;
    let converted = crate::app::ppk::convert::convert(&file, passphrase).map_err(|e| {
        match e {
            crate::app::ppk::parse::PpkError::WrongPassphrase => WRONG_PASSPHRASE_ERROR,
            crate::app::ppk::parse::PpkError::UnsupportedAlgorithm => PUTTY_UNSUPPORTED_ERROR,
            crate::app::ppk::parse::PpkError::Damaged => PUTTY_DAMAGED_ERROR,
            _ => NOT_A_KEY_ERROR,
        }
        .to_string()
    })?;

    let key = ssh_key::PrivateKey::from_openssh(converted.openssh.as_str())
        .map_err(|_| EXPORT_FAILED_ERROR.to_string())?;
    let out = if file.is_encrypted() {
        key.encrypt(&mut ssh_key::rand_core::OsRng, passphrase)
            .and_then(|k| k.to_openssh(ssh_key::LineEnding::LF))
            .map_err(|_| EXPORT_FAILED_ERROR.to_string())?
    } else {
        converted.openssh
    };

    let path = PathBuf::from(dest);
    write_private_file(&path, out.as_bytes()).map_err(|_| EXPORT_FAILED_ERROR.to_string())?;
    Ok(path)
}

/// Write key bytes with owner-only permissions, creating the file fresh.
///
/// On unix the mode is set at creation, not after: a file that is briefly
/// world-readable while it holds a key is a race worth not having. Windows
/// inherits the directory ACL, which for a user's own profile is already
/// owner-only; if `ssh` ever judges it too permissive, the fix is `icacls`,
/// documented in docs/usage/repositories.md.
fn write_private_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;

    fn write_encrypted_key(app: &TempAppData, passphrase: &str) -> String {
        crate::commands::test_support::write_key(app.dir(), "encrypted_key", Some(passphrase))
    }

    /// Write a PuTTY-format key next to the config and return its path.
    fn write_putty_key(app: &TempAppData, name: &str, contents: &str) -> String {
        let path = app.dir().join(name);
        std::fs::write(&path, contents).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// The `load` hook for [`raise_prompt`] cases that must never touch the
    /// agent: only a PuTTY key with no passphrase is loaded without asking.
    fn never_loaded() -> Result<(), String> {
        panic!("this key state must not be loaded into the agent")
    }

    #[test]
    fn selecting_a_key_persists_it_and_reports_the_state() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        let result = select(&app.ctx, path.clone()).unwrap();
        assert_eq!(result.path.as_deref(), Some(path.as_str()));
        assert_eq!(result.state, KeyState::Locked);
        // Persisted, so a restart finds the key again.
        let reloaded = crate::commands::config::load(&app.ctx);
        assert_eq!(
            reloaded.config.repositories.ssh_key_path.as_deref(),
            Some(path.as_str())
        );
    }

    #[test]
    fn clearing_removes_the_path_and_the_passphrase() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path).unwrap();
        app.ctx.ssh_key.unlock("topsecret").unwrap();
        let result = clear(&app.ctx).unwrap();
        assert_eq!(result.path, None);
        assert_eq!(result.state, KeyState::NotConfigured);
        assert!(crate::commands::config::load(&app.ctx)
            .config
            .repositories
            .ssh_key_path
            .is_none());
    }

    #[test]
    fn unlock_maps_a_wrong_passphrase_to_a_stable_code() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path).unwrap();
        assert_eq!(
            unlock(&app.ctx, "nope".to_string(), |_| {}),
            Err("ssh.wrongPassphrase".to_string())
        );
        assert_eq!(unlock(&app.ctx, "topsecret".to_string(), |_| {}), Ok(()));
        assert_eq!(state(&app.ctx).state, KeyState::Unlocked);
    }

    #[test]
    fn seeding_from_config_restores_the_path_but_not_the_passphrase() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path.clone()).unwrap();
        app.ctx.ssh_key.unlock("topsecret").unwrap();
        // A restart is a fresh store seeded from the config file.
        let fresh = crate::app::ssh_key::SshKeyStore::new();
        fresh.set_path(
            crate::commands::config::load(&app.ctx)
                .config
                .repositories
                .ssh_key_path,
        );
        assert_eq!(fresh.state(), KeyState::Locked);
    }

    /// A deadline the poll-loop tests below must never actually reach.
    ///
    /// Each of them proves the wait ends on a signal of its own; running out
    /// of time is the failure they exist to rule out. So the deadline is set
    /// far past any plausible scheduling delay and the assertion is "ended
    /// before its deadline", not "ended within N seconds of wall clock" -- the
    /// latter competes with the test runner for CPU and fails on a loaded
    /// machine while the behaviour is perfectly correct.
    const NEVER_REACHED: Duration = Duration::from_secs(20);

    fn far_off_deadline() -> Instant {
        Instant::now() + NEVER_REACHED
    }

    /// The reason the wait polls instead of parking once: an unlock that lands
    /// while this operation is still on its way to `wait_for_unlock` notifies
    /// nobody, and re-reading the key state is the only way to see it. Uses
    /// the bluntest possible version of that -- a key that becomes usable with
    /// no notification at all -- so a regression cannot pass by luck.
    #[test]
    fn the_wait_notices_a_usable_key_it_was_never_notified_about() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));
        let plain = crate::commands::test_support::write_key(app.dir(), "plain_key", None);
        let prompt = Arc::new(AtomicBool::new(false));

        let ctx = &app.ctx;
        // The key becomes usable AFTER the wait's first look at it, with no
        // notification of any kind -- so only a later round re-reading the
        // state for itself can ever see it. Driven from the join hook, which
        // the loop calls at a known point, rather than from a sleeping thread
        // whose ordering would be a bet.
        let swap_in_a_key_that_needs_no_passphrase = || {
            ctx.ssh_key.set_path(Some(plain.clone()));
            Ok(Arc::clone(&prompt))
        };

        assert_eq!(
            wait_for_usable_key(
                ctx,
                far_off_deadline(),
                swap_in_a_key_that_needs_no_passphrase
            ),
            Ok(()),
            "a single park would still be waiting: nothing notified it"
        );
    }

    /// The other half: a dismissal changes no key state, so only the prompt's
    /// flag carries it -- and it too may land in the gap before the park.
    ///
    /// The one test here that genuinely needs a second thread: the flag has to
    /// be set *after* the wait has adopted the prompt, and adoption happens
    /// inside the loop with no hook after it. What the thread must NOT do is
    /// bet on winning a race -- see the fresh-prompt-per-ask note below.
    #[test]
    fn the_wait_ends_when_the_prompt_it_joined_is_dismissed() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));

        // Every ask hands out a fresh, live prompt and records it -- exactly
        // what `open_unlock_window` does once the previous window has gone.
        // A single shared flag would instead trap the wait: dismissed before
        // it could be adopted, it would be re-asked for and re-rejected every
        // round until the deadline, which is precisely how this test used to
        // fail under load.
        let handed_out: Arc<std::sync::Mutex<Option<Arc<AtomicBool>>>> = Arc::default();
        let latest = Arc::clone(&handed_out);
        let join_prompt = move || {
            let prompt = Arc::new(AtomicBool::new(false));
            *latest.lock().unwrap() = Some(Arc::clone(&prompt));
            Ok(prompt)
        };

        let ctx = &app.ctx;
        let finished = Arc::new(AtomicBool::new(false));
        let done = Arc::clone(&finished);
        let dismisser = Arc::clone(&handed_out);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                // Keep dismissing the most recently handed-out prompt until
                // the wait returns. Whichever one it ends up adopting is
                // dismissed within a poll round, whatever the interleaving.
                while !done.load(Ordering::Acquire) {
                    if let Some(prompt) = dismisser.lock().unwrap().as_ref() {
                        prompt.store(true, Ordering::Release);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });

            let deadline = far_off_deadline();
            let result = wait_for_usable_key(ctx, deadline, join_prompt);
            finished.store(true, Ordering::Release);

            assert_eq!(result, Err("ssh.keyLocked".to_string()));
            assert!(
                Instant::now() < deadline,
                "the dismissal must end the wait; reaching the deadline means \
                 the answered flag was never looked at again"
            );
        });
    }

    /// Joining a window that is already tearing down must not park behind it:
    /// the operation asks again once the teardown is done and gets its own
    /// prompt.
    ///
    /// No thread and no clock: the second ask is the hook, and the outcome
    /// alone separates the two behaviours. Adopting the dying prompt would end
    /// the wait at the next answered check with `ssh.keyLocked`, and there
    /// would never be a second ask at all.
    #[test]
    fn a_prompt_already_dismissed_is_not_joined_but_asked_for_again() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));
        let plain = crate::commands::test_support::write_key(app.dir(), "plain_key", None);

        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&asks);
        let dying = Arc::new(AtomicBool::new(true));
        let fresh = Arc::new(AtomicBool::new(false));

        let ctx = &app.ctx;
        let join_prompt = move || {
            if counter.fetch_add(1, Ordering::AcqRel) == 0 {
                // The first ask lands on a window mid-teardown.
                Ok(Arc::clone(&dying))
            } else {
                // By the second, the teardown is over. Let the wait finish
                // from here by making the key usable, so the test ends on a
                // signal rather than on elapsed time.
                ctx.ssh_key.set_path(Some(plain.clone()));
                Ok(Arc::clone(&fresh))
            }
        };

        assert_eq!(
            wait_for_usable_key(ctx, far_off_deadline(), join_prompt),
            Ok(()),
            "adopting the dying prompt would have failed with ssh.keyLocked"
        );
        assert_eq!(
            asks.load(Ordering::Acquire),
            2,
            "the operation must ask for a prompt again after being handed a dismissed one"
        );
    }

    /// Settings raising the prompt for a locked key: the window goes up and
    /// the call returns, with nothing waiting behind it.
    #[test]
    fn a_locked_key_raises_a_prompt_on_demand_without_waiting_for_it() {
        let raises = std::sync::atomic::AtomicUsize::new(0);
        let fresh = Arc::new(AtomicBool::new(false));

        let result = raise_prompt(KeyState::Locked, never_loaded, || {
            raises.fetch_add(1, Ordering::AcqRel);
            Ok(Arc::clone(&fresh))
        });

        assert_eq!(result, Ok(()));
        assert_eq!(raises.load(Ordering::Acquire), 1);
        // No elapsed-time assertion: `raise_prompt` is handed nothing it could
        // wait on, so "does not park" is a property of its signature, not of
        // the clock. A wall-clock bound here could only ever misfire under
        // load.
    }

    /// A prompt an operation is already waiting behind must be joined, not
    /// duplicated: the same window, the same answered flag, and one focus.
    #[test]
    fn raising_a_prompt_that_is_already_open_joins_it() {
        // The prompt some blocked git operation put up and is waiting on.
        let waiting_on = Arc::new(AtomicBool::new(false));
        let raises = std::sync::atomic::AtomicUsize::new(0);
        let announcements = std::sync::atomic::AtomicUsize::new(0);

        let result = raise_prompt(KeyState::Locked, never_loaded, || {
            raises.fetch_add(1, Ordering::AcqRel);
            // Exactly what `open_unlock_window` does: take whatever is on
            // record instead of building, and announce it only if it can still
            // be answered. (`a_live_prompt_is_announced_once` pins that the
            // flag handed back is the recorded one, not a copy.)
            join_and_announce(
                || Ok(Arc::clone(&waiting_on)),
                || {
                    announcements.fetch_add(1, Ordering::AcqRel);
                },
            )
        });

        assert_eq!(result, Ok(()));
        assert_eq!(
            raises.load(Ordering::Acquire),
            1,
            "one raise, joining the window already up"
        );
        assert_eq!(
            announcements.load(Ordering::Acquire),
            1,
            "the prompt already up is brought to the front, once"
        );
        assert!(
            !waiting_on.load(Ordering::Acquire),
            "joining must leave the waiting operation's answered flag alone"
        );
    }

    /// And joining a prompt that has already been answered must not refocus
    /// it either -- the same rule the poll loop relies on.
    #[test]
    fn raising_a_prompt_that_is_already_answered_does_not_refocus_it() {
        let spent = Arc::new(AtomicBool::new(true));
        let announcements = std::sync::atomic::AtomicUsize::new(0);

        let result = raise_prompt(KeyState::Locked, never_loaded, || {
            join_and_announce(
                || Ok(Arc::clone(&spent)),
                || {
                    announcements.fetch_add(1, Ordering::AcqRel);
                },
            )
        });

        assert_eq!(result, Ok(()));
        assert_eq!(announcements.load(Ordering::Acquire), 0);
        assert!(spent.load(Ordering::Acquire), "the flag is left as it was");
    }

    /// What an on-demand prompt does for a key with no passphrase to ask
    /// about, and for one that cannot be used at all. Same table as the git
    /// path takes, because it is the same question.
    #[test]
    fn raising_a_prompt_for_a_key_that_needs_none_asks_nothing() {
        for state in [
            KeyState::Unlocked,
            KeyState::Unencrypted,
            KeyState::NotConfigured,
        ] {
            let raises = std::sync::atomic::AtomicUsize::new(0);
            let result = raise_prompt(state, never_loaded, || {
                raises.fetch_add(1, Ordering::AcqRel);
                Ok(Arc::new(AtomicBool::new(false)))
            });
            assert_eq!(result, Ok(()), "{state:?} needs no passphrase");
            assert_eq!(
                raises.load(Ordering::Acquire),
                0,
                "{state:?} must not put a window up"
            );
        }

        let never_raised = || -> Result<Arc<AtomicBool>, String> {
            panic!("a key that cannot be used must not raise a prompt")
        };
        assert_eq!(
            raise_prompt(KeyState::Missing, never_loaded, never_raised).unwrap_err(),
            "ssh.keyMissing"
        );
        assert_eq!(
            raise_prompt(KeyState::NotAKey, never_loaded, never_raised).unwrap_err(),
            "ssh.notAPrivateKey"
        );
    }

    /// A window that cannot be built reaches Settings as a code it can
    /// translate, never as the window system's own message.
    #[test]
    fn a_prompt_that_cannot_be_raised_fails_with_a_stable_code() {
        let result = raise_prompt(KeyState::Locked, never_loaded, || {
            // What `build_unlock_window` returns for any builder failure.
            Err(unlock_window_failed())
        });
        assert_eq!(result, Err("ssh.keyLocked".to_string()));
    }

    /// A prompt that has been answered but whose window is still on screen is
    /// asked for again every poll round -- and must be announced on none of
    /// them. Announcing means taking the focus and emitting
    /// `ssh:unlockRequired`, so re-announcing would have a window nobody can
    /// answer stealing the focus four times a second and firing thousands of
    /// events at the renderer while it lingered.
    #[test]
    fn an_answered_prompt_is_never_re_announced_however_many_rounds_pass() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));

        let plain = crate::commands::test_support::write_key(app.dir(), "plain_key", None);
        // Answered already, and the window it belongs to has not gone yet, so
        // it is asked for again on every round and adopted on none.
        let lingering = Arc::new(AtomicBool::new(true));
        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let announcements = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let asked = Arc::clone(&asks);
        let announced = Arc::clone(&announcements);
        let prompt = Arc::clone(&lingering);
        let ctx = &app.ctx;
        let rounds_to_observe = 3;
        let join_prompt = move || {
            if asked.fetch_add(1, Ordering::AcqRel) + 1 == rounds_to_observe {
                // Enough rounds observed; end the wait on a signal rather than
                // on elapsed time by making the key usable.
                ctx.ssh_key.set_path(Some(plain.clone()));
            }
            let announced = Arc::clone(&announced);
            join_and_announce(
                || Ok(Arc::clone(&prompt)),
                || {
                    announced.fetch_add(1, Ordering::AcqRel);
                },
            )
        };

        assert_eq!(
            wait_for_usable_key(ctx, far_off_deadline(), join_prompt),
            Ok(())
        );
        assert_eq!(
            asks.load(Ordering::Acquire),
            rounds_to_observe,
            "the answered prompt must be asked for again on every round"
        );
        assert_eq!(
            announcements.load(Ordering::Acquire),
            0,
            "an answered prompt must not be refocused or re-announced, on any round"
        );
    }

    /// The other side of that rule: a prompt that can still be answered is
    /// announced, so the window comes to the front and the renderer learns
    /// which key it is being asked about.
    #[test]
    fn a_live_prompt_is_announced_once() {
        let announcements = std::sync::atomic::AtomicUsize::new(0);
        let live = Arc::new(AtomicBool::new(false));
        let joined = join_and_announce(
            || Ok(Arc::clone(&live)),
            || {
                announcements.fetch_add(1, Ordering::AcqRel);
            },
        )
        .unwrap();
        assert!(Arc::ptr_eq(&joined, &live));
        assert_eq!(announcements.load(Ordering::Acquire), 1);
    }

    /// Collects what the resolution points announce, standing in for the
    /// app-wide `ssh:unlockResolved` emit.
    #[derive(Default)]
    struct Announcements(std::sync::Mutex<Vec<bool>>);

    impl Announcements {
        fn record(&self) -> impl Fn(bool) + '_ {
            |unlocked| self.0.lock().unwrap().push(unlocked)
        }

        fn seen(&self) -> Vec<bool> {
            self.0.lock().unwrap().clone()
        }
    }

    /// Settings is in a different window from the prompt, so a successful
    /// unlock has to say so out loud.
    #[test]
    fn a_successful_unlock_announces_that_the_key_is_usable() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path).unwrap();

        let announced = Announcements::default();
        assert_eq!(
            unlock(&app.ctx, "topsecret".to_string(), announced.record()),
            Ok(())
        );
        assert_eq!(announced.seen(), vec![true]);
    }

    /// A rejected passphrase is not a resolution: the prompt stays up for
    /// another try, and nothing should tell Settings otherwise.
    #[test]
    fn a_wrong_passphrase_announces_nothing() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path).unwrap();

        let announced = Announcements::default();
        assert_eq!(
            unlock(&app.ctx, "nope".to_string(), announced.record()).unwrap_err(),
            "ssh.wrongPassphrase"
        );
        assert!(announced.seen().is_empty());
    }

    /// A cancelled prompt announces that the key is still not usable.
    #[test]
    fn a_cancelled_prompt_announces_that_the_key_is_still_locked() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));
        let answered = Arc::new(AtomicBool::new(false));

        let announced = Announcements::default();
        assert!(dismiss_prompt(
            &answered,
            &app.ctx.ssh_key,
            announced.record()
        ));
        assert_eq!(announced.seen(), vec![false]);
    }

    /// Cancel and then the window closing are two exits from one resolution.
    /// The announcement rides inside the same answered-flag guard as the
    /// notification, so both happen exactly once.
    #[test]
    fn cancel_followed_by_a_close_announces_exactly_once() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));
        let answered = Arc::new(AtomicBool::new(false));

        let announced = Announcements::default();
        // The Cancel button.
        dismiss_prompt(&answered, &app.ctx.ssh_key, announced.record());
        // The renderer closing the window straight after it.
        dismiss_prompt(&answered, &app.ctx.ssh_key, announced.record());
        assert_eq!(
            announced.seen(),
            vec![false],
            "one resolution, one announcement"
        );
    }

    /// Closing the window after the passphrase was accepted is still a
    /// resolution, and it tells the truth about the key rather than a flat
    /// `false`.
    #[test]
    fn closing_after_a_successful_unlock_announces_the_key_as_usable() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path).unwrap();
        unlock(&app.ctx, "topsecret".to_string(), |_| {}).unwrap();
        let answered = Arc::new(AtomicBool::new(false));

        let announced = Announcements::default();
        dismiss_prompt(&answered, &app.ctx.ssh_key, announced.record());
        assert_eq!(announced.seen(), vec![true]);
    }

    /// Cancel and the window's own close both dismiss; the second must be a
    /// no-op, or it would fire a stale failure at whatever started waiting in
    /// the meantime.
    #[test]
    fn a_prompt_is_dismissed_once_however_many_exits_fire() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));
        let answered = Arc::new(AtomicBool::new(false));

        assert!(
            dismiss_prompt(&answered, &app.ctx.ssh_key, |_| {}),
            "the first exit answers the prompt"
        );
        assert!(
            !dismiss_prompt(&answered, &app.ctx.ssh_key, |_| {}),
            "the window closing after a Cancel must not dismiss a second time"
        );
        assert!(
            !dismiss_prompt(&answered, &app.ctx.ssh_key, |_| {}),
            "and neither must anything else"
        );
    }

    /// A prompt whose window is still on screen is joined; one whose window
    /// has gone is stale and must be replaced.
    #[test]
    fn only_a_prompt_with_a_window_behind_it_is_joined() {
        let prompt = Arc::new(AtomicBool::new(false));
        assert!(joinable(Some(&prompt), true));
        assert!(!joinable(Some(&prompt), false));
        // A window with no prompt on record cannot have been built here; the
        // build below will find the label taken and join blind.
        assert!(!joinable(None, true));
        assert!(!joinable(None, false));
    }

    /// The losers of a build race must join the winner's prompt, not surface
    /// the window system's own untranslatable message as the operation's
    /// error.
    #[test]
    fn a_taken_window_label_means_a_prompt_is_already_open() {
        assert!(is_label_taken(&tauri::Error::WindowLabelAlreadyExists(
            UNLOCK_WINDOW_LABEL.to_string()
        )));
        assert!(is_label_taken(&tauri::Error::WebviewLabelAlreadyExists(
            UNLOCK_WINDOW_LABEL.to_string()
        )));
        assert!(!is_label_taken(&tauri::Error::CannotReparentWebviewWindow));
        // Whatever the reason, the renderer gets a code it can translate.
        assert_eq!(unlock_window_failed(), "ssh.keyLocked");
    }

    #[test]
    fn an_empty_path_is_rejected_without_touching_the_config() {
        let app = TempAppData::new();
        assert_eq!(
            select(&app.ctx, "   ".to_string()).unwrap_err(),
            "ssh.keyMissing"
        );
        assert!(crate::commands::config::load(&app.ctx)
            .config
            .repositories
            .ssh_key_path
            .is_none());
    }

    /// A path containing a double quote cannot be expressed in
    /// `GIT_SSH_COMMAND`, so `ssh_env_vars` hands back nothing at all for it
    /// and git would quietly use the default agent identity while the UI
    /// showed a healthy key. Refuse it at the door instead.
    #[test]
    fn a_path_that_cannot_reach_git_is_refused() {
        let app = TempAppData::new();
        // Deliberately never written to disk: a double quote is a reserved
        // character in Windows filenames, so creating this file would panic
        // there. Nothing needs it to exist -- the precondition below and the
        // rejection itself both work on the path string alone.
        let quoted = app
            .dir()
            .join("quo\"ted_key")
            .to_string_lossy()
            .into_owned();
        assert!(skillkeeper_core::ssh_env::ssh_env_vars(&quoted, None).is_empty());

        assert_eq!(
            select(&app.ctx, quoted).unwrap_err(),
            "ssh.notAPrivateKey",
            "a path git cannot be told about is not a usable key"
        );
        assert!(crate::commands::config::load(&app.ctx)
            .config
            .repositories
            .ssh_key_path
            .is_none());
        assert_eq!(state(&app.ctx).state, KeyState::NotConfigured);
    }

    /// A hand-edited `sshKeyPath: ~/.ssh/id_ed25519` has to resolve against the
    /// home directory; taken literally it would classify as `Missing` and
    /// block every SSH operation with a configuration error.
    #[test]
    fn a_tilde_path_resolves_against_the_home_directory() {
        let app = TempAppData::new();
        let ssh_dir = Path::new(app.ctx.env.home_dir()).join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        let path =
            crate::commands::test_support::write_key(&ssh_dir, "id_ed25519", Some("topsecret"));

        // Seeded from a config file somebody edited by hand.
        seed_store(&app.ctx, Some("~/.ssh/id_ed25519".to_string()));
        assert_eq!(app.ctx.ssh_key.state(), KeyState::Locked);
        assert_eq!(app.ctx.ssh_key.path().as_deref(), Some(path.as_str()));

        // And the same on the way in from the picker or a renderer edit.
        let selected = select(&app.ctx, "~/.ssh/id_ed25519".to_string()).unwrap();
        assert_eq!(selected.path.as_deref(), Some(path.as_str()));
        assert_eq!(selected.state, KeyState::Locked);
        // Stored expanded, so the CLI reading the same config finds the file.
        assert_eq!(
            crate::commands::config::load(&app.ctx)
                .config
                .repositories
                .ssh_key_path
                .as_deref(),
            Some(path.as_str())
        );
    }

    /// Re-seeding with the value already in the config must look like "no
    /// change" to the store, or every config write would drop the passphrase.
    #[test]
    fn re_seeding_the_same_tilde_path_keeps_the_held_passphrase() {
        let app = TempAppData::new();
        let ssh_dir = Path::new(app.ctx.env.home_dir()).join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        crate::commands::test_support::write_key(&ssh_dir, "id_ed25519", Some("topsecret"));

        seed_store(&app.ctx, Some("~/.ssh/id_ed25519".to_string()));
        unlock(&app.ctx, "topsecret".to_string(), |_| {}).unwrap();
        seed_store(&app.ctx, Some("~/.ssh/id_ed25519".to_string()));
        assert_eq!(app.ctx.ssh_key.state(), KeyState::Unlocked);
    }

    #[test]
    fn expand_home_only_touches_a_leading_tilde() {
        assert_eq!(expand_home("~", "/home/bob"), "/home/bob");
        assert_eq!(
            expand_home("~/.ssh/id_ed25519", "/home/bob"),
            Path::new("/home/bob/.ssh/id_ed25519")
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(expand_home("/etc/key", "/home/bob"), "/etc/key");
        // Not a home reference: a `~` anywhere but the front is just a
        // character, and `~user` is not a form this expands.
        assert_eq!(expand_home("/tmp/~/key", "/home/bob"), "/tmp/~/key");
        assert_eq!(expand_home("~bob/key", "/home/bob"), "~bob/key");
    }

    #[test]
    fn unlock_errors_map_to_the_stable_renderer_keys() {
        assert_eq!(
            unlock_error_key(UnlockError::WrongPassphrase),
            "ssh.wrongPassphrase"
        );
        assert_eq!(unlock_error_key(UnlockError::Missing), "ssh.keyMissing");
        assert_eq!(unlock_error_key(UnlockError::NotAKey), "ssh.notAPrivateKey");
        // A DSA key and a corrupt file get codes of their own: flattening them
        // into "not a private key" would send the user looking for a problem
        // that is not theirs.
        assert_eq!(
            unlock_error_key(UnlockError::Unsupported),
            "ssh.puttyUnsupportedAlgorithm"
        );
        assert_eq!(unlock_error_key(UnlockError::Damaged), "ssh.puttyDamaged");
        // The key parsed and converted; it is the agent that could not take it,
        // and that is what the user needs to hear.
        assert_eq!(
            unlock_error_key(UnlockError::AgentUnavailable),
            "ssh.puttyNeedsAgent"
        );
    }

    /// Every key state's answer to the unlock window, in one table.
    ///
    /// The routing decides which of two quite different acts the passphrase
    /// just typed is spent on, and a state nobody listed silently taking the
    /// OpenSSH path is exactly how a PuTTY key already in the agent came to
    /// answer "not a private key" about itself.
    #[test]
    fn every_key_state_routes_to_the_act_that_fits_it() {
        use UnlockRoute::{AlreadyUsable, HoldPassphrase, LoadIntoAgent, Refuse};
        // Every variant of `KeyState`: a new one has to be added here to be
        // covered, and `unlock_route`'s own match makes forgetting it a compile
        // error rather than a wrong answer in production.
        let table = [
            (KeyState::NotConfigured, HoldPassphrase),
            (KeyState::Missing, HoldPassphrase),
            (KeyState::NotAKey, HoldPassphrase),
            (KeyState::Unencrypted, HoldPassphrase),
            (KeyState::Locked, HoldPassphrase),
            (KeyState::Unlocked, HoldPassphrase),
            (KeyState::PuttyLocked, LoadIntoAgent),
            (KeyState::PuttyUnencrypted, LoadIntoAgent),
            // Already in the agent and working: answering the window again must
            // not hand it to the OpenSSH path, which would inspect the file,
            // find a PPK and call it not a private key.
            (KeyState::PuttyInAgent, AlreadyUsable),
            (KeyState::PuttyNoAgent, Refuse(PUTTY_NEEDS_AGENT_ERROR)),
        ];
        for (state, expected) in table {
            assert_eq!(unlock_route(state), expected, "{state:?}");
        }
    }

    /// A PuTTY key with no passphrase needs the agent, not a window: pressing
    /// Unlock on one must load it rather than silently do nothing.
    #[test]
    fn an_unencrypted_putty_key_is_loaded_rather_than_asked_about() {
        let loads = std::sync::atomic::AtomicUsize::new(0);
        let result = raise_prompt(
            KeyState::PuttyUnencrypted,
            || {
                loads.fetch_add(1, Ordering::AcqRel);
                Ok(())
            },
            || panic!("nothing to ask about: this key has no passphrase"),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(loads.load(Ordering::Acquire), 1);
    }

    /// An encrypted one is the other way round: it needs the passphrase first,
    /// so it takes exactly the window a locked OpenSSH key takes.
    #[test]
    fn a_locked_putty_key_raises_the_same_prompt_as_any_other() {
        let fresh = Arc::new(AtomicBool::new(false));
        let raises = std::sync::atomic::AtomicUsize::new(0);
        let result = raise_prompt(KeyState::PuttyLocked, never_loaded, || {
            raises.fetch_add(1, Ordering::AcqRel);
            Ok(Arc::clone(&fresh))
        });
        assert_eq!(result, Ok(()));
        assert_eq!(raises.load(Ordering::Acquire), 1);
    }

    /// With no agent there is nowhere to put the key, so neither a window nor a
    /// load helps: the user is told the one thing that would.
    #[test]
    fn a_putty_key_with_no_agent_is_reported_rather_than_asked_about() {
        let never_raised =
            || -> Result<Arc<AtomicBool>, String> { panic!("no agent to unlock into") };
        assert_eq!(
            raise_prompt(KeyState::PuttyNoAgent, never_loaded, never_raised).unwrap_err(),
            "ssh.puttyNeedsAgent"
        );
    }

    /// The passphrase for a PuTTY key is spent on the load and dropped: it is
    /// never held, because `ssh` reads the key from the agent rather than from
    /// a file it must decrypt again per invocation.
    ///
    /// Deliberately a WRONG passphrase, so the conversion fails before anything
    /// reaches `ssh-add`: a test must never put a key in the developer's own
    /// agent. Either code below proves the routing, since the OpenSSH path this
    /// used to take answers `ssh.notAPrivateKey` for a PPK file.
    #[test]
    fn unlocking_a_putty_key_holds_no_passphrase() {
        let app = TempAppData::new();
        let path = write_putty_key(&app, "enc.ppk", crate::app::ppk::fixtures::ED25519_V3_ENC);
        select(&app.ctx, path).unwrap();

        let error = unlock(&app.ctx, "nope".to_string(), |_| {}).unwrap_err();
        assert!(
            error == "ssh.wrongPassphrase" || error == "ssh.puttyNeedsAgent",
            "unexpected code for a PuTTY key: {error}"
        );
        assert!(app.ctx.ssh_key.passphrase().is_none());
    }

    /// The guard behind `unlock` reporting the store's actual state rather
    /// than the bare `Ok` of a verification whose result was discarded because
    /// the chosen key changed underneath it.
    #[test]
    fn only_a_usable_key_counts_as_unlocked() {
        assert_eq!(state_error_key(KeyState::Unlocked), None);
        assert_eq!(state_error_key(KeyState::Unencrypted), None);
        assert_eq!(state_error_key(KeyState::Locked), Some("ssh.keyLocked"));
        assert_eq!(
            state_error_key(KeyState::NotConfigured),
            Some("ssh.keyLocked")
        );
        assert_eq!(state_error_key(KeyState::Missing), Some("ssh.keyMissing"));
        assert_eq!(
            state_error_key(KeyState::NotAKey),
            Some("ssh.notAPrivateKey")
        );
        // A PuTTY key counts as usable only once the agent holds it: `ssh`
        // cannot read the file, so even the unencrypted one is not ready until
        // it is loaded.
        assert_eq!(state_error_key(KeyState::PuttyInAgent), None);
        assert_eq!(
            state_error_key(KeyState::PuttyLocked),
            Some("ssh.keyLocked")
        );
        assert_eq!(
            state_error_key(KeyState::PuttyUnencrypted),
            Some("ssh.keyLocked")
        );
        assert_eq!(
            state_error_key(KeyState::PuttyNoAgent),
            Some("ssh.puttyNeedsAgent")
        );
    }

    /// One definition of "usable" for the wait loop, the close handler and
    /// `unlock`'s result check. An unencrypted key counts: switching to one
    /// while the prompt is up must let the operation through, not park it.
    #[test]
    fn a_key_is_usable_when_nothing_stands_in_its_way() {
        assert!(key_is_usable(KeyState::Unlocked));
        assert!(key_is_usable(KeyState::Unencrypted));
        assert!(!key_is_usable(KeyState::Locked));
        assert!(!key_is_usable(KeyState::Missing));
        assert!(!key_is_usable(KeyState::NotAKey));
        assert!(!key_is_usable(KeyState::NotConfigured));
    }

    #[test]
    fn forgetting_relocks_without_unchoosing_the_key() {
        let app = TempAppData::new();
        let path = write_encrypted_key(&app, "topsecret");
        select(&app.ctx, path.clone()).unwrap();
        unlock(&app.ctx, "topsecret".to_string(), |_| {}).unwrap();
        forget(&app.ctx);
        let after = state(&app.ctx);
        assert_eq!(after.path.as_deref(), Some(path.as_str()));
        assert_eq!(after.state, KeyState::Locked);
    }

    #[test]
    fn export_writes_an_encrypted_key_and_switches_the_path() {
        let dir = std::env::temp_dir().join("sk-ppk-export-test");
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("k.ppk");
        let dest = dir.join("k-openssh");
        std::fs::write(&source, crate::app::ppk::fixtures::ED25519_V3_ENC).unwrap();

        let written = export_openssh(
            &source.to_string_lossy(),
            &dest.to_string_lossy(),
            crate::app::ppk::fixtures::PASSPHRASE,
        )
        .expect("exports");
        assert!(written.exists());

        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        // Encrypted with the same passphrase: the plaintext key must not be
        // what lands on disk.
        let key = ssh_key::PrivateKey::from_openssh(&text).unwrap();
        assert!(key.is_encrypted());
        assert!(key.decrypt(crate::app::ppk::fixtures::PASSPHRASE).is_ok());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(
                mode & 0o777,
                0o600,
                "key files must not be group/world readable"
            );
        }

        std::fs::remove_file(&source).ok();
        std::fs::remove_file(&dest).ok();
    }

    #[test]
    fn export_refuses_a_wrong_passphrase_without_writing_anything() {
        let dir = std::env::temp_dir().join("sk-ppk-export-refuse-test");
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("k.ppk");
        let dest = dir.join("never-written");
        std::fs::write(&source, crate::app::ppk::fixtures::ED25519_V3_ENC).unwrap();

        assert!(
            export_openssh(&source.to_string_lossy(), &dest.to_string_lossy(), "not-it").is_err()
        );
        assert!(!dest.exists(), "a failed export must leave no file behind");

        std::fs::remove_file(&source).ok();
    }
}
