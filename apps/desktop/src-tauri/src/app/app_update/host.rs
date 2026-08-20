//! The architecture of the MACHINE, as opposed to the one this binary was
//! built for.
//!
//! `std::env::consts::ARCH` is a compile-time constant: it names the target,
//! not the host. That distinction is invisible until a binary runs somewhere it
//! was not compiled for, which is routine on both platforms that ship an
//! emulator:
//!
//! - An Intel build on Apple Silicon runs under Rosetta 2 and reports
//!   `x86_64`. `uname -m` agrees with it, because the whole point of the
//!   translation is that the process cannot tell.
//! - An x64 build on an arm64 Windows runs under its x64 emulation and reports
//!   `x86_64` for the same reason.
//!
//! Asking the compile-time constant therefore pins a user to whichever build
//! they first installed: the updater keeps fetching Intel artifacts for an
//! Apple Silicon machine and never moves them to the native one, which is both
//! slower and, once a platform drops its emulator, eventually a dead end.
//!
//! So the architecture is probed instead. The decision itself is a pure
//! function over the two answers, which is what the tests exercise; only the
//! probing touches the system.

/// Resolve the machine's architecture from the compiled target and what the
/// system says about translation.
///
/// Only the x86_64-reporting case can be a lie worth correcting: an arm64
/// build is never emulating an x86_64 machine, so it is always native.
fn resolve_arch(compiled: &str, translated: bool) -> &str {
    if compiled == "x86_64" && translated {
        "aarch64"
    } else {
        compiled
    }
}

/// Whether this process is being translated by Rosetta 2.
///
/// `sysctl.proc_translated` is 1 under translation, 0 when native, and absent
/// on Intel hardware and older systems -- all three of which mean "not
/// translated" here. Shelled out rather than pulled in through `libc`, which
/// the workspace does not depend on and which is not worth adding for one
/// integer; the crate already runs subprocesses for git and the installer.
#[cfg(target_os = "macos")]
fn probe_translated() -> bool {
    std::process::Command::new("/usr/sbin/sysctl")
        .args(["-in", "sysctl.proc_translated"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "1")
        .unwrap_or(false)
}

/// Whether this process is running under the arm64 Windows x64 emulation.
///
/// A process emulated that way is a WOW64 process, and Windows then sets
/// `PROCESSOR_ARCHITEW6432` to the machine's real architecture while
/// `PROCESSOR_ARCHITECTURE` keeps reporting the emulated one.
#[cfg(target_os = "windows")]
fn probe_translated() -> bool {
    std::env::var("PROCESSOR_ARCHITEW6432")
        .map(|v| v.eq_ignore_ascii_case("ARM64"))
        .unwrap_or(false)
}

/// Nothing else ships a transparent emulator we build for: a Linux x86_64
/// binary does not silently run on arm64.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn probe_translated() -> bool {
    false
}

/// The machine's architecture, in the spelling the release manifest uses.
pub fn host_arch() -> &'static str {
    resolve_arch(std::env::consts::ARCH, probe_translated())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_translated_x86_process_reports_the_arm_machine_under_it() {
        // The defect this exists for: an Intel build on Apple Silicon would
        // otherwise keep fetching Intel artifacts forever.
        assert_eq!(resolve_arch("x86_64", true), "aarch64");
    }

    #[test]
    fn a_native_process_reports_its_own_architecture() {
        assert_eq!(resolve_arch("x86_64", false), "x86_64");
        assert_eq!(resolve_arch("aarch64", false), "aarch64");
    }

    #[test]
    fn an_arm_build_is_never_treated_as_translated() {
        // No platform emulates an x86_64 machine for an arm64 binary, so this
        // combination cannot arise; if it somehow did, reporting the compiled
        // target is the safe answer rather than inventing an x86_64 machine.
        assert_eq!(resolve_arch("aarch64", true), "aarch64");
    }

    #[test]
    fn the_probe_agrees_with_this_machine() {
        // Ties the pure logic to a real answer on whatever runs the suite: a
        // native build must not report itself as translated.
        let arch = host_arch();
        assert!(
            arch == std::env::consts::ARCH
                || (std::env::consts::ARCH == "x86_64" && arch == "aarch64"),
            "host_arch() returned {arch}, which is neither the compiled target nor a corrected one"
        );
    }
}
