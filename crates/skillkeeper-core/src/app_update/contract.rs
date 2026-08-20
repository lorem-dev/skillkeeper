//! Contract tests against a real published manifest.
//!
//! Every other test in this module builds its own `Manifest` by hand, which
//! proves the logic is self-consistent but says nothing about whether the thing
//! `scripts/gen-versions-json.mjs` actually WRITES is the thing this code can
//! read. That gap is where the expensive mistakes of this feature lived: an
//! asset key spelled `darwin` instead of `macos` would have left every macOS
//! client silently finding no artifact, and a lexicographic `rc.N` sort would
//! have shipped a release whose own notes were missing -- both invisible to
//! hand-built fixtures, and both only observable after a release was published
//! and could no longer be recalled.
//!
//! So the fixture here is not written by hand. It is the manifest published with
//! `v0.5.0-rc.12`, copied verbatim from the release. Its value is precisely that
//! nobody edited it. When the generator changes, replace it with a freshly
//! published one rather than patching it to make a test pass.

use crate::app_update::{decide, DecideInput, Manifest};

const LIVE: &str = include_str!("fixtures/versions-0.5.0-rc.12.json");

fn manifest() -> Manifest {
    serde_json::from_str(LIVE).expect("the published manifest must parse as our own Manifest type")
}

/// The six `<os>-<arch>` keys the release matrix produces, spelled the way
/// `std::env::consts` spells them. `macos`, never `darwin`.
const EXPECTED_KEYS: [&str; 6] = [
    "linux-aarch64",
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];

#[test]
fn the_published_manifest_parses() {
    let m = manifest();
    assert_eq!(m.schema, 1);
    assert!(!m.versions.is_empty());
    assert!(!m.generated_at.is_empty());
}

#[test]
fn asset_keys_match_the_hosts_own_spelling() {
    let m = manifest();
    let newest = &m.versions[0];
    let mut keys: Vec<&str> = newest.assets.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, EXPECTED_KEYS);
    // The specific mistake this guards: `darwin` is what most tooling calls the
    // platform, and it is NOT what `std::env::consts::OS` returns.
    assert!(!newest.assets.contains_key("darwin-aarch64"));
}

#[test]
fn the_running_hosts_key_is_one_the_manifest_carries() {
    // Ties the consumer's own lookup to the producer's output on whatever
    // machine runs the suite, rather than trusting the table above.
    let m = manifest();
    // The compile-time target is the right thing HERE: this test asks whether
    // the manifest covers the host the suite is running on, and the suite runs
    // as the binary it was built as.
    let key = crate::app_update::asset_key(std::env::consts::OS, std::env::consts::ARCH);
    assert!(
        m.versions[0].assets.contains_key(&key),
        "the published manifest has no artifacts for this host key: {key}"
    );
}

#[test]
fn only_the_published_entry_carries_assets() {
    let m = manifest();
    let with_assets: Vec<&str> = m
        .versions
        .iter()
        .filter(|e| !e.assets.is_empty())
        .map(|e| e.version.as_str())
        .collect();
    assert_eq!(with_assets, ["0.5.0-rc.12"]);
}

#[test]
fn notes_are_carried_by_the_ten_most_recent_entries() {
    let m = manifest();
    let with_notes = m
        .versions
        .iter()
        .filter(|e| e.notes.as_deref().is_some_and(|n| !n.trim().is_empty()))
        .count();
    assert_eq!(with_notes, 10);
    // And they are the FIRST ten, not ten scattered through the list.
    for entry in m.versions.iter().take(10) {
        assert!(
            entry.notes.as_deref().is_some_and(|n| !n.trim().is_empty()),
            "{} should carry notes",
            entry.version
        );
    }
}

#[test]
fn entries_are_ordered_newest_first() {
    // This fixture carries rc.12 above rc.2, so it now covers the two-digit
    // candidate that a lexicographic sort would have placed below rc.2 -- the
    // defect that shipped a candidate without its own notes.
    let m = manifest();
    let parsed: Vec<_> = m
        .versions
        .iter()
        .map(|e| crate::app_update::Version::parse(&e.version).expect("every version must parse"))
        .collect();
    for pair in parsed.windows(2) {
        assert!(
            pair[0] > pair[1],
            "manifest is out of order: {} then {}",
            pair[0],
            pair[1]
        );
    }
}

#[test]
fn a_candidate_build_is_offered_the_published_candidate() {
    let m = manifest();
    let offer = decide(
        &m,
        &DecideInput {
            current: "0.5.0-rc.2",
            dismissed: None,
            asset_key: "macos-aarch64",
            kinds: &["dmg"],
            repo: "lorem-dev/skillkeeper",
        },
    )
    .expect("a candidate build one step behind must be offered the newer candidate");
    assert_eq!(offer.version, "0.5.0-rc.12");
    assert!(offer.artifact.is_some());
    assert_eq!(
        offer.url.as_deref(),
        Some(
            "https://github.com/lorem-dev/skillkeeper/releases/download/\
             v0.5.0-rc.12/SkillKeeper_0.5.0-rc.12_aarch64.dmg"
        ),
        "the download URL is built from the manifest, so a change in either side must be deliberate"
    );
}

#[test]
fn a_stable_build_is_offered_nothing_when_only_candidates_are_newer() {
    // 0.4.1 is the newest FINAL release in this manifest; everything above it is
    // a candidate. A stable build must therefore see no offer at all -- this is
    // the property that keeps release candidates away from ordinary users.
    let m = manifest();
    for (key, kinds) in [
        ("macos-aarch64", &["dmg"][..]),
        ("linux-x86_64", &["deb"][..]),
        ("windows-x86_64", &["nsis", "msi"][..]),
    ] {
        assert!(
            decide(
                &m,
                &DecideInput {
                    current: "0.4.1",
                    dismissed: None,
                    asset_key: key,
                    kinds,
                    repo: "lorem-dev/skillkeeper",
                },
            )
            .is_none(),
            "a stable build was offered a prerelease on {key}"
        );
    }
}

#[test]
fn every_host_resolves_an_installable_artifact_of_the_right_kind() {
    let m = manifest();
    for key in EXPECTED_KEYS {
        let os = key.split('-').next().expect("key has an os segment");
        // Ask for both Linux forms, since which one applies depends on whether
        // the running process came from an AppImage.
        for kinds in match os {
            "macos" => vec![&["dmg"][..]],
            "windows" => vec![&["nsis", "msi"][..]],
            _ => vec![&["appimage"][..], &["deb"][..]],
        } {
            let offer = decide(
                &m,
                &DecideInput {
                    current: "0.5.0-rc.2",
                    dismissed: None,
                    asset_key: key,
                    kinds,
                    repo: "lorem-dev/skillkeeper",
                },
            )
            .expect("an offer");
            let artifact = offer
                .artifact
                .unwrap_or_else(|| panic!("no {kinds:?} artifact for {key}"));
            assert!(kinds.contains(&artifact.kind.as_str()));
            assert_eq!(
                artifact.sha256.len(),
                64,
                "{key}: sha256 must be 64 hex chars, got {:?}",
                artifact.sha256
            );
            assert!(artifact.sha256.chars().all(|c| c.is_ascii_hexdigit()));
        }
    }
}
