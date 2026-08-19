//! Rewrapping an OpenSSH-format PEM body to the column width `ssh-key` reads.
//!
//! A codec and nothing else: it exists only because `ssh-encoding` hard-codes
//! one line width for its decoder as well as its encoder, and `puttygen` does
//! not write that width. Nothing here knows about key stores, agents or
//! passphrases.

/// The PEM line width `ssh-encoding` hard-codes -- for its DECODER as well as
/// its encoder, which is what makes the rewrap below necessary.
const PEM_LINE_WIDTH: usize = 70;

/// The only PEM label `ssh_key::PrivateKey::from_openssh` accepts.
const OPENSSH_PEM_BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_PEM_END: &str = "-----END OPENSSH PRIVATE KEY-----";

/// Rewrap an OpenSSH-format PEM body to the 70 columns `ssh-key` insists on,
/// leaving anything that is not one alone.
///
/// `ssh-encoding` uses one hard-coded `PEM_LINE_WIDTH` for both directions, so
/// `ssh-key` reads only 70-column PEM -- which is what OpenSSH itself writes.
/// `puttygen -O private-openssh-new` writes **64** columns, and that is exactly
/// the command this project's own CLI warning tells users to run. Without this,
/// such a key never parses: `ssh_key::inspect` falls through to the legacy-PEM
/// branch, where an OpenSSH-format encrypted key (whose body carries neither
/// `ENCRYPTED` nor `DEK-Info`, both being legacy-PEM headers) is classified
/// `Unencrypted`. Git still works, because `ssh` reads the file itself, but the
/// app never offers to hold the passphrase.
///
/// Layout only: the base64 body is passed through character for character, so
/// a body that is not valid base64 still fails in the parser rather than here.
pub(crate) fn normalize_openssh_pem(text: &str) -> std::borrow::Cow<'_, str> {
    let mut body = String::new();
    let mut in_body = false;
    let mut terminated = false;
    for line in text.lines() {
        let line = line.trim();
        if line == OPENSSH_PEM_BEGIN {
            in_body = true;
        } else if line == OPENSSH_PEM_END {
            terminated = in_body;
            break;
        } else if in_body {
            body.push_str(line);
        }
    }
    if !terminated {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(body.len() + OPENSSH_PEM_BEGIN.len() * 2 + 8);
    out.push_str(OPENSSH_PEM_BEGIN);
    out.push('\n');
    for (i, ch) in body.chars().enumerate() {
        if i > 0 && i % PEM_LINE_WIDTH == 0 {
            out.push('\n');
        }
        out.push(ch);
    }
    out.push('\n');
    out.push_str(OPENSSH_PEM_END);
    out.push('\n');
    std::borrow::Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Normalization is for PEM-shaped OpenSSH keys only: a legacy PEM key and
    /// anything that is not a key at all must reach the parser unchanged.
    #[test]
    fn normalizing_leaves_everything_but_an_openssh_pem_alone() {
        let legacy = "-----BEGIN RSA PRIVATE KEY-----\nbogus\n-----END RSA PRIVATE KEY-----\n";
        assert_eq!(normalize_openssh_pem(legacy).as_ref(), legacy);
        assert_eq!(
            normalize_openssh_pem("just some text\n").as_ref(),
            "just some text\n"
        );
        // A begin line with no end line is not a body this can rewrap.
        let unterminated = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n";
        assert_eq!(normalize_openssh_pem(unterminated).as_ref(), unterminated);
    }
}
