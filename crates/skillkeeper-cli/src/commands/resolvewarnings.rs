//! Surfacing skill-resolution warnings.
//!
//! `resolve_skills` is infallible: it returns a `ResolveResult` carrying a
//! `warnings` list rather than failing. Those warnings are the only signal that a
//! `SKILL.md` was found but could not be installed -- a path nested deeper than a
//! single group, a malformed manifest, an unparsable `skillkeeper.repo.yaml`, or a
//! path declared in the repository config with no `SKILL.md` behind it. Discarding
//! the list makes such a skill silently invisible, so every command that resolves
//! a working tree routes it through here.

use std::io;
use std::io::Write;

/// Print each resolution warning for one repository to `err`, attributing it to
/// the repository it came from. A repository resolving cleanly prints nothing.
///
/// Warnings are advisory: they never change an exit code, because the skills that
/// did resolve are still usable.
///
/// # Errors
///
/// Returns the underlying write error. This is plain [`io::Result`] rather than a
/// `PortResult`: the only failure is a stderr write, and `CliError` already
/// converts from [`io::Error`], so every caller can use `?` with no mapping.
pub fn print_resolve_warnings(
    err: &mut dyn Write,
    repo_name: &str,
    warnings: &[String],
) -> io::Result<()> {
    for warning in warnings {
        writeln!(err, "[{repo_name}] {warning}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prints_nothing_for_a_clean_resolve() {
        let mut err = Vec::new();
        print_resolve_warnings(&mut err, "repo", &[]).unwrap();
        assert!(err.is_empty());
    }

    #[test]
    fn attributes_each_warning_to_its_repository() {
        let mut err = Vec::new();
        print_resolve_warnings(
            &mut err,
            "team-skills",
            &[
                "Unresolved SKILL.md at \"a/b/c\"".to_string(),
                "x".to_string(),
            ],
        )
        .unwrap();
        let out = String::from_utf8(err).unwrap();
        assert_eq!(
            out,
            "[team-skills] Unresolved SKILL.md at \"a/b/c\"\n[team-skills] x\n"
        );
    }
}
