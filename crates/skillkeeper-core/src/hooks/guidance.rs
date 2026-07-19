//! SkillKeeper-owned guidance blocks in an agent guidance file (Rust port of
//! `packages/core/src/hooks/guidance.ts`).
//!
//! A block is a GUIDE.md / RULES.md body wrapped in stable HTML-comment markers
//! keyed by the skill's source remote and id, so it can be updated in place or
//! removed later by key -- even when the source guide no longer exists.

use std::sync::OnceLock;

use regex::Regex;

/// The block key: `<remote>; <id>`.
pub fn guidance_key(remote: &str, id: &str) -> String {
    format!("{remote}; {id}")
}

/// The skill id shown in the marker: `group/name`, or `name` when ungrouped.
pub fn skill_guidance_id(group: Option<&str>, name: &str) -> String {
    match group {
        Some(group) if !group.is_empty() => format!("{group}/{name}"),
        _ => name.to_string(),
    }
}

fn start_marker(key: &str) -> String {
    format!("<!-- SKILLKEEPER_START: {key} -->")
}

fn end_marker(key: &str) -> String {
    format!("<!-- SKILLKEEPER_END: {key} -->")
}

/// Line index range (inclusive) of the block for `key`, or `None`.
fn find_block(file: &str, key: &str) -> Option<(usize, usize)> {
    let lines: Vec<&str> = file.split('\n').collect();
    let open = start_marker(key);
    let close = end_marker(key);
    let mut open_line: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if open_line.is_none() && *line == open {
            open_line = Some(i);
        } else if let Some(start) = open_line {
            if *line == close {
                return Some((start, i));
            }
        }
    }
    None
}

/// True when a block for `key` is present.
pub fn has_guidance_block(file: &str, key: &str) -> bool {
    find_block(file, key).is_some()
}

/// Insert or replace the block for `key`. When it exists it is replaced in place
/// (position preserved); otherwise it is appended after the existing content,
/// separated by one blank line. The result always ends with a newline.
pub fn upsert_guidance_block(file: &str, key: &str, body: &str) -> String {
    let block = format!("{}\n{body}\n{}", start_marker(key), end_marker(key));
    if let Some((start, end)) = find_block(file, key) {
        let lines: Vec<&str> = file.split('\n').collect();
        let mut out: Vec<&str> = Vec::new();
        out.extend_from_slice(&lines[..start]);
        let block_lines: Vec<&str> = block.split('\n').collect();
        out.extend_from_slice(&block_lines);
        out.extend_from_slice(&lines[end + 1..]);
        let joined = out.join("\n");
        return if joined.ends_with('\n') {
            joined
        } else {
            format!("{joined}\n")
        };
    }
    if file.trim().is_empty() {
        return format!("{block}\n");
    }
    let base = if file.ends_with('\n') {
        file.to_string()
    } else {
        format!("{file}\n")
    };
    format!("{base}\n{block}\n")
}

/// Remove the block for `key` (and a single blank line immediately before it, if
/// present). Returns the input unchanged when no such block exists.
pub fn remove_guidance_block(file: &str, key: &str) -> String {
    let Some((mut start, mut end)) = find_block(file, key) else {
        return file.to_string();
    };
    let lines: Vec<&str> = file.split('\n').collect();
    if start > 0 && lines[start - 1].is_empty() {
        start -= 1;
    } else if lines.get(end + 1) == Some(&"") {
        end += 1;
    }
    let mut kept: Vec<&str> = Vec::new();
    kept.extend_from_slice(&lines[..start]);
    kept.extend_from_slice(&lines[end + 1..]);
    let joined = kept.join("\n");
    if joined.trim().is_empty() {
        String::new()
    } else {
        joined
    }
}

/// Drop any SkillKeeper guidance marker lines from a guide body, so a marker that
/// appears literally inside a GUIDE.md / RULES.md cannot be mistaken for a block
/// boundary. Call this on a guide body before wrapping it in a block.
pub fn strip_guidance_markers(body: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?i)<!--\s*SKILLKEEPER_(?:START|END):").expect("valid marker regex")
    });
    body.split('\n')
        .filter(|line| !re.is_match(line))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const REMOTE: &str = "git@github.com:acme/skills.git";

    fn key() -> String {
        guidance_key(REMOTE, "web/api")
    }

    #[test]
    fn skill_guidance_id_joins_group_and_name_or_uses_name_alone() {
        assert_eq!(skill_guidance_id(Some("web"), "api"), "web/api");
        assert_eq!(skill_guidance_id(None, "api"), "api");
        assert_eq!(skill_guidance_id(Some(""), "api"), "api");
    }

    #[test]
    fn guidance_key_joins_remote_and_id() {
        assert_eq!(
            guidance_key("git@x:acme/s.git", "web/api"),
            "git@x:acme/s.git; web/api"
        );
    }

    #[test]
    fn upsert_appends_a_block_to_empty_content() {
        let k = key();
        let out = upsert_guidance_block("", &k, "Body line.");
        assert_eq!(
            out,
            format!("<!-- SKILLKEEPER_START: {k} -->\nBody line.\n<!-- SKILLKEEPER_END: {k} -->\n")
        );
    }

    #[test]
    fn upsert_appends_after_existing_content_with_a_blank_line() {
        let k = key();
        let out = upsert_guidance_block("# Project\n\nHello.\n", &k, "Body.");
        assert_eq!(
            out,
            format!(
                "# Project\n\nHello.\n\n<!-- SKILLKEEPER_START: {k} -->\nBody.\n<!-- SKILLKEEPER_END: {k} -->\n"
            )
        );
    }

    #[test]
    fn upsert_replaces_an_existing_block_in_place() {
        let k = key();
        let before = format!(
            "top\n\n<!-- SKILLKEEPER_START: {k} -->\nOLD\n<!-- SKILLKEEPER_END: {k} -->\n\nbottom\n"
        );
        let out = upsert_guidance_block(&before, &k, "NEW");
        assert_eq!(
            out,
            format!(
                "top\n\n<!-- SKILLKEEPER_START: {k} -->\nNEW\n<!-- SKILLKEEPER_END: {k} -->\n\nbottom\n"
            )
        );
    }

    #[test]
    fn upsert_does_not_touch_a_different_skill_block() {
        let k = key();
        let other = guidance_key(REMOTE, "other");
        let with_other =
            format!("<!-- SKILLKEEPER_START: {other} -->\nX\n<!-- SKILLKEEPER_END: {other} -->\n");
        let out = upsert_guidance_block(&with_other, &k, "Body.");
        assert!(out.contains(&format!("SKILLKEEPER_START: {other}")));
        assert!(out.contains(&format!("SKILLKEEPER_START: {k}")));
    }

    #[test]
    fn upsert_adds_trailing_newline_when_replacing_in_a_file_lacking_one() {
        let k = key();
        let before =
            format!("top\n<!-- SKILLKEEPER_START: {k} -->\nOLD\n<!-- SKILLKEEPER_END: {k} -->");
        let out = upsert_guidance_block(&before, &k, "NEW");
        assert!(out.ends_with('\n'));
        assert_eq!(
            out,
            format!("top\n<!-- SKILLKEEPER_START: {k} -->\nNEW\n<!-- SKILLKEEPER_END: {k} -->\n")
        );
    }

    #[test]
    fn remove_removes_the_block_and_the_blank_line_before_it() {
        let k = key();
        let before = format!(
            "# Project\n\nHello.\n\n<!-- SKILLKEEPER_START: {k} -->\nBody.\n<!-- SKILLKEEPER_END: {k} -->\n"
        );
        assert_eq!(remove_guidance_block(&before, &k), "# Project\n\nHello.\n");
    }

    #[test]
    fn remove_returns_input_unchanged_when_absent() {
        assert_eq!(remove_guidance_block("# Project\n", &key()), "# Project\n");
    }

    #[test]
    fn remove_removes_the_only_block_leaving_empty_content() {
        let k = key();
        let only =
            format!("<!-- SKILLKEEPER_START: {k} -->\nBody.\n<!-- SKILLKEEPER_END: {k} -->\n");
        assert_eq!(remove_guidance_block(&only, &k), "");
    }

    #[test]
    fn remove_first_of_two_sequential_blocks_without_leading_blank_line() {
        let a = guidance_key(REMOTE, "a");
        let b = guidance_key(REMOTE, "b");
        let mut file = upsert_guidance_block("", &a, "A");
        file = upsert_guidance_block(&file, &b, "B");
        let out = remove_guidance_block(&file, &a);
        assert_eq!(
            out,
            format!("<!-- SKILLKEEPER_START: {b} -->\nB\n<!-- SKILLKEEPER_END: {b} -->\n")
        );
    }

    #[test]
    fn has_guidance_block_detects_presence() {
        let k = key();
        let out = upsert_guidance_block("", &k, "Body.");
        assert!(has_guidance_block(&out, &k));
        assert!(!has_guidance_block("", &k));
    }

    #[test]
    fn strip_drops_marker_lines_but_keeps_the_rest() {
        let k = key();
        let body = format!(
            "Line one.\n<!-- SKILLKEEPER_END: {k} -->\nLine two.\n<!-- SKILLKEEPER_START: x; y -->"
        );
        assert_eq!(strip_guidance_markers(&body), "Line one.\nLine two.");
    }

    #[test]
    fn strip_leaves_an_unrelated_body_untouched() {
        assert_eq!(
            strip_guidance_markers("Just guidance text.\nMore."),
            "Just guidance text.\nMore."
        );
    }

    #[test]
    fn strip_neutralizes_a_body_so_it_cannot_break_its_own_block() {
        let k = key();
        let body = strip_guidance_markers(&format!("intro\n<!-- SKILLKEEPER_END: {k} -->\noutro"));
        let out = upsert_guidance_block("", &k, &body);
        assert_eq!(out.matches("SKILLKEEPER_START").count(), 1);
        assert_eq!(out.matches("SKILLKEEPER_END").count(), 1);
    }
}
