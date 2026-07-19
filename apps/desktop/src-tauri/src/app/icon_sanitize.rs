//! Resolve a project's display icon from a few conventional locations and return
//! it as a data URL, or `None`. Only the project's own folder is read.
//!
//! SECURITY-CRITICAL: a verbatim port of the Electron `projectIcon.ts`. The
//! image passes a quick, cheap "is this a safe image" check before it is handed
//! to the renderer:
//!   - a size cap rejects oversized files (and entity / decompression bombs);
//!   - PNGs must carry the PNG magic signature (declared type matches content);
//!   - SVGs are rejected when they carry active or external content (script,
//!     event handlers, foreignObject, `javascript:`, external URLs,
//!     DOCTYPE/ENTITY).
//!
//! The renderer additionally shows the icon through an `<img>`, where the
//! browser neither executes scripts nor loads external resources from an SVG --
//! so this check is defence-in-depth, not the only guard.

use std::path::Path;

use super::base64_encode;

/// Candidate icon files relative to the project root, in resolution order.
const CANDIDATES: [&str; 4] = ["icon.png", "icon.svg", ".idea/icon.png", ".idea/icon.svg"];

/// Reject files larger than this. Icons are small; this stops bombs. (1 MB)
const MAX_BYTES: u64 = 1024 * 1024;

/// The 8-byte PNG file signature.
const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/// True for the ASCII whitespace `\s` matches (space, tab, LF, VT, FF, CR).
fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

/// Port of `/\son[a-z]+\s*=/` over the lowercased source: whitespace, then
/// `on`, then one-or-more ASCII letters, optional whitespace, then `=`.
fn has_event_handler(lower: &str) -> bool {
    let b = lower.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        if is_ws(b[i]) {
            let mut k = i + 1;
            if k + 1 < n && b[k] == b'o' && b[k + 1] == b'n' {
                k += 2;
                let start = k;
                while k < n && b[k].is_ascii_lowercase() {
                    k += 1;
                }
                if k > start {
                    while k < n && is_ws(b[k]) {
                        k += 1;
                    }
                    if k < n && b[k] == b'=' {
                        return true;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

/// Port of `/(?:href|src)\s*=\s*["']?\s*(?:https?:)?\/\//i`: an `href`/`src`
/// attribute whose value is an absolute `http(s)://` or protocol-relative `//`
/// reference (remote fetch on render). Operates on the lowercased source, which
/// is equivalent to the case-insensitive match over ASCII patterns.
fn has_remote_ref(lower: &str) -> bool {
    let b = lower.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        let kw_len = if lower[i..].starts_with("href") {
            Some(4)
        } else if lower[i..].starts_with("src") {
            Some(3)
        } else {
            None
        };
        if let Some(kw) = kw_len {
            let mut k = i + kw;
            while k < n && is_ws(b[k]) {
                k += 1;
            }
            if k < n && b[k] == b'=' {
                k += 1;
                while k < n && is_ws(b[k]) {
                    k += 1;
                }
                if k < n && (b[k] == b'"' || b[k] == b'\'') {
                    k += 1;
                }
                while k < n && is_ws(b[k]) {
                    k += 1;
                }
                // Optional `https?:` prefix before the `//`.
                if lower[k..].starts_with("http") {
                    let mut m = k + 4;
                    if m < n && b[m] == b's' {
                        m += 1;
                    }
                    if m < n && b[m] == b':' {
                        k = m + 1;
                    }
                }
                if k + 1 < n && b[k] == b'/' && b[k + 1] == b'/' {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

/// Cheap allowlist: an SVG must not carry active or external content.
/// Verbatim port of the TypeScript `isSafeSvg`.
fn is_safe_svg(source: &str) -> bool {
    let s = source.to_lowercase();
    if s.contains("<script") {
        return false;
    }
    if has_event_handler(&s) {
        return false; // onload=, onclick=, ...
    }
    if s.contains("<foreignobject") {
        return false;
    }
    if s.contains("javascript:") {
        return false;
    }
    if s.contains("<!doctype") || s.contains("<!entity") {
        return false; // XXE / entity bombs
    }
    // Block absolute http(s) and protocol-relative references (remote fetch on
    // render); local/relative refs and inline data: URIs are fine.
    if has_remote_ref(&s) {
        return false;
    }
    true
}

/// Build a `data:<mime>;base64,<...>` URL from raw bytes.
fn to_data_url(mime: &str, buf: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64_encode(buf))
}

/// First safe icon for a project folder as a data URL, or `None` when none of
/// the candidates exist or pass the safety check. Never panics.
pub fn resolve_project_icon(project_path: &str) -> Option<String> {
    for rel in CANDIDATES {
        let file = Path::new(project_path).join(rel);
        let meta = match std::fs::metadata(&file) {
            Ok(m) => m,
            Err(_) => continue, // Missing or unreadable candidate: try the next.
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BYTES {
            continue;
        }
        let buf = match std::fs::read(&file) {
            Ok(b) => b,
            Err(_) => continue,
        };
        if rel.ends_with(".png") {
            if buf.len() >= PNG_MAGIC.len() && buf[..PNG_MAGIC.len()] == PNG_MAGIC {
                return Some(to_data_url("image/png", &buf));
            }
            continue;
        }
        // .svg -- validate the markup, then hand over as a data URL.
        if is_safe_svg(&String::from_utf8_lossy(&buf)) {
            return Some(to_data_url("image/svg+xml", &buf));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A throwaway project directory, removed on drop.
    struct TmpDir {
        path: PathBuf,
    }

    impl TmpDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path =
                std::env::temp_dir().join(format!("skillkeeper-icon-{}-{}", std::process::id(), n));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }

        fn path(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }

        fn write(&self, rel: &str, bytes: &[u8]) {
            let file = self.path.join(rel);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, bytes).unwrap();
        }
    }

    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A minimal valid PNG (magic + a byte).
    fn png_bytes() -> Vec<u8> {
        let mut v = PNG_MAGIC.to_vec();
        v.push(0x00);
        v
    }

    // ---- is_safe_svg: accept cases ----

    #[test]
    fn safe_svg_accepts_plain_markup() {
        assert!(is_safe_svg(
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>"
        ));
    }

    #[test]
    fn safe_svg_accepts_local_and_relative_refs() {
        assert!(is_safe_svg(
            "<svg><use href=\"#id\"/><image href=\"icon.png\"/></svg>"
        ));
    }

    #[test]
    fn safe_svg_accepts_inline_data_uri() {
        assert!(is_safe_svg(
            "<svg><image href=\"data:image/png;base64,AAAA\"/></svg>"
        ));
    }

    // ---- is_safe_svg: reject cases (one per guard) ----

    #[test]
    fn safe_svg_rejects_script() {
        assert!(!is_safe_svg("<svg><script>alert(1)</script></svg>"));
    }

    #[test]
    fn safe_svg_rejects_uppercase_script() {
        assert!(!is_safe_svg("<svg><SCRIPT>alert(1)</SCRIPT></svg>"));
    }

    #[test]
    fn safe_svg_rejects_event_handler() {
        assert!(!is_safe_svg("<svg onload=\"x()\"></svg>"));
        assert!(!is_safe_svg("<rect onclick=\"x()\"/>"));
        // Whitespace variations around the `=`.
        assert!(!is_safe_svg("<svg onload = 'x()'></svg>"));
    }

    #[test]
    fn safe_svg_rejects_foreign_object() {
        assert!(!is_safe_svg("<svg><foreignObject></foreignObject></svg>"));
    }

    #[test]
    fn safe_svg_rejects_javascript_uri() {
        assert!(!is_safe_svg("<svg><a href=\"javascript:alert(1)\"/></svg>"));
    }

    #[test]
    fn safe_svg_rejects_doctype_and_entity() {
        assert!(!is_safe_svg("<!DOCTYPE svg><svg></svg>"));
        assert!(!is_safe_svg(
            "<!ENTITY x SYSTEM \"file:///etc/passwd\"><svg/>"
        ));
    }

    #[test]
    fn safe_svg_rejects_remote_https_ref() {
        assert!(!is_safe_svg(
            "<svg><image href=\"https://evil.test/x.png\"/></svg>"
        ));
    }

    #[test]
    fn safe_svg_rejects_remote_http_ref() {
        assert!(!is_safe_svg(
            "<svg><image src=\"http://evil.test/x.png\"/></svg>"
        ));
    }

    #[test]
    fn safe_svg_rejects_protocol_relative_ref() {
        assert!(!is_safe_svg(
            "<svg><image href=\"//evil.test/x.png\"/></svg>"
        ));
    }

    #[test]
    fn safe_svg_rejects_remote_ref_without_quotes() {
        assert!(!is_safe_svg("<svg><image href=https://evil.test/x/></svg>"));
    }

    // ---- resolve_project_icon ----

    #[test]
    fn resolve_returns_none_when_no_candidates() {
        let dir = TmpDir::new();
        assert_eq!(resolve_project_icon(&dir.path()), None);
    }

    #[test]
    fn resolve_accepts_a_valid_png() {
        let dir = TmpDir::new();
        dir.write("icon.png", &png_bytes());
        let url = resolve_project_icon(&dir.path()).expect("png accepted");
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn resolve_rejects_a_png_without_magic_bytes() {
        let dir = TmpDir::new();
        dir.write("icon.png", b"not a png");
        assert_eq!(resolve_project_icon(&dir.path()), None);
    }

    #[test]
    fn resolve_accepts_a_safe_svg() {
        let dir = TmpDir::new();
        dir.write("icon.svg", b"<svg><rect/></svg>");
        let url = resolve_project_icon(&dir.path()).expect("svg accepted");
        assert!(url.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn resolve_rejects_an_unsafe_svg() {
        let dir = TmpDir::new();
        dir.write("icon.svg", b"<svg><script>x</script></svg>");
        assert_eq!(resolve_project_icon(&dir.path()), None);
    }

    #[test]
    fn resolve_rejects_an_oversized_file() {
        let dir = TmpDir::new();
        let mut big = png_bytes();
        big.resize((MAX_BYTES as usize) + 1, 0);
        dir.write("icon.png", &big);
        assert_eq!(resolve_project_icon(&dir.path()), None);
    }

    #[test]
    fn resolve_skips_empty_file() {
        let dir = TmpDir::new();
        dir.write("icon.png", b"");
        assert_eq!(resolve_project_icon(&dir.path()), None);
    }

    #[test]
    fn resolve_prefers_png_then_svg_then_idea() {
        let dir = TmpDir::new();
        // Only the .idea/icon.svg exists: it is the last candidate and must win.
        dir.write(".idea/icon.svg", b"<svg><rect/></svg>");
        let url = resolve_project_icon(&dir.path()).expect("idea svg accepted");
        assert!(url.starts_with("data:image/svg+xml;base64,"));

        // Adding a top-level png makes it win over the .idea svg (earlier candidate).
        dir.write("icon.png", &png_bytes());
        let url = resolve_project_icon(&dir.path()).expect("png wins");
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn resolve_falls_through_unsafe_svg_to_next_candidate() {
        let dir = TmpDir::new();
        // icon.svg is unsafe; .idea/icon.png is a valid fallback.
        dir.write("icon.svg", b"<svg onload=\"x()\"></svg>");
        dir.write(".idea/icon.png", &png_bytes());
        let url = resolve_project_icon(&dir.path()).expect("falls through to png");
        assert!(url.starts_with("data:image/png;base64,"));
    }
}
