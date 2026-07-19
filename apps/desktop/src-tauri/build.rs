use std::path::Path;
use std::process::Command;

fn main() {
    ensure_icons();
    ensure_i18n();
    tauri_build::build()
}

/// The desktop icon set under `icons/**` is git-ignored and generated from the
/// sources in `assets/icons/` by `scripts/gen-icons.mjs`. It must exist before
/// `tauri_build::build()` (which validates the `icons/menu-icons/*` resources
/// glob) and before the crate's `include_bytes!` / `generate_context!` read it.
///
/// Generate it here when it is missing -- a fresh clone, a `git clean`, or a
/// local `cargo build` that skipped the explicit CI step. When the set is
/// already present (the common case, and always in CI, which regenerates it in
/// a dedicated step) this is a cheap no-op. Editing the sources in
/// `assets/icons/` requires re-running `pnpm run icons` by hand.
fn ensure_icons() {
    // Rerun when the sources or the generator change, and if the sentinel is
    // removed (so a `git clean` re-triggers generation on the next build).
    println!("cargo:rerun-if-changed=../../../assets/icons");
    println!("cargo:rerun-if-changed=../../../scripts/gen-icons.mjs");
    println!("cargo:rerun-if-changed=icons/icon.icns");

    // Check both a bundle sentinel and a menu-glyph sentinel: the glob is what
    // `tauri_build` validates, so a partial set must still regenerate.
    let present = Path::new("icons/icon.icns").exists()
        && Path::new("icons/menu-icons/undoTemplate@2x.png").exists();
    if present {
        return;
    }

    let status = Command::new("node")
        .arg("../../../scripts/gen-icons.mjs")
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!(
            "scripts/gen-icons.mjs exited with {s}. The desktop icon set is \
             generated at build time from assets/icons/; ensure Node and \
             `pnpm install` are available, or run `pnpm run icons`."
        ),
        Err(e) => panic!(
            "could not run `node scripts/gen-icons.mjs` ({e}). The desktop icon \
             set is generated at build time and requires Node + `pnpm install`; \
             run `pnpm run icons`."
        ),
    }
}

/// The compiled gettext catalogs under `locales/*.mo` are git-ignored and
/// generated from the single-source `../../../locales/*.po` by
/// `scripts/gen-i18n.mjs`. They are embedded via `include_bytes!` in
/// `app/i18n.rs`, so they must exist before this crate compiles.
///
/// Generate them here when missing -- a fresh clone, a `git clean`, or a local
/// `cargo build` that skipped `pnpm install` (whose `postinstall` also runs the
/// generator). When present (the common case) this is a cheap no-op.
fn ensure_i18n() {
    println!("cargo:rerun-if-changed=../../../locales");
    println!("cargo:rerun-if-changed=../../../scripts/gen-i18n.mjs");
    println!("cargo:rerun-if-changed=locales/en.mo");

    if Path::new("locales/en.mo").exists() {
        return;
    }

    let status = Command::new("node")
        .arg("../../../scripts/gen-i18n.mjs")
        .status();
    match status {
        Ok(s) if s.success() => {}
        Ok(s) => panic!(
            "scripts/gen-i18n.mjs exited with {s}. The gettext .mo catalogs are \
             generated at build time from locales/*.po; ensure Node and \
             `pnpm install` are available, or run `pnpm run i18n`."
        ),
        Err(e) => panic!(
            "could not run `node scripts/gen-i18n.mjs` ({e}). The gettext .mo \
             catalogs are generated at build time and require Node + \
             `pnpm install`; run `pnpm run i18n`."
        ),
    }
}
