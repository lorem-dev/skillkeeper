//! Managed ssh-agent for the app session (a port of
//! `apps/desktop/src/main/sshAgent.ts` and `sshAgentEnv.ts`).
//!
//! Reuses an inherited `SSH_AUTH_SOCK` on any OS; otherwise, on macOS/Linux,
//! spawns `ssh-agent -s`, parses its socket/PID from stdout, and injects them
//! into this process's environment so git subprocesses inherit the agent.
//! Windows relies on the OS OpenSSH agent (a named pipe) and is only reused,
//! never spawned. Default keys are loaded once, best-effort, without ever
//! blocking on a passphrase. No passphrase prompting (deferred), matching the
//! TypeScript.

use std::process::Command;
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
