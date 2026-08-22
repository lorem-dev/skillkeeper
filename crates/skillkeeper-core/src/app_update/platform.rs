//! Which release artifact this host wants.
//!
//! The manifest keys artifacts by `<os>-<arch>` and tags each with a `kind`, so
//! selection is two lookups rather than a per-platform branch in the caller.

/// The manifest key for an os/arch pair, e.g. `macos-aarch64`.
///
/// Takes both rather than reading `std::env::consts` itself, because ARCH is a
/// COMPILE-TIME constant: it names the target the binary was built for, not the
/// machine it is running on. An Intel build under Rosetta on Apple Silicon
/// reports `x86_64` and would therefore fetch the Intel artifact forever,
/// never moving the user to the native one. Deciding the real architecture
/// needs to ask the system, which is the desktop backend's job (see its
/// `app_update::host`), so this stays pure and is told the answer.
pub fn asset_key(os: &str, arch: &str) -> String {
    format!("{os}-{arch}")
}

/// Artifact kinds this OS accepts, most preferred first.
///
/// `appimage` is chosen only when the running process actually came from one
/// (the caller checks `$APPIMAGE`): replacing an AppImage in place is correct
/// for that install and wrong for a packaged one, which must go back through
/// the system package manager.
pub fn preferred_kinds(os: &str, appimage: bool) -> &'static [&'static str] {
    match os {
        "macos" => &["dmg"],
        "windows" => &["nsis", "msi"],
        "linux" if appimage => &["appimage"],
        "linux" => &["deb"],
        _ => &[],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_key_joins_os_and_arch() {
        assert_eq!(asset_key("macos", "aarch64"), "macos-aarch64");
        assert_eq!(asset_key("windows", "x86_64"), "windows-x86_64");
        assert_eq!(asset_key("linux", "aarch64"), "linux-aarch64");
    }

    #[test]
    fn each_platform_has_a_preference_order() {
        assert_eq!(preferred_kinds("macos", false), &["dmg"]);
        assert_eq!(preferred_kinds("windows", false), &["nsis", "msi"]);
        // A running AppImage updates itself in place; anything else on Linux
        // goes through the system package installer.
        assert_eq!(preferred_kinds("linux", true), &["appimage"]);
        assert_eq!(preferred_kinds("linux", false), &["deb"]);
    }

    #[test]
    fn an_unknown_platform_prefers_nothing() {
        assert!(preferred_kinds("freebsd", false).is_empty());
    }
}
