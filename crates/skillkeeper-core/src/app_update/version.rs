//! Version parsing for the app's own releases.
//!
//! The project's version grammar is exactly `X.Y.Z` and `X.Y.Z-rc.N`, enforced
//! by `scripts/check-version.mjs` and consumed by `scripts/set-wix-version.mjs`.
//! A general semver dependency would be more surface than the parser it
//! replaces, so this is hand-rolled and total: anything outside that grammar
//! parses to `None` rather than to a best guess.

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

/// A parsed SkillKeeper version.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    /// The `N` of a `-rc.N` suffix; `None` for a final release.
    pub rc: Option<u32>,
}

/// How far apart two versions are, used to decide badge-only versus modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bump {
    Major,
    Minor,
    Patch,
}

impl Version {
    /// Parse `X.Y.Z` or `X.Y.Z-rc.N`, tolerating one leading `v` (tags carry
    /// it, manifests do not). Returns `None` for anything else.
    pub fn parse(s: &str) -> Option<Self> {
        let s = s.strip_prefix('v').unwrap_or(s);
        let (core, rc) = match s.split_once("-rc.") {
            Some((core, n)) => (core, Some(parse_u32(n)?)),
            None => {
                // Any other pre-release form is outside the project's grammar.
                if s.contains('-') {
                    return None;
                }
                (s, None)
            }
        };
        let mut parts = core.split('.');
        let major = parse_u32(parts.next()?)?;
        let minor = parse_u32(parts.next()?)?;
        let patch = parse_u32(parts.next()?)?;
        if parts.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
            rc,
        })
    }

    /// Whether this is a release candidate rather than a final release.
    pub fn is_prerelease(&self) -> bool {
        self.rc.is_some()
    }
}

/// Strict `u32` parse: rejects empty input, signs, and whitespace, all of which
/// `str::parse` alone would either accept or report identically to a real
/// overflow.
fn parse_u32(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            // A candidate precedes its own final release, so `None` (final)
            // must sort ABOVE `Some(n)`. That is the reverse of Option's
            // natural order, hence the explicit match.
            .then_with(|| match (self.rc, other.rc) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => a.cmp(&b),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(n) = self.rc {
            write!(f, "-rc.{n}")?;
        }
        Ok(())
    }
}

/// Classify the distance from `from` to `to`.
///
/// Deliberately ignores the `-rc.N` suffix: advancing `0.5.0-rc.2` to
/// `0.5.0-rc.3`, or finalizing it as `0.5.0`, is a `Patch` -- not a new feature
/// line, and so not worth interrupting the user with a modal. Crossing into a
/// new minor or major line is classified from those numbers alone, whether or
/// not either side is a candidate.
pub fn bump_between(from: &Version, to: &Version) -> Bump {
    if from.major != to.major {
        Bump::Major
    } else if from.minor != to.minor {
        Bump::Minor
    } else {
        Bump::Patch
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_final_version() {
        let v = Version::parse("1.2.3").unwrap();
        assert_eq!((v.major, v.minor, v.patch, v.rc), (1, 2, 3, None));
        assert!(!v.is_prerelease());
    }

    #[test]
    fn parses_a_release_candidate() {
        let v = Version::parse("0.5.0-rc.2").unwrap();
        assert_eq!((v.major, v.minor, v.patch, v.rc), (0, 5, 0, Some(2)));
        assert!(v.is_prerelease());
    }

    #[test]
    fn tolerates_a_leading_v() {
        assert_eq!(Version::parse("v1.0.0"), Version::parse("1.0.0"));
    }

    #[test]
    fn rejects_malformed_input() {
        for s in [
            "",
            "1.2",
            "1.2.3.4",
            "1.2.x",
            "1.2.3-beta.1",
            "1.2.3-rc",
            "-rc.1",
        ] {
            assert!(Version::parse(s).is_none(), "expected None for {s:?}");
        }
    }

    #[test]
    fn a_release_candidate_sorts_below_its_final() {
        let rc = Version::parse("0.5.0-rc.2").unwrap();
        let fin = Version::parse("0.5.0").unwrap();
        assert!(rc < fin);
    }

    #[test]
    fn candidates_sort_by_their_number() {
        assert!(Version::parse("0.5.0-rc.2").unwrap() < Version::parse("0.5.0-rc.10").unwrap());
    }

    #[test]
    fn orders_by_major_then_minor_then_patch() {
        let mut all = [
            Version::parse("1.0.0").unwrap(),
            Version::parse("0.9.9").unwrap(),
            Version::parse("1.0.1").unwrap(),
            Version::parse("1.1.0").unwrap(),
        ];
        all.sort();
        let shown: Vec<String> = all.iter().map(ToString::to_string).collect();
        assert_eq!(shown, ["0.9.9", "1.0.0", "1.0.1", "1.1.0"]);
    }

    #[test]
    fn displays_round_trip() {
        for s in ["1.2.3", "0.5.0-rc.2"] {
            assert_eq!(Version::parse(s).unwrap().to_string(), s);
        }
    }

    #[test]
    fn classifies_the_bump() {
        let cases = [
            ("1.0.0", "2.0.0", Bump::Major),
            ("1.0.0", "1.1.0", Bump::Minor),
            ("1.0.0", "1.0.1", Bump::Patch),
            // Advancing or finalizing a candidate is not a new feature line.
            ("0.5.0-rc.2", "0.5.0", Bump::Patch),
            ("0.5.0-rc.2", "0.5.0-rc.3", Bump::Patch),
            // ... but crossing into a new minor line is, candidate or not.
            ("0.5.0-rc.2", "0.6.0-rc.1", Bump::Minor),
            ("0.5.0", "1.0.0-rc.1", Bump::Major),
        ];
        for (from, to, want) in cases {
            let got = bump_between(&Version::parse(from).unwrap(), &Version::parse(to).unwrap());
            assert_eq!(got, want, "{from} -> {to}");
        }
    }
}
