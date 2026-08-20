//! Self-update commands: check for an update, download and verify it, install
//! it, discard a download, or dismiss an offered version.
//!
//! Mirrors `commands/repositories.rs`: thin `#[tauri::command]` wrappers over
//! plain functions taking `&AppContext`, so the decision logic is exercised
//! directly in unit tests (a `tauri::State` is awkward to construct). The
//! operations that must notify the renderer while they run (download
//! progress, a failed download or install, a pending install failure found at
//! startup) also take an `AppHandle`, the same way `repositories::offer_unlock`
//! and `ssh_key::prompt` do -- those are not unit tested either, for the same
//! reason: there is no `AppHandle` outside a running Tauri app.
//!
//! On macOS and Linux/AppImage, an install replaces the running application
//! from a detached helper script that outlives this process (see
//! `app::app_update::install`'s module doc), so this process can never
//! observe that install failing. `sweep_stale_downloads` and
//! `report_pending_install_failure` are the other half of that mechanism:
//! together they read back the marker the helper script leaves on failure,
//! on the next launch, without deleting the artifact out from under it.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use skillkeeper_core::app_update::{
    bump_between, decide, host_asset_key, preferred_kinds, should_show_dialog, Artifact, Bump,
    DecideInput, Manifest, UpdateOffer, Version,
};
use skillkeeper_core::ports::Clock;

use super::blocking;
use crate::app::app_update::session::AppUpdateSession;
use crate::app::app_update::{fetch, install, store, verify};
use crate::state::AppContext;

/// The self-update offer sent to the renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../../apps/desktop/src/renderer/services/bridge/generated/"
    )
)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateOffer {
    pub version: String,
    pub bump: String,
    pub notes: String,
    pub truncated_history: bool,
    pub installable: bool,
    pub show_dialog: bool,
}

/// Outcome of an automatic `appUpdate:check` attempt: the decided offer (if
/// any), and whether this attempt actually reached the network.
///
/// `suppressed` is `true` for exactly one reason: the request landed inside
/// [`CHECK_INTERVAL_SECS`] of the last real attempt, so this call returned the
/// persisted offer (or nothing) instead of a fresh decision. It used to mean
/// "either the interval OR a debug build", and a debug build no longer skips
/// at all -- do not reintroduce that, since skipping returned before recording
/// an attempt and so turned "check on startup" into "never check" with nothing
/// to show it. The renderer surfaces this on the
/// `app-update-check` task as `skipped` rather than `done`, so "no badge
/// appeared" is never silently indistinguishable from "no check ever ran" --
/// which is exactly the confusion that cost real debugging time before this
/// existed. Not ts-rs generated: a plain command DTO, same as
/// `ProgressPayload`/`ReadyPayload` below.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckOutcome {
    pub offer: Option<AppUpdateOffer>,
    pub suppressed: bool,
}

/// `appUpdate:progress` payload.
#[derive(Debug, Clone, Serialize)]
struct ProgressPayload {
    percent: u8,
}

/// `appUpdate:ready` payload.
#[derive(Debug, Clone, Serialize)]
struct ReadyPayload {
    version: String,
    path: String,
}

/// `appUpdate:failed` payload.
///
/// `phase` tells the renderer which flow failed, since the two need
/// different recovery UI: a failed download can just be retried, but a
/// failed install (most commonly the macOS copy into `/Applications` being
/// refused) needs the manual-fallback instructions, `installFailed`
/// wording included.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FailedPayload {
    message: String,
    /// `"download"` or `"install"`, always one of those two exact lowercase
    /// spellings -- the renderer matches on them verbatim.
    phase: &'static str,
    /// The preserved artifact's absolute path. Present ONLY for a
    /// marker-based install failure discovered on a fresh launch (see
    /// [`pending_install_failure`]) whose artifact could still be found on
    /// disk: that is the one case where the ready dialog carrying the manual
    /// fallback never opened in this session at all, so the renderer needs
    /// enough here to reopen it itself. Absent for a download failure, and
    /// for a same-session install failure (`install_update`'s `Err` branch)
    /// where the ready dialog is already open and does not need to travel
    /// this way.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// The offer the reopened ready dialog should show the version of, for
    /// the same marker-based case as `path`. `None` whenever `path` is.
    #[serde(skip_serializing_if = "Option::is_none")]
    offer: Option<AppUpdateOffer>,
    /// Whether the session was successfully rehydrated so `app_update_install`
    /// can retry against the preserved artifact without a fresh download --
    /// see [`rehydrate_preserved_download`]. Only ever true when `path` is
    /// `Some`; `false` (meaningless but harmless) in every other case,
    /// including a download failure and a same-session install failure.
    /// The renderer uses this to decide whether "Install now" is offered at
    /// all in the reopened dialog, or replaced by a route back to
    /// downloading -- a corrupt or superseded preserved artifact must never
    /// be handed to the installer.
    install_ready: bool,
}

/// Render an [`UpdateOffer`] into the DTO the renderer receives.
fn to_dto(offer: &UpdateOffer, dismissed: Option<&str>) -> AppUpdateOffer {
    AppUpdateOffer {
        version: offer.version.clone(),
        bump: bump_str(offer.bump),
        notes: offer.notes.clone(),
        truncated_history: offer.truncated_history,
        installable: offer.url.is_some(),
        show_dialog: should_show_dialog(offer, dismissed),
    }
}

/// Lowercase name for a [`Bump`] (`"major"`, `"minor"`, `"patch"`).
fn bump_str(bump: Bump) -> String {
    match bump {
        Bump::Major => "major",
        Bump::Minor => "minor",
        Bump::Patch => "patch",
    }
    .to_string()
}

/// The dedicated subdirectory (a sibling of `config.yaml`, like
/// `onboarding.json`) an update artifact is downloaded into, so `discard` can
/// remove the whole thing -- the file, and the `.part` temp file a partial
/// download left behind -- in one step rather than tracking each leftover.
///
/// Sized off `ctx.paths` rather than the OS temp directory so it stays inside
/// each test's own hermetic app-data dir; in production this is the same
/// per-install app-data directory every other command already writes to.
fn download_dir(ctx: &AppContext) -> PathBuf {
    let dir = Path::new(&ctx.paths.config_yaml)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    dir.join("update")
}

/// Where `download` writes (and `install` later reads) the artifact for
/// `artifact`.
fn download_dest(ctx: &AppContext, artifact: &Artifact) -> PathBuf {
    download_dir(ctx).join(&artifact.name)
}

/// Acquire the update session lock, recovering the guard if a prior holder
/// panicked while holding it (mirrors `repositories::lock` for `state_lock`).
fn lock(ctx: &AppContext) -> std::sync::MutexGuard<'_, AppUpdateSession> {
    ctx.app_update.lock().unwrap_or_else(|e| e.into_inner())
}

/// Minimum interval between checks that actually reach the network, so
/// `app_update_check` never exhausts GitHub's unauthenticated rate limit (60
/// requests/hour/IP) however often the app is relaunched or the renderer's
/// own 24h schedule fires. A check invoked before this elapses is
/// "suppressed": see [`suppressed_offer`].
const CHECK_INTERVAL_SECS: i64 = 24 * 60 * 60;

/// Overall timeout for a manifest fetch (a small JSON file): ureq 3's
/// defaults set a connect timeout but nothing bounds a connection that opens
/// then never sends the body, so without this a stalled CDN wedges `check`
/// for the life of the process. Generous for a file this small.
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Overall timeout for an artifact download (an installer, up to roughly
/// 150 MB). Two hours, not fifteen minutes -- ureq 3.4.0 has no per-read or
/// idle timeout at all: `timeout_global`, and every other timeout variant the
/// crate offers (including the closer-scoped `timeout_recv_body`), compute a
/// single fixed deadline from a milestone once and never push it out as
/// further bytes arrive. So whatever this is set to is a TOTAL transfer
/// deadline, not a stall detector, and it kills a slow-but-still-progressing
/// download exactly like a genuinely stalled one -- a 150 MB dmg over a slow
/// link can easily take longer than fifteen minutes without ever actually
/// being stuck. Weighing the two failure modes: a generous deadline's only
/// cost is that a truly stalled transfer wedges `downloading` (see
/// `model.ts`'s `midDecision`) for up to this long instead of forever, and
/// the app stays fully usable throughout -- the status-bar badge just shows a
/// percentage. A tight deadline's cost is a user who can never complete an
/// update at all on a slow connection. The former is recoverable by waiting;
/// the latter is not, so this errs long.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

/// A ureq agent bounded by `MANIFEST_TIMEOUT`, used for the manifest fetch
/// (and the newest-release lookup that precedes it on a candidate build).
fn manifest_agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(MANIFEST_TIMEOUT))
            .build(),
    )
}

/// A ureq agent bounded by `DOWNLOAD_TIMEOUT`, used for the artifact
/// download.
fn download_agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_global(Some(DOWNLOAD_TIMEOUT))
            .build(),
    )
}

/// Whether the last check attempt recorded in `state` is recent enough that
/// this one must not reach the network. `None` (never checked) is never
/// recent.
fn recently_checked(state: &store::AppUpdateState, now: i64, current: &str) -> bool {
    // A check made by a DIFFERENT build never suppresses this one. The interval
    // is there to stop repeated identical checks from spending GitHub's
    // unauthenticated rate limit; it is not a reason to hand someone who just
    // installed a new version a verdict reached about the binary they replaced.
    // Without this, upgrading inside the window showed "postponed" at startup
    // and no badge, while the manual button immediately found the update.
    if state.last_check_version.as_deref() != Some(current) {
        return false;
    }
    state
        .last_check_at
        .is_some_and(|at| now.saturating_sub(at) < CHECK_INTERVAL_SECS)
}

/// Revalidate a previously resolved offer against the version running RIGHT
/// NOW, so a cached offer can never outlive the update it describes: a user
/// who installed the update by hand (or any process restart onto a newer
/// build) must stop seeing the badge rather than being nagged by a stale
/// cache forever.
///
/// Recomputes `bump` fresh against `current` -- the persisted value was
/// computed against whatever was running at the time the offer was decided,
/// which may no longer be this build. Returns `None` once `current` has
/// caught up to (or passed) the offer's version, or if either fails to
/// parse.
fn revalidate(offer: UpdateOffer, current: &str) -> Option<UpdateOffer> {
    let current_version = Version::parse(current)?;
    let offer_version = Version::parse(&offer.version)?;
    if offer_version <= current_version {
        return None;
    }
    Some(UpdateOffer {
        bump: bump_between(&current_version, &offer_version),
        ..offer
    })
}

/// The result of a suppressed check: the persisted offer, revalidated
/// against `current`, and restored into the in-memory session so a fresh
/// process (the common case -- a suppressed check almost always follows a
/// restart) can still `download`/`install` it without a prior real check in
/// this process. Never touches disk or the network.
///
/// Does not disturb a session that already holds an offer: a suppressed
/// check can also happen later in the same process (a scheduled recheck
/// inside the interval), and that offer is already current.
fn suppressed_offer(
    ctx: &AppContext,
    state: store::AppUpdateState,
    current: &str,
) -> Option<AppUpdateOffer> {
    let offer = revalidate(state.cached_offer?, current)?;
    let dto = to_dto(&offer, state.dismissed_version.as_deref());

    let mut session = lock(ctx);
    if session.offer.is_none() {
        session.offer = Some(offer);
    }

    Some(dto)
}

/// The real work of `check`, taking the manifest fetch's outcome as a plain
/// argument rather than performing it -- so tests can drive both branches
/// (a manifest, or a fetch failure) without reaching the network at all.
///
/// `last_check_at` is written unconditionally, before the manifest result is
/// even inspected for `decide`, so a failed fetch defers a full day exactly
/// like a successful one that found nothing worth offering. A failed fetch
/// carries no new information, so `cached_offer` is left untouched rather
/// than cleared -- a transient network error must not erase a still-valid
/// offer the same way a suppressed check must not. A successful fetch is
/// authoritative: whatever it decides, offer or nothing, replaces whatever
/// was cached before.
fn decide_and_record(
    ctx: &AppContext,
    manifest: Result<Manifest, String>,
) -> Option<AppUpdateOffer> {
    let mut state = store::load(&ctx.fs, &ctx.paths.app_update_json);
    let current = env!("CARGO_PKG_VERSION");
    state.last_check_at = Some(ctx.clock.now() / 1000);
    state.last_check_version = Some(current.to_string());

    let asset_key = host_asset_key();
    let appimage = std::env::var("APPIMAGE").is_ok();
    let kinds = preferred_kinds(std::env::consts::OS, appimage);

    let offer = match manifest {
        Ok(manifest) => {
            let offer = decide(
                &manifest,
                &DecideInput {
                    current,
                    dismissed: state.dismissed_version.as_deref(),
                    asset_key: &asset_key,
                    kinds,
                    repo: fetch::REPO,
                },
            );
            state.cached_offer = offer.clone();
            offer
        }
        Err(_) => state
            .cached_offer
            .clone()
            .and_then(|o| revalidate(o, current)),
    };

    let _ = store::save(&ctx.fs, &ctx.paths.app_update_json, &state);

    let dto = offer
        .as_ref()
        .map(|o| to_dto(o, state.dismissed_version.as_deref()));

    // A fresh check supersedes whatever `download`/`install` were holding:
    // any previously downloaded artifact belongs to the offer this just
    // replaced. Bumping `generation` also invalidates a download already in
    // flight for the offer being replaced -- see `record_download`.
    let mut session = lock(ctx);
    session.generation = session.generation.wrapping_add(1);
    session.offer = offer;
    session.downloaded = None;

    dto
}

/// The manifest fetch for the running version's channel: a candidate build
/// resolves the newest release (prereleases included) rather than the plain
/// "latest" alias -- running a candidate IS opting into that stream. Shared by
/// `check` and `check_forced` so the channel decision is not duplicated
/// between them.
fn fetch_manifest_for(current: &str) -> Result<Manifest, String> {
    let prerelease_channel = Version::parse(current)
        .map(|v| v.is_prerelease())
        .unwrap_or(false);
    let agent = manifest_agent();
    fetch::fetch_manifest(&agent, prerelease_channel)
}

/// `app_update:check` -- fetch the release manifest and decide whether an
/// update is worth offering, or -- when [`CHECK_INTERVAL_SECS`] has not yet
/// elapsed since the last attempt -- return the persisted offer from that
/// last attempt instead of touching the network at all.
///
/// Runs in a debug build too. It used to skip them outright, on the theory
/// that a development build would be perpetually "behind" the last release
/// and would nag on every launch -- which was wrong twice over. A dev build's
/// version comes from the working tree and IS a real version, so `decide`
/// offers something only when something genuinely newer exists; and the skip
/// quietly turned "check on startup" into "never check", which is both a
/// broken promise and unobservable, since the attempt never even recorded a
/// timestamp. It also made the feature impossible to exercise in the one
/// environment it is developed in.
///
/// Returns a [`CheckOutcome`] rather than a bare `Option` so the caller can
/// tell a real network check apart from one this call refused to make (see
/// `CheckOutcome::suppressed`, now set only by the interval). An explicit,
/// user-initiated check ignores the interval too -- see [`check_forced`].
pub fn check(ctx: &AppContext) -> CheckOutcome {
    let current = env!("CARGO_PKG_VERSION");
    let state = store::load(&ctx.fs, &ctx.paths.app_update_json);
    let now = ctx.clock.now() / 1000;
    if recently_checked(&state, now, current) {
        return CheckOutcome {
            offer: suppressed_offer(ctx, state, current),
            suppressed: true,
        };
    }

    let offer = decide_and_record(ctx, fetch_manifest_for(current));
    CheckOutcome {
        offer,
        suppressed: false,
    }
}

/// `appUpdate:checkNow` -- an explicit, user-initiated check, invoked from the
/// About dialog's "Check for updates" button rather than the renderer's own
/// 24-hour schedule.
///
/// Ignores [`CHECK_INTERVAL_SECS`], the one gate `check` still has. That gate
/// protects GitHub's unauthenticated rate limit (60 requests/hour/IP) from an
/// automatic schedule firing on every relaunch; a single deliberate request
/// cannot threaten it the way an unattended background schedule could.
///
/// Unlike `check`, a manifest-fetch failure is surfaced as `Err` here instead
/// of being folded into a silent cached-offer fallback: a person who
/// explicitly asked needs to be told the request failed
/// (`appUpdate.checkFailed`), not handed a possibly-stale "no update" with no
/// explanation. `last_check_at` is still written unconditionally either way,
/// exactly like an automatic check -- see [`decide_and_record`].
pub fn check_forced(ctx: &AppContext) -> Result<Option<AppUpdateOffer>, String> {
    let current = env!("CARGO_PKG_VERSION");
    check_forced_with(ctx, fetch_manifest_for(current))
}

/// The real work of [`check_forced`], taking the manifest fetch's outcome as
/// a plain argument for the same reason [`decide_and_record`] does: so tests
/// can drive both branches -- and prove neither gate applies -- without
/// reaching the network.
fn check_forced_with(
    ctx: &AppContext,
    manifest: Result<Manifest, String>,
) -> Result<Option<AppUpdateOffer>, String> {
    let failed = manifest.as_ref().err().cloned();
    let offer = decide_and_record(ctx, manifest);
    match failed {
        Some(message) => Err(message),
        None => Ok(offer),
    }
}

/// The artifact, download URL, and current generation for the offer `check`
/// last decided. The generation travels with the artifact/URL so a download
/// started from this offer can later prove, in `record_download`, that
/// nothing replaced it while it ran.
///
/// # Errors
///
/// Returns a message when there is no held offer, or it has no artifact/URL
/// for this host.
fn current_artifact(ctx: &AppContext) -> Result<(Artifact, String, u64), String> {
    let session = lock(ctx);
    let offer = session
        .offer
        .as_ref()
        .ok_or_else(|| "no update offer to download".to_string())?;
    let artifact = offer
        .artifact
        .clone()
        .ok_or_else(|| "no artifact for this host".to_string())?;
    let url = offer
        .url
        .clone()
        .ok_or_else(|| "no download url for this host".to_string())?;
    Ok((artifact, url, session.generation))
}

/// Record a finished download's path against the session -- but only if the
/// offer it was started for (`generation`) is still the one the session
/// holds. If a `check` replaced the offer while the download was running,
/// the file on disk belongs to a decision that no longer matches `offer`;
/// recording it there would let a later install apply a mismatched
/// (offer, artifact) pair, so this refuses instead.
///
/// Returns the version to report in `appUpdate:ready` on success.
///
/// # Errors
///
/// Returns a message when the session moved on to a different offer while
/// the download was in flight.
fn record_download(ctx: &AppContext, generation: u64, dest: PathBuf) -> Result<String, String> {
    let mut session = lock(ctx);
    if session.generation != generation {
        return Err(
            "the update offer changed while downloading; discarding this download".to_string(),
        );
    }
    session.downloaded = Some(dest);
    Ok(session
        .offer
        .as_ref()
        .map(|o| o.version.clone())
        .unwrap_or_default())
}

/// Download and verify the artifact for the held offer, reporting progress.
///
/// # Errors
///
/// Returns a message on a network failure, an IO failure, a checksum
/// mismatch, or a `check` replacing the offer before this finishes. Never
/// re-fetches the manifest -- the offer came from `check`.
fn run_download(ctx: &AppContext, app: &AppHandle) -> Result<(), String> {
    let (artifact, url, generation) = current_artifact(ctx)?;
    let dest = download_dest(ctx, &artifact);
    std::fs::create_dir_all(download_dir(ctx)).map_err(|e| e.to_string())?;

    let agent = download_agent();
    let progress_app = app.clone();
    fetch::download(&agent, &url, &dest, &|percent| {
        let _ = progress_app.emit("appUpdate:progress", ProgressPayload { percent });
    })?;
    verify::verify(&dest, &artifact.sha256)?;

    let version = record_download(ctx, generation, dest.clone())?;

    let _ = app.emit(
        "appUpdate:ready",
        ReadyPayload {
            version,
            path: dest.to_string_lossy().into_owned(),
        },
    );
    Ok(())
}

/// `app_update:download` -- download and verify the artifact for the held
/// offer, ending in exactly one of `appUpdate:ready` or `appUpdate:failed`.
fn download(ctx: &AppContext, app: &AppHandle) {
    if let Err(message) = run_download(ctx, app) {
        let _ = app.emit(
            "appUpdate:failed",
            FailedPayload {
                message,
                phase: "download",
                path: None,
                offer: None,
                install_ready: false,
            },
        );
    }
}

/// The running app bundle's own path, needed only for a macOS dmg install.
///
/// Not gated to `target_os = "macos"`: it degrades to `None` on every other
/// host (the `.app/` marker is never found), which is exactly what
/// `plan_install` needs there.
fn running_app_bundle() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let real = std::fs::canonicalize(&exe).unwrap_or(exe);
    let real = real.to_string_lossy().into_owned();
    let marker = real.find(".app/")?;
    Some(real[..marker + ".app".len()].to_string())
}

/// Plan and execute the install for the artifact `download` already
/// verified.
///
/// # Errors
///
/// Returns a message when nothing was downloaded, the held offer has no
/// artifact, or [`install::plan_install`]/[`install::execute`] fails.
fn plan_and_execute(ctx: &AppContext) -> Result<(), String> {
    let (downloaded, kind) = {
        let session = lock(ctx);
        let downloaded = session
            .downloaded
            .clone()
            .ok_or_else(|| "no downloaded update to install".to_string())?;
        let kind = session
            .offer
            .as_ref()
            .and_then(|o| o.artifact.as_ref())
            .map(|a| a.kind.clone())
            .ok_or_else(|| "no artifact for this host".to_string())?;
        (downloaded, kind)
    };

    let os = std::env::consts::OS;
    let app_path = running_app_bundle();
    let appimage = std::env::var("APPIMAGE").ok();
    let pid = std::process::id();

    let plan = install::plan_install(
        os,
        &kind,
        &downloaded,
        app_path.as_deref(),
        appimage.as_deref(),
        pid,
    )?;
    install::execute(&plan)
}

/// `app_update:install` -- install the artifact `download` already verified,
/// then exit.
///
/// If the install fails, this emits `appUpdate:failed` and does NOT exit:
/// quitting after a failed install would leave the user with no app and no
/// explanation.
fn install_update(ctx: &AppContext, app: &AppHandle) {
    match plan_and_execute(ctx) {
        Ok(()) => app.exit(0),
        Err(message) => {
            let _ = app.emit(
                "appUpdate:failed",
                FailedPayload {
                    message,
                    phase: "install",
                    // The ready dialog is already open in this process (see
                    // its doc comment: nothing closes it on an install
                    // failure), so it does not need reopening -- unlike the
                    // marker-based case in `pending_install_failure`.
                    path: None,
                    offer: None,
                    install_ready: false,
                },
            );
        }
    }
}

/// `app_update:discard` -- delete the downloaded artifact and forget it, so a
/// later `app_update_download` starts fresh. Ignores a missing file: there is
/// nothing to discard if the user never downloaded one, or already installed
/// it.
fn discard(ctx: &AppContext) {
    lock(ctx).downloaded = None;
    let _ = std::fs::remove_dir_all(download_dir(ctx));
}

/// The path `install::INSTALL_FAILED_MARKER` is written to for the artifact
/// currently (or most recently) in `download_dir`.
fn install_failure_marker(ctx: &AppContext) -> PathBuf {
    download_dir(ctx).join(install::INSTALL_FAILED_MARKER)
}

/// Remove anything left in the download directory from a previous run,
/// UNLESS a helper script left an install-failure marker there.
///
/// Meant to be called once, at startup, before any command touches
/// `update/`. `download_dir` lives inside the app's own data directory
/// rather than the OS temp directory (a deliberate trade for hermetic tests),
/// so a crash leaves the OS temp reaper unable to help -- and an installer
/// can be 150 MB. A download discarded because a `check` superseded it has
/// the same problem, since nothing sweeps it until now. Safe to call
/// unconditionally: a fresh process has no session referencing anything
/// under this directory yet.
///
/// The marker check is the other half of C1's fix: on the two platforms
/// where the install replaces the running application, a failed copy is
/// invisible to this process (see `app::app_update::install`'s module doc).
/// The only trace it leaves is the marker file, read back (and consumed) by
/// `report_pending_install_failure`. Deleting the directory here, before
/// that read happens, would both destroy the evidence of the failure AND
/// force the user to re-download the artifact -- typically a dmg or
/// AppImage close to 150 MB -- on every single relaunch.
pub fn sweep_stale_downloads(ctx: &AppContext) {
    if install_failure_marker(ctx).exists() {
        return;
    }
    let _ = std::fs::remove_dir_all(download_dir(ctx));
}

/// Read and consume a pending install-failure marker, returning the raw exit
/// status text a previous run's helper script recorded (empty if the script
/// wrote the marker without one). Removes the marker so it is reported
/// exactly once; never touches the downloaded artifact itself.
fn take_pending_install_failure(ctx: &AppContext) -> Option<String> {
    let marker = install_failure_marker(ctx);
    let status = std::fs::read_to_string(&marker).ok()?;
    let _ = std::fs::remove_file(&marker);
    Some(status.trim().to_string())
}

/// The path of the one file `sweep_stale_downloads` preserved for a pending
/// install failure: the entry in the download directory that is neither the
/// failure marker itself nor a `.part` temp file left by an interrupted
/// download. `None` if nothing else is there -- the artifact this failure
/// refers to is for some reason already gone -- in which case there is
/// nothing concrete to tell the user to install by hand.
fn preserved_artifact_path(ctx: &AppContext) -> Option<PathBuf> {
    let marker_name = std::ffi::OsStr::new(install::INSTALL_FAILED_MARKER);
    std::fs::read_dir(download_dir(ctx))
        .ok()?
        .flatten()
        .find_map(|entry| {
            let name = entry.file_name();
            if name == marker_name || name.to_string_lossy().ends_with(".part") {
                return None;
            }
            let path = entry.path();
            path.is_file().then_some(path)
        })
}

/// Attempt to rehydrate the session's `downloaded` field from a preserved
/// artifact at `path`, so `app_update_install` can retry against the file
/// already on disk instead of "no downloaded update to install" forcing a
/// full redownload of what is likely a ~150 MB installer.
///
/// The artifact has been sitting on disk across a full process exit, so it
/// is re-verified exactly as a fresh download would be: its SHA-256 must
/// match the CURRENTLY held offer's artifact -- not whatever offer was active
/// when the failed install happened. That is deliberate, not an
/// approximation: if `check` (which has already run by the time this is
/// called -- see `report_pending_install_failure`) moved on to a different
/// release since the failed attempt, the preserved file's hash simply will
/// not match the new offer's, and verification fails closed. Writing
/// `downloaded` also goes through the existing `record_download`, which
/// re-checks `generation` under the lock -- the same guard a real download
/// completing late is subject to -- rather than assigning the field
/// directly, so this rehydration path cannot pair a stale file with a
/// superseded offer any more than a normal download could.
///
/// Returns whether the session now holds `path` as a valid, verified
/// download. `false` on a missing/artifact-less offer, a hash mismatch, or a
/// generation change -- in every case the session is left untouched, so a
/// later `app_update_install` reports the honest "no downloaded update to
/// install" rather than being handed a corrupt or mismatched file.
fn rehydrate_preserved_download(ctx: &AppContext, path: &Path) -> bool {
    let (generation, expected_sha256) = {
        let session = lock(ctx);
        let Some(artifact) = session.offer.as_ref().and_then(|o| o.artifact.as_ref()) else {
            return false;
        };
        (session.generation, artifact.sha256.clone())
    };
    if verify::verify(path, &expected_sha256).is_err() {
        return false;
    }
    record_download(ctx, generation, path.to_path_buf()).is_ok()
}

/// What to report for a pending install failure found at startup, if any --
/// see `take_pending_install_failure`.
///
/// `current_offer` is whatever `check` just decided in the SAME call to
/// `app_update_check`, passed in rather than recomputed, so a reopened ready
/// dialog shows exactly the offer this command is about to return, not a
/// second, possibly different, decision.
///
/// `path`/`offer` on the returned payload are populated ONLY when the
/// preserved artifact can still be found on disk. That is the signal the
/// renderer uses to reopen the ready dialog: on the two platforms where an
/// install replaces the running application, a failure discovered this way
/// happened in a helper script after this process's PREVIOUS run had already
/// exited, so the ready dialog carrying the manual fallback never opened in
/// this session at all -- unlike a same-session install failure, where it is
/// already open (see `install_update`). Without a preserved artifact there is
/// nothing concrete to install by hand, so the message does not claim there
/// is, and the renderer leaves the toast as the whole story.
///
/// When a preserved artifact IS found, [`rehydrate_preserved_download`]
/// verifies it and, on success, records it against the session so
/// `install_ready` on the payload is `true` and a same-click "Install now"
/// from the reopened dialog can proceed without redownloading. A failed
/// verification leaves `install_ready` `false`: the dialog (and the macOS
/// fallback command, which names no file and is unaffected either way) still
/// reopens, but the renderer must not offer "Install now" as though it will
/// work.
fn pending_install_failure(
    ctx: &AppContext,
    current_offer: Option<&AppUpdateOffer>,
) -> Option<FailedPayload> {
    let status = take_pending_install_failure(ctx)?;
    let preserved = preserved_artifact_path(ctx);
    let install_ready = preserved
        .as_deref()
        .is_some_and(|p| rehydrate_preserved_download(ctx, p));
    let path = preserved.map(|p| p.to_string_lossy().into_owned());

    let message = if !status.is_empty() {
        format!("the automatic install failed (helper script exited with status {status})")
    } else if path.is_some() {
        "the automatic install failed; see the manual install instructions below".to_string()
    } else {
        "the automatic install failed".to_string()
    };

    Some(FailedPayload {
        message,
        phase: "install",
        offer: path.as_ref().and_then(|_| current_offer.cloned()),
        path,
        install_ready,
    })
}

/// Surface a pending install failure (see `pending_install_failure`) as
/// `appUpdate:failed { phase: "install" }`, if the startup sweep found one.
///
/// Called from `app_update_check` rather than from startup directly: startup
/// (`lib.rs::run`) has no `AppHandle` yet, and even if it did, the renderer
/// has not necessarily mounted its `onAppUpdateFailed` listener that early.
/// `app_update_check` is the first command the renderer issues once its
/// initial load settles, by which point `useAppUpdateSchedule`'s listener
/// effects (registered unconditionally on mount, before that first check
/// resolves) are already wired up. Called AFTER `check` has decided this
/// call's offer, so `current_offer` reflects exactly what the renderer is
/// about to receive as this same command's return value.
fn report_pending_install_failure(
    ctx: &AppContext,
    app: &AppHandle,
    current_offer: Option<&AppUpdateOffer>,
) {
    if let Some(payload) = pending_install_failure(ctx, current_offer) {
        let _ = app.emit("appUpdate:failed", payload);
    }
}

/// `app_update:dismiss` -- remember `version` as refused, so the dialog stays
/// down until a newer minor or major line appears (see
/// [`should_show_dialog`]).
fn dismiss(ctx: &AppContext, version: String) {
    let mut state = store::load(&ctx.fs, &ctx.paths.app_update_json);
    state.dismissed_version = Some(version);
    let _ = store::save(&ctx.fs, &ctx.paths.app_update_json, &state);
}

// ---------------------------------------------------------------------------
// Tauri command wrappers. Thin adapters over the `&AppContext` functions above.
// ---------------------------------------------------------------------------

/// `appUpdate:check`.
///
/// Also reports a pending install failure left by a previous run's helper
/// script, if the startup sweep found one -- see
/// `report_pending_install_failure`. Runs `check` first so the report can
/// carry this call's own decided offer.
#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
) -> Result<CheckOutcome, String> {
    blocking(&ctx, move |c| {
        let outcome = check(c);
        report_pending_install_failure(c, &app, outcome.offer.as_ref());
        outcome
    })
    .await
}

/// `appUpdate:checkNow` -- explicit, user-initiated check; see
/// [`check_forced`].
///
/// Does not also call `report_pending_install_failure`: that marker-based
/// report is one-time (the marker is consumed on first read) and is already
/// surfaced by the automatic startup check that always runs first -- the
/// renderer issues `app_update_check` once its initial load settles, before a
/// person could ever reach the button that calls this command.
#[tauri::command]
pub async fn app_update_check_now(
    ctx: State<'_, Arc<AppContext>>,
) -> Result<Option<AppUpdateOffer>, String> {
    blocking(&ctx, check_forced).await?
}

/// `appUpdate:download`.
#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    blocking(&ctx, move |c| download(c, &app)).await
}

/// `appUpdate:install`.
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    ctx: State<'_, Arc<AppContext>>,
) -> Result<(), String> {
    blocking(&ctx, move |c| install_update(c, &app)).await
}

/// `appUpdate:discard`.
#[tauri::command]
pub async fn app_update_discard(ctx: State<'_, Arc<AppContext>>) -> Result<(), String> {
    blocking(&ctx, discard).await
}

/// `appUpdate:dismiss`.
#[tauri::command]
pub async fn app_update_dismiss(
    ctx: State<'_, Arc<AppContext>>,
    version: String,
) -> Result<(), String> {
    blocking(&ctx, move |c| dismiss(c, version)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::TempAppData;

    fn sample_offer(url: Option<&str>) -> UpdateOffer {
        UpdateOffer {
            version: "9.9.9".to_string(),
            tag: "v9.9.9".to_string(),
            bump: Bump::Minor,
            notes: "notes".to_string(),
            truncated_history: false,
            artifact: url.map(|_| Artifact {
                kind: "deb".to_string(),
                name: "skillkeeper.deb".to_string(),
                sha256: "aa".to_string(),
            }),
            url: url.map(str::to_string),
        }
    }

    #[test]
    fn a_check_inside_the_interval_is_suppressed_without_touching_the_network() {
        // `check` no longer skips debug builds, so this is the only remaining
        // path through it that is safe to exercise in a test: a recent
        // `last_check_at` must make it return before any fetch. If that ever
        // regresses, this test starts making a real request, which is itself
        // the signal.
        let app = TempAppData::new();
        let now = app.ctx.clock.now() / 1000;
        store::save(
            &app.ctx.fs,
            &app.ctx.paths.app_update_json,
            &store::AppUpdateState {
                last_check_at: Some(now),
                // Must match the running version, or the gate deliberately
                // refuses to suppress -- see `recently_checked`.
                last_check_version: Some(env!("CARGO_PKG_VERSION").to_string()),
                ..Default::default()
            },
        )
        .unwrap();

        let outcome = check(&app.ctx);
        assert!(
            outcome.suppressed,
            "a check inside the interval must report itself suppressed"
        );
        assert!(outcome.offer.is_none(), "nothing was ever cached to return");
    }

    #[test]
    fn bump_str_lowercases_each_variant() {
        assert_eq!(bump_str(Bump::Major), "major");
        assert_eq!(bump_str(Bump::Minor), "minor");
        assert_eq!(bump_str(Bump::Patch), "patch");
    }

    #[test]
    fn dto_reflects_installable_and_show_dialog() {
        let offer = sample_offer(Some("https://example.invalid/skillkeeper.deb"));
        let dto = to_dto(&offer, None);
        assert_eq!(dto.version, "9.9.9");
        assert_eq!(dto.bump, "minor");
        assert!(dto.installable);
        assert!(dto.show_dialog);
    }

    #[test]
    fn dto_is_not_installable_without_an_artifact() {
        let offer = sample_offer(None);
        let dto = to_dto(&offer, None);
        assert!(!dto.installable);
    }

    #[test]
    fn a_patch_dismissed_version_never_shows_the_dialog_again() {
        let offer = sample_offer(Some("https://example.invalid/skillkeeper.deb"));
        assert!(!to_dto(&offer, Some("9.9.9")).show_dialog);
    }

    #[test]
    fn current_artifact_errs_with_no_offer() {
        let app = TempAppData::new();
        assert!(current_artifact(&app.ctx).is_err());
    }

    #[test]
    fn current_artifact_errs_with_no_url() {
        let app = TempAppData::new();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(None)),
            downloaded: None,
            generation: 0,
        };
        assert!(current_artifact(&app.ctx).is_err());
    }

    #[test]
    fn current_artifact_reads_the_held_offer() {
        let app = TempAppData::new();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            downloaded: None,
            generation: 7,
        };
        let (artifact, url, generation) = current_artifact(&app.ctx).unwrap();
        assert_eq!(artifact.name, "skillkeeper.deb");
        assert_eq!(url, "https://example.invalid/skillkeeper.deb");
        assert_eq!(generation, 7);
    }

    #[test]
    fn plan_and_execute_errs_with_nothing_downloaded() {
        let app = TempAppData::new();
        assert!(plan_and_execute(&app.ctx).is_err());
    }

    #[test]
    fn discard_clears_the_session_and_removes_the_temp_dir() {
        let app = TempAppData::new();
        let artifact = Artifact {
            kind: "deb".to_string(),
            name: "skillkeeper.deb".to_string(),
            sha256: "aa".to_string(),
        };
        let dest = download_dest(&app.ctx, &artifact);
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(&dest, b"stub").unwrap();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            downloaded: Some(dest.clone()),
            generation: 0,
        };

        discard(&app.ctx);

        assert!(app.ctx.app_update.lock().unwrap().downloaded.is_none());
        assert!(!dest.exists());
        assert!(!download_dir(&app.ctx).exists());
    }

    #[test]
    fn discard_ignores_a_missing_download() {
        let app = TempAppData::new();
        discard(&app.ctx);
        assert!(app.ctx.app_update.lock().unwrap().downloaded.is_none());
    }

    #[test]
    fn sweep_stale_downloads_removes_a_leftover_directory() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(download_dir(&app.ctx).join("stale.deb"), b"stale").unwrap();

        sweep_stale_downloads(&app.ctx);

        assert!(!download_dir(&app.ctx).exists());
    }

    #[test]
    fn sweep_stale_downloads_tolerates_a_missing_directory() {
        let app = TempAppData::new();
        sweep_stale_downloads(&app.ctx); // must not panic
        assert!(!download_dir(&app.ctx).exists());
    }

    // --- C1: a failed helper-script install must be reportable, and the
    // artifact it left behind must survive the startup sweep. ---

    #[test]
    fn sweep_stale_downloads_preserves_everything_when_a_failure_marker_is_present() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(download_dir(&app.ctx).join("skillkeeper.dmg"), b"artifact").unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "1").unwrap();

        sweep_stale_downloads(&app.ctx);

        assert!(
            download_dir(&app.ctx).join("skillkeeper.dmg").exists(),
            "the artifact must survive so the user is not forced to re-download it"
        );
        assert!(
            install_failure_marker(&app.ctx).exists(),
            "the marker itself must survive until report_pending_install_failure reads it"
        );
    }

    #[test]
    fn take_pending_install_failure_reads_and_consumes_the_marker() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(download_dir(&app.ctx).join("skillkeeper.dmg"), b"artifact").unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "1\n").unwrap();

        let status = take_pending_install_failure(&app.ctx).unwrap();

        assert_eq!(status, "1");
        assert!(
            !install_failure_marker(&app.ctx).exists(),
            "the marker must be consumed so it is reported exactly once"
        );
        assert!(
            download_dir(&app.ctx).join("skillkeeper.dmg").exists(),
            "consuming the marker must never touch the artifact"
        );
    }

    #[test]
    fn take_pending_install_failure_is_none_with_nothing_recorded() {
        let app = TempAppData::new();
        assert!(take_pending_install_failure(&app.ctx).is_none());
    }

    #[test]
    fn take_pending_install_failure_returns_an_empty_string_for_an_empty_marker() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "").unwrap();

        assert_eq!(take_pending_install_failure(&app.ctx), Some(String::new()));
    }

    // --- Re-review of the fix wave: the marker-based failure must reach the
    // renderer with enough to reopen the ready dialog, not just a toast. ---

    #[test]
    fn pending_install_failure_is_none_with_nothing_recorded() {
        let app = TempAppData::new();
        assert!(pending_install_failure(&app.ctx, None).is_none());
    }

    #[test]
    fn pending_install_failure_carries_the_preserved_path_and_offer() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(download_dir(&app.ctx).join("SkillKeeper.dmg"), b"artifact").unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "").unwrap();
        let offer = to_dto(
            &sample_offer(Some("https://example.invalid/skillkeeper.deb")),
            None,
        );

        let payload = pending_install_failure(&app.ctx, Some(&offer)).unwrap();

        assert_eq!(payload.phase, "install");
        assert!(
            payload.message.contains("below"),
            "the message must only promise a fallback that is actually reachable"
        );
        let expected_path = download_dir(&app.ctx)
            .join("SkillKeeper.dmg")
            .to_string_lossy()
            .into_owned();
        assert_eq!(payload.path.as_deref(), Some(expected_path.as_str()));
        assert_eq!(
            payload.offer.as_ref().map(|o| o.version.as_str()),
            Some("9.9.9")
        );
    }

    /// A domain offer whose artifact's declared SHA-256 is `sha256`, for the
    /// rehydration tests below, which need control over the digest rather
    /// than `sample_offer`'s fixed placeholder.
    fn offer_with_sha256(sha256: &str) -> UpdateOffer {
        UpdateOffer {
            version: "9.9.9".to_string(),
            tag: "v9.9.9".to_string(),
            bump: Bump::Minor,
            notes: "notes".to_string(),
            truncated_history: false,
            artifact: Some(Artifact {
                kind: "dmg".to_string(),
                name: "SkillKeeper.dmg".to_string(),
                sha256: sha256.to_string(),
            }),
            url: Some("https://example.invalid/SkillKeeper.dmg".to_string()),
        }
    }

    // --- Coordinator follow-up: "Install now" from the reopened dialog must
    // retry against the preserved artifact, not fail with "no downloaded
    // update to install" -- but only when that artifact still verifies. ---

    #[test]
    fn pending_install_failure_rehydrates_the_session_when_the_artifact_verifies() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        let dest = download_dir(&app.ctx).join("SkillKeeper.dmg");
        std::fs::write(&dest, b"a genuinely complete, unmodified artifact").unwrap();
        let sha256 = verify::sha256_file(&dest).unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "").unwrap();

        let domain_offer = offer_with_sha256(&sha256);
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(domain_offer.clone()),
            downloaded: None,
            generation: 4,
        };
        let dto = to_dto(&domain_offer, None);

        let payload = pending_install_failure(&app.ctx, Some(&dto)).unwrap();

        assert!(
            payload.install_ready,
            "a preserved artifact that verifies must make the session installable"
        );
        assert_eq!(
            app.ctx.app_update.lock().unwrap().downloaded,
            Some(dest),
            "the session must hold the preserved artifact so Install now can \
             retry without a fresh download"
        );
        // The generation the rehydration wrote against must be unchanged --
        // rehydrating must never look like a new download superseding it.
        assert_eq!(app.ctx.app_update.lock().unwrap().generation, 4);
    }

    #[test]
    fn pending_install_failure_does_not_rehydrate_a_corrupt_artifact() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        let dest = download_dir(&app.ctx).join("SkillKeeper.dmg");
        std::fs::write(&dest, b"truncated garbage, not what was published").unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "").unwrap();

        // A digest that does not match the file's actual content -- as if the
        // copy across the failed install (or across the process exit) landed
        // on a corrupt or partial file.
        let domain_offer =
            offer_with_sha256("0000000000000000000000000000000000000000000000000000000000000000");
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(domain_offer.clone()),
            downloaded: None,
            generation: 4,
        };
        let dto = to_dto(&domain_offer, None);

        let payload = pending_install_failure(&app.ctx, Some(&dto)).unwrap();

        assert!(
            !payload.install_ready,
            "a corrupt or mismatched artifact must never be handed to the installer"
        );
        assert!(
            app.ctx.app_update.lock().unwrap().downloaded.is_none(),
            "the session must stay empty so a later Install now fails honestly \
             instead of running a bad file"
        );
        // The dialog itself must still be reachable: the path and the offer
        // (and, on macOS, the fallback command, which names no file) are
        // unaffected by verification failing.
        assert!(payload.path.is_some());
        assert!(payload.offer.is_some());
    }

    #[test]
    fn rehydrate_preserved_download_is_false_with_no_offer_held() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        let dest = download_dir(&app.ctx).join("SkillKeeper.dmg");
        std::fs::write(&dest, b"bytes").unwrap();

        assert!(!rehydrate_preserved_download(&app.ctx, &dest));
        assert!(app.ctx.app_update.lock().unwrap().downloaded.is_none());
    }

    #[test]
    fn pending_install_failure_leaves_path_and_offer_dark_without_a_preserved_artifact() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "").unwrap();
        let offer = to_dto(
            &sample_offer(Some("https://example.invalid/skillkeeper.deb")),
            None,
        );

        let payload = pending_install_failure(&app.ctx, Some(&offer)).unwrap();

        assert!(payload.path.is_none());
        assert!(payload.offer.is_none());
        assert!(
            !payload.message.contains("below"),
            "must not point at fallback instructions that have nowhere to render"
        );
    }

    #[test]
    fn pending_install_failure_reports_the_exit_status_when_one_was_recorded() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(download_dir(&app.ctx).join("SkillKeeper.dmg"), b"artifact").unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "1\n").unwrap();

        let payload = pending_install_failure(&app.ctx, None).unwrap();

        assert!(payload.message.contains('1'));
        // The path still travels even though no offer was decided this call
        // (an interval-suppressed check with nothing cached, or a real check
        // that failed) -- the offer is simply left off the payload then.
        assert!(payload.path.is_some());
        assert!(payload.offer.is_none());
    }

    #[test]
    fn pending_install_failure_consumes_the_marker_exactly_once() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "1").unwrap();
        assert!(pending_install_failure(&app.ctx, None).is_some());
        assert!(pending_install_failure(&app.ctx, None).is_none());
    }

    #[test]
    fn preserved_artifact_path_ignores_the_marker_and_part_files() {
        let app = TempAppData::new();
        std::fs::create_dir_all(download_dir(&app.ctx)).unwrap();
        std::fs::write(install_failure_marker(&app.ctx), "1").unwrap();
        std::fs::write(
            download_dir(&app.ctx).join("SkillKeeper.dmg.part"),
            b"partial",
        )
        .unwrap();

        assert!(
            preserved_artifact_path(&app.ctx).is_none(),
            "a marker and a leftover .part file alone are not a preserved artifact"
        );

        std::fs::write(download_dir(&app.ctx).join("SkillKeeper.dmg"), b"artifact").unwrap();
        assert_eq!(
            preserved_artifact_path(&app.ctx),
            Some(download_dir(&app.ctx).join("SkillKeeper.dmg"))
        );
    }

    #[test]
    fn dismiss_persists_the_refused_version() {
        let app = TempAppData::new();
        dismiss(&app.ctx, "1.2.3".to_string());
        let state = store::load(&app.ctx.fs, &app.ctx.paths.app_update_json);
        assert_eq!(state.dismissed_version.as_deref(), Some("1.2.3"));
    }

    /// An empty-but-valid manifest: `decide` finds nothing to offer, but
    /// `decide_and_record` still has a real (`Ok`) fetch result to record
    /// `last_check_at` against, with no network involved.
    fn empty_manifest() -> Manifest {
        Manifest {
            schema: 1,
            generated_at: String::new(),
            versions: Vec::new(),
        }
    }

    #[test]
    fn last_check_at_is_written_after_a_successful_attempt() {
        let app = TempAppData::new();
        assert!(store::load(&app.ctx.fs, &app.ctx.paths.app_update_json)
            .last_check_at
            .is_none());
        decide_and_record(&app.ctx, Ok(empty_manifest()));
        assert!(store::load(&app.ctx.fs, &app.ctx.paths.app_update_json)
            .last_check_at
            .is_some());
    }

    #[test]
    fn last_check_at_is_written_after_a_failed_attempt() {
        let app = TempAppData::new();
        decide_and_record(&app.ctx, Err("network unreachable".to_string()));
        assert!(store::load(&app.ctx.fs, &app.ctx.paths.app_update_json)
            .last_check_at
            .is_some());
    }

    #[test]
    fn a_network_failure_preserves_the_previously_cached_offer() {
        let app = TempAppData::new();
        let seeded = store::AppUpdateState {
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };
        store::save(&app.ctx.fs, &app.ctx.paths.app_update_json, &seeded).unwrap();

        decide_and_record(&app.ctx, Err("network unreachable".to_string()));

        let state = store::load(&app.ctx.fs, &app.ctx.paths.app_update_json);
        assert!(
            state.cached_offer.is_some(),
            "a failed fetch must not erase a previously cached offer"
        );
    }

    #[test]
    fn a_successful_check_replaces_a_stale_cached_offer_with_nothing() {
        let app = TempAppData::new();
        let seeded = store::AppUpdateState {
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };
        store::save(&app.ctx.fs, &app.ctx.paths.app_update_json, &seeded).unwrap();

        decide_and_record(&app.ctx, Ok(empty_manifest()));

        let state = store::load(&app.ctx.fs, &app.ctx.paths.app_update_json);
        assert!(
            state.cached_offer.is_none(),
            "a real check is authoritative and must replace a stale cached offer"
        );
    }

    // --- A1: a suppressed check must still return the last known offer,
    // revalidated against the version running right now. ---

    #[test]
    fn revalidate_recomputes_the_bump_for_a_still_newer_offer() {
        let offer = sample_offer(Some("https://example.invalid/skillkeeper.deb"));
        assert_eq!(offer.bump, Bump::Minor);
        // The offer was decided as a Minor bump; against a much older
        // running version it must be recomputed as Major.
        let revalidated = revalidate(offer, "1.0.0").unwrap();
        assert_eq!(revalidated.version, "9.9.9");
        assert_eq!(revalidated.bump, Bump::Major);
    }

    #[test]
    fn revalidate_drops_an_offer_the_running_version_has_caught_up_to() {
        let offer = sample_offer(Some("https://example.invalid/skillkeeper.deb"));
        assert!(
            revalidate(offer.clone(), "9.9.9").is_none(),
            "a cached offer for the version now running must not survive"
        );
        assert!(
            revalidate(offer, "10.0.0").is_none(),
            "a cached offer must not outlive an even newer running version"
        );
    }

    #[test]
    fn a_version_change_defeats_the_interval() {
        // The regression this guards: install a new build inside the window,
        // and its startup check used to be suppressed by a verdict the PREVIOUS
        // build had reached -- reported as "postponed", no badge, while the
        // manual button immediately found the update.
        let state = store::AppUpdateState {
            last_check_at: Some(1_000_000),
            last_check_version: Some("0.5.0-rc.7".to_string()),
            ..Default::default()
        };
        let just_after = 1_000_000 + 60;

        assert!(
            recently_checked(&state, just_after, "0.5.0-rc.7"),
            "the same build inside the window must still be suppressed"
        );
        assert!(
            !recently_checked(&state, just_after, "0.5.0-rc.8"),
            "a different build must check, however recent the last attempt"
        );
    }

    #[test]
    fn a_check_records_which_version_made_it() {
        // Without this the gate above has nothing to compare against, so the
        // first check after an upgrade would suppress the next one.
        let app = TempAppData::new();
        decide_and_record(&app.ctx, Err("offline".to_string()));
        let state = store::load(&app.ctx.fs, &app.ctx.paths.app_update_json);
        assert_eq!(
            state.last_check_version.as_deref(),
            Some(env!("CARGO_PKG_VERSION")),
            "even a FAILED attempt must record the version that made it"
        );
    }

    #[test]
    fn recently_checked_is_false_when_never_checked() {
        assert!(!recently_checked(
            &store::AppUpdateState::default(),
            1_000_000,
            "1.0.0"
        ));
    }

    #[test]
    fn recently_checked_is_true_within_the_interval() {
        let state = store::AppUpdateState {
            last_check_at: Some(1_000_000),
            last_check_version: Some("1.0.0".to_string()),
            ..Default::default()
        };
        assert!(recently_checked(
            &state,
            1_000_000 + CHECK_INTERVAL_SECS - 1,
            "1.0.0"
        ));
    }

    #[test]
    fn recently_checked_is_false_once_the_interval_elapses() {
        let state = store::AppUpdateState {
            last_check_at: Some(1_000_000),
            last_check_version: Some("1.0.0".to_string()),
            ..Default::default()
        };
        assert!(!recently_checked(
            &state,
            1_000_000 + CHECK_INTERVAL_SECS,
            "1.0.0"
        ));

        // The point of the version guard: the same recent timestamp must NOT
        // suppress a check once the running build has changed.
        assert!(!recently_checked(&state, 1_000_000 + 1, "1.0.1"));
    }

    #[test]
    fn a_suppressed_check_returns_the_cached_offer() {
        let app = TempAppData::new();
        let state = store::AppUpdateState {
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };
        let dto = suppressed_offer(&app.ctx, state, "1.0.0").unwrap();
        assert_eq!(dto.version, "9.9.9");
        assert!(dto.installable);
    }

    #[test]
    fn a_suppressed_check_restores_the_offer_into_a_fresh_session() {
        let app = TempAppData::new();
        let state = store::AppUpdateState {
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };
        suppressed_offer(&app.ctx, state, "1.0.0").unwrap();
        // `download` reads the session offer directly; without restoring it
        // here, a badge shown from a suppressed check on a fresh process
        // would have no offer to act on.
        assert!(current_artifact(&app.ctx).is_ok());
    }

    #[test]
    fn a_suppressed_check_does_not_disturb_an_offer_already_in_the_session() {
        let app = TempAppData::new();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some("https://example.invalid/other.deb"))),
            downloaded: None,
            generation: 3,
        };
        let state = store::AppUpdateState {
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };

        suppressed_offer(&app.ctx, state, "1.0.0");

        let session = app.ctx.app_update.lock().unwrap();
        assert_eq!(
            session.generation, 3,
            "suppression must not bump generation"
        );
        assert_eq!(
            session.offer.as_ref().unwrap().url.as_deref(),
            Some("https://example.invalid/other.deb")
        );
    }

    #[test]
    fn a_cached_offer_at_or_below_the_running_version_returns_nothing() {
        let app = TempAppData::new();
        let state = store::AppUpdateState {
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };
        assert!(suppressed_offer(&app.ctx, state, "9.9.9").is_none());
    }

    #[test]
    fn a_suppressed_check_with_nothing_cached_returns_nothing() {
        let app = TempAppData::new();
        assert!(suppressed_offer(&app.ctx, store::AppUpdateState::default(), "1.0.0").is_none());
    }

    #[test]
    fn decide_and_record_bumps_the_generation_and_clears_any_download() {
        let app = TempAppData::new();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            downloaded: Some(PathBuf::from("/tmp/old.deb")),
            generation: 5,
        };
        decide_and_record(&app.ctx, Ok(empty_manifest()));
        let session = app.ctx.app_update.lock().unwrap();
        assert_eq!(session.generation, 6);
        assert!(session.downloaded.is_none());
    }

    // --- Finding 1 regression: a download must never be recorded against an
    // offer other than the one it started for. ---

    #[test]
    fn a_download_finishing_after_a_newer_check_is_not_recorded() {
        let app = TempAppData::new();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            downloaded: None,
            generation: 1,
        };
        // `download` starts: it captures the generation the offer had when it
        // began.
        let (_, _, started_generation) = current_artifact(&app.ctx).unwrap();

        // A `check` lands mid-download: a newer offer replaces the one the
        // download started for, exactly like `decide_and_record` would.
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some("https://example.invalid/other.deb"))),
            downloaded: None,
            generation: 2,
        };

        // The in-flight download finishes and tries to record its result.
        // Without the generation check this would overwrite `downloaded`
        // with a path for an artifact that belongs to the offer just
        // replaced -- exactly the mismatch Finding 1 flagged.
        let result = record_download(
            &app.ctx,
            started_generation,
            PathBuf::from("/tmp/skillkeeper.deb"),
        );

        assert!(result.is_err(), "a stale download must not be recorded");
        assert!(
            app.ctx.app_update.lock().unwrap().downloaded.is_none(),
            "the session must still show nothing downloaded for the current offer"
        );
    }

    #[test]
    fn a_download_finishing_for_the_current_generation_is_recorded() {
        let app = TempAppData::new();
        *app.ctx.app_update.lock().unwrap() = AppUpdateSession {
            offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            downloaded: None,
            generation: 1,
        };
        let (_, _, started_generation) = current_artifact(&app.ctx).unwrap();

        let version = record_download(
            &app.ctx,
            started_generation,
            PathBuf::from("/tmp/skillkeeper.deb"),
        )
        .unwrap();

        assert_eq!(version, "9.9.9");
        assert_eq!(
            app.ctx.app_update.lock().unwrap().downloaded,
            Some(PathBuf::from("/tmp/skillkeeper.deb"))
        );
    }

    // --- I7: a stalled connection must not wedge the feature forever --
    // ureq 3's defaults set a connect timeout but no read/body timeout. ---

    #[test]
    fn the_manifest_agent_has_a_finite_global_timeout() {
        let agent = manifest_agent();
        assert_eq!(
            agent.config().timeouts().global,
            Some(MANIFEST_TIMEOUT),
            "a stalled manifest fetch must eventually give up rather than \
             wedge `check` for the life of the process"
        );
    }

    #[test]
    fn the_download_agent_has_a_finite_global_timeout() {
        let agent = download_agent();
        assert_eq!(
            agent.config().timeouts().global,
            Some(DOWNLOAD_TIMEOUT),
            "a stalled artifact download must eventually give up rather than \
             leave `downloading` stuck, which also disables every future \
             scheduled check"
        );
    }

    #[test]
    fn the_download_timeout_is_wide_enough_for_a_slow_but_alive_transfer() {
        // A 150 MB installer over a slow-but-working connection must not be
        // mistaken for a stall; the manifest fetch, a few KB of JSON, needs
        // far less headroom.
        assert!(DOWNLOAD_TIMEOUT > MANIFEST_TIMEOUT);
    }

    // --- Observability follow-up: an explicit, user-initiated check must
    // bypass both of `check`'s gates, and an automatic one must still respect
    // them. ---

    #[test]
    fn a_forced_check_bypasses_the_interval_that_still_gates_an_automatic_one() {
        let app = TempAppData::new();
        let now = app.ctx.clock.now() / 1000;
        let seeded = store::AppUpdateState {
            last_check_at: Some(now),
            last_check_version: Some(env!("CARGO_PKG_VERSION").to_string()),
            cached_offer: Some(sample_offer(Some(
                "https://example.invalid/skillkeeper.deb",
            ))),
            ..Default::default()
        };
        store::save(&app.ctx.fs, &app.ctx.paths.app_update_json, &seeded).unwrap();

        // The automatic gate: `recently_checked` -- the same predicate `check`
        // consults -- says this state must not reach the network again yet.
        assert!(
            recently_checked(&seeded, now, env!("CARGO_PKG_VERSION")),
            "sanity: this state must read as recently checked"
        );

        // The forced path ignores that gate entirely and makes a fresh
        // decision: an empty manifest replaces the cached offer with nothing,
        // which a suppressed automatic check (see
        // `a_suppressed_check_returns_the_cached_offer`) never would.
        let result = check_forced_with(&app.ctx, Ok(empty_manifest()));
        assert_eq!(result, Ok(None));
        let state_after = store::load(&app.ctx.fs, &app.ctx.paths.app_update_json);
        assert!(
            state_after.cached_offer.is_none(),
            "a forced check must record a fresh decision even within the interval"
        );
    }

    #[test]
    fn a_forced_check_ignores_the_interval() {
        let app = TempAppData::new();
        // A forced check must decide even when `check` would have returned
        // early. Driven through `check_forced_with` so the manifest is
        // injected and nothing reaches the network.
        let result = check_forced_with(&app.ctx, Ok(empty_manifest()));
        assert_eq!(result, Ok(None));
    }

    #[test]
    fn a_forced_check_writes_last_check_at_unconditionally() {
        let app = TempAppData::new();
        assert!(store::load(&app.ctx.fs, &app.ctx.paths.app_update_json)
            .last_check_at
            .is_none());

        let _ = check_forced_with(&app.ctx, Ok(empty_manifest()));

        assert!(store::load(&app.ctx.fs, &app.ctx.paths.app_update_json)
            .last_check_at
            .is_some());
    }

    #[test]
    fn a_forced_check_writes_last_check_at_even_after_a_fetch_failure() {
        let app = TempAppData::new();

        let _ = check_forced_with(&app.ctx, Err("network unreachable".to_string()));

        assert!(store::load(&app.ctx.fs, &app.ctx.paths.app_update_json)
            .last_check_at
            .is_some());
    }

    #[test]
    fn a_forced_check_surfaces_a_fetch_failure_as_an_error() {
        let app = TempAppData::new();

        let result = check_forced_with(&app.ctx, Err("network unreachable".to_string()));

        assert_eq!(result, Err("network unreachable".to_string()));
    }
}
