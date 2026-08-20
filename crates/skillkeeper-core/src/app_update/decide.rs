//! What to offer the running build, if anything.
//!
//! Total over its inputs: a malformed running version, a malformed entry, or a
//! manifest with nothing newer all yield "no offer" rather than an error, so a
//! bad manifest can never break the app that reads it.

use serde::{Deserialize, Serialize};

use crate::app_update::manifest::{download_url, select_artifact, Artifact, Manifest};
use crate::app_update::version::{bump_between, Bump, Version};

/// Upper bound on the notes handed to the renderer. A malformed or hostile
/// manifest should not be able to stall the UI with an unbounded string.
pub const MAX_NOTES_BYTES: usize = 64 * 1024;

/// The single update being offered.
///
/// Serializable so the desktop backend can persist the most recently decided
/// offer to disk and hand it back when a later check is rate-limit
/// suppressed (see `app_update::store` in the desktop crate).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub version: String,
    pub tag: String,
    pub bump: Bump,
    /// Cumulative release notes, newest section first.
    pub notes: String,
    /// Whether at least one version in the range had no notes in the manifest,
    /// so the reader is seeing an incomplete history.
    pub truncated_history: bool,
    /// The artifact for this host, when the release built one.
    pub artifact: Option<Artifact>,
    /// Download URL for `artifact`.
    pub url: Option<String>,
}

/// Everything `decide` needs about the running host.
#[derive(Debug, Clone)]
pub struct DecideInput<'a> {
    /// The running application version.
    pub current: &'a str,
    /// The version the user last refused, if any.
    pub dismissed: Option<&'a str>,
    /// Manifest asset key for this host (`host_asset_key()`).
    pub asset_key: &'a str,
    /// Acceptable artifact kinds, most preferred first.
    pub kinds: &'a [&'a str],
    /// `owner/name` of the GitHub repository.
    pub repo: &'a str,
}

/// Pick the highest version worth offering, or `None`.
pub fn decide(manifest: &Manifest, input: &DecideInput<'_>) -> Option<UpdateOffer> {
    let current = Version::parse(input.current)?;

    // A stable build sees only final releases; a candidate build sees
    // everything, because running a candidate IS opting into that stream.
    let accepts_prerelease = current.is_prerelease();

    let mut candidates: Vec<(Version, &_)> = manifest
        .versions
        .iter()
        .filter_map(|e| Version::parse(&e.version).map(|v| (v, e)))
        .filter(|(v, _)| *v > current)
        .filter(|(v, _)| accepts_prerelease || !v.is_prerelease())
        .collect();
    candidates.sort_by_key(|c| std::cmp::Reverse(c.0));

    let (best_version, best) = candidates.first()?;

    // Every candidate above the running version contributes its notes, so a
    // user who skipped releases sees what they skipped. Sections are already
    // sorted newest-first.
    let mut sections: Vec<String> = Vec::new();
    let mut truncated_history = false;
    for (v, entry) in &candidates {
        match entry.notes.as_deref() {
            Some(notes) if !notes.trim().is_empty() => {
                sections.push(format!("{v}\n\n{}", notes.trim_end()));
            }
            // The manifest carries notes only for the most recent versions; an
            // older one contributes nothing but must not read as "no changes".
            _ => truncated_history = true,
        }
    }
    let notes = cap_bytes(&sections.join("\n\n"), MAX_NOTES_BYTES);

    let artifact = select_artifact(best, input.asset_key, input.kinds).cloned();
    let url = artifact
        .as_ref()
        .map(|a| download_url(input.repo, &best.tag, &a.name));

    Some(UpdateOffer {
        version: best.version.clone(),
        tag: best.tag.clone(),
        bump: bump_between(&current, best_version),
        notes,
        truncated_history,
        artifact,
        url,
    })
}

/// Whether this offer warrants interrupting the user with a dialog.
///
/// A dialog is for a new feature line only. A dismissal is remembered as a
/// version, not a flag, so refusing `0.6.0` also silences `0.6.7` while
/// `0.7.0` still gets through. An unparseable dismissal is treated as no
/// dismissal: a corrupt state file must not silence updates permanently.
pub fn should_show_dialog(offer: &UpdateOffer, dismissed: Option<&str>) -> bool {
    if offer.bump == Bump::Patch {
        return false;
    }
    let Some(latest) = Version::parse(&offer.version) else {
        return false;
    };
    match dismissed.and_then(Version::parse) {
        Some(prev) if latest > prev => bump_between(&prev, &latest) != Bump::Patch,
        Some(_) => false,
        None => true,
    }
}

/// Truncate to at most `max` bytes without splitting a UTF-8 character.
fn cap_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_update::manifest::{Artifact, Manifest, ManifestEntry};
    use std::collections::HashMap;

    fn entry(version: &str, prerelease: bool, notes: Option<&str>) -> ManifestEntry {
        ManifestEntry {
            version: version.to_string(),
            prerelease,
            tag: format!("v{version}"),
            notes: notes.map(ToString::to_string),
            assets: HashMap::new(),
        }
    }

    fn with_asset(mut e: ManifestEntry) -> ManifestEntry {
        e.assets.insert(
            "linux-x86_64".to_string(),
            vec![Artifact {
                kind: "deb".to_string(),
                name: format!("SkillKeeper_{}_amd64.deb", e.version),
                sha256: "ab".to_string(),
            }],
        );
        e
    }

    fn manifest(entries: Vec<ManifestEntry>) -> Manifest {
        Manifest {
            schema: 1,
            generated_at: String::new(),
            versions: entries,
        }
    }

    fn input<'a>(current: &'a str, dismissed: Option<&'a str>) -> DecideInput<'a> {
        DecideInput {
            current,
            dismissed,
            asset_key: "linux-x86_64",
            kinds: &["deb"],
            repo: "lorem-dev/skillkeeper",
        }
    }

    #[test]
    fn offers_nothing_when_already_current() {
        let m = manifest(vec![with_asset(entry("0.5.0", false, Some("n")))]);
        assert!(decide(&m, &input("0.5.0", None)).is_none());
    }

    #[test]
    fn offers_nothing_when_ahead_of_the_manifest() {
        let m = manifest(vec![with_asset(entry("0.5.0", false, Some("n")))]);
        assert!(decide(&m, &input("0.6.0", None)).is_none());
    }

    #[test]
    fn a_stable_build_ignores_candidates() {
        let m = manifest(vec![
            with_asset(entry("0.6.0-rc.1", true, Some("rc notes"))),
            entry("0.5.0", false, Some("stable notes")),
        ]);
        assert!(decide(&m, &input("0.5.0", None)).is_none());
    }

    #[test]
    fn a_candidate_build_is_offered_a_newer_candidate() {
        let m = manifest(vec![
            with_asset(entry("0.5.0-rc.3", true, Some("rc3 notes"))),
            entry("0.5.0-rc.2", true, Some("rc2 notes")),
        ]);
        let offer = decide(&m, &input("0.5.0-rc.2", None)).unwrap();
        assert_eq!(offer.version, "0.5.0-rc.3");
        // Advancing a candidate is not a new feature line.
        assert_eq!(offer.bump, Bump::Patch);
    }

    #[test]
    fn a_candidate_build_prefers_the_greater_stable_release() {
        let m = manifest(vec![
            with_asset(entry("0.5.0", false, Some("final notes"))),
            entry("0.5.0-rc.3", true, Some("rc3 notes")),
        ]);
        let offer = decide(&m, &input("0.5.0-rc.2", None)).unwrap();
        assert_eq!(offer.version, "0.5.0");
    }

    #[test]
    fn notes_accumulate_newest_first_across_skipped_versions() {
        let m = manifest(vec![
            with_asset(entry("0.8.0", false, Some("### Added\n- eight\n"))),
            entry("0.7.0", false, Some("### Added\n- seven\n")),
            entry("0.6.0", false, Some("### Added\n- six\n")),
            entry("0.5.0", false, Some("### Added\n- five\n")),
        ]);
        let offer = decide(&m, &input("0.6.0", None)).unwrap();
        assert_eq!(offer.version, "0.8.0");
        let eight = offer.notes.find("eight").unwrap();
        let seven = offer.notes.find("seven").unwrap();
        assert!(eight < seven, "newest section must come first");
        assert!(offer.notes.contains("0.8.0") && offer.notes.contains("0.7.0"));
        // The running version's own notes are not "what is new".
        assert!(!offer.notes.contains("six"));
        assert!(!offer.notes.contains("five"));
        assert!(!offer.truncated_history);
    }

    #[test]
    fn versions_without_notes_are_flagged_rather_than_silently_dropped() {
        let m = manifest(vec![
            with_asset(entry("0.8.0", false, Some("### Added\n- eight\n"))),
            entry("0.7.0", false, None),
        ]);
        let offer = decide(&m, &input("0.6.0", None)).unwrap();
        assert!(offer.notes.contains("eight"));
        assert!(offer.truncated_history, "a skipped version had no notes");
    }

    #[test]
    fn notes_are_capped() {
        let huge = "x".repeat(MAX_NOTES_BYTES * 2);
        let m = manifest(vec![with_asset(entry("0.9.0", false, Some(&huge)))]);
        let offer = decide(&m, &input("0.5.0", None)).unwrap();
        assert!(offer.notes.len() <= MAX_NOTES_BYTES);
    }

    #[test]
    fn cap_bytes_backs_off_rather_than_splitting_a_multibyte_character() {
        // "e" with an acute accent is two UTF-8 bytes; a cap landing on its
        // second byte must back off to the character boundary before it,
        // dropping the whole character rather than emitting invalid UTF-8 (or
        // panicking on a non-boundary slice, which is the failure the
        // boundary-walk in `cap_bytes` exists to prevent).
        let s = format!("{}{}{}", "a".repeat(5), '\u{e9}', "b".repeat(5));
        assert_eq!(cap_bytes(&s, 6), "a".repeat(5));
        // A cap that lands exactly on the character boundary keeps it whole.
        assert_eq!(cap_bytes(&s, 7), format!("{}{}", "a".repeat(5), '\u{e9}'));
    }

    #[test]
    fn resolves_the_artifact_and_its_url() {
        let m = manifest(vec![with_asset(entry("0.6.0", false, Some("n")))]);
        let offer = decide(&m, &input("0.5.0", None)).unwrap();
        let artifact = offer.artifact.unwrap();
        assert_eq!(artifact.kind, "deb");
        assert_eq!(
            offer.url.unwrap(),
            "https://github.com/lorem-dev/skillkeeper/releases/download/v0.6.0/SkillKeeper_0.6.0_amd64.deb"
        );
    }

    #[test]
    fn an_offer_without_an_artifact_for_this_host_still_reports_the_version() {
        // The badge should say a version exists even where we cannot install it.
        let m = manifest(vec![entry("0.6.0", false, Some("n"))]);
        let offer = decide(&m, &input("0.5.0", None)).unwrap();
        assert_eq!(offer.version, "0.6.0");
        assert!(offer.artifact.is_none());
        assert!(offer.url.is_none());
    }

    #[test]
    fn a_malformed_version_string_in_the_manifest_is_skipped() {
        let m = manifest(vec![
            entry("not-a-version", false, Some("junk")),
            with_asset(entry("0.6.0", false, Some("n"))),
        ]);
        assert_eq!(decide(&m, &input("0.5.0", None)).unwrap().version, "0.6.0");
    }

    #[test]
    fn a_malformed_running_version_offers_nothing() {
        let m = manifest(vec![with_asset(entry("0.6.0", false, Some("n")))]);
        assert!(decide(&m, &input("nonsense", None)).is_none());
    }

    #[test]
    fn a_dialog_shows_for_a_minor_or_major_bump() {
        let m = manifest(vec![with_asset(entry("0.6.0", false, Some("n")))]);
        let offer = decide(&m, &input("0.5.0", None)).unwrap();
        assert!(should_show_dialog(&offer, None));
    }

    #[test]
    fn a_patch_bump_is_badge_only() {
        let m = manifest(vec![with_asset(entry("0.5.1", false, Some("n")))]);
        let offer = decide(&m, &input("0.5.0", None)).unwrap();
        assert!(!should_show_dialog(&offer, None));
    }

    #[test]
    fn dismissing_a_version_silences_later_patches_of_that_line() {
        let m = manifest(vec![with_asset(entry("0.6.7", false, Some("n")))]);
        let offer = decide(&m, &input("0.5.0", Some("0.6.0"))).unwrap();
        // Still offered in the badge...
        assert_eq!(offer.version, "0.6.7");
        // ...but the dialog stays down until a new minor or major line.
        assert!(!should_show_dialog(&offer, Some("0.6.0")));
    }

    #[test]
    fn a_new_minor_line_defeats_an_earlier_dismissal() {
        let m = manifest(vec![with_asset(entry("0.7.0", false, Some("n")))]);
        let offer = decide(&m, &input("0.5.0", Some("0.6.0"))).unwrap();
        assert!(should_show_dialog(&offer, Some("0.6.0")));
    }

    #[test]
    fn an_unparseable_dismissal_is_ignored_rather_than_silencing_forever() {
        let m = manifest(vec![with_asset(entry("0.6.0", false, Some("n")))]);
        let offer = decide(&m, &input("0.5.0", Some("garbage"))).unwrap();
        assert!(should_show_dialog(&offer, Some("garbage")));
    }
}
