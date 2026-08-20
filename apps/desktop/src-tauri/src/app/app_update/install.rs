//! Turning a verified, downloaded artifact into an installed one.
//!
//! On macOS and Linux (AppImage) the install REPLACES the very bundle or file
//! the running process was launched from. Doing that in-process races the
//! app's own exit and produces a half-copied application, so the work is
//! split in two:
//!
//! - [`plan_install`] is pure: it decides WHAT to do and returns an
//!   [`InstallPlan`], performing no IO. This is what lets the generated
//!   script text be asserted in a unit test without ever running an
//!   installer.
//! - [`execute`] performs the plan.
//!
//! For macOS and a running AppImage, the plan is a shell script that first
//! waits for the current process to exit, then replaces the bundle or file,
//! then relaunches; `execute` spawns it fully detached so it outlives this
//! process. For a deb and for every Windows installer there is no script at
//! all: the file is handed to the system via `opener`, and the caller quits
//! the app.
//!
//! Neither helper script can report its own outcome to this process: by the
//! time the copy runs, this process has already exited (see
//! `commands::app_update::install_update`), and both scripts' stdio streams
//! are null (see [`execute_helper`]). Instead, a script that fails writes
//! [`INSTALL_FAILED_MARKER`] into the same directory the artifact was
//! downloaded into; `commands::app_update::sweep_stale_downloads` and
//! `report_pending_install_failure` read it back on the next launch.

use std::path::{Path, PathBuf};

/// The file name a failed helper script leaves next to the downloaded
/// artifact (i.e. at `downloaded.with_file_name(INSTALL_FAILED_MARKER)`),
/// containing the script's exit status. Read (and consumed) by
/// `commands::app_update::report_pending_install_failure`, and checked by
/// `commands::app_update::sweep_stale_downloads` before it deletes anything.
pub const INSTALL_FAILED_MARKER: &str = "install-failed";

/// What [`execute`] should do to turn a downloaded, verified artifact into an
/// installed one.
#[derive(Debug, PartialEq)]
pub enum InstallPlan {
    /// A generated POSIX `sh` script that waits for the running process to
    /// exit, replaces the bundle or file it was launched from, and relaunches
    /// it. `plan_install` only ever produces this on Unix.
    Helper { script: String },
    /// Hand `path` to the OS default handler and let the caller quit the app.
    /// Used for a deb (goes through the system package installer) and for
    /// every Windows installer (its own process; a helper script would add a
    /// failure mode without adding anything).
    Handoff { path: PathBuf },
}

/// Decide how to install `downloaded`, without performing any IO.
///
/// - `os`: `macos`, `linux`, or `windows`.
/// - `kind`: the artifact kind, e.g. `dmg`, `appimage`, `deb`, `nsis`, `msi`.
/// - `app_path`: the running app bundle's path, required for `macos`/`dmg`.
/// - `appimage`: the running AppImage's own path (`$APPIMAGE`), required for
///   `linux`/`appimage`.
/// - `pid`: the current process id, so the helper script can wait for it to
///   exit before replacing what it was launched from.
pub fn plan_install(
    os: &str,
    kind: &str,
    downloaded: &Path,
    app_path: Option<&str>,
    appimage: Option<&str>,
    pid: u32,
) -> Result<InstallPlan, String> {
    // `app_path`, `appimage`, and `pid` are consumed only by the two
    // Unix-only match arms below (a helper script needs the running bundle
    // path, the AppImage path, and the pid to wait on). A non-Unix build
    // never reaches those arms, so without this they would be unused
    // parameters there -- touch them directly rather than silence the whole
    // function with a blanket `#[allow(unused_variables)]`, which would also
    // hide a genuinely unused parameter added later.
    #[cfg(not(unix))]
    let _ = (app_path, appimage, pid);

    match (os, kind) {
        #[cfg(unix)]
        ("macos", "dmg") => {
            let app_path = app_path.ok_or_else(|| {
                "macos dmg install requires a resolved app bundle path".to_string()
            })?;
            Ok(InstallPlan::Helper {
                script: macos_dmg_script(downloaded, app_path, pid),
            })
        }
        #[cfg(unix)]
        ("linux", "appimage") => {
            let appimage = appimage.ok_or_else(|| {
                "linux appimage install requires the running appimage path".to_string()
            })?;
            Ok(InstallPlan::Helper {
                script: appimage_script(downloaded, appimage, pid),
            })
        }
        ("linux", "deb") => Ok(InstallPlan::Handoff {
            path: downloaded.to_path_buf(),
        }),
        ("windows", _) => Ok(InstallPlan::Handoff {
            path: downloaded.to_path_buf(),
        }),
        _ => Err(format!("unsupported install combination: {os}/{kind}")),
    }
}

/// Single-quote `s` for POSIX `sh`, escaping any embedded `'` as `'\''`. Every
/// path interpolated into a generated script must be routed through this: an
/// unquoted path that splits into two words on a space is the difference
/// between an update and a destroyed installation.
#[cfg(unix)]
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The marker path for the install that produces `downloaded`: a sibling of
/// the artifact, inside the same download directory.
#[cfg(unix)]
fn marker_for(downloaded: &Path) -> String {
    downloaded
        .with_file_name(INSTALL_FAILED_MARKER)
        .to_string_lossy()
        .into_owned()
}

/// The macOS helper script: wait for `pid` to exit, mount the dmg, copy the
/// mounted bundle to a sibling of the destination, swap the two by renaming
/// (never merging into the live bundle), unmount, relaunch, then delete the
/// dmg and the script itself.
///
/// # Replace, never merge
///
/// A previous version of this script ran `ditto mounted dest` directly onto
/// the existing installed bundle. `ditto` onto an existing destination
/// MERGES: it overwrites files the new release still has, but never removes
/// one the new release dropped, so a bundle accumulates stale files across
/// updates and `codesign --verify` starts failing (the fresh
/// `_CodeSignature/CodeResources` only lists the new file set). This version
/// copies to `{app}.new`, renames the live bundle to `{app}.old`, renames
/// `{app}.new` into place, then removes `{app}.old` -- a `rename(2)` within
/// one directory is a single atomic syscall, so a failure between the two
/// renames is (empirically) as close to impossible as a shell script gets,
/// and the trap below still restores `{app}.old` if it somehow happens
/// anyway. The live bundle is never removed before the sibling copy has
/// already succeeded.
///
/// # Finding the mounted bundle by content, not by the running app's name
///
/// A previous version built the mounted bundle's path from the RUNNING app's
/// file name. A user who renamed `SkillKeeper.app` to anything else made
/// that path wrong -- the mounted volume still contains a bundle named
/// `SkillKeeper.app`, not whatever the user renamed the destination to. This
/// version discovers the mounted bundle with `find "$mountpoint" -maxdepth 1
/// -name '*.app'` instead, which is correct regardless of what the
/// destination is named.
///
/// A trap runs `hdiutil detach` on exit, guarded by a `mounted` flag so it is
/// a no-op unless `hdiutil attach` actually succeeded. `set -e` means a
/// failed `attach` or the copy aborts the script immediately -- without the
/// trap that would leave the volume mounted forever, since the explicit
/// `hdiutil detach` on the success path would never be reached. The same
/// trap also restores `{app}.old` if the live bundle ended up missing while
/// a backup still exists (the swap started but did not finish), so a
/// failure here never leaves the user with no application at all.
///
/// # Failure reporting
///
/// This process has already exited by the time this script runs, so it
/// cannot observe the script failing (see the module doc). The same `cleanup`
/// trap reads `$?` and, if non-zero, writes it to [`INSTALL_FAILED_MARKER`]
/// next to the artifact -- the only way a failure here ever reaches the app.
/// A marker left by an earlier failed attempt is cleared at the top of the
/// script, so a retry that succeeds does not leave a stale failure behind for
/// `report_pending_install_failure` to find.
///
/// Everything after the swap (removing `{app}.old`, the explicit `hdiutil
/// detach`, deleting the dmg, deleting the script itself) is best-effort
/// cleanup that runs once the install has already succeeded, so each of those
/// is `|| true`-guarded: none of them may abort the script under `set -e`, or
/// a transient failure in a step that no longer matters would write a failure
/// marker for an update that actually installed correctly, and skip the
/// relaunch besides. `open {app}` is deliberately NOT guarded the same way --
/// it is the relaunch itself, not cleanup, so a failure there is worth
/// knowing about.
#[cfg(unix)]
fn macos_dmg_script(downloaded: &Path, app_path: &str, pid: u32) -> String {
    let dmg = sq(&downloaded.to_string_lossy());
    let app = sq(app_path);
    let app_new = sq(&format!("{app_path}.new"));
    let app_old = sq(&format!("{app_path}.old"));
    let marker = sq(&marker_for(downloaded));
    format!(
        "#!/bin/sh\n\
set -e\n\
rm -f {marker} 2>/dev/null || true\n\
while kill -0 {pid} 2>/dev/null; do sleep 0.2; done\n\
mountpoint=$(mktemp -d)\n\
mounted=0\n\
cleanup() {{\n\
    status=$?\n\
    if [ \"$mounted\" = \"1\" ]; then\n\
        hdiutil detach -quiet \"$mountpoint\" >/dev/null 2>&1 || true\n\
    fi\n\
    if [ \"$status\" != \"0\" ]; then\n\
        echo \"$status\" > {marker} 2>/dev/null || true\n\
    fi\n\
    if [ ! -e {app} ] && [ -e {app_old} ]; then\n\
        mv {app_old} {app} 2>/dev/null || true\n\
    fi\n\
}}\n\
trap cleanup EXIT\n\
hdiutil attach -nobrowse -quiet -mountpoint \"$mountpoint\" {dmg}\n\
mounted=1\n\
mounted_app=$(find \"$mountpoint\" -maxdepth 1 -name '*.app' -print -quit)\n\
if [ -z \"$mounted_app\" ]; then\n\
    exit 1\n\
fi\n\
rm -rf {app_new}\n\
ditto \"$mounted_app\" {app_new}\n\
rm -rf {app_old}\n\
mv {app} {app_old}\n\
mv {app_new} {app}\n\
rm -rf {app_old} 2>/dev/null || true\n\
hdiutil detach -quiet \"$mountpoint\" >/dev/null 2>&1 || true\n\
mounted=0\n\
open {app}\n\
rm -f {dmg} 2>/dev/null || true\n\
rm -f \"$0\" 2>/dev/null || true\n"
    )
}

/// The AppImage helper script: wait for `pid` to exit, copy the download to a
/// sibling of `$APPIMAGE`, make it executable, rename it over `$APPIMAGE`
/// (atomic, since it is a rename within one directory), delete the
/// downloaded copy and the script itself, then relaunch it in place.
///
/// # Atomicity
///
/// A previous version of this script ran `cp {src} $APPIMAGE` directly: `cp`
/// opens the destination with `O_TRUNC` and streams into it, so an
/// interruption (power loss, `ENOSPC`, the OOM killer) left `$APPIMAGE` --
/// the user's only copy of the application -- truncated and non-executable,
/// with no rollback: the good copy would still be sitting under the app's
/// own update directory, but the user has no reason to know that exists.
/// This version copies to `{appimage}.new` (a sibling, so the later rename
/// stays on one filesystem and is therefore atomic) and only renames it over
/// `$APPIMAGE` once the copy and `chmod` have both already succeeded, so
/// `$APPIMAGE` itself is always either the old version or the new one, never
/// a partial file.
///
/// Both deletes happen before `exec` rather than after: `exec` replaces the
/// running shell process and never returns control to the script, so a step
/// placed after it would never run. Matches the macOS script, which cleans
/// itself up the same way (there it can run after the relaunch, since
/// `open` returns rather than replacing the process).
///
/// # Failure reporting
///
/// Same mechanism as the macOS script: a `cleanup` trap on `EXIT` writes
/// [`INSTALL_FAILED_MARKER`] next to the artifact if `$?` is non-zero when
/// the script aborts under `set -e`. `exec` on success replaces the process
/// before the trap can run, which is exactly the outcome wanted: no marker on
/// success. A marker from an earlier failed attempt is cleared at the top of
/// the script.
///
/// The two deletes between the atomic rename and `exec` (the downloaded copy,
/// then the script itself) are best-effort cleanup that runs once the install
/// has already succeeded, so both are `|| true`-guarded: a transient failure
/// removing either must not abort the script under `set -e` and write a
/// failure marker for an update that actually installed correctly (which
/// would also skip `exec`, so the app would not even relaunch). `exec` itself
/// is deliberately NOT guarded -- it is the relaunch, not cleanup, so a
/// failure there is worth knowing about.
#[cfg(unix)]
fn appimage_script(downloaded: &Path, appimage: &str, pid: u32) -> String {
    let src = sq(&downloaded.to_string_lossy());
    let dest = sq(appimage);
    let dest_new = sq(&format!("{appimage}.new"));
    let marker = sq(&marker_for(downloaded));
    format!(
        "#!/bin/sh\n\
set -e\n\
rm -f {marker} 2>/dev/null || true\n\
cleanup() {{\n\
    status=$?\n\
    if [ \"$status\" != \"0\" ]; then\n\
        echo \"$status\" > {marker} 2>/dev/null || true\n\
    fi\n\
}}\n\
trap cleanup EXIT\n\
while kill -0 {pid} 2>/dev/null; do sleep 0.2; done\n\
cp {src} {dest_new}\n\
chmod +x {dest_new}\n\
mv {dest_new} {dest}\n\
rm -f {src} 2>/dev/null || true\n\
rm -f \"$0\" 2>/dev/null || true\n\
exec {dest}\n"
    )
}

/// Perform a plan: write and detach-spawn a helper script, or hand a file off
/// to the system via `opener`.
pub fn execute(plan: &InstallPlan) -> Result<(), String> {
    match plan {
        InstallPlan::Helper { script } => execute_helper(script),
        InstallPlan::Handoff { path } => opener::open(path).map_err(|e| e.to_string()),
    }
}

/// Write the script to the temp directory with mode 0o755 and spawn `sh
/// <script>` fully detached (all three stdio streams null, no wait) so it
/// outlives this process.
///
/// The child is also put into its own process group (`process_group(0)`,
/// equivalent to a `setsid`-style detach): without it, a signal sent to this
/// process's group -- for instance a terminal closing during a dev-build
/// launch, or a shell's Ctrl-C -- would reach the helper too and could kill
/// the installer mid-copy. A GUI launch (LaunchServices, a `.desktop` file)
/// has no controlling terminal to deliver such a signal in the first place,
/// so this matters mainly for the dev-build case, but it costs one call.
#[cfg(unix)]
fn execute_helper(script: &str) -> Result<(), String> {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let mut path = std::env::temp_dir();
    path.push(format!("skillkeeper-update-{}.sh", std::process::id()));
    fs::write(&path, script).map_err(|e| format!("{}: {e}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("{}: {e}", path.display()))?;

    Command::new("sh")
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `plan_install` never produces a `Helper` plan on a non-Unix target, so this
/// is unreachable in practice; it exists only so the crate compiles.
#[cfg(not(unix))]
fn execute_helper(_script: &str) -> Result<(), String> {
    Err("helper-script install is not supported on this platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn macos_waits_for_the_process_then_copies_the_bundle() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        // The running bundle must be gone before it is replaced.
        assert!(script.contains("4242"));
        assert!(script.contains("hdiutil attach"));
        assert!(script.contains("ditto"));
        assert!(script.contains("hdiutil detach"));
        assert!(script.contains("open"));
        let wait = script.find("4242").unwrap();
        let copy = script.find("ditto").unwrap();
        assert!(wait < copy, "the wait must precede the copy");
    }

    #[test]
    fn macos_detaches_the_dmg_even_if_attach_or_the_copy_fails() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        // A trap, not just a linear post-copy call, is what makes detach
        // survive `set -e` aborting on a failed `attach` or copy.
        assert!(script.contains("trap cleanup EXIT"));
        assert!(script.contains("hdiutil detach"));
        let trap = script.find("trap cleanup EXIT").unwrap();
        let attach = script.find("hdiutil attach").unwrap();
        assert!(
            trap < attach,
            "the trap must be installed before hdiutil attach can fail"
        );
    }

    #[test]
    fn macos_discovers_the_mounted_bundle_by_content_not_by_the_running_name() {
        // A renamed application (`app_path` no longer "SkillKeeper.app") must
        // not be baked into the path the copy reads from inside the mounted
        // volume -- the mounted bundle's own name is unrelated to whatever
        // the user renamed the destination to.
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/My Renamed Copy.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        assert!(
            script.contains("find \"$mountpoint\" -maxdepth 1 -name '*.app' -print -quit"),
            "the mounted bundle must be discovered by content, not assumed from the running \
             app's file name"
        );
        // The old, buggy construction built the source path for the copy by
        // concatenating the mount point with the RUNNING app's file name
        // (`"$mountpoint"'/My Renamed Copy.app'`), which is wrong whenever
        // the two names differ. That exact shape must be gone.
        assert!(!script.contains("$mountpoint\"'/My Renamed Copy.app'"));
        assert!(script.contains("ditto \"$mounted_app\""));
    }

    #[test]
    fn macos_replaces_the_bundle_by_renaming_a_sibling_copy_rather_than_merging() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let app = sq("/Applications/SkillKeeper.app");
        let app_new = sq("/Applications/SkillKeeper.app.new");
        let app_old = sq("/Applications/SkillKeeper.app.old");

        // `ditto` must land on the sibling, never directly on the live
        // bundle -- that is the whole point of the fix: `ditto` onto an
        // existing destination merges rather than replaces.
        assert!(script.contains(&format!("ditto \"$mounted_app\" {app_new}")));
        assert!(!script.contains(&format!("ditto \"$mounted_app\" {app}\n")));

        // Ordering: the sibling copy must complete before the live bundle is
        // touched at all, so a failed copy never removes anything.
        let ditto = script.find("ditto ").unwrap();
        let rename_away = script.find(&format!("mv {app} {app_old}")).unwrap();
        let rename_in = script.find(&format!("mv {app_new} {app}")).unwrap();
        assert!(
            ditto < rename_away,
            "the copy must finish before the live bundle is renamed aside"
        );
        assert!(
            rename_away < rename_in,
            "the old bundle must be renamed aside before the new one takes its place"
        );
    }

    #[test]
    fn macos_never_removes_the_live_bundle_before_the_sibling_copy_succeeds() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let app = sq("/Applications/SkillKeeper.app");
        // The only destructive operations on the live bundle path itself are
        // the two renames (`mv`); it is never the target of an `rm -rf` --
        // only its disposable `.new`/`.old` siblings are.
        assert!(!script.contains(&format!("rm -rf {app}\n")));
        assert!(!script.contains(&format!("rm -rf {app} ")));
    }

    #[test]
    fn macos_restores_the_old_bundle_if_the_swap_did_not_finish() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let app = sq("/Applications/SkillKeeper.app");
        let app_old = sq("/Applications/SkillKeeper.app.old");
        assert!(script.contains(&format!(
            "if [ ! -e {app} ] && [ -e {app_old} ]; then\nmv {app_old} {app} 2>/dev/null || true\nfi"
        )));
    }

    // --- C1: a failed install must leave a trace this process can read back
    // on the next launch, since it has already exited by the time the
    // helper script runs. ---

    #[test]
    fn macos_writes_a_failure_marker_when_the_trap_sees_a_nonzero_status() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let marker = sq("/tmp/u/install-failed");
        assert!(
            script.contains(&format!("rm -f {marker} 2>/dev/null || true")),
            "a marker from an earlier failed attempt must be cleared at the start"
        );
        assert!(
            script.contains(&format!("echo \"$status\" > {marker} 2>/dev/null || true")),
            "a nonzero exit status must be recorded to the marker"
        );
        let clear = script.find("rm -f").unwrap();
        let write = script.find("echo \"$status\"").unwrap();
        assert!(
            clear < write,
            "the marker must be cleared before it can be rewritten"
        );
    }

    #[test]
    fn an_appimage_writes_a_failure_marker_when_the_trap_sees_a_nonzero_status() {
        let plan = plan_install(
            "linux",
            "appimage",
            Path::new("/tmp/u/SkillKeeper.AppImage"),
            None,
            Some("/home/u/Apps/SkillKeeper.AppImage"),
            99,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let marker = sq("/tmp/u/install-failed");
        assert!(script.contains(&format!("rm -f {marker} 2>/dev/null || true")));
        assert!(script.contains(&format!("echo \"$status\" > {marker} 2>/dev/null || true")));
        assert!(script.contains("trap cleanup EXIT"));
        let trap = script.find("trap cleanup EXIT").unwrap();
        let exec = script.find("exec ").unwrap();
        assert!(
            trap < exec,
            "the trap must be armed before the risky copy, well before exec"
        );
    }

    #[test]
    fn an_appimage_replaces_itself_atomically_via_a_sibling_rename() {
        let plan = plan_install(
            "linux",
            "appimage",
            Path::new("/tmp/u/SkillKeeper.AppImage"),
            None,
            Some("/home/u/Apps/SkillKeeper.AppImage"),
            99,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let dest = sq("/home/u/Apps/SkillKeeper.AppImage");
        let dest_new = sq("/home/u/Apps/SkillKeeper.AppImage.new");
        assert!(script.contains(&format!(
            "cp {} {dest_new}",
            sq("/tmp/u/SkillKeeper.AppImage")
        )));
        assert!(script.contains(&format!("chmod +x {dest_new}")));
        assert!(script.contains(&format!("mv {dest_new} {dest}")));
        // `$APPIMAGE` itself must never be opened directly for writing: the
        // copy lands on the sibling, and only a rename ever touches `dest`,
        // so an interrupted copy always leaves `$APPIMAGE` as a complete
        // file -- either the old version or the new one, never a partial
        // one.
        assert!(!script.contains(&format!("cp {} {dest}", sq("/tmp/u/SkillKeeper.AppImage"))));

        // The wait must precede the copy: replacing the AppImage while the
        // old process launched from it might still be running would corrupt
        // a file that process has open.
        let wait = script.find("99").unwrap();
        let copy = script.find("cp ").unwrap();
        assert!(wait < copy, "the wait must precede the copy");

        // Copy, then make executable, then the atomic rename -- in that
        // order, so a failure at any earlier step never touches `$APPIMAGE`.
        let chmod = script.find("chmod +x").unwrap();
        let rename = script.find("mv ").unwrap();
        assert!(copy < chmod, "the copy must finish before chmod");
        assert!(chmod < rename, "chmod must finish before the atomic rename");

        // The downloaded copy must be deleted before `exec`: `exec` replaces
        // the running shell and never returns, so a delete placed after it
        // would never run.
        let delete_download = script
            .find(&format!("rm -f {}", sq("/tmp/u/SkillKeeper.AppImage")))
            .unwrap();
        let exec = script.find("exec ").unwrap();
        assert!(
            delete_download < exec,
            "the download must be deleted before exec, since exec never returns"
        );
    }

    #[test]
    fn an_appimage_helper_removes_itself_before_relaunching() {
        let plan = plan_install(
            "linux",
            "appimage",
            Path::new("/tmp/u/SkillKeeper.AppImage"),
            None,
            Some("/home/u/Apps/SkillKeeper.AppImage"),
            99,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        assert!(
            script.contains("rm -f \"$0\""),
            "the helper script must remove itself, like the macOS one does"
        );
        let delete_self = script.find("rm -f \"$0\"").unwrap();
        let exec = script.find("exec ").unwrap();
        assert!(
            delete_self < exec,
            "the script must delete itself before exec, since exec never returns"
        );
    }

    #[test]
    fn a_deb_is_handed_to_the_system_installer() {
        let plan = plan_install("linux", "deb", Path::new("/tmp/u/sk.deb"), None, None, 1).unwrap();
        assert_eq!(
            plan,
            InstallPlan::Handoff {
                path: Path::new("/tmp/u/sk.deb").to_path_buf()
            }
        );
    }

    #[test]
    fn a_windows_installer_is_handed_off_and_never_scripted() {
        let plan = plan_install(
            "windows",
            "nsis",
            Path::new("C:/tmp/sk-setup.exe"),
            None,
            None,
            1,
        )
        .unwrap();
        // The NSIS installer is its own process; a helper script would add a
        // failure mode without adding anything.
        assert!(matches!(plan, InstallPlan::Handoff { .. }));
    }

    #[test]
    fn an_appimage_kind_without_an_appimage_path_is_an_error() {
        let err =
            plan_install("linux", "appimage", Path::new("/tmp/a"), None, None, 1).unwrap_err();
        assert!(err.to_lowercase().contains("appimage"));
    }

    #[test]
    fn macos_without_a_resolved_bundle_path_is_an_error() {
        assert!(plan_install("macos", "dmg", Path::new("/tmp/a.dmg"), None, None, 1).is_err());
    }

    #[test]
    fn an_unsupported_combination_is_an_error() {
        assert!(plan_install("freebsd", "deb", Path::new("/tmp/a"), None, None, 1).is_err());
    }

    #[test]
    fn paths_are_single_quoted_so_a_space_cannot_split_a_word() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/My Updates/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            5,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!()
        };
        assert!(script.contains("'/tmp/My Updates/SkillKeeper.dmg'"));
    }

    // --- Fix-wave re-review: post-swap cleanup must never turn a successful
    // install into a reported failure. ---

    #[test]
    fn macos_post_swap_cleanup_cannot_write_a_false_failure_marker() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/SkillKeeper.app"),
            None,
            4242,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let app = sq("/Applications/SkillKeeper.app");
        let app_new = sq("/Applications/SkillKeeper.app.new");
        let app_old = sq("/Applications/SkillKeeper.app.old");
        let dmg = sq("/tmp/u/SkillKeeper.dmg");

        // Everything from the swap (`mv {app_new} {app}`) onward is
        // best-effort cleanup that runs after the install has already
        // succeeded; a transient failure in any of it must not abort the
        // script under `set -e` and write a false failure marker.
        let swap = script.find(&format!("mv {app_new} {app}")).unwrap();
        let tail = &script[swap..];
        assert!(
            tail.contains(&format!("rm -rf {app_old} 2>/dev/null || true")),
            "removing the renamed-aside old bundle must be guarded"
        );
        assert!(
            tail.contains("hdiutil detach -quiet \"$mountpoint\" >/dev/null 2>&1 || true"),
            "the explicit post-swap detach must be guarded"
        );
        assert!(
            tail.contains(&format!("rm -f {dmg} 2>/dev/null || true")),
            "deleting the downloaded dmg must be guarded"
        );
        assert!(
            tail.contains("rm -f \"$0\" 2>/dev/null || true"),
            "the helper deleting itself must be guarded"
        );
    }

    #[test]
    fn an_appimage_post_swap_cleanup_cannot_write_a_false_failure_marker() {
        let plan = plan_install(
            "linux",
            "appimage",
            Path::new("/tmp/u/SkillKeeper.AppImage"),
            None,
            Some("/home/u/Apps/SkillKeeper.AppImage"),
            99,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!("expected a helper script")
        };
        let dest = sq("/home/u/Apps/SkillKeeper.AppImage");
        let dest_new = sq("/home/u/Apps/SkillKeeper.AppImage.new");
        let src = sq("/tmp/u/SkillKeeper.AppImage");

        // Everything from the atomic rename onward runs after the install
        // has already succeeded; the two cleanup deletes must be guarded, or
        // a failure removing the downloaded copy or the script itself would
        // report a successful update as failed and skip `exec` besides.
        let swap = script.find(&format!("mv {dest_new} {dest}")).unwrap();
        let tail = &script[swap..];
        assert!(
            tail.contains(&format!("rm -f {src} 2>/dev/null || true")),
            "deleting the downloaded copy must be guarded"
        );
        assert!(
            tail.contains("rm -f \"$0\" 2>/dev/null || true"),
            "the helper deleting itself must be guarded"
        );
    }

    #[test]
    fn a_space_in_the_app_path_is_quoted_in_every_derived_variant() {
        let plan = plan_install(
            "macos",
            "dmg",
            Path::new("/tmp/u/SkillKeeper.dmg"),
            Some("/Applications/My App.app"),
            None,
            5,
        )
        .unwrap();
        let InstallPlan::Helper { script } = plan else {
            panic!()
        };
        assert!(script.contains(&sq("/Applications/My App.app")));
        assert!(script.contains(&sq("/Applications/My App.app.new")));
        assert!(script.contains(&sq("/Applications/My App.app.old")));
    }
}
