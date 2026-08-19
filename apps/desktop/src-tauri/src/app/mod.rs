//! Host-facing helpers that operate on a project's own folder or on installed
//! applications: project-icon sanitization (a security-critical port of the
//! Electron `projectIcon.ts`) and editor detection/launch (a port of
//! `editors.ts`).
//!
//! These reach the real OS directly (filesystem reads for icons, subprocess
//! probing for editors), so they take plain paths rather than the domain
//! [`FsPort`](skillkeeper_core::ports::FsPort). The `FsPort` has no binary-read
//! method, so icon reads use `std::fs` -- the same shape the TypeScript used
//! (`fs.readFileSync`).

pub mod askpass;
pub mod editor_launch;
pub mod i18n;
pub mod icon_sanitize;
pub mod menu;
pub mod openssh_pem;
pub mod ppk;
pub mod ssh_agent;
pub mod ssh_git;
pub mod ssh_key;
pub mod theme;
pub mod watcher;

/// Quit the whole app immediately.
///
/// Runs our own teardown (kill the shell, stop a self-spawned ssh-agent) and
/// then `std::process::exit`, deliberately bypassing the graceful AppKit
/// `terminate:` / Tauri unwind. Measured on macOS: routing Quit through the
/// native `terminate:` selector takes ~15s (AppKit + WebKit teardown), while a
/// direct `process::exit` after our teardown quits in ~0.3s. Used by both the
/// Quit menu item / Cmd+Q ([`menu::handle_event`]) and the window-close /
/// exit-request paths in `lib.rs`.
pub fn quit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> ! {
    use tauri::Manager;

    if let Some(ctx) = app.try_state::<std::sync::Arc<crate::state::AppContext>>() {
        ctx.terminal.shutdown();
        // Before the agent is stopped, because a user's own long-lived agent is
        // not stopped at all: without this the converted key would sit in it
        // until the TTL ran out, long after the app that put it there had gone.
        unload_putty_bounded(&ctx.ssh_key);
    }
    ssh_agent::stop_ssh_agent();
    std::process::exit(0);
}

/// How long an exit path waits for the agent to give the session's PuTTY key
/// up before leaving it to the key's TTL.
///
/// A live local agent answers `ssh-add -d` in single-digit milliseconds, so
/// this is never reached in practice; it exists for the agent that cannot
/// answer at all -- a gpg-agent still starting, a stale `SSH_AUTH_SOCK` whose
/// peer is gone, a third-party agent wedged on something of its own.
const UNLOAD_ON_EXIT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

/// Take the session's PuTTY key back out of the agent, but never let a wedged
/// agent hold up the exit.
///
/// [`SshKeyStore::unload_putty`](ssh_key::SshKeyStore::unload_putty) waits for
/// an `ssh-add -d` subprocess with no deadline of its own, which is right
/// everywhere else -- it runs on the blocking pool there -- and wrong on an
/// exit path: on macOS this runs on the main thread inside
/// `applicationShouldTerminate:`, with the window still on screen. So the
/// removal runs on a thread of its own and this waits only
/// [`UNLOAD_ON_EXIT_TIMEOUT`] for it. Both callers `process::exit` immediately
/// after, which takes the thread and any `ssh-add` still running with them;
/// what is lost in that case is only the removal the TTL would have made
/// anyway.
fn unload_putty_bounded(ssh_key: &std::sync::Arc<ssh_key::SshKeyStore>) {
    let store = std::sync::Arc::clone(ssh_key);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    // A failed spawn leaves the key to the TTL, which is exactly what this
    // whole function degrades to on a timeout.
    if std::thread::Builder::new()
        .spawn(move || {
            store.unload_putty();
            let _ = done_tx.send(());
        })
        .is_err()
    {
        return;
    }
    let _ = done_rx.recv_timeout(UNLOAD_ON_EXIT_TIMEOUT);
}

/// The key store the macOS fast-terminate path takes the session's PuTTY key
/// out of the agent through.
///
/// A global because `applicationShouldTerminate:` is a plain C function with
/// nowhere to put a captured handle and no `AppHandle` of its own to read the
/// managed state from, unlike [`quit`]. Written once, in
/// [`install_fast_terminate`].
#[cfg(target_os = "macos")]
static QUIT_SSH_KEY: std::sync::OnceLock<std::sync::Arc<ssh_key::SshKeyStore>> =
    std::sync::OnceLock::new();

/// Make every AppKit `terminate:` path (Cmd+Q, the Quit menu item, Dock > Quit)
/// exit fast.
///
/// The app-menu's reserved key equivalents (Cmd+Q, Cmd+,) are handled by AppKit
/// itself and never reach our muda menu handler, so Cmd+Q goes straight to
/// `-[NSApplication terminate:]`, whose graceful AppKit + WebKit teardown takes
/// ~15s. `terminate:` first calls the app delegate's
/// `applicationShouldTerminate:`; we replace that method on tao's delegate with
/// one that runs our teardown and `process::exit`s immediately (~0.3s), before
/// the slow unwind begins.
///
/// The shell child is reaped by the kernel closing the PTY master on exit
/// (SIGHUP), so the only context needed here is `ssh_key`: the session's PuTTY
/// key has to come back out of the agent, which a user's own long-lived agent
/// would otherwise hold until its TTL expired. It is taken as a parameter and
/// stashed in [`QUIT_SSH_KEY`] because the replacement method below is a plain
/// C function that can capture nothing. The removal costs a lock and, only when
/// a key really is loaded, one `ssh-add -d` against a live local agent -- and
/// it is bounded by [`unload_putty_bounded`], so this path stays as fast as it
/// was even against an agent that never answers.
#[cfg(target_os = "macos")]
pub fn install_fast_terminate(ssh_key: &std::sync::Arc<ssh_key::SshKeyStore>) {
    use objc2::runtime::{AnyClass, AnyObject, Sel};
    use objc2::sel;
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    extern "C-unwind" fn should_terminate(
        _this: &AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        if let Some(store) = QUIT_SSH_KEY.get() {
            unload_putty_bounded(store);
        }
        ssh_agent::stop_ssh_agent();
        std::process::exit(0);
    }

    let _ = QUIT_SSH_KEY.set(std::sync::Arc::clone(ssh_key));
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else {
        return;
    };
    let obj: &AnyObject = delegate.as_ref();
    let class = obj.class();
    let sel = sel!(applicationShouldTerminate:);
    // NSUInteger return, self, _cmd, id argument.
    let types = c"Q@:@";
    let imp: unsafe extern "C-unwind" fn() = unsafe {
        std::mem::transmute::<
            extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject) -> usize,
            unsafe extern "C-unwind" fn(),
        >(should_terminate)
    };
    unsafe {
        let cls = class as *const _ as *mut AnyClass;
        let added = objc2::ffi::class_addMethod(cls, sel, imp, types.as_ptr());
        if !added.as_bool() {
            objc2::ffi::class_replaceMethod(cls, sel, imp, types.as_ptr());
        }
    }
}

/// Standard base64 alphabet (RFC 4648), matching Node's `Buffer.toString('base64')`.
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode bytes as standard, padded base64 (mirrors `Buffer.toString('base64')`).
pub(crate) fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied();
        let b2 = chunk.get(2).copied();
        let n =
            (u32::from(b0) << 16) | (u32::from(b1.unwrap_or(0)) << 8) | u32::from(b2.unwrap_or(0));
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if b1.is_some() {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if b2.is_some() {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // A byte with the high bit set (PNG magic first byte) round-trips.
        assert_eq!(base64_encode(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
    }
}
