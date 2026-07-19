//! Shell-integration marker protocol (Phase 3, Wave 2).
//!
//! A faithful port of the marker/hook/query/prompt logic in
//! `apps/desktop/src/main/terminal.ts`, reduced to the pieces that operate over
//! the shell's byte stream. The Electron version drove this from a node-pty
//! `EventEmitter` with `setTimeout` timers and per-command promises; here the
//! protocol state machine is a plain struct that consumes decoded output chunks
//! and returns a [`Reaction`] describing the side effects the owning
//! [`manager`](super::manager) must apply (display text, replies to write back
//! into the shell, timers to arm/cancel, and the `needsInput` signal). This keeps
//! every protocol decision a pure, unit-testable function over strings.
//!
//! # What the protocol does
//!
//! * **Hook injection.** POSIX zsh/bash/sh get a one-line `precmd` /
//!   `PROMPT_COMMAND` hook typed into the shell the moment its line editor is
//!   ready (bracketed paste enabled, `ESC[?2004h`). The hook prints an invisible
//!   OSC marker -- `ESC ] 777 ; skk ; <exitCode> BEL` -- before every prompt.
//! * **Marker stripping.** Those markers are removed from the output *before* it
//!   reaches the frontend, their exit codes extracted, and a marker split across
//!   two read chunks is buffered (the "carry") so it is never shown or split.
//! * **Readiness gating.** Bracketed-paste-enable is the "ready for the next
//!   command" signal; two fallback timers ([`HOOK_QUIET_MS`],
//!   [`HOOK_CONFIRM_MS`]) cover shells that never send it or never confirm.
//! * **Self-answered queries.** Color / cursor / device-attribute queries a
//!   prompt sends at startup are answered immediately so an eagerly-started shell
//!   never stalls waiting for a reply.
//! * **Input-prompt detection.** Output matching [`needs_input`] raises the
//!   `needsInput` signal so the UI can surface the terminal for a passphrase.
//!
//! In-shell git execution, `ssh-add`, and the per-command promise plumbing from
//! `terminal.ts` are deliberately NOT ported here -- they land in Wave 3.

/// Fallback (shells without bracketed paste): silence this long => "at prompt".
/// Mirrors `HOOK_QUIET_MS` in `terminal.ts`.
pub const HOOK_QUIET_MS: u64 = 2000;
/// Reveal output / give up on integration if no marker arrives this soon after
/// installing the hook. Mirrors `HOOK_CONFIRM_MS` in `terminal.ts`.
pub const HOOK_CONFIRM_MS: u64 = 3000;

/// Invisible per-prompt marker prefix: `ESC ] 777 ; skk ;`. A full marker is
/// this prefix, one-or-more decimal digits (the exit code), then `BEL`.
pub const MARKER_PREFIX: &str = "\x1b]777;skk;";

/// The `BEL` byte that terminates a marker.
const BEL: u8 = 0x07;
/// The `ESC` byte that opens a marker (and every terminal escape sequence).
const ESC: u8 = 0x1b;

/// Bracketed-paste-enable. The shell emits this exactly when its line editor is
/// ready to read a command at the prompt -- the reliable moment both to install
/// the hook and to release the next command.
const BRACKETED_PASTE_ENABLE: &str = "\x1b[?2004h";

/// True when a chunk contains the bracketed-paste-enable readiness signal.
pub fn is_ready(chunk: &str) -> bool {
    chunk.contains(BRACKETED_PASTE_ENABLE)
}

/// git/ssh output that means the command is blocked waiting for user input.
///
/// Port of `NEEDS_INPUT = /enter passphrase|password:|\(yes\/no|continue
/// connecting/i` in `terminal.ts` -- a case-insensitive substring match against
/// each alternative (no regex crate needed as the alternatives are literals).
pub fn needs_input(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("enter passphrase")
        || lower.contains("password:")
        || lower.contains("(yes/no")
        || lower.contains("continue connecting")
}

/// The one-line hook that makes the shell emit the invisible exit-code marker
/// before every prompt, or `None` for shells we do not integrate with.
///
/// Ported verbatim from `integrationSetup` in `terminal.ts`. The hook runs FIRST
/// (prepended) and restores `$?` so it does not disturb the user's own prompt.
/// It also enables "ignore space" so the space-prefixed commands the app injects
/// stay out of shell history. Windows and unintegrated shells return `None` and
/// take the fallback (no-hook) path.
pub fn integration_setup(shell: &str) -> Option<String> {
    if is_zsh(shell) {
        // `zle_highlight=(paste:none)` stops zsh from showing our
        // bracketed-paste command as an inverse-video "selected" region.
        return Some(
            "setopt hist_ignore_space; zle_highlight=(paste:none); __skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; precmd_functions=(__skk_pc $precmd_functions)"
                .to_string(),
        );
    }
    if is_bash_or_sh(shell) {
        return Some(
            "HISTCONTROL=ignorespace; __skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; PROMPT_COMMAND=\"__skk_pc${PROMPT_COMMAND:+; $PROMPT_COMMAND}\""
                .to_string(),
        );
    }
    None
}

/// Match `terminal.ts` `/(^|\/)zsh$/`: the shell is `zsh` or ends in `/zsh`.
fn is_zsh(shell: &str) -> bool {
    shell == "zsh" || shell.ends_with("/zsh")
}

/// Match `terminal.ts` `/(^|\/)(bash|sh)$/`: `bash`/`sh` or ending `/bash`,
/// `/sh`. (`zsh` is excluded: the char before `sh` there is `z`, not `/`.)
fn is_bash_or_sh(shell: &str) -> bool {
    shell == "bash" || shell.ends_with("/bash") || shell == "sh" || shell.ends_with("/sh")
}

/// Canned replies to the terminal queries a shell/prompt (e.g. starship) sends
/// at startup, in the order and with the exact bytes of `QUERY_REPLIES` in
/// `terminal.ts`. Answering here means an eagerly-started shell reaches its
/// prompt even before any terminal view is mounted, so it never stalls.
pub fn query_replies(chunk: &str) -> Vec<&'static str> {
    let mut out = Vec::new();
    // Foreground color query: ESC ] 10 ; ? (BEL | ST).
    if chunk.contains("\x1b]10;?\x07") || chunk.contains("\x1b]10;?\x1b\\") {
        out.push("\x1b]10;rgb:d4d4/d4d4/d4d4\x07");
    }
    // Background color query.
    if chunk.contains("\x1b]11;?\x07") || chunk.contains("\x1b]11;?\x1b\\") {
        out.push("\x1b]11;rgb:1e1e/1e1e/1e1e\x07");
    }
    // Cursor color query.
    if chunk.contains("\x1b]12;?\x07") || chunk.contains("\x1b]12;?\x1b\\") {
        out.push("\x1b]12;rgb:d4d4/d4d4/d4d4\x07");
    }
    // Cursor position report (ESC [ 6 n).
    if chunk.contains("\x1b[6n") {
        out.push("\x1b[1;1R");
    }
    // Primary device attributes (ESC [ c or ESC [ 0 c).
    if chunk.contains("\x1b[c") || chunk.contains("\x1b[0c") {
        out.push("\x1b[?1;2c");
    }
    out
}

/// A piece of the output stream after marker extraction, in stream order.
///
/// [`scan_markers`] returns these so the caller can interleave "display this
/// text" and "the previous command's exit code arrived" exactly as
/// `terminal.ts` does (a marker mid-chunk reveals hidden output for the text
/// that follows it, but not the text before it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamPiece {
    /// Visible output to display (already marker-free).
    Text(String),
    /// A stripped marker carrying the just-finished command's exit code.
    Marker(i64),
}

/// The result of scanning one chunk (plus any carried-over partial) for markers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanResult {
    /// Text/marker pieces in stream order.
    pub pieces: Vec<StreamPiece>,
    /// A partial marker held back from the end of the chunk (empty when none).
    pub carry: String,
}

impl ScanResult {
    /// The concatenated visible text (test/inspection helper).
    #[cfg(test)]
    pub fn cleaned(&self) -> String {
        let mut s = String::new();
        for piece in &self.pieces {
            if let StreamPiece::Text(t) = piece {
                s.push_str(t);
            }
        }
        s
    }

    /// The exit codes of every stripped marker, in order (test/inspection).
    #[cfg(test)]
    pub fn exit_codes(&self) -> Vec<i64> {
        self.pieces
            .iter()
            .filter_map(|p| match p {
                StreamPiece::Marker(code) => Some(*code),
                StreamPiece::Text(_) => None,
            })
            .collect()
    }
}

/// Strip invisible `ESC]777;skk;<exit>BEL` markers from `carry + chunk`.
///
/// This is the critical correctness piece and a direct port of the marker loop
/// in `handleShellData`. It returns the surviving output split into ordered
/// [`StreamPiece`]s plus a `carry`: the tail of the chunk that *could* be the
/// start of a marker whose `BEL` has not arrived yet. Buffering that tail is what
/// makes a marker split across two `read()` boundaries safe -- it is never shown
/// and never split. The next call prepends the carry, so a marker reassembles.
///
/// Only the final `ESC`-run is considered for the carry (matching `terminal.ts`
/// `lastIndexOf('\x1b')`); complete markers anywhere in the stream are always
/// removed first. All marker bytes (`ESC`, digits, `;`, `BEL`) are ASCII, so the
/// byte indices used here always fall on `char` boundaries.
pub fn scan_markers(carry: &str, chunk: &str) -> ScanResult {
    let stream = format!("{carry}{chunk}");
    let bytes = stream.as_bytes();
    let mut pieces = Vec::new();
    let mut cursor = 0usize;
    let mut i = 0usize;

    // Extract every COMPLETE marker: prefix, one-or-more digits, then BEL.
    while i < bytes.len() {
        // `bytes[i] == ESC` guarantees `i` is a char boundary (ESC is ASCII and
        // never appears inside a multi-byte UTF-8 sequence), so the slice is safe.
        if bytes[i] == ESC && stream[i..].starts_with(MARKER_PREFIX) {
            let after = i + MARKER_PREFIX.len();
            let mut j = after;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if j > after && j < bytes.len() && bytes[j] == BEL {
                if cursor < i {
                    pieces.push(StreamPiece::Text(stream[cursor..i].to_string()));
                }
                let code = stream[after..j].parse::<i64>().unwrap_or(0);
                pieces.push(StreamPiece::Marker(code));
                i = j + 1;
                cursor = i;
                continue;
            }
        }
        i += 1;
    }

    // Hold back a partial marker at the very end so it is never shown or split.
    let mut rest_end = stream.len();
    let mut carry_out = String::new();
    if let Some(rel) = stream[cursor..].rfind('\x1b') {
        let esc = cursor + rel;
        let tail = &stream[esc..];
        let after_prefix = esc + MARKER_PREFIX.len();
        let partial = MARKER_PREFIX.starts_with(tail)
            || (tail.starts_with(MARKER_PREFIX)
                && stream[after_prefix..].bytes().all(|b| b.is_ascii_digit()));
        if partial {
            carry_out = tail.to_string();
            rest_end = esc;
        }
    }
    if cursor < rest_end {
        pieces.push(StreamPiece::Text(stream[cursor..rest_end].to_string()));
    }

    ScanResult {
        pieces,
        carry: carry_out,
    }
}

/// Side effects the protocol asks the owning manager to perform for one input
/// event (a data chunk or a fired timer). Applying it is the manager's job; the
/// state machine itself performs no I/O, so it stays pure and testable.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Reaction {
    /// Marker-free text to display (append to scrollback + emit as `Data`).
    pub display: String,
    /// Bytes to write back into the shell: query replies and/or the hook line.
    pub writes: Vec<String>,
    /// The latest command's exit code, if a marker was seen this event.
    pub exit_code: Option<i64>,
    /// Raise the `needsInput` signal (a passphrase/password/confirm prompt).
    pub request_open: bool,
    /// (Re)arm the quiet timer that installs the hook after a lull.
    pub arm_quiet_timer: bool,
    /// Arm the confirm timer that reveals output if the hook never confirms.
    pub arm_confirm_timer: bool,
    /// Cancel any pending quiet timer.
    pub cancel_quiet_timer: bool,
    /// Cancel any pending confirm timer.
    pub cancel_confirm_timer: bool,
    /// The line editor is ready for the next command (bracketed paste re-enabled
    /// at a prompt). Edge-triggered: set on each ready prompt so the manager can
    /// release a queued in-shell git command (port of `terminal.ts` `markReady`
    /// setting `idle = true` and waking `whenIdle` waiters). Wave 3 consumes it.
    pub mark_ready: bool,
}

/// The per-session shell-integration state machine.
///
/// One instance lives per spawned shell (reset on respawn). Feed it decoded
/// output via [`on_data`](Self::on_data); drive the fallback timers via
/// [`on_quiet_timeout`](Self::on_quiet_timeout) and
/// [`on_confirm_timeout`](Self::on_confirm_timeout). Each returns a [`Reaction`].
#[derive(Debug)]
pub struct ShellIntegration {
    /// Whether this shell is integrated (POSIX zsh/bash/sh); cleared if the hook
    /// never confirms or the shell is unsupported.
    use_integration: bool,
    /// The hook snippet for this shell (`None` for unintegrated shells).
    setup: Option<String>,
    /// True once the hook line has been typed into the shell.
    hook_sent: bool,
    /// True once a marker has proven the hook works.
    confirmed: bool,
    /// Hides output (the hook-install line) until the first marker confirms it.
    hide_hook: bool,
    /// True when the shell is back at a ready prompt (bracketed paste re-enabled).
    /// Read by Wave 3's in-shell command gating; write-only in Wave 2.
    #[allow(dead_code)]
    ready: bool,
    /// Leftover bytes of a marker split across data chunks.
    carry: String,
    /// Debounces the `needsInput` signal to once per prompt (reset on ready).
    input_signaled: bool,
}

impl ShellIntegration {
    /// Build the state machine for `shell` (the shell executable path/name).
    pub fn new(shell: &str) -> Self {
        let setup = integration_setup(shell);
        Self {
            use_integration: setup.is_some(),
            setup,
            hook_sent: false,
            confirmed: false,
            hide_hook: false,
            ready: false,
            carry: String::new(),
            input_signaled: false,
        }
    }

    /// Whether this shell takes the integrated (in-shell hook) path. Consumed by
    /// Wave 3 to choose between in-shell and arg-array git execution.
    #[allow(dead_code)]
    pub fn use_integration(&self) -> bool {
        self.use_integration
    }

    /// Process one decoded output chunk (port of `handleShellData`).
    pub fn on_data(&mut self, chunk: &str) -> Reaction {
        let mut r = Reaction::default();

        // 1. Reply to any terminal queries so an eager shell never stalls.
        for reply in query_replies(chunk) {
            r.writes.push(reply.to_string());
        }

        // 2. Bracketed-paste-enable is the reliable "ready" moment: both when to
        //    install the hook and when to release the next command. A mid-startup
        //    lull is NOT ready (input would be lost), so the quiet timer is only
        //    a fallback.
        let ready = is_ready(chunk);
        // A fresh ready prompt re-arms the `needsInput` debounce so the next
        // command that blocks can raise the signal again (this happens for both
        // integrated and unintegrated shells, so it is not tied to the hook).
        if ready {
            self.input_signaled = false;
        }
        let mut just_installed = false;
        if self.use_integration && !self.hook_sent {
            if ready {
                self.install_hook(&mut r);
                just_installed = true;
            } else {
                r.arm_quiet_timer = true;
            }
        }

        // 3. Strip markers (carrying a partial across the chunk boundary) and
        //    replay the surviving pieces in order so a mid-chunk marker reveals
        //    hidden output only for the text that follows it.
        let scan = scan_markers(&self.carry, chunk);
        self.carry = scan.carry;
        for piece in scan.pieces {
            match piece {
                StreamPiece::Text(t) => self.show(&t, &mut r),
                StreamPiece::Marker(code) => self.on_marker(code, &mut r),
            }
        }

        // 4. Release the next command only once the shell is back at a ready
        //    prompt -- never on the same chunk that just installed the hook
        //    (it is still running it).
        if ready && self.hook_sent && !just_installed {
            self.mark_ready(&mut r);
        }

        r
    }

    /// The quiet timer fired: install the hook even though bracketed paste never
    /// appeared (fallback for shells without a line editor).
    pub fn on_quiet_timeout(&mut self) -> Reaction {
        let mut r = Reaction::default();
        if self.use_integration && !self.hook_sent {
            self.install_hook(&mut r);
        }
        r
    }

    /// The confirm timer fired: if no marker proved the hook works, reveal any
    /// hidden output and abandon integration so nothing stays hidden forever.
    pub fn on_confirm_timeout(&mut self) -> Reaction {
        let r = Reaction::default();
        if self.confirmed {
            return r; // a marker already proved the hook works
        }
        self.hide_hook = false;
        self.use_integration = false;
        r
    }

    /// Display shell output, dropping only the hidden hook-install line and
    /// raising `needsInput` on a blocking prompt (port of `show`).
    fn show(&mut self, text: &str, r: &mut Reaction) {
        if text.is_empty() || self.hide_hook {
            return;
        }
        if !self.input_signaled && needs_input(text) {
            self.input_signaled = true;
            r.request_open = true;
        }
        r.display.push_str(text);
    }

    /// The just-finished command's exit code arrived (port of `onMarker`).
    fn on_marker(&mut self, code: i64, r: &mut Reaction) {
        self.confirmed = true;
        self.hide_hook = false;
        r.exit_code = Some(code);
        r.cancel_confirm_timer = true;
    }

    /// Type the hook once, hide its line, and arm the confirm timeout (port of
    /// `installHook`). The leading space keeps the hook line out of history.
    fn install_hook(&mut self, r: &mut Reaction) {
        if self.hook_sent {
            return;
        }
        let Some(setup) = self.setup.clone() else {
            self.use_integration = false;
            return;
        };
        self.hook_sent = true;
        self.hide_hook = true;
        r.cancel_quiet_timer = true;
        r.writes.push(format!(" {setup}\r"));
        // If the marker never comes, the hook did not take: reveal output and
        // abandon integration so git never hangs on a missing marker.
        r.arm_confirm_timer = true;
    }

    /// The line editor is ready for the next command (bracketed paste re-enabled).
    /// This -- not the earlier precmd marker -- is when the next command may be
    /// typed. Edge-triggered: it also raises [`Reaction::mark_ready`] so the
    /// manager releases the next queued in-shell git command.
    fn mark_ready(&mut self, r: &mut Reaction) {
        self.ready = true;
        r.mark_ready = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- marker stripping ------------------------------------------------

    #[test]
    fn no_marker_passes_through_unchanged() {
        let scan = scan_markers("", "hello world");
        assert_eq!(scan.cleaned(), "hello world");
        assert!(scan.exit_codes().is_empty());
        assert_eq!(scan.carry, "");
    }

    #[test]
    fn single_marker_is_stripped_and_exit_code_extracted() {
        let scan = scan_markers("", "before\x1b]777;skk;0\x07after");
        assert_eq!(scan.cleaned(), "beforeafter");
        assert_eq!(scan.exit_codes(), vec![0]);
        assert_eq!(scan.carry, "");
    }

    #[test]
    fn multiple_markers_in_one_chunk_are_all_stripped() {
        let scan = scan_markers("", "\x1b]777;skk;0\x07mid\x1b]777;skk;1\x07tail");
        assert_eq!(scan.cleaned(), "midtail");
        assert_eq!(scan.exit_codes(), vec![0, 1]);
        assert_eq!(scan.carry, "");
    }

    #[test]
    fn nonzero_exit_code_is_extracted() {
        let scan = scan_markers("", "\x1b]777;skk;130\x07");
        assert_eq!(scan.cleaned(), "");
        assert_eq!(scan.exit_codes(), vec![130]);
    }

    #[test]
    fn marker_split_after_digits_is_carried_then_completed() {
        // First chunk ends mid-marker (prefix + digits, no BEL yet).
        let first = scan_markers("", "out\x1b]777;skk;12");
        assert_eq!(first.cleaned(), "out");
        assert!(first.exit_codes().is_empty());
        assert_eq!(first.carry, "\x1b]777;skk;12");

        // Second chunk supplies the BEL; the marker reassembles from the carry.
        let second = scan_markers(&first.carry, "\x07next");
        assert_eq!(second.cleaned(), "next");
        assert_eq!(second.exit_codes(), vec![12]);
        assert_eq!(second.carry, "");
    }

    #[test]
    fn marker_split_inside_the_prefix_is_carried() {
        // Boundary falls in the middle of the OSC prefix bytes.
        let first = scan_markers("", "foo\x1b]777");
        assert_eq!(first.cleaned(), "foo");
        assert_eq!(first.carry, "\x1b]777");

        let second = scan_markers(&first.carry, ";skk;5\x07bar");
        assert_eq!(second.cleaned(), "bar");
        assert_eq!(second.exit_codes(), vec![5]);
    }

    #[test]
    fn bare_prefix_with_no_digits_is_carried_not_shown() {
        let scan = scan_markers("", "\x1b]777;skk;");
        assert_eq!(scan.cleaned(), "");
        assert!(scan.exit_codes().is_empty());
        assert_eq!(scan.carry, "\x1b]777;skk;");
    }

    #[test]
    fn marker_exactly_at_the_buffer_boundary_never_leaks() {
        // Feed the whole marker one byte at a time; nothing may be displayed
        // until the terminating BEL arrives, and no marker byte may leak.
        let full = "A\x1b]777;skk;7\x07B";
        let mut carry = String::new();
        let mut shown = String::new();
        let mut codes = Vec::new();
        for ch in full.chars() {
            let mut buf = [0u8; 4];
            let piece = ch.encode_utf8(&mut buf);
            let scan = scan_markers(&carry, piece);
            shown.push_str(&scan.cleaned());
            codes.extend(scan.exit_codes());
            carry = scan.carry;
        }
        assert_eq!(shown, "AB");
        assert_eq!(codes, vec![7]);
        assert!(!shown.contains('\x1b'));
        assert_eq!(carry, "");
    }

    #[test]
    fn non_marker_escape_sequence_is_not_held_back() {
        // A colour SGR ends the chunk; it is not a marker so it is shown, not
        // carried (mirrors terminal.ts only holding back a real marker prefix).
        let scan = scan_markers("", "text\x1b[0m");
        assert_eq!(scan.cleaned(), "text\x1b[0m");
        assert_eq!(scan.carry, "");
    }

    #[test]
    fn marker_followed_by_partial_marker_carries_the_partial() {
        let scan = scan_markers("", "a\x1b]777;skk;0\x07b\x1b]777;skk;9");
        assert_eq!(scan.cleaned(), "ab");
        assert_eq!(scan.exit_codes(), vec![0]);
        assert_eq!(scan.carry, "\x1b]777;skk;9");
    }

    // ---- readiness detection --------------------------------------------

    #[test]
    fn bracketed_paste_enable_is_detected_as_ready() {
        assert!(is_ready("prompt \x1b[?2004h"));
    }

    #[test]
    fn bracketed_paste_disable_is_not_ready() {
        assert!(!is_ready("\x1b[?2004l"));
    }

    #[test]
    fn plain_output_is_not_ready() {
        assert!(!is_ready("just some output"));
    }

    // ---- query auto-replies ---------------------------------------------

    #[test]
    fn foreground_color_query_with_bel_is_answered() {
        assert_eq!(
            query_replies("\x1b]10;?\x07"),
            vec!["\x1b]10;rgb:d4d4/d4d4/d4d4\x07"]
        );
    }

    #[test]
    fn foreground_color_query_with_st_terminator_is_answered() {
        assert_eq!(
            query_replies("\x1b]10;?\x1b\\"),
            vec!["\x1b]10;rgb:d4d4/d4d4/d4d4\x07"]
        );
    }

    #[test]
    fn background_and_cursor_color_queries_are_answered() {
        assert_eq!(
            query_replies("\x1b]11;?\x07"),
            vec!["\x1b]11;rgb:1e1e/1e1e/1e1e\x07"]
        );
        assert_eq!(
            query_replies("\x1b]12;?\x07"),
            vec!["\x1b]12;rgb:d4d4/d4d4/d4d4\x07"]
        );
    }

    #[test]
    fn cursor_position_report_is_answered() {
        assert_eq!(query_replies("\x1b[6n"), vec!["\x1b[1;1R"]);
    }

    #[test]
    fn primary_device_attributes_query_is_answered_both_forms() {
        assert_eq!(query_replies("\x1b[c"), vec!["\x1b[?1;2c"]);
        assert_eq!(query_replies("\x1b[0c"), vec!["\x1b[?1;2c"]);
    }

    #[test]
    fn multiple_queries_in_one_chunk_are_all_answered_in_order() {
        let replies = query_replies("\x1b]11;?\x07\x1b[6n\x1b[c");
        assert_eq!(
            replies,
            vec!["\x1b]11;rgb:1e1e/1e1e/1e1e\x07", "\x1b[1;1R", "\x1b[?1;2c"]
        );
    }

    #[test]
    fn no_query_yields_no_reply() {
        assert!(query_replies("ordinary output\r\n").is_empty());
    }

    // ---- needsInput regex ------------------------------------------------

    #[test]
    fn needs_input_matches_passphrase_prompt() {
        assert!(needs_input(
            "Enter passphrase for key '/home/u/.ssh/id_ed25519':"
        ));
    }

    #[test]
    fn needs_input_matches_password_prompt_case_insensitively() {
        assert!(needs_input("Password: "));
        assert!(needs_input("user@host's password:"));
    }

    #[test]
    fn needs_input_matches_yes_no_prompt() {
        assert!(needs_input(
            "The authenticity of host ... (yes/no/[fingerprint])?"
        ));
    }

    #[test]
    fn needs_input_matches_continue_connecting_prompt() {
        assert!(needs_input(
            "Are you sure you want to continue connecting (yes/no)?"
        ));
    }

    #[test]
    fn needs_input_ignores_ordinary_output() {
        assert!(!needs_input("Cloning into 'repo'..."));
        assert!(!needs_input("password strength: strong")); // no trailing colon
        assert!(!needs_input("please pass the salt"));
        assert!(!needs_input(""));
    }

    // ---- hook snippets ---------------------------------------------------

    #[test]
    fn zsh_hook_matches_terminal_ts_verbatim() {
        let setup = integration_setup("/usr/bin/zsh").expect("zsh is integrated");
        assert_eq!(
            setup,
            "setopt hist_ignore_space; zle_highlight=(paste:none); __skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; precmd_functions=(__skk_pc $precmd_functions)"
        );
    }

    #[test]
    fn bash_hook_matches_terminal_ts_verbatim() {
        let setup = integration_setup("/bin/bash").expect("bash is integrated");
        assert_eq!(
            setup,
            "HISTCONTROL=ignorespace; __skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; PROMPT_COMMAND=\"__skk_pc${PROMPT_COMMAND:+; $PROMPT_COMMAND}\""
        );
    }

    #[test]
    fn sh_uses_the_bash_family_hook() {
        assert_eq!(integration_setup("/bin/sh"), integration_setup("/bin/bash"));
        assert_eq!(integration_setup("sh"), integration_setup("bash"));
    }

    #[test]
    fn bare_shell_names_are_recognized() {
        assert!(integration_setup("zsh").is_some());
        assert!(integration_setup("bash").is_some());
    }

    #[test]
    fn unintegrated_shells_have_no_hook() {
        assert!(integration_setup("powershell.exe").is_none());
        assert!(integration_setup("C:\\Windows\\System32\\cmd.exe").is_none());
        assert!(integration_setup("/usr/bin/fish").is_none());
        // Not a suffix-boundary match for zsh/sh.
        assert!(integration_setup("/opt/myzsh").is_none());
    }

    // ---- ShellIntegration state machine ---------------------------------

    #[test]
    fn integrated_shell_installs_hook_on_ready() {
        let mut si = ShellIntegration::new("/bin/bash");
        assert!(si.use_integration());
        let r = si.on_data("\x1b[?2004h");
        // The hook line is written with a leading space and trailing CR.
        assert!(r.writes.iter().any(|w| w.starts_with(' ')
            && w.contains("HISTCONTROL=ignorespace")
            && w.ends_with('\r')));
        assert!(r.arm_confirm_timer);
        assert!(r.cancel_quiet_timer);
    }

    #[test]
    fn hook_install_line_and_output_hidden_until_a_marker_confirms() {
        let mut si = ShellIntegration::new("/bin/bash");
        si.on_data("\x1b[?2004h"); // installs hook, hides output
        let hidden = si.on_data("noisy startup output");
        assert_eq!(hidden.display, "", "output stays hidden before confirm");
        // A marker reveals subsequent output and yields the exit code.
        let revealed = si.on_data("\x1b]777;skk;0\x07visible");
        assert_eq!(revealed.display, "visible");
        assert_eq!(revealed.exit_code, Some(0));
        assert!(revealed.cancel_confirm_timer);
    }

    #[test]
    fn unintegrated_shell_never_installs_a_hook_but_still_shows_output() {
        let mut si = ShellIntegration::new("powershell.exe");
        assert!(!si.use_integration());
        let r = si.on_data("PS C:\\> ");
        assert!(r.writes.is_empty());
        assert!(!r.arm_quiet_timer);
        assert_eq!(r.display, "PS C:\\> ");
    }

    #[test]
    fn non_ready_chunk_arms_the_quiet_fallback_timer() {
        let mut si = ShellIntegration::new("/bin/bash");
        let r = si.on_data("still starting up");
        assert!(r.arm_quiet_timer);
        assert!(!r.cancel_quiet_timer);
    }

    #[test]
    fn quiet_timeout_installs_the_hook_as_a_fallback() {
        let mut si = ShellIntegration::new("/bin/bash");
        si.on_data("no bracketed paste here");
        let r = si.on_quiet_timeout();
        assert!(r
            .writes
            .iter()
            .any(|w| w.contains("HISTCONTROL=ignorespace")));
    }

    #[test]
    fn confirm_timeout_reveals_and_abandons_integration_without_a_marker() {
        let mut si = ShellIntegration::new("/bin/bash");
        si.on_data("\x1b[?2004h"); // hook installed, hide_hook set
        let r = si.on_confirm_timeout();
        assert_eq!(r, Reaction::default());
        assert!(!si.use_integration());
        // Output is no longer hidden.
        let after = si.on_data("visible now");
        assert_eq!(after.display, "visible now");
    }

    #[test]
    fn confirm_timeout_is_a_noop_once_a_marker_confirmed_the_hook() {
        let mut si = ShellIntegration::new("/bin/bash");
        si.on_data("\x1b[?2004h");
        si.on_data("\x1b]777;skk;0\x07"); // confirms
        let r = si.on_confirm_timeout();
        assert_eq!(r, Reaction::default());
        assert!(si.use_integration(), "integration remains enabled");
    }

    #[test]
    fn needs_input_signal_is_raised_once_per_prompt() {
        let mut si = ShellIntegration::new("powershell.exe"); // no hook to hide
        let first = si.on_data("Enter passphrase for key:");
        assert!(first.request_open);
        // A second matching chunk before a new prompt does not re-signal.
        let again = si.on_data("password: ");
        assert!(!again.request_open);
        // A new ready prompt re-arms the signal.
        si.on_data("\x1b[?2004h");
        let next = si.on_data("password: ");
        assert!(next.request_open);
    }

    #[test]
    fn mark_ready_fires_on_the_prompt_after_the_hook_not_on_install() {
        let mut si = ShellIntegration::new("/bin/bash");
        // First ready installs the hook; the shell is still running it, so the
        // next command must NOT be released yet.
        let install = si.on_data("\x1b[?2004h");
        assert!(!install.mark_ready, "no release on the hook-install chunk");
        // A marker confirms the hook; still not a fresh ready prompt.
        let confirm = si.on_data("\x1b]777;skk;0\x07");
        assert!(!confirm.mark_ready);
        // The next bracketed-paste-enable is the ready prompt: release now.
        let ready = si.on_data("\x1b[?2004h");
        assert!(ready.mark_ready, "release on the prompt after the hook");
    }

    #[test]
    fn unintegrated_shell_never_marks_ready() {
        let mut si = ShellIntegration::new("powershell.exe");
        let r = si.on_data("\x1b[?2004h");
        assert!(!r.mark_ready, "no in-shell command gating without a hook");
    }

    #[test]
    fn carry_persists_across_on_data_calls() {
        let mut si = ShellIntegration::new("powershell.exe");
        let first = si.on_data("done\x1b]777;skk;3");
        assert_eq!(first.display, "done");
        assert_eq!(first.exit_code, None);
        let second = si.on_data("\x07");
        assert_eq!(second.exit_code, Some(3));
        assert_eq!(second.display, "");
    }
}
