//! In-memory bookkeeping for the running app's self-update flow.
//!
//! Held as a `Mutex<AppUpdateSession>` on `AppContext`, alongside the other
//! mutable backend state it already carries (see `state_lock`, `ssh_key`).
//! Distinct from `store::AppUpdateState`, which is the small record persisted
//! to disk (dismissed version, last check time, the most recently resolved
//! offer): this exists only for the running process, so `app_update_download`
//! and `app_update_install` can act on the offer `app_update_check` already
//! decided without re-fetching the manifest or re-running `decide`.

use std::path::PathBuf;

use skillkeeper_core::app_update::UpdateOffer;

/// The offer from the most recent check, and the path of the artifact
/// downloaded for it, once `app_update_download` has verified one.
///
/// `generation` is bumped every time `check` records a new offer (whatever
/// that offer turns out to be, including `None`). A download in flight
/// captures the generation of the offer it started for, and is only allowed
/// to write `downloaded` if the generation is still current when it
/// finishes -- otherwise a `check` landed mid-download and the file on disk
/// belongs to a decision that no longer matches `offer`. This is the
/// invariant the whole struct exists to protect: `downloaded` is only ever
/// readable together with the exact offer it came from.
#[derive(Debug, Default)]
pub struct AppUpdateSession {
    /// The offer `app_update_check` most recently decided, if any.
    pub offer: Option<UpdateOffer>,
    /// Where the artifact for `offer` was downloaded and verified, once
    /// `app_update_download` has succeeded. Cleared by `app_update_discard`
    /// and by a fresh `app_update_check`.
    pub downloaded: Option<PathBuf>,
    /// Monotonic stamp bumped by every `check`; see the struct doc.
    pub generation: u64,
}
