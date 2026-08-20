//! The desktop app's own update bookkeeping.
//!
//! Deliberately a separate file rather than a field in `state.json`: the CLI
//! writes that file too, and serde drops unknown fields on a round trip, so a
//! slightly older CLI would silently erase the dismissed version and the dialog
//! would return after the user refused it. This file has one writer.

use serde::{Deserialize, Serialize};
use skillkeeper_core::app_update::UpdateOffer;
use skillkeeper_core::ports::FsPort;

/// Persisted state for the self-updater.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppUpdateState {
    /// The version the user refused; the dialog stays down until a newer minor
    /// or major line appears.
    pub dismissed_version: Option<String>,
    /// Unix seconds of the last check ATTEMPT, successful or not -- a failed
    /// check defers by a full day rather than retrying in a loop.
    pub last_check_at: Option<i64>,
    /// The application version that performed that attempt.
    ///
    /// The interval exists to stop repeated IDENTICAL checks from spending
    /// GitHub's unauthenticated rate limit, not to carry a stale conclusion
    /// across an upgrade. So a check made by a different build must not
    /// suppress this one: someone who just installed a new version and is told
    /// "postponed" has been handed a verdict reached about a binary they are
    /// no longer running.
    pub last_check_version: Option<String>,
    /// The most recently resolved offer, if any. Returned (after recomputing
    /// its bump against the version running RIGHT NOW) when a later check is
    /// rate-limit suppressed, so the badge does not vanish on every restart
    /// inside the suppression window. A network failure leaves this
    /// untouched rather than clearing it -- see `commands::app_update`.
    pub cached_offer: Option<UpdateOffer>,
}

/// Read the state file, falling back to defaults for anything unreadable.
pub fn load(fs: &dyn FsPort, path: &str) -> AppUpdateState {
    let Ok(true) = fs.exists(path) else {
        return AppUpdateState::default();
    };
    fs.read_file(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the state file.
pub fn save(fs: &dyn FsPort, path: &str, state: &AppUpdateState) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    fs.write_file(path, &raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use skillkeeper_core::testing::MemFs;

    #[test]
    fn a_missing_file_loads_defaults() {
        let fs = MemFs::new();
        let state = load(&fs, "/x/app-update.json");
        assert_eq!(state, AppUpdateState::default());
        assert!(state.dismissed_version.is_none());
    }

    #[test]
    fn a_corrupt_file_loads_defaults_rather_than_failing() {
        let fs = MemFs::new();
        fs.write_file("/x/app-update.json", "{ not json").unwrap();
        // Update bookkeeping is not worth refusing to start over.
        assert_eq!(load(&fs, "/x/app-update.json"), AppUpdateState::default());
    }

    #[test]
    fn round_trips_through_disk() {
        let fs = MemFs::new();
        let written = AppUpdateState {
            dismissed_version: Some("0.6.0".to_string()),
            last_check_at: Some(1_760_000_000),
            last_check_version: Some("1.2.3".to_string()),
            cached_offer: None,
        };
        save(&fs, "/x/app-update.json", &written).unwrap();
        assert_eq!(load(&fs, "/x/app-update.json"), written);
    }

    #[test]
    fn writes_camel_case_keys() {
        let fs = MemFs::new();
        save(
            &fs,
            "/x/app-update.json",
            &AppUpdateState {
                dismissed_version: Some("1.0.0".into()),
                last_check_at: Some(7),
                last_check_version: Some("1.0.0".into()),
                cached_offer: None,
            },
        )
        .unwrap();
        let raw = fs.read_file("/x/app-update.json").unwrap();
        assert!(raw.contains("dismissedVersion"));
        assert!(raw.contains("lastCheckAt"));
    }

    fn sample_offer() -> UpdateOffer {
        UpdateOffer {
            version: "0.7.0".to_string(),
            tag: "v0.7.0".to_string(),
            bump: skillkeeper_core::app_update::Bump::Minor,
            notes: "notes".to_string(),
            truncated_history: false,
            artifact: None,
            url: None,
        }
    }

    #[test]
    fn a_cached_offer_round_trips_through_disk() {
        let fs = MemFs::new();
        let written = AppUpdateState {
            dismissed_version: None,
            last_check_at: Some(1_760_000_000),
            last_check_version: Some("1.2.3".to_string()),
            cached_offer: Some(sample_offer()),
        };
        save(&fs, "/x/app-update.json", &written).unwrap();
        assert_eq!(load(&fs, "/x/app-update.json"), written);
    }

    #[test]
    fn a_missing_cached_offer_field_loads_as_none() {
        // An older `app-update.json` written before this field existed must
        // still load rather than being treated as corrupt.
        let fs = MemFs::new();
        fs.write_file(
            "/x/app-update.json",
            r#"{"dismissedVersion":"1.0.0","lastCheckAt":7}"#,
        )
        .unwrap();
        let state = load(&fs, "/x/app-update.json");
        assert_eq!(state.dismissed_version.as_deref(), Some("1.0.0"));
        assert!(state.cached_offer.is_none());
    }

    #[test]
    fn writes_camel_case_keys_for_the_cached_offer() {
        let fs = MemFs::new();
        save(
            &fs,
            "/x/app-update.json",
            &AppUpdateState {
                dismissed_version: None,
                last_check_at: None,
                last_check_version: None,
                cached_offer: Some(sample_offer()),
            },
        )
        .unwrap();
        let raw = fs.read_file("/x/app-update.json").unwrap();
        assert!(raw.contains("cachedOffer"));
        assert!(raw.contains("truncatedHistory"));
    }
}
