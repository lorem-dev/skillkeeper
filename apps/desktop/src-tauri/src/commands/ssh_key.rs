//! SSH key commands: choosing the key, unlocking it, and the gate that decides
//! when an operation has to ask.
//!
//! Channel mapping (dots replaced by underscores, matching the rest of the
//! command surface):
//!   `sshKey:state`        -> `ssh_key_state`
//!   `sshKey:select`       -> `ssh_key_select`
//!   `sshKey:clear`        -> `ssh_key_clear`
//!   `sshKey:unlock`       -> `ssh_key_unlock`
//!   `sshKey:forget`       -> `ssh_key_forget`
//!   `sshKey:cancelUnlock` -> `ssh_key_cancel_unlock`
//!
//! The passphrase crosses the bridge in exactly one direction, once: as the
//! argument of [`ssh_key_unlock`]. It is never returned, never logged, and
//! never part of an error -- every failure here is one of the stable error
//! keys [`crate::app::ssh_key`] exports, which the renderer translates.
//!
//! [`require_unlocked`] is the gate the repository commands call before any
//! git work that may touch the chosen key. It is the only thing here that can
//! raise the unlock window, and it does so only for work the user just asked
//! for -- [`gate_for`] encodes that rule, so a scheduled update check can
//! never pop a passphrase prompt with nobody there to answer it.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

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
/// Returns [`KEY_MISSING_ERROR`] for a blank path, or the config writer's
/// message when the file cannot be written.
pub fn select(ctx: &AppContext, path: String) -> Result<SshKeyDto, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(KEY_MISSING_ERROR.to_string());
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
/// Returns [`WRONG_PASSPHRASE_ERROR`], [`KEY_MISSING_ERROR`] or
/// [`NOT_A_KEY_ERROR`]. The passphrase itself never appears in the error.
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
/// Cancel button, and its close handler as a backstop.
pub fn cancel_unlock(ctx: &AppContext) {
    ctx.ssh_key.notify_unlock_result(false);
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

/// Whether closing the unlock window should release a waiting operation.
///
/// Only a key that ended up usable means the prompt did its job; anything else
/// is a window closed without an answer, and the operation waiting behind it
/// must be told so rather than left hanging until the timeout.
fn releases_waiters_on_close(state: KeyState) -> bool {
    !matches!(state, KeyState::Unlocked | KeyState::Unencrypted)
}

/// Make sure the chosen key is usable before an operation that needs it.
///
/// A locked key blocks only work the user just asked for: a scheduled update
/// check must never raise a passphrase window on its own. Called BEFORE the git
/// queue and before the state lock, so a waiting prompt never holds either.
///
/// # Errors
///
/// Returns one of [`KEY_LOCKED_ERROR`], [`KEY_MISSING_ERROR`] or
/// [`NOT_A_KEY_ERROR`] when the operation must not run, including when the
/// user cancels the prompt or it goes unanswered for [`UNLOCK_TIMEOUT`].
// Wired into the repository commands in a later task; the window half is
// exercised by hand and the waiting half by the tests below.
#[allow(dead_code)]
pub fn require_unlocked(
    app: &AppHandle,
    ctx: &AppContext,
    is_ssh: bool,
    interactive: bool,
) -> Result<(), String> {
    match gate_for(is_ssh, ctx.ssh_key.state(), interactive) {
        Gate::Proceed => Ok(()),
        Gate::Fail(code) => Err(code.to_string()),
        Gate::Prompt => {
            open_unlock_window(app, ctx)?;
            // Raising the window is not instant, and when a prompt is already
            // on screen it may be answered while this call is still getting
            // there. `wait_for_unlock` only reacts to notifications that
            // arrive after it starts waiting, so re-read the state first
            // rather than parking on one that has already been and gone.
            if ctx.ssh_key.state() == KeyState::Unlocked {
                Ok(())
            } else {
                // Blocks this blocking-pool thread until the window reports
                // back. No lock is held here -- see this function's doc.
                ctx.ssh_key.wait_for_unlock(UNLOCK_TIMEOUT)
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

/// Raise (or focus) the small window that asks for the passphrase, then
/// announce which key it is asking about.
///
/// Focusing an existing window rather than building a second one keeps a burst
/// of blocked operations to a single prompt; each of them waits on the same
/// store, and one successful unlock releases them all.
///
/// # Errors
///
/// Returns the window builder's message when the window cannot be created.
fn open_unlock_window(app: &AppHandle, ctx: &AppContext) -> Result<(), String> {
    let path = ctx.ssh_key.path().unwrap_or_default();
    match app.get_webview_window(UNLOCK_WINDOW_LABEL) {
        Some(existing) => {
            let _ = existing.set_focus();
        }
        None => {
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
            // Parented to the main window so the OS keeps the prompt in front
            // of the app it belongs to, the same reason the native pickers in
            // `commands::dialog` are parented.
            if let Some(main) = app.get_webview_window("main") {
                builder = builder.parent(&main).map_err(|e| e.to_string())?;
            }
            let window = builder.build().map_err(|e| e.to_string())?;

            // A closed window must never leave a git operation hanging: the
            // Cancel button routes through `ssh_key_cancel_unlock`, and this
            // catches every other way the window can go away (the close
            // button, the window menu, the app tearing it down).
            let store = Arc::clone(&ctx.ssh_key);
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed)
                    && releases_waiters_on_close(store.state())
                {
                    store.notify_unlock_result(false);
                }
            });
        }
    }

    // Emitted app-wide, not to the window alone, so an already-open prompt
    // learns that a further operation is now waiting on it. A window built
    // just above is not listening yet, which is why the renderer paints its
    // first frame from `ssh_key_state` instead of from this event.
    app.emit(UNLOCK_REQUIRED_EVENT, UnlockRequired { path })
        .map_err(|e| e.to_string())
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

    #[test]
    fn a_cancelled_prompt_releases_the_waiting_operation() {
        let app = TempAppData::new();
        let store = std::sync::Arc::clone(&app.ctx.ssh_key);
        let waiter = std::thread::spawn(move || store.wait_for_unlock(UNLOCK_TIMEOUT));
        // Give the waiter a moment to park, then cancel as the window would.
        std::thread::sleep(std::time::Duration::from_millis(50));
        app.ctx.ssh_key.notify_unlock_result(false);
        assert_eq!(waiter.join().unwrap(), Err("ssh.keyLocked".to_string()));
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

    /// Closing the window releases whatever is waiting -- unless the wait is
    /// already over because the unlock succeeded, in which case a second
    /// notification would be a spurious failure signal.
    #[test]
    fn closing_the_window_releases_waiters_except_after_a_successful_unlock() {
        assert!(releases_waiters_on_close(KeyState::Locked));
        assert!(releases_waiters_on_close(KeyState::Missing));
        assert!(releases_waiters_on_close(KeyState::NotAKey));
        assert!(releases_waiters_on_close(KeyState::NotConfigured));
        assert!(!releases_waiters_on_close(KeyState::Unlocked));
        assert!(!releases_waiters_on_close(KeyState::Unencrypted));
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
