//! Self-update decision logic for the desktop application.
//!
//! Pure: no network and no filesystem. The desktop backend supplies the fetched
//! manifest and the running version; everything here is a total function over
//! those, so the whole policy is unit-testable without a release to point at.

// Test-only: contract checks against a manifest a real release published, as
// opposed to the hand-built fixtures every other test here uses.
#[cfg(test)]
mod contract;

pub mod decide;
pub mod manifest;
pub mod platform;
pub mod version;

pub use decide::{decide, should_show_dialog, DecideInput, UpdateOffer, MAX_NOTES_BYTES};
pub use manifest::{download_url, select_artifact, Artifact, Manifest, ManifestEntry};
pub use platform::{host_asset_key, preferred_kinds};
pub use version::{bump_between, Bump, Version};
