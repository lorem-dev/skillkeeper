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
//! never part of an error -- every key-related failure is one of the four
//! stable codes the renderer translates ([`WRONG_PASSPHRASE_ERROR`] and the
//! three [`crate::app::ssh_key`] exports), never a message from `ssh`, the
//! window system, or the key parser.
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

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use skillkeeper_core::ports::HostEnv;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use zeroize::Zeroizing;

use crate::app::ssh_key::{
    gate_for, Gate, KeyState, UnlockError, KEY_LOCKED_ERROR, KEY_MISSING_ERROR, NOT_A_KEY_ERROR,
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
/// # Errors
///
/// Returns [`WRONG_PASSPHRASE_ERROR`], [`KEY_MISSING_ERROR`],
/// [`NOT_A_KEY_ERROR`], or [`KEY_LOCKED_ERROR`] when the passphrase verified
/// but the chosen key changed underneath it (see the body). The passphrase
/// itself never appears in the error.
pub fn unlock(ctx: &AppContext, passphrase: String) -> Result<(), String> {
    // Scrubbed when this call returns: the store keeps its own zeroizing copy,
    // and this one -- the last hop of the value that came over the bridge --
    // must not outlive the call that used it.
    let passphrase = Zeroizing::new(passphrase);
    ctx.ssh_key
        .unlock(&passphrase)
        .map_err(unlock_error_key)
        .map_err(str::to_string)?;
    // `SshKeyStore::unlock` reports success for a passphrase it verified, but
    // records nothing if the chosen key changed while it was verifying -- so
    // `Ok` alone does not mean the key is usable now. Report what the store
    // actually ended up in, or the renderer would close the prompt on a
    // success that never happened.
    match state_error_key(ctx.ssh_key.state()) {
        Some(code) => Err(code.to_string()),
        None => Ok(()),
    }
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
/// the window dismisses once, not twice.
pub fn cancel_unlock(ctx: &AppContext) {
    let live = live_prompt();
    match live.as_deref() {
        Some(answered) => {
            dismiss_prompt(answered, &ctx.ssh_key);
        }
        // No prompt on record -- a defensive call from the renderer, or one
        // racing the very first build. Release any waiter anyway.
        None => ctx.ssh_key.notify_unlock_result(false),
    }
}

/// The renderer-facing error key for an [`UnlockError`].
fn unlock_error_key(error: UnlockError) -> &'static str {
    match error {
        UnlockError::WrongPassphrase => WRONG_PASSPHRASE_ERROR,
        UnlockError::Missing => KEY_MISSING_ERROR,
        UnlockError::NotAKey => NOT_A_KEY_ERROR,
    }
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
fn dismiss_prompt(answered: &AtomicBool, store: &crate::app::ssh_key::SshKeyStore) -> bool {
    if answered.swap(true, Ordering::AcqRel) {
        return false;
    }
    // Nothing to release when the prompt did its job: the successful unlock
    // has already woken everyone waiting.
    if !key_is_usable(store.state()) {
        store.notify_unlock_result(false);
    }
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
/// Returns [`KEY_MISSING_ERROR`], [`NOT_A_KEY_ERROR`], or [`KEY_LOCKED_ERROR`]
/// when the prompt could not be raised. Never a raw window-system message.
pub fn prompt(app: &AppHandle, ctx: &AppContext) -> Result<(), String> {
    raise_prompt(ctx.ssh_key.state(), || open_unlock_window(app, ctx))
}

/// The decision half of [`prompt`], with raising the window as a parameter so
/// it can be tested without a window system.
///
/// `raise` is [`open_unlock_window`], which joins the prompt already on screen
/// rather than building a second one and announces it only if it can still be
/// answered -- so a prompt raised here and a prompt raised by a blocked git
/// operation are always the same window, with the same answered flag, whoever
/// got there first.
fn raise_prompt(
    state: KeyState,
    raise: impl FnOnce() -> Result<Arc<AtomicBool>, String>,
) -> Result<(), String> {
    // `true, true`: this IS the user asking about the SSH key, so the decision
    // is the ssh-transport, interactive one -- the same row of the table a
    // user-initiated clone over SSH would take.
    match gate_for(true, state, true) {
        Gate::Proceed => Ok(()),
        Gate::Fail(code) => Err(code.to_string()),
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
    .inner_size(460.0, 300.0)
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
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            dismiss_prompt(&answered_on_close, &store);
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
/// [`ssh_key_unlock`] from that window, after which Settings re-reads
/// [`ssh_key_state`].
///
/// Joins the prompt an operation may already be waiting behind rather than
/// opening a second one.
#[tauri::command]
pub async fn ssh_key_prompt(app: AppHandle, ctx: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&ctx, move |c| prompt(&app, c)).await?
}

/// `sshKey:unlock` -- verify `passphrase` and hold it for this session.
///
/// The one place a passphrase crosses the bridge, and only inbound.
#[tauri::command]
pub async fn ssh_key_unlock(
    ctx: State<'_, Arc<AppContext>>,
    passphrase: String,
) -> Result<(), String> {
    blocking(&ctx, move |c| unlock(c, passphrase)).await?
}

/// `sshKey:forget` -- drop the held passphrase without unchoosing the key.
#[tauri::command]
pub async fn ssh_key_forget(ctx: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&ctx, forget).await
}

/// `sshKey:cancelUnlock` -- the unlock window's Cancel: fail whatever is
/// waiting on it rather than leaving it to time out.
#[tauri::command]
pub async fn ssh_key_cancel_unlock(ctx: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&ctx, cancel_unlock).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;

    fn write_encrypted_key(app: &TempAppData, passphrase: &str) -> String {
        crate::commands::test_support::write_key(app.dir(), "encrypted_key", Some(passphrase))
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
            unlock(&app.ctx, "nope".to_string()),
            Err("ssh.wrongPassphrase".to_string())
        );
        assert_eq!(unlock(&app.ctx, "topsecret".to_string()), Ok(()));
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

    /// A prompt that is answered, from a test's point of view: hand
    /// [`wait_for_usable_key`] a flag instead of a window.
    fn fake_prompt(answered: &Arc<AtomicBool>) -> impl FnMut() -> Result<Arc<AtomicBool>, String> {
        let prompt = Arc::clone(answered);
        move || Ok(Arc::clone(&prompt))
    }

    fn in_a_moment() -> Instant {
        Instant::now() + Duration::from_secs(5)
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
        let answered = Arc::new(AtomicBool::new(false));

        let ctx = &app.ctx;
        let plain = crate::commands::test_support::write_key(app.dir(), "plain_key", None);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(50));
                // No notification of any kind: just a key that is now usable.
                ctx.ssh_key.set_path(Some(plain));
            });
            let started = Instant::now();
            let result = wait_for_usable_key(ctx, in_a_moment(), fake_prompt(&answered));
            assert_eq!(result, Ok(()));
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the poll must notice the state change, not wait out the deadline"
            );
        });
    }

    /// The other half: a dismissal changes no key state, so only the prompt's
    /// flag carries it -- and it too may land in the gap before the park.
    #[test]
    fn the_wait_ends_when_the_prompt_it_joined_is_dismissed() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));
        let answered = Arc::new(AtomicBool::new(false));

        let ctx = &app.ctx;
        let flag = Arc::clone(&answered);
        std::thread::scope(|scope| {
            scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(50));
                // A dismissal whose notification this waiter never sees.
                flag.store(true, Ordering::Release);
            });
            let started = Instant::now();
            let result = wait_for_usable_key(ctx, in_a_moment(), fake_prompt(&answered));
            assert_eq!(result, Err("ssh.keyLocked".to_string()));
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the poll must notice the dismissal, not wait out the deadline"
            );
        });
    }

    /// Joining a window that is already tearing down must not park behind it:
    /// the operation asks again once the teardown is done and gets its own
    /// prompt.
    #[test]
    fn a_prompt_already_dismissed_is_not_joined_but_asked_for_again() {
        let app = TempAppData::new();
        app.ctx
            .ssh_key
            .set_path(Some(write_encrypted_key(&app, "topsecret")));

        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&asks);
        let dying = Arc::new(AtomicBool::new(true));
        let fresh = Arc::new(AtomicBool::new(false));
        let fresh_for_prompt = Arc::clone(&fresh);
        let join_prompt = move || {
            if counter.fetch_add(1, Ordering::AcqRel) == 0 {
                // The first ask lands on a window mid-teardown.
                Ok(Arc::clone(&dying))
            } else {
                // By the second, the teardown is over: a live prompt.
                Ok(Arc::clone(&fresh_for_prompt))
            }
        };

        let ctx = &app.ctx;
        std::thread::scope(|scope| {
            scope.spawn(|| {
                std::thread::sleep(Duration::from_millis(400));
                // Dismissing the FRESH prompt is what ends the wait; the dying
                // one must never have been adopted, or this would still be
                // parked behind it.
                fresh.store(true, Ordering::Release);
            });
            let started = Instant::now();
            assert_eq!(
                wait_for_usable_key(ctx, in_a_moment(), join_prompt),
                Err("ssh.keyLocked".to_string())
            );
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "the fresh prompt's dismissal must end the wait, not the deadline"
            );
        });
        assert!(
            asks.load(Ordering::Acquire) >= 2,
            "the operation must ask for a prompt again after joining a dismissed one, \
             asked {} time(s)",
            asks.load(Ordering::Acquire)
        );
    }

    /// Settings raising the prompt for a locked key: the window goes up and
    /// the call returns, with nothing waiting behind it.
    #[test]
    fn a_locked_key_raises_a_prompt_on_demand_without_waiting_for_it() {
        let raises = std::sync::atomic::AtomicUsize::new(0);
        let fresh = Arc::new(AtomicBool::new(false));

        let started = Instant::now();
        let result = raise_prompt(KeyState::Locked, || {
            raises.fetch_add(1, Ordering::AcqRel);
            Ok(Arc::clone(&fresh))
        });

        assert_eq!(result, Ok(()));
        assert_eq!(raises.load(Ordering::Acquire), 1);
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "Settings must not be parked behind the answer"
        );
    }

    /// A prompt an operation is already waiting behind must be joined, not
    /// duplicated: the same window, the same answered flag, and one focus.
    #[test]
    fn raising_a_prompt_that_is_already_open_joins_it() {
        // The prompt some blocked git operation put up and is waiting on.
        let waiting_on = Arc::new(AtomicBool::new(false));
        let raises = std::sync::atomic::AtomicUsize::new(0);
        let announcements = std::sync::atomic::AtomicUsize::new(0);

        let result = raise_prompt(KeyState::Locked, || {
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

        let result = raise_prompt(KeyState::Locked, || {
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
            let result = raise_prompt(state, || {
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
            raise_prompt(KeyState::Missing, never_raised).unwrap_err(),
            "ssh.keyMissing"
        );
        assert_eq!(
            raise_prompt(KeyState::NotAKey, never_raised).unwrap_err(),
            "ssh.notAPrivateKey"
        );
    }

    /// A window that cannot be built reaches Settings as a code it can
    /// translate, never as the window system's own message.
    #[test]
    fn a_prompt_that_cannot_be_raised_fails_with_a_stable_code() {
        let result = raise_prompt(KeyState::Locked, || {
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

        // Answered already, and the window it belongs to has not gone yet.
        let lingering = Arc::new(AtomicBool::new(true));
        let asks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let announcements = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let asked = Arc::clone(&asks);
        let announced = Arc::clone(&announcements);
        let prompt = Arc::clone(&lingering);
        let join_prompt = move || {
            asked.fetch_add(1, Ordering::AcqRel);
            let announced = Arc::clone(&announced);
            join_and_announce(
                || Ok(Arc::clone(&prompt)),
                || {
                    announced.fetch_add(1, Ordering::AcqRel);
                },
            )
        };

        // Several poll rounds, then give up: the answered prompt is never
        // adopted, so the wait ends on the deadline.
        let deadline = Instant::now() + Duration::from_millis(900);
        assert_eq!(
            wait_for_usable_key(&app.ctx, deadline, join_prompt),
            Err("ssh.keyLocked".to_string())
        );
        assert!(
            asks.load(Ordering::Acquire) >= 3,
            "the wait must have polled several times, asked {} time(s)",
            asks.load(Ordering::Acquire)
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
            dismiss_prompt(&answered, &app.ctx.ssh_key),
            "the first exit answers the prompt"
        );
        assert!(
            !dismiss_prompt(&answered, &app.ctx.ssh_key),
            "the window closing after a Cancel must not dismiss a second time"
        );
        assert!(
            !dismiss_prompt(&answered, &app.ctx.ssh_key),
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
        unlock(&app.ctx, "topsecret".to_string()).unwrap();
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
        unlock(&app.ctx, "topsecret".to_string()).unwrap();
        forget(&app.ctx);
        let after = state(&app.ctx);
        assert_eq!(after.path.as_deref(), Some(path.as_str()));
        assert_eq!(after.state, KeyState::Locked);
    }
}
