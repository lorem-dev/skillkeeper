//! Which private-key file format a chosen key is in, decided by content.
//!
//! Extensions decide nothing here: private keys usually have none, and a
//! `.ppk` may be named anything. Both front ends need the answer -- the desktop
//! app to pick between the `ssh -i` path and the agent path, the CLI to say
//! something useful instead of letting `ssh` fail on a file it cannot read --
//! so the sniff lives in the core, where it costs no dependency at all.

/// The private-key file formats this project can tell apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyFormat {
    /// OpenSSH's own format, or a legacy PEM key: what `ssh -i` accepts.
    OpenSsh,
    /// PuTTY's format, which `ssh` cannot read.
    Putty,
    /// Not recognisable as either.
    Other,
}

/// Classify `contents` by its first meaningful line.
///
/// Cheap and total: no allocation, no parsing beyond the header, and no error
/// case -- text this recognises nothing in is simply [`KeyFormat::Other`].
/// Nothing here touches the filesystem, so a file that cannot be read is its
/// caller's business, not this function's.
pub fn sniff(contents: &str) -> KeyFormat {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("PuTTY-User-Key-File-") {
            return KeyFormat::Putty;
        }
        if line.starts_with("-----BEGIN") && line.contains("PRIVATE KEY") {
            return KeyFormat::OpenSsh;
        }
        return KeyFormat::Other;
    }
    KeyFormat::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_putty_v3_header_is_putty() {
        assert_eq!(
            sniff("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n"),
            KeyFormat::Putty
        );
    }

    #[test]
    fn a_putty_v2_header_is_putty() {
        assert_eq!(
            sniff("PuTTY-User-Key-File-2: ssh-rsa\nEncryption: aes256-cbc\n"),
            KeyFormat::Putty
        );
    }

    #[test]
    fn an_openssh_key_is_openssh() {
        assert_eq!(
            sniff("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n"),
            KeyFormat::OpenSsh
        );
    }

    #[test]
    fn a_legacy_pem_key_is_openssh() {
        assert_eq!(
            sniff("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n"),
            KeyFormat::OpenSsh
        );
    }

    #[test]
    fn leading_blank_lines_do_not_hide_the_header() {
        assert_eq!(
            sniff("\n\n  PuTTY-User-Key-File-3: ssh-rsa\n"),
            KeyFormat::Putty
        );
    }

    #[test]
    fn anything_else_is_other() {
        assert_eq!(sniff("hello\n"), KeyFormat::Other);
        assert_eq!(sniff(""), KeyFormat::Other);
    }
}
