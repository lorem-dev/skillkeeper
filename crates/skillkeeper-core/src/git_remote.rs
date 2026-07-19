//! Git remote URL parsing and canonicalization (Rust port of
//! `packages/core/src/git/repoRemote.ts`).
//!
//! Two helpers the desktop command surface shares:
//!
//! - [`parse_remote`] derives the [`RepositoryKind`] and [`Transport`] a
//!   [`crate::models::Repository`] record stores from a remote URL.
//! - [`normalize_remote`] canonicalizes a remote so transport/format
//!   differences (scp vs. `https://` vs. `ssh://`, a trailing `.git` or `/`)
//!   collapse to one identity, used to match an install's source repo.

use crate::models::{RepositoryKind, Transport};

/// The [`RepositoryKind`] and [`Transport`] a [`crate::models::Repository`]
/// derives from a Git remote URL.
pub fn parse_remote(url: &str) -> (RepositoryKind, Transport) {
    let kind = if url.contains("github.com") {
        RepositoryKind::Github
    } else if url.contains("bitbucket.org") {
        RepositoryKind::Bitbucket
    } else {
        RepositoryKind::Generic
    };
    let transport = if url.starts_with("git@") || url.starts_with("ssh://") {
        Transport::Ssh
    } else {
        Transport::Https
    };
    (kind, transport)
}

/// Canonicalize a Git remote URL so transport/format differences map to one
/// identity. Returns `host/path` lowercased, without transport, user, port, a
/// trailing `.git`, or a trailing slash. Falls back to the trimmed, lowercased
/// input when the shape is unrecognized. Mirrors the TS `normalizeRemote`.
pub fn normalize_remote(url: &str) -> String {
    let trimmed = url.trim();
    let s = if let Some(scp) = scp_remote(trimmed) {
        scp
    } else if let Some(scheme) = scheme_remote(trimmed) {
        scheme
    } else {
        trimmed.to_string()
    };
    let s = s.trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    s.to_lowercase()
}

/// scp-like `user@host:org/repo` -> `host/org/repo` (mirrors the TS
/// `^[^/@]+@([^:/]+):(.+)$`).
fn scp_remote(s: &str) -> Option<String> {
    let at = s.find('@')?;
    let user = &s[..at];
    if user.is_empty() || user.contains('/') {
        return None;
    }
    let rest = &s[at + 1..];
    let colon = rest.find(':')?;
    let host = &rest[..colon];
    let path = &rest[colon + 1..];
    if host.is_empty() || host.contains('/') || path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}"))
}

/// `scheme://[user@]host[:port]/path` -> `host/path` (mirrors the TS
/// scheme branch: drop the scheme, any `user@`, and a `:port` after the host).
fn scheme_remote(s: &str) -> Option<String> {
    let idx = s.find("://")?;
    let scheme = &s[..idx];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return None;
    }
    let mut rest = &s[idx + 3..];
    if let Some(at) = rest.rfind('@') {
        rest = &rest[at + 1..];
    }
    Some(drop_host_port(rest))
}

/// Drop a `:port` immediately after the host in `host:port/path` -> `host/path`.
fn drop_host_port(rest: &str) -> String {
    if let Some(slash) = rest.find('/') {
        let hostpart = &rest[..slash];
        if let Some(colon) = hostpart.find(':') {
            let host = &hostpart[..colon];
            let port = &hostpart[colon + 1..];
            if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) {
                return format!("{host}/{}", &rest[slash + 1..]);
            }
        }
    }
    rest.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_remote_derives_kind_and_transport() {
        assert_eq!(
            parse_remote("git@github.com:acme/skills.git"),
            (RepositoryKind::Github, Transport::Ssh)
        );
        assert_eq!(
            parse_remote("https://github.com/acme/skills.git"),
            (RepositoryKind::Github, Transport::Https)
        );
        assert_eq!(
            parse_remote("https://bitbucket.org/team/repo.git"),
            (RepositoryKind::Bitbucket, Transport::Https)
        );
        assert_eq!(
            parse_remote("ssh://git@example.com/team/repo.git"),
            (RepositoryKind::Generic, Transport::Ssh)
        );
        assert_eq!(
            parse_remote("https://example.com/team/repo.git"),
            (RepositoryKind::Generic, Transport::Https)
        );
    }

    #[test]
    fn normalize_remote_canonicalizes_transports_to_one_identity() {
        let canonical = "github.com/acme/skills";
        assert_eq!(
            normalize_remote("git@github.com:acme/skills.git"),
            canonical
        );
        assert_eq!(
            normalize_remote("https://github.com/acme/skills.git"),
            canonical
        );
        assert_eq!(
            normalize_remote("ssh://git@github.com:22/acme/skills"),
            canonical
        );
        assert_eq!(
            normalize_remote("https://github.com/acme/skills/"),
            canonical
        );
        // Unrecognized shapes fall back to the trimmed, lowercased input.
        assert_eq!(normalize_remote("  Plain-Text  "), "plain-text");
    }
}
