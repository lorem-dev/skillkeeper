//! serde types for the `versions.json` release manifest.
//!
//! Deliberately tolerant of missing `notes` and `assets`: only the newest entry
//! carries artifacts, and only the newest ten carry release notes, so most
//! entries are a version number and a tag.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// One downloadable file in a release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    /// `dmg`, `nsis`, `msi`, `appimage`, or `deb`.
    pub kind: String,
    /// Release asset file name.
    pub name: String,
    /// Lowercase hex SHA-256 of the asset.
    pub sha256: String,
}

/// One released version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub version: String,
    #[serde(default)]
    pub prerelease: bool,
    pub tag: String,
    /// Release notes, carried only by the most recent entries.
    #[serde(default)]
    pub notes: Option<String>,
    /// Artifacts keyed by `<os>-<arch>`; present only on the newest entry.
    #[serde(default)]
    pub assets: HashMap<String, Vec<Artifact>>,
}

/// The published `versions.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    #[serde(default)]
    pub generated_at: String,
    pub versions: Vec<ManifestEntry>,
}

/// The first artifact for `key` whose kind appears in `kinds`, honouring the
/// order of `kinds` (preference) rather than the order of the manifest.
pub fn select_artifact<'a>(
    entry: &'a ManifestEntry,
    key: &str,
    kinds: &[&str],
) -> Option<&'a Artifact> {
    let available = entry.assets.get(key)?;
    kinds
        .iter()
        .find_map(|want| available.iter().find(|a| a.kind == *want))
}

/// The GitHub release download URL for one asset.
pub fn download_url(repo: &str, tag: &str, name: &str) -> String {
    format!("https://github.com/{repo}/releases/download/{tag}/{name}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r####"{
      "schema": 1,
      "generatedAt": "2026-08-20T10:00:00Z",
      "versions": [
        {
          "version": "0.6.0",
          "prerelease": false,
          "tag": "v0.6.0",
          "notes": "### Added\n- thing\n",
          "assets": {
            "linux-x86_64": [
              { "kind": "appimage", "name": "SkillKeeper_0.6.0_amd64.AppImage", "sha256": "aa" },
              { "kind": "deb", "name": "SkillKeeper_0.6.0_amd64.deb", "sha256": "bb" }
            ]
          }
        },
        { "version": "0.5.0", "prerelease": false, "tag": "v0.5.0" }
      ]
    }"####;

    #[test]
    fn parses_a_manifest() {
        let m: Manifest = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(m.schema, 1);
        assert_eq!(m.versions.len(), 2);
        assert_eq!(m.versions[0].version, "0.6.0");
    }

    #[test]
    fn older_entries_may_omit_notes_and_assets() {
        let m: Manifest = serde_json::from_str(SAMPLE).unwrap();
        assert!(m.versions[1].notes.is_none());
        assert!(m.versions[1].assets.is_empty());
    }

    #[test]
    fn selects_the_first_available_preferred_kind() {
        let m: Manifest = serde_json::from_str(SAMPLE).unwrap();
        let picked = select_artifact(&m.versions[0], "linux-x86_64", &["deb"]).unwrap();
        assert_eq!(picked.name, "SkillKeeper_0.6.0_amd64.deb");
        assert_eq!(picked.sha256, "bb");
    }

    #[test]
    fn falls_through_to_the_next_preferred_kind() {
        let m: Manifest = serde_json::from_str(SAMPLE).unwrap();
        // "msi" is absent here, so the second preference wins.
        let picked = select_artifact(&m.versions[0], "linux-x86_64", &["msi", "appimage"]).unwrap();
        assert_eq!(picked.kind, "appimage");
    }

    #[test]
    fn returns_none_for_an_unbuilt_platform() {
        let m: Manifest = serde_json::from_str(SAMPLE).unwrap();
        assert!(select_artifact(&m.versions[0], "darwin-aarch64", &["dmg"]).is_none());
    }

    #[test]
    fn builds_the_release_download_url() {
        assert_eq!(
            download_url("lorem-dev/skillkeeper", "v0.6.0", "a.dmg"),
            "https://github.com/lorem-dev/skillkeeper/releases/download/v0.6.0/a.dmg"
        );
    }
}
