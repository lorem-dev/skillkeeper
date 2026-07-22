//! Editor detection and launch for the "open in an editor" controls (a port of
//! the Electron `editors.ts`).
//!
//! Editors are launched from a fixed allowlist via detached `std::process::
//! Command::spawn` with argument arrays (never a shell string); the only path
//! passed is the caller-provided target path. The OS-default entry opens the
//! target via the `opener` crate (the analogue of Electron `shell.openPath`).
//!
//! Icon extraction is best-effort. Electron used `app.getFileIcon`, which has no
//! pure-Rust equivalent; on macOS we still pull an `.app` bundle's real icon out
//! of its `.icns` via `defaults` + `sips` (matching the TypeScript
//! `macAppIconDataUrl`). For every other target (CLI binaries, the config file,
//! Windows executables) no icon is returned -- see the module notes in the PR.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

use super::base64_encode;

/// One selectable editor entry (mirrors the TypeScript `EditorOption`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorOption {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
    pub available: bool,
}

/// Outcome of an open request: `{ ok: true }` or `{ ok: false, error }`
/// (mirrors the TypeScript `OpenResult`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl OpenResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error: None,
        }
    }

    fn err(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
        }
    }
}

/// Open a URL (or path) in the OS default handler -- used for external links
/// such as the online documentation. Never panics; returns an [`OpenResult`].
pub fn open_external(target: &str) -> OpenResult {
    match opener::open(target) {
        Ok(()) => OpenResult::ok(),
        Err(e) => OpenResult::err(e.to_string()),
    }
}

/// The synthetic id that opens the target in the OS default application.
pub const DEFAULT_EDITOR_ID: &str = "default";

/// One allowlisted editor: how to find and launch it per OS.
struct EditorSpec {
    id: &'static str,
    name: &'static str,
    /// CLI command probed on PATH (all OSes).
    cli: Option<&'static str>,
    /// macOS app bundle name under /Applications or ~/Applications.
    mac_app: Option<&'static str>,
    /// Windows executable basename probed on PATH / PATHEXT.
    win_exe: Option<&'static str>,
    /// CLI flag that forces opening the target in a NEW window, when supported.
    new_window_arg: Option<&'static str>,
}

/// Fixed allowlist. Order is the display order (mirrors the TypeScript `EDITORS`).
const EDITORS: &[EditorSpec] = &[
    EditorSpec {
        id: "vscode",
        name: "Visual Studio Code",
        cli: Some("code"),
        mac_app: Some("Visual Studio Code.app"),
        win_exe: Some("code"),
        new_window_arg: Some("-n"),
    },
    EditorSpec {
        id: "cursor",
        name: "Cursor",
        cli: Some("cursor"),
        mac_app: Some("Cursor.app"),
        win_exe: Some("cursor"),
        new_window_arg: Some("-n"),
    },
    EditorSpec {
        id: "zed",
        name: "Zed",
        cli: Some("zed"),
        mac_app: Some("Zed.app"),
        win_exe: None,
        new_window_arg: None,
    },
    EditorSpec {
        id: "sublime",
        name: "Sublime Text",
        cli: Some("subl"),
        mac_app: Some("Sublime Text.app"),
        win_exe: Some("subl"),
        new_window_arg: Some("-n"),
    },
    EditorSpec {
        id: "textedit",
        name: "TextEdit",
        cli: None,
        mac_app: Some("TextEdit.app"),
        win_exe: None,
        new_window_arg: None,
    },
    EditorSpec {
        id: "notepad",
        name: "Notepad",
        cli: None,
        mac_app: None,
        win_exe: Some("notepad"),
        new_window_arg: None,
    },
];

/// A resolved, launchable editor: a CLI path, an `.app` bundle path, or both.
#[derive(Debug, Default)]
struct Resolved {
    cli_path: Option<String>,
    app_path: Option<String>,
}

/// Look a command up on PATH via `which` (Unix) / `where` (Windows); returns the
/// first resolved path. Port of the TypeScript `whichCli`.
fn which_cli(cli: &str) -> Option<String> {
    let cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let mut command = Command::new(cmd);
    command.arg(cli);
    crate::util::hide_console(&mut command);
    let out = command.output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// The user's home directory, from `HOME` (Unix) or `USERPROFILE` (Windows).
fn home_dir() -> Option<String> {
    std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
}

/// Locate a macOS `.app` bundle in a standard applications directory.
/// Port of the TypeScript `macAppPath`.
fn mac_app_path(app_name: &str) -> Option<String> {
    let mut candidates = vec![format!("/Applications/{app_name}")];
    if let Some(home) = home_dir() {
        candidates.push(format!("{home}/Applications/{app_name}"));
    }
    candidates.into_iter().find(|p| Path::new(p).exists())
}

/// Derive an `.app` bundle from a CLI path by resolving symlinks and taking the
/// enclosing bundle (port of the TypeScript `macAppFromCli`).
fn mac_app_from_cli(cli_path: &str) -> Option<String> {
    let real = std::fs::canonicalize(cli_path).ok()?;
    let real = real.to_string_lossy();
    let marker = real.find(".app/")?;
    Some(real[..marker + ".app".len()].to_string())
}

/// Resolve a launchable spec to a [`Resolved`] when available (port of
/// `resolveEditor`).
fn resolve_editor(spec: &EditorSpec) -> Option<Resolved> {
    let cli_path = spec.cli.and_then(which_cli);

    if cfg!(target_os = "macos") {
        if let Some(mac_app) = spec.mac_app {
            // Prefer the real .app bundle so the icon is the app's, not a
            // generic executable glyph: a standard location first, then derived
            // from the CLI symlink when the app lives elsewhere.
            let app_path =
                mac_app_path(mac_app).or_else(|| cli_path.as_deref().and_then(mac_app_from_cli));
            if let Some(app_path) = app_path {
                return Some(Resolved {
                    cli_path,
                    app_path: Some(app_path),
                });
            }
        }
    }
    if let Some(cli_path) = cli_path {
        return Some(Resolved {
            cli_path: Some(cli_path),
            app_path: None,
        });
    }
    if cfg!(target_os = "windows") {
        if let Some(win_exe) = spec.win_exe {
            if let Some(win_path) = which_cli(win_exe) {
                return Some(Resolved {
                    cli_path: Some(win_path),
                    app_path: None,
                });
            }
        }
    }
    None
}

/// Extract a macOS `.app`'s real icon as a PNG data URL via `defaults` + `sips`
/// (port of the TypeScript `macAppIconDataUrl`). `None` on any miss.
fn mac_app_icon_data_url(app_path: &str) -> Option<String> {
    let info = Command::new("defaults")
        .args([
            "read",
            &format!("{app_path}/Contents/Info"),
            "CFBundleIconFile",
        ])
        .output()
        .ok()?;
    if !info.status.success() {
        return None;
    }
    let mut name = String::from_utf8_lossy(&info.stdout).trim().to_string();
    if name.is_empty() {
        return None;
    }
    if !name.ends_with(".icns") {
        name.push_str(".icns");
    }
    let icns = format!("{app_path}/Contents/Resources/{name}");
    if !Path::new(&icns).exists() {
        return None;
    }
    // Rasterize to 40px (crisp at the 20px display size on retina). sips writes
    // to a file, so use a pid+bundle-unique temp path and remove it after.
    let stem = Path::new(&icns)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let out =
        std::env::temp_dir().join(format!("sk-editor-icon-{}-{stem}.png", std::process::id()));
    let out_str = out.to_string_lossy().into_owned();
    let conv = Command::new("sips")
        .args([
            "-s", "format", "png", "-z", "40", "40", &icns, "--out", &out_str,
        ])
        .output()
        .ok()?;
    if !conv.status.success() || !out.exists() {
        return None;
    }
    let bytes = std::fs::read(&out).ok()?;
    let _ = std::fs::remove_file(&out);
    Some(format!("data:image/png;base64,{}", base64_encode(&bytes)))
}

/// Best-effort icon for a launch target (port of the TypeScript `iconFor`).
/// Only macOS `.app` bundles yield an icon; everything else returns `None`
/// (no `app.getFileIcon` equivalent).
fn icon_for(target_path: &str) -> Option<String> {
    if cfg!(target_os = "macos") && target_path.ends_with(".app") {
        return mac_app_icon_data_url(target_path);
    }
    None
}

/// Build the list of available editors plus the OS-default entry (port of
/// `listEditors`).
pub fn list_editors(config_path: &str) -> Vec<EditorOption> {
    let mut out = Vec::new();
    for spec in EDITORS {
        let Some(resolved) = resolve_editor(spec) else {
            continue;
        };
        let icon_target = resolved
            .app_path
            .as_deref()
            .or(resolved.cli_path.as_deref());
        let icon_data_url = icon_target.and_then(icon_for);
        out.push(EditorOption {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            icon_data_url,
            available: true,
        });
    }
    out.push(EditorOption {
        id: DEFAULT_EDITOR_ID.to_string(),
        name: DEFAULT_EDITOR_ID.to_string(),
        icon_data_url: icon_for(config_path),
        available: true,
    });
    out
}

/// Spawn a command fully detached (no inherited stdio); the child keeps running
/// after this process drops the handle.
fn spawn_detached(program: &str, args: &[String]) -> std::io::Result<()> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::util::hide_console(&mut command);
    command.spawn().map(|_child| ())
}

/// Open `target_path` in the given allowlisted editor id (or the OS default).
/// Port of `openInEditor`; never panics -- returns an [`OpenResult`].
pub fn open_in_editor(editor_id: &str, target_path: &str, new_window: bool) -> OpenResult {
    if editor_id == DEFAULT_EDITOR_ID {
        return match opener::open(target_path) {
            Ok(()) => OpenResult::ok(),
            Err(e) => OpenResult::err(e.to_string()),
        };
    }
    let Some(spec) = EDITORS.iter().find(|e| e.id == editor_id) else {
        return OpenResult::err(format!("Unknown editor: {editor_id}"));
    };
    let Some(resolved) = resolve_editor(spec) else {
        return OpenResult::err(format!("Editor not available: {editor_id}"));
    };
    // Force a new window when asked (opening a project) and the editor's CLI
    // supports it -- so it never reuses/replaces the user's current window.
    let nw: Vec<String> = if new_window {
        spec.new_window_arg
            .map(|a| vec![a.to_string()])
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Some(cli) = resolved.cli_path {
        let mut args = nw;
        args.push(target_path.to_string());
        return match spawn_detached(&cli, &args) {
            Ok(()) => OpenResult::ok(),
            Err(e) => OpenResult::err(e.to_string()),
        };
    }
    if let Some(app) = resolved.app_path {
        // `open -n` launches a fresh instance (a new window) of the app.
        let args: Vec<String> = if new_window {
            vec![
                "-n".to_string(),
                "-a".to_string(),
                app,
                target_path.to_string(),
            ]
        } else {
            vec!["-a".to_string(), app, target_path.to_string()]
        };
        return match spawn_detached("open", &args) {
            Ok(()) => OpenResult::ok(),
            Err(e) => OpenResult::err(e.to_string()),
        };
    }
    OpenResult::err(format!("Editor not launchable: {editor_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_editors_always_includes_the_default_entry() {
        let list = list_editors("/tmp/does-not-exist/config.yaml");
        // The default-app entry is always present and last.
        let last = list.last().expect("at least the default entry");
        assert_eq!(last.id, DEFAULT_EDITOR_ID);
        assert!(last.available);
        // Every listed editor id belongs to the allowlist (plus the default).
        for opt in &list {
            assert!(
                opt.id == DEFAULT_EDITOR_ID || EDITORS.iter().any(|e| e.id == opt.id),
                "unexpected editor id: {}",
                opt.id
            );
            assert!(opt.available);
        }
    }

    #[test]
    fn open_reports_unknown_editor_id() {
        let r = open_in_editor("no-such-editor", "/tmp/whatever", false);
        assert!(!r.ok);
        assert_eq!(r.error.as_deref(), Some("Unknown editor: no-such-editor"));
    }

    #[test]
    fn open_reports_unavailable_editor_when_not_installed() {
        // Find an allowlisted editor that does not resolve on this machine, so
        // the "not available" branch is exercised deterministically.
        if let Some(spec) = EDITORS.iter().find(|s| resolve_editor(s).is_none()) {
            let r = open_in_editor(spec.id, "/tmp/whatever", false);
            assert!(!r.ok);
            assert_eq!(
                r.error.as_deref(),
                Some(format!("Editor not available: {}", spec.id).as_str())
            );
        }
    }

    #[test]
    fn editor_option_serializes_camel_case_and_skips_absent_icon() {
        let opt = EditorOption {
            id: "vscode".to_string(),
            name: "Visual Studio Code".to_string(),
            icon_data_url: None,
            available: true,
        };
        let json = serde_json::to_string(&opt).unwrap();
        assert!(json.contains("\"available\":true"));
        assert!(!json.contains("iconDataUrl"));
        let with_icon = EditorOption {
            icon_data_url: Some("data:image/png;base64,AA".to_string()),
            ..opt
        };
        let json = serde_json::to_string(&with_icon).unwrap();
        assert!(json.contains("\"iconDataUrl\":\"data:image/png;base64,AA\""));
    }

    #[test]
    fn open_result_serializes_camel_case_and_skips_absent_error() {
        let ok = serde_json::to_string(&OpenResult::ok()).unwrap();
        assert_eq!(ok, "{\"ok\":true}");
        let err = serde_json::to_string(&OpenResult::err("boom")).unwrap();
        assert_eq!(err, "{\"ok\":false,\"error\":\"boom\"}");
    }
}
