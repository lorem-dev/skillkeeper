//! Environment variables that point git at one specific SSH key.
//!
//! Kept as a pure function so both front ends build the same environment: the
//! CLI with the key alone, the desktop app with an askpass helper that answers
//! the passphrase prompt from memory.

/// Where the askpass helper finds the passphrase: the endpoint to connect to and
/// the single-use token that authorises one read.
#[derive(Debug, Clone, Copy)]
pub struct AskpassRef<'a> {
    /// Absolute path to the helper executable (the app binary in helper mode).
    pub helper: &'a str,
    /// Local-socket name the helper connects to.
    pub endpoint: &'a str,
    /// Single-use token the helper presents.
    pub token: &'a str,
}

/// Name of the environment variable carrying the askpass endpoint.
pub const ASKPASS_ENDPOINT_ENV: &str = "SKILLKEEPER_ASKPASS_ENDPOINT";
/// Name of the environment variable carrying the single-use askpass token.
pub const ASKPASS_TOKEN_ENV: &str = "SKILLKEEPER_ASKPASS_TOKEN";

/// Build the environment that points git at `key_path`.
///
/// The key is offered, not enforced: `IdentitiesOnly=yes` used to be set here,
/// and per ssh_config(5) it makes `ssh` "only use the configured authentication
/// identity and certificate files ... even if ssh-agent ... offers more
/// identities". One global key with that restriction breaks the moment a
/// repository lives on a host the key has no access to: a corporate host and a
/// public forge usually mean two different identities, and the restriction turned
/// the second one into `Permission denied (publickey)` with no way to recover.
/// Without it, the chosen key is tried and everything the user already
/// configured -- their `~/.ssh/config` identities and their agent -- still works
/// as a fallback.
///
/// Returns an empty vector for a path that cannot be expressed safely (one
/// containing a double quote), so a caller falls back to the system default
/// rather than passing a broken command through.
pub fn ssh_env_vars(key_path: &str, askpass: Option<AskpassRef<'_>>) -> Vec<(String, String)> {
    if key_path.contains('"') {
        return Vec::new();
    }
    // git splits this value shell-style, so a path with whitespace needs quoting.
    // A path without any is left bare: the quotes are pure cost there, and on
    // Windows they are worse than that -- `cmd.exe` doubles an embedded double
    // quote, and git's argument parser then splits the value at that point, which
    // turned `-o IdentitiesOnly=yes` into an unknown git option.
    // Backslashes are separators on Windows but escapes to the shell-style
    // splitter, so normalise them either way.
    let path = key_path.replace('\\', "/");
    let path = if path.chars().any(char::is_whitespace) {
        format!("\"{path}\"")
    } else {
        path
    };
    let mut vars = vec![("GIT_SSH_COMMAND".to_string(), format!("ssh -i {path}"))];
    if let Some(a) = askpass {
        vars.push(("SSH_ASKPASS".to_string(), a.helper.to_string()));
        // `force` is required: with `prefer` OpenSSH only consults the helper
        // when DISPLAY is set, and otherwise prompts on the terminal.
        vars.push(("SSH_ASKPASS_REQUIRE".to_string(), "force".to_string()));
        vars.push((ASKPASS_ENDPOINT_ENV.to_string(), a.endpoint.to_string()));
        vars.push((ASKPASS_TOKEN_ENV.to_string(), a.token.to_string()));
    }
    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(vars: &'a [(String, String)], key: &str) -> Option<&'a str> {
        vars.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn quotes_the_key_path_and_offers_the_identity() {
        let vars = ssh_env_vars("/home/u/.ssh/my key", None);
        assert_eq!(
            get(&vars, "GIT_SSH_COMMAND"),
            Some("ssh -i \"/home/u/.ssh/my key\"")
        );
    }

    #[test]
    fn without_askpass_no_askpass_variables_are_set() {
        let vars = ssh_env_vars("/k", None);
        assert!(get(&vars, "SSH_ASKPASS").is_none());
        assert!(get(&vars, "SSH_ASKPASS_REQUIRE").is_none());
        assert!(get(&vars, ASKPASS_TOKEN_ENV).is_none());
    }

    #[test]
    fn with_askpass_forces_the_helper() {
        let vars = ssh_env_vars(
            "/k",
            Some(AskpassRef {
                helper: "/Applications/SkillKeeper.app/skillkeeper",
                endpoint: "sk-askpass-abc",
                token: "t-1",
            }),
        );
        assert_eq!(
            get(&vars, "SSH_ASKPASS"),
            Some("/Applications/SkillKeeper.app/skillkeeper")
        );
        // `prefer` is not enough: OpenSSH ignores the helper unless DISPLAY is
        // set and then prompts on the terminal instead.
        assert_eq!(get(&vars, "SSH_ASKPASS_REQUIRE"), Some("force"));
        assert_eq!(get(&vars, ASKPASS_ENDPOINT_ENV), Some("sk-askpass-abc"));
        assert_eq!(get(&vars, ASKPASS_TOKEN_ENV), Some("t-1"));
    }

    #[test]
    fn windows_style_separators_are_normalised() {
        let vars = ssh_env_vars(r"C:\Users\u\.ssh\id_ed25519", None);
        assert_eq!(
            get(&vars, "GIT_SSH_COMMAND"),
            Some("ssh -i C:/Users/u/.ssh/id_ed25519")
        );
    }

    #[test]
    fn a_path_without_whitespace_is_left_unquoted() {
        // Quoting it would be pure cost on unix and actively broken on Windows:
        // `cmd.exe` doubles an embedded double quote and git's argument parser
        // then splits the value there, so `-o IdentitiesOnly=yes` arrived as an
        // unknown git option instead of part of the ssh command.
        let vars = ssh_env_vars("C:/Users/u/.ssh/id_rsa", None);
        assert_eq!(
            get(&vars, "GIT_SSH_COMMAND"),
            Some("ssh -i C:/Users/u/.ssh/id_rsa")
        );
    }

    #[test]
    fn a_double_quote_in_the_path_is_rejected_rather_than_injected() {
        // A quote would break out of the quoted argument; such a path cannot be
        // expressed and yields no variables at all.
        assert!(ssh_env_vars("/tmp/we\"ird", None).is_empty());
    }
}
