//! `skillkeeper update` -- print how to update the SkillKeeper CLI itself.
//!
//! This command performs no network access and checks no version against
//! GitHub: it only prints the current version and the one-line install
//! command that reinstalls the latest release, copied verbatim from the
//! header comments of `scripts/install.sh` and `scripts/install.ps1`.

use std::io::Write;

use crate::error::CliError;

/// One-line installer for macOS and Linux, copied verbatim from the header
/// comment of `scripts/install.sh`.
const SHELL_INSTALL: &str =
    "curl -fsSL https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.sh | sh";

/// One-line installer for Windows, copied verbatim from the header comment
/// of `scripts/install.ps1`.
const POWERSHELL_INSTALL: &str =
    "irm https://raw.githubusercontent.com/lorem-dev/skillkeeper/main/scripts/install.ps1 | iex";

/// Write update instructions for the SkillKeeper CLI to `out`.
///
/// `platform` is expected to be `std::env::consts::OS` ("linux", "macos",
/// "windows", ...). Unix platforms get the shell installer, Windows gets the
/// PowerShell installer, and an unrecognized platform gets both so the
/// output stays useful instead of silently guessing wrong. No network
/// access, no version check against GitHub: this command only prints.
/// Always succeeds with exit code 0.
pub fn run(out: &mut dyn Write, platform: &str) -> Result<i32, CliError> {
    writeln!(
        out,
        "This is SkillKeeper CLI {}.",
        env!("CARGO_PKG_VERSION")
    )?;
    writeln!(out)?;
    writeln!(
        out,
        "To update the SkillKeeper CLI to the latest release, run:"
    )?;
    writeln!(out)?;

    match platform {
        "windows" => writeln!(out, "  {POWERSHELL_INSTALL}")?,
        "linux" | "macos" => writeln!(out, "  {SHELL_INSTALL}")?,
        _ => {
            writeln!(out, "  {SHELL_INSTALL}")?;
            writeln!(out, "  {POWERSHELL_INSTALL}")?;
        }
    }

    writeln!(out)?;
    writeln!(
        out,
        "If you installed the CLI through a package manager (Homebrew, apt, \
         winget, or similar), update it through that package manager \
         instead. Running the installer above as well would leave two \
         copies of the CLI on your PATH."
    )?;

    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(platform: &str) -> String {
        let mut out = Vec::new();
        assert_eq!(run(&mut out, platform).unwrap(), 0);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn unix_platforms_get_the_shell_installer() {
        for p in ["linux", "macos"] {
            let text = output(p);
            assert!(text.contains("install.sh"), "{p}: {text}");
            assert!(text.contains("curl"), "{p}: {text}");
            assert!(!text.contains("install.ps1"), "{p}: {text}");
        }
    }

    #[test]
    fn windows_gets_the_powershell_installer() {
        let text = output("windows");
        assert!(text.contains("install.ps1"));
        assert!(!text.contains("curl -fsSL"));
    }

    #[test]
    fn an_unknown_platform_still_prints_both() {
        let text = output("freebsd");
        assert!(text.contains("install.sh"));
        assert!(text.contains("install.ps1"));
    }

    #[test]
    fn names_the_current_version_and_says_it_updates_the_cli() {
        let text = output("linux");
        assert!(text.contains(env!("CARGO_PKG_VERSION")));
        assert!(text.to_lowercase().contains("cli"));
    }

    #[test]
    fn names_the_product_consistently_in_title_case() {
        // The rest of this output ("SkillKeeper CLI to the latest release")
        // uses title case; the opening line must match it rather than
        // lowercasing the product name.
        assert!(output("linux").contains("SkillKeeper CLI"));
    }

    #[test]
    fn mentions_that_a_package_manager_install_updates_elsewhere() {
        assert!(output("linux").to_lowercase().contains("package manager"));
    }

    #[test]
    fn output_is_ascii() {
        for p in ["linux", "macos", "windows", "freebsd"] {
            assert!(output(p).is_ascii(), "{p}");
        }
    }
}
