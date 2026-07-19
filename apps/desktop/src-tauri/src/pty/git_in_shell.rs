//! In-shell git execution helpers (Phase 3, Wave 3).
//!
//! A faithful port of the git-through-shell, standalone-git-process, command
//! queue, and `ssh-add` logic in `apps/desktop/src/main/terminal.ts`. This
//! module holds the *pure* pieces -- POSIX quoting, git command-line assembly,
//! bracketed-paste framing, the `ssh-add` command string, and the serialising
//! command queue -- so every decision is unit-testable without a live PTY. The
//! stateful methods that drive a real shell (`run_git`, `run_git_in_shell`,
//! `run_git_process`, `run_ssh_add`) live on
//! [`TerminalManager`](super::manager::TerminalManager), which owns the PTY
//! handles these helpers feed.

use std::sync::Mutex;

/// Bracketed-paste-enable prefix. Inserting a command between this and
/// [`PASTE_END`] makes the shell take the whole line at once (no char-by-char
/// echo / syntax-highlight redraw that can drop a glyph under rapid queuing).
pub const PASTE_BEGIN: &str = "\x1b[200~";
/// Bracketed-paste-disable suffix.
pub const PASTE_END: &str = "\x1b[201~";

/// POSIX single-quote escape: wraps in `'...'` and turns every embedded `'`
/// into `'\''`. Verbatim port of `shq` in `terminal.ts`:
///
/// ```text
/// `'${value.replace(/'/g, "'\\''")}'`
/// ```
///
/// Wrapping in single quotes makes every other shell metacharacter literal, so
/// URLs/paths cannot inject shell operators; the `'\''` dance is the only way to
/// embed a literal single quote inside a single-quoted string.
pub fn shq(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for ch in value.chars() {
        if ch == '\'' {
            // Close the quote, emit an escaped quote, reopen: '\''
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Assemble the shell-escaped `git -C <dir> <args...>` command line, matching
/// `terminal.ts`:
///
/// ```text
/// [shq(gitPath), '-C', shq(cwd), ...args.map(shq)].join(' ')
/// ```
///
/// `git -C <dir>` runs in the repo directly (no `cd`/subshell), so the line
/// carries no shell operators of its own.
pub fn git_command_line(git: &str, dir: &str, args: &[String]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 3);
    parts.push(shq(git));
    parts.push("-C".to_string());
    parts.push(shq(dir));
    for arg in args {
        parts.push(shq(arg));
    }
    parts.join(" ")
}

/// Wrap a command in bracketed paste with the leading space + trailing CR,
/// matching `terminal.ts`:
///
/// ```text
/// `\x1b[200~ ${command}\x1b[201~\r`
/// ```
///
/// The leading space keeps the line out of history (`hist_ignore_space`); the
/// trailing CR runs it. The `200~`/`201~` wrappers are consumed (not shown)
/// because the command is only typed once the shell has re-enabled bracketed
/// paste at a ready prompt.
pub fn wrap_bracketed_paste(command: &str) -> String {
    format!("{PASTE_BEGIN} {command}{PASTE_END}\r")
}

/// The `ssh-add` line to type into the interactive shell, matching
/// `terminal.ts`: macOS uses `--apple-use-keychain`, everything else is bare
/// `ssh-add`. The leading space keeps it out of history; the trailing CR runs
/// it.
pub fn ssh_add_command(is_macos: bool) -> &'static str {
    if is_macos {
        " ssh-add --apple-use-keychain\r"
    } else {
        " ssh-add\r"
    }
}

/// Serialises git operations so concurrent `run_git` calls never interleave
/// (port of the `queue`/`whenIdle` promise chain in `terminal.ts`, which ran
/// each git command strictly after the previous one settled).
///
/// The Electron version chained promises on a single JS thread; here the same
/// "one at a time" guarantee is a mutex held for the whole duration of a git
/// op. A caller entering [`run`](Self::run) blocks until any in-flight op has
/// finished, so their shell writes and marker waits can never interleave with
/// another op's.
#[derive(Debug, Default)]
pub struct GitQueue {
    lock: Mutex<()>,
}

impl GitQueue {
    /// A fresh, idle queue.
    pub fn new() -> Self {
        Self {
            lock: Mutex::new(()),
        }
    }

    /// Run `f` with exclusive access, blocking until any prior op has finished.
    /// The guard is released when `f` returns, admitting the next waiter.
    pub fn run<F, R>(&self, f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let _guard = self.lock.lock().expect("git queue lock poisoned");
        f()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    // ---- shq: POSIX single-quote escaping --------------------------------

    #[test]
    fn shq_wraps_a_plain_value_in_single_quotes() {
        assert_eq!(shq("status"), "'status'");
    }

    #[test]
    fn shq_of_the_empty_string_is_a_pair_of_quotes() {
        assert_eq!(shq(""), "''");
    }

    #[test]
    fn shq_preserves_spaces_inside_the_quotes() {
        assert_eq!(shq("a b c"), "'a b c'");
        assert_eq!(shq("/path/with spaces/repo"), "'/path/with spaces/repo'");
    }

    #[test]
    fn shq_escapes_a_single_quote_with_the_close_escape_reopen_dance() {
        // Matches JS: "it's".replace(/'/g, "'\\''") wrapped -> 'it'\''s'
        assert_eq!(shq("it's"), "'it'\\''s'");
    }

    #[test]
    fn shq_escapes_multiple_single_quotes() {
        assert_eq!(shq("'a'"), "''\\''a'\\'''");
    }

    #[test]
    fn shq_of_a_lone_single_quote() {
        assert_eq!(shq("'"), "''\\'''");
    }

    #[test]
    fn shq_leaves_other_shell_metacharacters_literal_inside_quotes() {
        // None of these are special inside single quotes, so they pass through.
        assert_eq!(shq("a;b&c|d"), "'a;b&c|d'");
        assert_eq!(shq("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(shq("a`b`c"), "'a`b`c'");
        assert_eq!(shq("a\\b"), "'a\\b'");
        assert_eq!(shq("a\"b"), "'a\"b'");
        assert_eq!(shq("*.txt"), "'*.txt'");
        assert_eq!(shq("~/x > /dev/null"), "'~/x > /dev/null'");
        assert_eq!(shq("a\nb"), "'a\nb'");
    }

    #[test]
    fn shq_handles_a_realistic_repo_url() {
        assert_eq!(
            shq("https://example.com/o'brien/repo.git"),
            "'https://example.com/o'\\''brien/repo.git'"
        );
    }

    // ---- git command-line assembly ---------------------------------------

    #[test]
    fn git_command_line_quotes_git_dir_and_each_arg() {
        let args = vec!["status".to_string(), "--short".to_string()];
        assert_eq!(
            git_command_line("git", "/repos/x", &args),
            "'git' -C '/repos/x' 'status' '--short'"
        );
    }

    #[test]
    fn git_command_line_with_no_args_is_just_git_dash_c_dir() {
        assert_eq!(git_command_line("git", "/r", &[]), "'git' -C '/r'");
    }

    #[test]
    fn git_command_line_escapes_a_url_arg_with_a_quote() {
        let args = vec![
            "clone".to_string(),
            "https://h/o'brien.git".to_string(),
            "/dest dir".to_string(),
        ];
        assert_eq!(
            git_command_line("/usr/bin/git", "/work", &args),
            "'/usr/bin/git' -C '/work' 'clone' 'https://h/o'\\''brien.git' '/dest dir'"
        );
    }

    #[test]
    fn git_command_line_leaves_dash_c_flag_unquoted() {
        // The literal `-C` is our own token, not user input, so it is bare.
        let line = git_command_line("git", "/r", &["log".to_string()]);
        assert!(line.contains(" -C "));
    }

    // ---- bracketed-paste framing -----------------------------------------

    #[test]
    fn wrap_bracketed_paste_frames_with_space_and_cr() {
        assert_eq!(
            wrap_bracketed_paste("'git' -C '/r' 'status'"),
            "\x1b[200~ 'git' -C '/r' 'status'\x1b[201~\r"
        );
    }

    #[test]
    fn wrap_bracketed_paste_begins_with_paste_enable_and_a_space() {
        let framed = wrap_bracketed_paste("x");
        assert!(framed.starts_with("\x1b[200~ "));
    }

    #[test]
    fn wrap_bracketed_paste_ends_with_paste_disable_then_cr() {
        let framed = wrap_bracketed_paste("x");
        assert!(framed.ends_with("\x1b[201~\r"));
    }

    #[test]
    fn framed_git_command_matches_terminal_ts_verbatim() {
        // End-to-end of the two pure steps for `git -C /r status`.
        let line = git_command_line("git", "/r", &["status".to_string()]);
        assert_eq!(
            wrap_bracketed_paste(&line),
            "\x1b[200~ 'git' -C '/r' 'status'\x1b[201~\r"
        );
    }

    // ---- ssh-add command -------------------------------------------------

    #[test]
    fn ssh_add_command_on_macos_uses_the_keychain_flag() {
        assert_eq!(ssh_add_command(true), " ssh-add --apple-use-keychain\r");
    }

    #[test]
    fn ssh_add_command_off_macos_is_bare_ssh_add() {
        assert_eq!(ssh_add_command(false), " ssh-add\r");
    }

    #[test]
    fn ssh_add_command_is_space_prefixed_and_cr_terminated() {
        for cmd in [ssh_add_command(true), ssh_add_command(false)] {
            assert!(
                cmd.starts_with(' '),
                "leading space keeps it out of history"
            );
            assert!(cmd.ends_with('\r'), "trailing CR runs it");
        }
    }

    // ---- command queue: serialisation / ordering -------------------------

    #[test]
    fn queue_runs_a_single_closure_and_returns_its_value() {
        let q = GitQueue::new();
        assert_eq!(q.run(|| 6 * 7), 42);
    }

    #[test]
    fn queue_preserves_call_order_on_one_thread() {
        // Logical ordering: sequential calls run in the order issued.
        let q = GitQueue::new();
        let mut order = Vec::new();
        for i in 0..5 {
            q.run(|| order.push(i));
        }
        assert_eq!(order, vec![0, 1, 2, 3, 4]);
    }

    #[test]
    fn queue_never_interleaves_concurrent_ops() {
        // Each op records its own "enter i"/"leave i" pair. If the queue truly
        // serialises, the log is perfectly well-nested: every enter is followed
        // immediately by its matching leave, with no other op's marks between.
        let q = Arc::new(GitQueue::new());
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let mut handles = Vec::new();
        for i in 0..8 {
            let q = Arc::clone(&q);
            let log = Arc::clone(&log);
            handles.push(std::thread::spawn(move || {
                q.run(|| {
                    log.lock().unwrap().push(format!("enter {i}"));
                    // A short spin widens the window for interleaving to show.
                    std::thread::yield_now();
                    log.lock().unwrap().push(format!("leave {i}"));
                });
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 16);
        for pair in log.chunks(2) {
            let enter = pair[0].strip_prefix("enter ").expect("enter first");
            let leave = pair[1].strip_prefix("leave ").expect("leave second");
            assert_eq!(enter, leave, "op {enter} was interleaved by another op");
        }
    }
}
