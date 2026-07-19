//! Native window theming (a port of the theme handling in
//! `apps/desktop/src/main/index.ts`).
//!
//! Drives the window's theme *source* from `config.general.theme`
//! (`system` -> follow the OS, `light`/`dark` -> pinned) and paints the window
//! background to match the effective appearance so the window shows its themed
//! colour before the renderer's first paint (mirrors `themedWindowBackground`:
//! `#1c1c1e` dark / `#f2f2f7` light). While the source follows the OS, a
//! `ThemeChanged` listener repaints the background on a system appearance flip.
//!
//! Dark/light *app-icon* swapping (the Electron `applyAppIcon` taskbar swap) is
//! ported per platform. Windows and Linux draw the taskbar/title-bar from the
//! per-window icon, so the swap goes through [`apply_window_icon`]. macOS ignores
//! the window icon but draws a dock icon, so there the swap sets the running
//! application's dock icon via `NSApplication.setApplicationIconImage`
//! ([`apply_dock_icon`]).

use tauri::window::Color;
use tauri::WebviewWindow;

use skillkeeper_config::Theme;

/// Runtime app icons for the light/dark appearances (256x256 PNGs). Generated
/// from `assets/icons/` by `scripts/gen-icons.mjs` into the git-ignored
/// `src-tauri/icons/`; the desktop crate's `build.rs` produces them before this
/// `include_bytes!` runs. Used for the Windows/Linux window icon and the macOS
/// dock icon.
const WINDOW_ICON_LIGHT: &[u8] = include_bytes!("../../icons/icon-light-256.png");
const WINDOW_ICON_DARK: &[u8] = include_bytes!("../../icons/icon-dark-256.png");

/// Select the runtime window-icon PNG bytes for the effective appearance:
/// dark -> the dark icon, light -> the light icon. Pure, so the mapping is
/// unit-testable.
pub fn window_icon_png(dark: bool) -> &'static [u8] {
    if dark {
        WINDOW_ICON_DARK
    } else {
        WINDOW_ICON_LIGHT
    }
}

/// Swap the window icon to match the effective appearance.
///
/// Only Windows and Linux honor a per-window icon (taskbar / title bar); macOS
/// draws the app icon from the packaged bundle and dock and ignores the window
/// icon, so this is a deliberate no-op there (the mapping itself stays testable
/// via [`window_icon_png`]).
fn apply_window_icon(window: &WebviewWindow, dark: bool) {
    let png = window_icon_png(dark);
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        if let Ok(image) = tauri::image::Image::from_bytes(png) {
            let _ = window.set_icon(image);
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        // macOS: the window icon has no effect; the dock/bundle icon is used.
        let _ = (window, png);
    }
}

/// Swap the macOS dock icon to match the effective appearance.
///
/// macOS ignores the per-window icon and instead draws a dock icon, which
/// defaults to the packaged bundle icon. Override the running application's dock
/// icon so it tracks the light/dark theme like the window background does. A
/// no-op on other platforms (their taskbar icon is handled by
/// [`apply_window_icon`]).
///
/// `setApplicationIconImage:` must run on the main thread. This is called from
/// `config_set` -- which, since the command body runs on a blocking worker, is
/// *not* on the main thread when the user switches theme in-app -- so the
/// AppKit call is marshalled onto the main thread rather than assumed to be on
/// it (the earlier direct call silently no-oped off-main, leaving the dock icon
/// stale on an in-app theme change).
fn apply_dock_icon(window: &WebviewWindow, dark: bool) {
    #[cfg(target_os = "macos")]
    {
        let _ = window.run_on_main_thread(move || {
            use objc2::AnyThread;
            use objc2_app_kit::{NSApplication, NSImage};
            use objc2_foundation::{MainThreadMarker, NSData};

            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let data = NSData::with_bytes(window_icon_png(dark));
            let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
                return;
            };
            // SAFETY: called on the main thread with a valid NSImage; the app
            // takes its own reference to the image.
            unsafe {
                NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, dark);
}

/// The themed window background as an RGB triple for the given effective
/// appearance: dark -> `#1c1c1e`, light -> `#f2f2f7`. Pure, so the mapping is
/// unit-testable.
pub fn background_rgb(dark: bool) -> (u8, u8, u8) {
    if dark {
        (0x1c, 0x1c, 0x1e)
    } else {
        (0xf2, 0xf2, 0xf7)
    }
}

/// The themed background as an opaque Tauri [`Color`].
fn background_color(dark: bool) -> Color {
    let (r, g, b) = background_rgb(dark);
    Color(r, g, b, 0xff)
}

/// Map the config theme preference to a Tauri window theme source
/// (`None` follows the OS appearance).
fn theme_source(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

/// Whether the window's currently effective appearance is dark.
fn is_dark(window: &WebviewWindow) -> bool {
    window
        .theme()
        .map(|t| t == tauri::Theme::Dark)
        .unwrap_or(false)
}

/// Apply the theme source from `config.general.theme` and repaint the window
/// background to match the resulting effective appearance.
pub fn apply(window: &WebviewWindow, theme: Theme) {
    let _ = window.set_theme(theme_source(theme));
    // Derive the effective appearance from the preference directly: a pinned
    // Light/Dark is known, and reading it back via `window.theme()` right after
    // `set_theme` can still report the pre-change value on macOS. Only `System`
    // needs the live OS appearance.
    let dark = match theme {
        Theme::Light => false,
        Theme::Dark => true,
        Theme::System => is_dark(window),
    };
    let _ = window.set_background_color(Some(background_color(dark)));
    apply_window_icon(window, dark);
    apply_dock_icon(window, dark);
}

/// Re-apply just the macOS dock icon for the effective appearance of `theme`.
///
/// The dock icon set during `setup` (via [`apply`]) is applied before the app
/// finishes launching, so the system's load of the bundle icon clobbers it.
/// Calling this once the app is ready (`RunEvent::Ready`) sets the themed icon
/// after that, so a dark-mode launch shows the dark icon straight away. A no-op
/// off macOS.
pub fn refresh_dock_icon(window: &WebviewWindow, theme: Theme) {
    let dark = match theme {
        Theme::Light => false,
        Theme::Dark => true,
        Theme::System => is_dark(window),
    };
    apply_dock_icon(window, dark);
}

/// Register a listener that repaints the background when the OS appearance
/// changes. `ThemeChanged` is only delivered while the window theme source is
/// `None` (i.e. `config.general.theme` is `system`), so a pinned light/dark
/// preference is unaffected.
pub fn wire_system_theme_follow(window: &WebviewWindow) {
    let follow_window = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::ThemeChanged(theme) = event {
            let dark = *theme == tauri::Theme::Dark;
            let _ = follow_window.set_background_color(Some(background_color(dark)));
            apply_window_icon(&follow_window, dark);
            apply_dock_icon(&follow_window, dark);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_background_is_near_black() {
        assert_eq!(background_rgb(true), (0x1c, 0x1c, 0x1e));
    }

    #[test]
    fn light_background_is_off_white() {
        assert_eq!(background_rgb(false), (0xf2, 0xf2, 0xf7));
    }

    #[test]
    fn theme_source_maps_system_to_follow_os() {
        assert!(theme_source(Theme::System).is_none());
        assert_eq!(theme_source(Theme::Light), Some(tauri::Theme::Light));
        assert_eq!(theme_source(Theme::Dark), Some(tauri::Theme::Dark));
    }

    #[test]
    fn window_icon_maps_appearance_to_distinct_png() {
        let light = window_icon_png(false);
        let dark = window_icon_png(true);
        // The two appearances select different artwork.
        assert_ne!(light, dark);
        // Both are the embedded light/dark masters, not swapped.
        assert_eq!(light, WINDOW_ICON_LIGHT);
        assert_eq!(dark, WINDOW_ICON_DARK);
        // Both are valid PNGs (8-byte PNG signature).
        const PNG_SIG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        assert!(light.starts_with(PNG_SIG));
        assert!(dark.starts_with(PNG_SIG));
    }
}
