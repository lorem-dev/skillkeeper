//! Managed ssh-agent for the app session (a port of
//! `apps/desktop/src/main/sshAgent.ts` and `sshAgentEnv.ts`).
//!
//! Reuses an inherited `SSH_AUTH_SOCK` on any OS; otherwise, on macOS/Linux,
//! spawns `ssh-agent -s`, parses its socket/PID from stdout, and injects them
//! into this process's environment so git subprocesses inherit the agent.
//! Windows relies on the OS OpenSSH agent (a named pipe) and is only reused,
//! never spawned. Default keys are loaded once, best-effort, without ever
//! blocking on a passphrase. No passphrase prompting (deferred), matching the
//! TypeScript. Also loads and unloads individual keys (e.g. converted from a
//! PuTTY file) by piping them to `ssh-add`, so they never touch disk.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// PID of an agent WE spawned (`None` when reusing an inherited one). Killed on
/// exit by [`stop_ssh_agent`].
static SPAWNED_PID: Mutex<Option<String>> = Mutex::new(None);

/// The env values parsed out of `ssh-agent -s` stdout (a port of the TS
/// `AgentEnv`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct AgentEnv {
    /// `SSH_AUTH_SOCK` value, if present.
    pub sock: Option<String>,
    /// `SSH_AGENT_PID` value, if present.
    pub pid: Option<String>,
}

/// Read a `KEY=value` assignment out of `ssh-agent -s` stdout, stopping the
/// value at the first `;` or whitespace (mirrors the TS `[^;\s]+` capture). An
/// empty value yields `None`.
fn extract(stdout: &str, key: &str) -> Option<String> {
    let needle = format!("{key}=");
    let start = stdout.find(&needle)? + needle.len();
    let rest = &stdout[start..];
    let end = rest
        .find(|c: char| c == ';' || c.is_whitespace())
        .unwrap_or(rest.len());
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Parse `ssh-agent -s` stdout into the env values we need. Pure, so it is
/// unit-testable. ssh-agent prints lines like:
/// ```text
/// SSH_AUTH_SOCK=/tmp/ssh-abc/agent.42; export SSH_AUTH_SOCK;
/// SSH_AGENT_PID=43; export SSH_AGENT_PID;
/// ```
pub fn parse_agent_env(stdout: &str) -> AgentEnv {
    AgentEnv {
        sock: extract(stdout, "SSH_AUTH_SOCK"),
        pid: extract(stdout, "SSH_AGENT_PID"),
    }
}

/// True when a non-empty `SSH_AUTH_SOCK` is already present in the environment.
fn has_inherited_agent() -> bool {
    std::env::var("SSH_AUTH_SOCK")
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// The named pipe the Windows OpenSSH agent service listens on. Windows sets no
/// `SSH_AUTH_SOCK`, so its presence is the only way to tell the service is up.
#[cfg(windows)]
const WINDOWS_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

/// Whether an ssh-agent is available to hold a key for this session.
///
/// Consumed by the `ssh_agent_available` command: with no agent, every SSH
/// operation has to ask for the key passphrase, so the app points the user at
/// the setup documentation instead of leaving the repeated prompts unexplained.
///
/// This reports only that an agent EXISTS, not that it holds the right key --
/// listing keys would mean running `ssh-add -l` on a path where a hung agent
/// could block, and a false "available" only costs the hint, not correctness.
pub fn is_available() -> bool {
    if has_inherited_agent() {
        return true;
    }
    #[cfg(windows)]
    {
        return std::path::Path::new(WINDOWS_AGENT_PIPE).exists();
    }
    #[cfg(not(windows))]
    false
}

/// Load the default ssh keys once, best-effort, without ever blocking on a
/// passphrase. No TTY (not a shell) plus `SSH_ASKPASS_REQUIRE=never` / empty
/// `SSH_ASKPASS` / `DISPLAY` means an encrypted key absent from the keychain
/// fails fast. macOS loads keychain-stored passphrases via
/// `--apple-use-keychain`.
fn load_keys() {
    let mut cmd = Command::new("ssh-add");
    if cfg!(target_os = "macos") {
        cmd.arg("--apple-use-keychain");
    }
    cmd.env("SSH_ASKPASS_REQUIRE", "never")
        .env("SSH_ASKPASS", "")
        .env("DISPLAY", "");
    crate::util::hide_console(&mut cmd);
    // Best-effort: no keys, tool missing, or a passphrase-protected key without
    // keychain -- leave the agent as-is; https clones still work.
    let _ = cmd.output();
}

/// Ensure an ssh-agent is available to git subprocesses via the process
/// environment. Called from `lib.rs` setup before any git command may run.
pub fn ensure_ssh_agent() {
    if has_inherited_agent() {
        load_keys();
        return;
    }
    // Windows without an inherited socket: the OS OpenSSH agent uses a named
    // pipe consulted by Windows OpenSSH ssh directly; nothing to spawn.
    if cfg!(target_os = "windows") {
        return;
    }

    let output = match Command::new("ssh-agent").arg("-s").output() {
        Ok(output) if output.status.success() => output,
        // ssh-agent unavailable or failed: leave env untouched; https works.
        _ => return,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed = parse_agent_env(&stdout);
    let Some(sock) = parsed.sock else {
        return;
    };
    std::env::set_var("SSH_AUTH_SOCK", &sock);
    if let Some(pid) = parsed.pid {
        std::env::set_var("SSH_AGENT_PID", &pid);
        if let Ok(mut guard) = SPAWNED_PID.lock() {
            *guard = Some(pid);
        }
    }
    load_keys();
}

/// Kill an agent we spawned (no-op when an inherited agent was reused). Called
/// on app exit. `ssh-agent -k` reads `SSH_AGENT_PID`, which was injected into
/// this process's environment when we spawned it.
pub fn stop_ssh_agent() {
    let spawned = SPAWNED_PID.lock().ok().and_then(|mut g| g.take());
    if spawned.is_none() {
        return;
    }
    let _ = Command::new("ssh-agent").arg("-k").output();
}

/// How long a key loaded from a PuTTY file stays in the agent: twelve hours.
///
/// Long enough never to expire inside a working session, short enough that a
/// process that dies without running its teardown does not leave the key in a
/// long-lived user agent indefinitely. The app removes the key on exit anyway;
/// this is the backstop for the case where it cannot.
pub const AGENT_KEY_TTL_SECS: u64 = 12 * 60 * 60;

/// The arguments for adding a key from stdin. Split out so the shape is
/// testable without an agent to talk to.
pub(crate) fn add_args(ttl_secs: u64) -> Vec<String> {
    vec!["-t".to_string(), ttl_secs.to_string(), "-".to_string()]
}

/// Add an OpenSSH-format private key to the session agent, reading it from a
/// pipe so it never becomes a file.
///
/// # Errors
///
/// The agent's own message when `ssh-add` fails, or the spawn error when it
/// cannot be run at all. Both are diagnostics for the log, not renderer-facing
/// codes -- the caller maps them.
pub fn add_from_memory(openssh: &str, ttl_secs: u64) -> Result<(), String> {
    let mut command = Command::new("ssh-add");
    command
        .args(add_args(ttl_secs))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    crate::util::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let write_result: Result<(), String> = (|| {
        let mut stdin = child.stdin.take().ok_or("ssh-add stdin unavailable")?;
        stdin
            .write_all(openssh.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(())
        // The handle drops here, at the end of this closure, which closes the
        // pipe; ssh-add reads to EOF, so without this it would wait forever
        // and so would we.
    })();
    if let Err(e) = write_result {
        // Reap the child on every error path: `Child` is not waited on drop,
        // so skipping this (e.g. on the EPIPE from ssh-add exiting before it
        // reads) would leave a zombie process behind. The wait outcome itself
        // is discarded -- the write error is the one worth reporting.
        let _ = child.wait();
        return Err(e);
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// The algorithm and key blob of a public-key line, dropping the comment.
///
/// The comment is the agent's business: `ssh-add -L` prints whatever comment
/// the key was added with, which a user can change, so the key material is the
/// only part that says whether two lines are the same key. `None` for a line
/// with fewer than two fields, which is how the prose `ssh-add` prints when it
/// holds nothing ("The agent has no identities.") fails to match anything.
fn key_material(line: &str) -> Option<(&str, &str)> {
    let mut fields = line.split_whitespace();
    let algorithm = fields.next()?;
    let blob = fields.next()?;
    Some((algorithm, blob))
}

/// Whether `listing` -- the stdout of `ssh-add -L` -- contains `public_line`.
///
/// Split out from [`holds_key`] so the comparison is testable with no agent to
/// talk to, the same way [`add_args`] and [`parse_agent_env`] are.
fn lists_key(listing: &str, public_line: &str) -> bool {
    let Some(wanted) = key_material(public_line) else {
        return false;
    };
    listing
        .lines()
        .any(|line| key_material(line) == Some(wanted))
}

/// Whether the agent currently holds the key with this `public_line`.
///
/// `false` for every way of not being sure -- no agent, no `ssh-add` on PATH,
/// a non-zero exit, unreadable output -- because the caller acts on "this key
/// is no longer usable", and an agent that cannot even be asked is not one
/// holding a usable key.
pub fn holds_key(public_line: &str) -> bool {
    let mut command = Command::new("ssh-add");
    command
        .arg("-L")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::util::hide_console(&mut command);
    match command.output() {
        // `ssh-add -L` exits non-zero both for an agent with no identities and
        // for one it cannot reach; neither is a listing worth reading.
        Ok(output) if output.status.success() => {
            lists_key(&String::from_utf8_lossy(&output.stdout), public_line)
        }
        _ => false,
    }
}

/// Remove a key from the agent by its public line, again over a pipe.
///
/// Best-effort by nature: the agent may be gone, the key may have expired, or
/// the user may have cleared it by hand. All of those are the desired end
/// state, so the caller ignores the error.
pub fn remove(public_line: &str) -> Result<(), String> {
    let mut command = Command::new("ssh-add");
    command
        .args(["-d", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::util::hide_console(&mut command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let write_result: Result<(), String> = (|| {
        let mut stdin = child.stdin.take().ok_or("ssh-add stdin unavailable")?;
        stdin
            .write_all(public_line.as_bytes())
            .map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        Ok(())
        // Same reasoning as add_from_memory: the handle drops here, before we
        // reap the child, so ssh-add sees EOF instead of blocking forever.
    })();
    if let Err(e) = write_result {
        // Same reasoning as add_from_memory: always reap the child so a
        // write failure never leaves a zombie process behind.
        let _ = child.wait();
        return Err(e);
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("ssh-add -d failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A public line as `ssh-add -L` prints it.
    const OURS: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfake0000000000000000000000000000000 skillkeeper";
    const THEIRS: &str =
        "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQother000000000000000000000000000000 someone@host";

    #[test]
    fn our_key_is_found_among_the_agents_other_identities() {
        let listing = format!("{THEIRS}\n{OURS}\n");
        assert!(lists_key(&listing, OURS));
    }

    /// The comment is the agent's business, not ours: `ssh-add -L` prints
    /// whatever comment the key was added with, and the key material is what
    /// says whether this is the same key.
    #[test]
    fn a_different_comment_is_still_our_key() {
        let listing = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfake0000000000000000000000000000000 renamed-by-someone\n";
        assert!(lists_key(listing, OURS));
    }

    #[test]
    fn a_listing_without_our_key_does_not_hold_it() {
        assert!(!lists_key(&format!("{THEIRS}\n"), OURS));
    }

    #[test]
    fn an_empty_listing_holds_nothing() {
        assert!(!lists_key("", OURS));
        assert!(!lists_key("\n\n", OURS));
    }

    /// What `ssh-add -L` prints when the agent is running but empty. It is
    /// prose, not a key line, and must never be mistaken for one.
    #[test]
    fn an_agent_with_no_identities_holds_nothing() {
        assert!(!lists_key("The agent has no identities.\n", OURS));
    }

    /// A public line we could not have produced answers no rather than
    /// matching the first prose line it happens to line up with.
    #[test]
    fn a_malformed_public_line_matches_nothing() {
        assert!(!lists_key(&format!("{OURS}\n"), ""));
        assert!(!lists_key(&format!("{OURS}\n"), "ssh-ed25519"));
    }

    #[test]
    fn parses_both_sock_and_pid() {
        let stdout = "SSH_AUTH_SOCK=/tmp/ssh-abc/agent.42; export SSH_AUTH_SOCK;\n\
                      SSH_AGENT_PID=43; export SSH_AGENT_PID;\n\
                      echo Agent pid 43;\n";
        assert_eq!(
            parse_agent_env(stdout),
            AgentEnv {
                sock: Some("/tmp/ssh-abc/agent.42".to_string()),
                pid: Some("43".to_string()),
            }
        );
    }

    #[test]
    fn missing_values_are_none() {
        assert_eq!(parse_agent_env(""), AgentEnv::default());
        assert_eq!(
            parse_agent_env("SSH_AGENT_PID=99; export SSH_AGENT_PID;\n"),
            AgentEnv {
                sock: None,
                pid: Some("99".to_string()),
            }
        );
    }

    #[test]
    fn stops_at_whitespace_when_no_semicolon() {
        assert_eq!(
            parse_agent_env("SSH_AUTH_SOCK=/tmp/agent.sock\n"),
            AgentEnv {
                sock: Some("/tmp/agent.sock".to_string()),
                pid: None,
            }
        );
    }

    #[test]
    fn empty_assignment_is_none() {
        assert_eq!(parse_agent_env("SSH_AUTH_SOCK=;"), AgentEnv::default());
    }

    #[test]
    fn ignores_the_export_line_without_a_value() {
        // "export SSH_AUTH_SOCK;" has no '=' after the name, so only the real
        // assignment is captured.
        let stdout = "SSH_AUTH_SOCK=/run/x; export SSH_AUTH_SOCK;";
        assert_eq!(parse_agent_env(stdout).sock, Some("/run/x".to_string()));
    }

    #[test]
    fn add_args_ask_for_a_ttl_and_read_from_stdin() {
        // `-` is what makes ssh-add read the key from stdin, which is the whole
        // point: the converted key must never become a file.
        assert_eq!(add_args(43_200), vec!["-t", "43200", "-"]);
    }

    #[test]
    fn the_default_ttl_is_twelve_hours() {
        assert_eq!(AGENT_KEY_TTL_SECS, 12 * 60 * 60);
    }
}
