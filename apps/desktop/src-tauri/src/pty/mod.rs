//! PTY-backed interactive terminal (Phase 3, Wave 1).
//!
//! A port of the Electron `apps/desktop/src/main/terminal.ts` session: spawn a
//! persistent login shell over a pseudo-terminal, stream its output to the
//! frontend, retain a bounded rolling scrollback for re-attaching renderers, and
//! auto-restart the shell if it exits. Wave 2 adds the shell-integration marker
//! protocol ([`shell_integration`]): the invisible per-prompt exit-code marker is
//! stripped before output reaches the frontend, terminal queries are
//! self-answered, and blocking input prompts raise a `needsInput` signal.
//! Wave 3 adds in-shell git execution and `ssh-add` ([`git_in_shell`]): the
//! app's git runs in the interactive shell (or as its own PTY on
//! Windows/unintegrated shells), serialised so calls never interleave.
//!
//! This module holds the pure, unit-testable pieces (shell selection and the
//! scrollback ring); [`manager`] holds the thread-owning [`TerminalManager`];
//! [`shell_integration`] holds the Wave 2 marker/hook/query protocol;
//! [`git_in_shell`] holds the Wave 3 quoting/framing/queue helpers.

pub mod git_in_shell;
pub mod manager;
pub mod shell_integration;

pub use manager::TerminalManager;

/// Retained scrollback cap, in bytes. Mirrors `MAX_BUFFER` in `terminal.ts`.
pub const MAX_BUFFER: usize = 256 * 1024;

/// The program + arguments used to launch the interactive shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellSpec {
    /// The shell executable (an absolute path or a bare name resolved via PATH).
    pub program: String,
    /// Launch arguments (POSIX uses `-l` for a login shell; Windows uses none).
    pub args: Vec<String>,
}

/// Choose the login shell for the host, mirroring `terminal.ts` `defaultShell`
/// and its `-l` argument choice.
///
/// * Windows (`platform == "win32"`): `%COMSPEC%`, else `powershell.exe`, with
///   no arguments.
/// * POSIX: `$SHELL`, else `/bin/bash`, launched as a login shell (`-l`).
///
/// `comspec` and `shell` are the raw values of the `COMSPEC` and `SHELL`
/// environment variables (`None` when unset); passing them in keeps this a pure
/// function that is trivial to test per platform.
pub fn resolve_shell(platform: &str, comspec: Option<&str>, shell: Option<&str>) -> ShellSpec {
    if platform == "win32" {
        let program = non_empty(comspec).unwrap_or("powershell.exe").to_string();
        ShellSpec {
            program,
            args: Vec::new(),
        }
    } else {
        let program = non_empty(shell).unwrap_or("/bin/bash").to_string();
        ShellSpec {
            program,
            args: vec!["-l".to_string()],
        }
    }
}

/// Return the value only when it is present and not blank.
fn non_empty(value: Option<&str>) -> Option<&str> {
    match value {
        Some(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// A bounded rolling scrollback buffer.
///
/// Bytes are appended as they stream from the shell; once the buffer exceeds its
/// cap it is trimmed from the front (oldest output is dropped), matching the
/// `this.buffer.slice(-MAX_BUFFER)` behaviour in `terminal.ts`. Storage is raw
/// bytes so the cap is an exact byte budget; a snapshot decodes lossily, so a
/// multi-byte sequence clipped by a front trim degrades to a replacement
/// character rather than corrupting the stream.
#[derive(Debug)]
pub struct Scrollback {
    buf: Vec<u8>,
    cap: usize,
}

impl Scrollback {
    /// Create an empty scrollback bounded to `cap` bytes.
    pub fn new(cap: usize) -> Self {
        Self {
            buf: Vec::new(),
            cap,
        }
    }

    /// Append a chunk, trimming the front so the buffer never exceeds the cap.
    pub fn append(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
        if self.buf.len() > self.cap {
            let drop = self.buf.len() - self.cap;
            self.buf.drain(..drop);
        }
    }

    /// Decode the retained bytes to a string for replay (lossy, see the type
    /// docs).
    pub fn snapshot(&self) -> String {
        String::from_utf8_lossy(&self.buf).into_owned()
    }

    /// Drop all retained output.
    pub fn clear(&mut self) {
        self.buf.clear();
    }

    /// The number of retained bytes (test/inspection helper).
    #[cfg(test)]
    pub fn byte_len(&self) -> usize {
        self.buf.len()
    }
}

/// An event produced by the reader thread, pumped to the frontend in
/// `lib.rs` setup as a `terminal:data` / `terminal:exit` Tauri event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    /// A chunk of shell output (already decoded to a string).
    Data(String),
    /// The shell process exited (a restart follows unless disposing).
    Exit,
    /// The shell is blocked waiting for user input (a passphrase/password/
    /// confirm prompt was detected). The frontend should surface the terminal.
    RequestOpen,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_uses_shell_env_with_login_flag() {
        let spec = resolve_shell("linux", None, Some("/usr/bin/zsh"));
        assert_eq!(spec.program, "/usr/bin/zsh");
        assert_eq!(spec.args, vec!["-l".to_string()]);
    }

    #[test]
    fn posix_falls_back_to_bin_bash() {
        let spec = resolve_shell("darwin", None, None);
        assert_eq!(spec.program, "/bin/bash");
        assert_eq!(spec.args, vec!["-l".to_string()]);
    }

    #[test]
    fn posix_ignores_blank_shell() {
        let spec = resolve_shell("linux", None, Some("   "));
        assert_eq!(spec.program, "/bin/bash");
    }

    #[test]
    fn windows_uses_comspec_without_args() {
        let spec = resolve_shell("win32", Some("C:\\Windows\\System32\\cmd.exe"), None);
        assert_eq!(spec.program, "C:\\Windows\\System32\\cmd.exe");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn windows_falls_back_to_powershell() {
        let spec = resolve_shell("win32", None, Some("/bin/bash"));
        assert_eq!(spec.program, "powershell.exe");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn scrollback_retains_short_output_verbatim() {
        let mut sb = Scrollback::new(MAX_BUFFER);
        sb.append(b"hello");
        sb.append(b" world");
        assert_eq!(sb.snapshot(), "hello world");
        assert_eq!(sb.byte_len(), 11);
    }

    #[test]
    fn scrollback_trims_from_the_front_at_the_cap() {
        let mut sb = Scrollback::new(4);
        sb.append(b"abcdef");
        // Only the last 4 bytes survive.
        assert_eq!(sb.byte_len(), 4);
        assert_eq!(sb.snapshot(), "cdef");
    }

    #[test]
    fn scrollback_trims_across_multiple_appends() {
        let mut sb = Scrollback::new(8);
        for _ in 0..10 {
            sb.append(b"XY");
        }
        assert_eq!(sb.byte_len(), 8);
        assert_eq!(sb.snapshot(), "XYXYXYXY");
    }

    #[test]
    fn scrollback_enforces_the_256k_byte_cap() {
        let mut sb = Scrollback::new(MAX_BUFFER);
        let chunk = vec![b'a'; 100 * 1024];
        for _ in 0..5 {
            sb.append(&chunk);
        }
        // 500 KB written, capped at 256 KB.
        assert_eq!(sb.byte_len(), MAX_BUFFER);
    }

    #[test]
    fn scrollback_clear_empties_the_buffer() {
        let mut sb = Scrollback::new(MAX_BUFFER);
        sb.append(b"data");
        sb.clear();
        assert_eq!(sb.byte_len(), 0);
        assert_eq!(sb.snapshot(), "");
    }

    #[test]
    fn scrollback_snapshot_is_lossy_on_a_clipped_multibyte_sequence() {
        let mut sb = Scrollback::new(3);
        // A 2-byte 'e-acute' whose lead byte is clipped by the front trim.
        sb.append(&[0xc3, 0xa9, b'x', b'y']);
        assert_eq!(sb.byte_len(), 3);
        // The dangling continuation byte decodes to the replacement char.
        assert!(sb.snapshot().contains('\u{fffd}'));
    }
}
