//! Which release artifact this host wants.
//!
//! The manifest keys artifacts by `<os>-<arch>` and tags each with a `kind`, so
//! selection is two lookups rather than a per-platform branch in the caller.

/// The manifest key for the running host, e.g. `macos-aarch64`.
///
/// Uses Rust's own target constants rather than a hand-maintained table, so a
/// new build target cannot drift from the key the release workflow writes.
pub fn host_asset_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
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
    fn host_key_joins_os_and_arch() {
        let key = host_asset_key();
        assert_eq!(
            key,
            format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
        );
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
