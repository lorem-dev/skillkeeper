//! Delimited-text hook strategy (Rust port of
//! `packages/core/src/hooks/hookRegion.ts`).
//!
//! Manage an owned, comment-delimited region in a comment-capable file. The
//! region is bounded by stable markers carrying a `delimiter_id` so the exact
//! block can be found and removed later even if the surrounding content changed.

use std::sync::OnceLock;

use regex::Regex;

/// The sentinel substring that identifies a SkillKeeper-managed region.
const SENTINEL: &str = "skillkeeper:hook";

/// Guard token used to neutralize foreign occurrences of the sentinel so user
/// content cannot be mistaken for a managed region. Chosen to be unlikely to
/// appear naturally and reversible via doubling.
const GUARD: &str = "SK7HOOKGUARD7";

/// Options for [`wrap_region`].
#[derive(Debug, Clone)]
pub struct WrapRegionOptions {
    /// Opening comment token for the target file type (`#`, `//`, `<!--`).
    pub comment_token: String,
    /// Optional closing comment token (for example `-->` for HTML).
    pub comment_close: Option<String>,
    /// Stable identifier embedded in both markers.
    pub delimiter_id: String,
    /// Human-readable label, typically `<group>/<name>:<hookName>`.
    pub label: String,
    /// Optional version shown on the opening marker.
    pub version: Option<String>,
    /// The generated content placed between the markers.
    pub content: String,
}

/// Insertion position for [`insert_region`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InsertMode {
    Append,
    Prepend,
}

fn open_marker(opts: &WrapRegionOptions) -> String {
    let version = match &opts.version {
        None => String::new(),
        Some(v) => format!("v{v} "),
    };
    let core = format!(
        ">>> {SENTINEL} {} {version}[{}] >>>",
        opts.label, opts.delimiter_id
    );
    let close = match &opts.comment_close {
        None => String::new(),
        Some(c) => format!(" {c}"),
    };
    format!("{} {core}{close}", opts.comment_token)
}

fn close_marker(opts: &WrapRegionOptions) -> String {
    let core = format!("<<< {SENTINEL} {} [{}] <<<", opts.label, opts.delimiter_id);
    let close = match &opts.comment_close {
        None => String::new(),
        Some(c) => format!(" {c}"),
    };
    format!("{} {core}{close}", opts.comment_token)
}

/// Build a delimited region block (open marker, content, close marker) with no
/// trailing newline. Use [`insert_region`] to place it into a file.
pub fn wrap_region(opts: &WrapRegionOptions) -> String {
    format!(
        "{}\n{}\n{}",
        open_marker(opts),
        opts.content,
        close_marker(opts)
    )
}

/// Index range (inclusive line indices) of the managed region identified by
/// `delimiter_id`, or `None`.
fn find_region(file: &str, delimiter_id: &str) -> Option<(usize, usize)> {
    let lines: Vec<&str> = file.split('\n').collect();
    let open_needle = format!("[{delimiter_id}] >>>");
    let close_needle = format!("[{delimiter_id}] <<<");
    let mut open_line: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if open_line.is_none() && line.contains(SENTINEL) && line.contains(&open_needle) {
            open_line = Some(i);
        } else if open_line.is_some() && line.contains(SENTINEL) && line.contains(&close_needle) {
            return Some((open_line.expect("open line set"), i));
        }
    }
    None
}

/// Extract the exact region block text (open marker through close marker) for
/// `delimiter_id`, or `None` when no such region exists.
pub fn extract_region(file: &str, delimiter_id: &str) -> Option<String> {
    let (start, end) = find_region(file, delimiter_id)?;
    let lines: Vec<&str> = file.split('\n').collect();
    Some(lines[start..=end].join("\n"))
}

fn block_delimiter_id(block: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[([^\]]+)\] >>>").expect("valid id regex"));
    re.captures(block)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

/// Insert a region block into a file. If a region with the same `delimiter_id`
/// already exists it is replaced in place (idempotent); otherwise the block is
/// appended or prepended per `mode`. The result always ends with a newline.
pub fn insert_region(file: &str, block: &str, mode: InsertMode) -> String {
    if let Some(delimiter_id) = block_delimiter_id(block) {
        if let Some((start, end)) = find_region(file, &delimiter_id) {
            let lines: Vec<&str> = file.split('\n').collect();
            let mut out: Vec<&str> = Vec::new();
            out.extend_from_slice(&lines[..start]);
            let block_lines: Vec<&str> = block.split('\n').collect();
            out.extend_from_slice(&block_lines);
            out.extend_from_slice(&lines[end + 1..]);
            return out.join("\n");
        }
    }
    if file.is_empty() {
        return format!("{block}\n");
    }
    let base = if file.ends_with('\n') {
        file.to_string()
    } else {
        format!("{file}\n")
    };
    match mode {
        InsertMode::Append => format!("{base}{block}\n"),
        InsertMode::Prepend => format!("{block}\n{base}"),
    }
}

/// Remove exactly the managed region identified by `delimiter_id`, including the
/// region's own trailing newline. Surrounding content is preserved. Returns the
/// input unchanged when no such region exists.
pub fn remove_region(file: &str, delimiter_id: &str) -> String {
    let Some((start, end)) = find_region(file, delimiter_id) else {
        return file.to_string();
    };
    let lines: Vec<&str> = file.split('\n').collect();
    let mut kept: Vec<&str> = Vec::new();
    kept.extend_from_slice(&lines[..start]);
    kept.extend_from_slice(&lines[end + 1..]);
    kept.join("\n")
}

/// One managed region lifted out of a file by [`lift_regions`], with the little
/// context [`restore_regions`] needs to put it back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiftedRegion {
    /// The region text verbatim, open marker line through close marker line,
    /// without a trailing newline.
    pub block: String,
    /// Whether the region sat above every other line of the file (blank lines
    /// aside). Line numbers cannot be preserved across a caller that rewrites
    /// the rest of the file wholesale, so "before or after the content" is the
    /// position that survives.
    pub leading: bool,
}

/// The delimiter id of an opening marker line, or `None` when the line is not
/// one of our opening markers.
fn open_marker_id(line: &str) -> Option<String> {
    if !line.contains(SENTINEL) {
        return None;
    }
    block_delimiter_id(line)
}

/// Line index of the closing marker for `delimiter_id` at or after `from`.
fn close_marker_line(lines: &[&str], from: usize, delimiter_id: &str) -> Option<usize> {
    let needle = format!("[{delimiter_id}] <<<");
    lines[from..]
        .iter()
        .position(|line| line.contains(SENTINEL) && line.contains(&needle))
        .map(|offset| from + offset)
}

/// Lift every managed region out of `file`, returning the remaining text plus
/// the lifted blocks in source order.
///
/// This exists for writers whose parser cannot survive a comment-delimited
/// region in the file they own -- the one live case is opencode at global scope,
/// where the hook target file and the native MCP config file are the same
/// `~/.config/opencode/opencode.json`. Such a writer lifts our regions, parses
/// the remainder, and calls [`restore_regions`] on its output.
///
/// Only a COMPLETE region (an opening marker with a matching closing marker) is
/// lifted. A lone marker -- a truncated file, a half-hand-edited block -- stays
/// in the remainder, as does every other byte of foreign content, so a caller
/// that parses the remainder still rejects what it cannot understand instead of
/// quietly dropping it.
pub fn lift_regions(file: &str) -> (String, Vec<LiftedRegion>) {
    let lines: Vec<&str> = file.split('\n').collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut regions: Vec<LiftedRegion> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(id) = open_marker_id(lines[i]) {
            if let Some(end) = close_marker_line(&lines, i + 1, &id) {
                regions.push(LiftedRegion {
                    block: lines[i..=end].join("\n"),
                    leading: kept.iter().all(|line| line.trim().is_empty()),
                });
                i = end + 1;
                continue;
            }
        }
        kept.push(lines[i]);
        i += 1;
    }
    (kept.join("\n"), regions)
}

/// Put regions lifted by [`lift_regions`] back into `file`, each block
/// byte-for-byte and on the side of the content it came from. The result ends
/// with a newline whenever any region is restored.
pub fn restore_regions(file: &str, regions: &[LiftedRegion]) -> String {
    let mut out = file.to_string();
    // Leading blocks are prepended in reverse so that repeated prepends leave
    // them in their original relative order.
    for region in regions.iter().filter(|r| r.leading).rev() {
        out = insert_region(&out, &region.block, InsertMode::Prepend);
    }
    for region in regions.iter().filter(|r| !r.leading) {
        out = insert_region(&out, &region.block, InsertMode::Append);
    }
    out
}

/// Escape any foreign occurrence of the managed-region sentinel in arbitrary
/// content so it cannot be parsed as a real delimiter. Reversible via
/// [`decapsulate_foreign_delimiters`].
pub fn encapsulate_foreign_delimiters(content: &str) -> String {
    // Protect literal guard tokens by doubling them first, then break the
    // sentinel with a single guard so it no longer reads as "skillkeeper:hook".
    content
        .replace(GUARD, &format!("{GUARD}{GUARD}"))
        .replace(SENTINEL, &format!("skillkeeper:{GUARD}hook"))
}

/// Inverse of [`encapsulate_foreign_delimiters`].
pub fn decapsulate_foreign_delimiters(content: &str) -> String {
    content
        .replace(&format!("skillkeeper:{GUARD}hook"), SENTINEL)
        .replace(&format!("{GUARD}{GUARD}"), GUARD)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(
        comment_token: &str,
        delimiter_id: &str,
        label: &str,
        content: &str,
    ) -> WrapRegionOptions {
        WrapRegionOptions {
            comment_token: comment_token.to_string(),
            comment_close: None,
            delimiter_id: delimiter_id.to_string(),
            label: label.to_string(),
            version: None,
            content: content.to_string(),
        }
    }

    #[test]
    fn wrap_produces_exact_markers_for_hash_token() {
        let block = wrap_region(&WrapRegionOptions {
            comment_token: "#".to_string(),
            comment_close: None,
            delimiter_id: "abc123".to_string(),
            label: "group/name:hookName".to_string(),
            version: Some("1.0.0".to_string()),
            content: "export FOO=bar".to_string(),
        });
        let lines: Vec<&str> = block.split('\n').collect();
        assert_eq!(
            lines[0],
            "# >>> skillkeeper:hook group/name:hookName v1.0.0 [abc123] >>>"
        );
        assert_eq!(lines[1], "export FOO=bar");
        assert_eq!(
            lines[2],
            "# <<< skillkeeper:hook group/name:hookName [abc123] <<<"
        );
    }

    #[test]
    fn wrap_omits_version_when_absent() {
        let block = wrap_region(&opts("//", "id1", "a:b", "x"));
        assert_eq!(
            block.split('\n').next().unwrap(),
            "// >>> skillkeeper:hook a:b [id1] >>>"
        );
    }

    #[test]
    fn wrap_supports_html_comment_close_form() {
        let block = wrap_region(&WrapRegionOptions {
            comment_token: "<!--".to_string(),
            comment_close: Some("-->".to_string()),
            delimiter_id: "h1".to_string(),
            label: "a:b".to_string(),
            version: None,
            content: "body".to_string(),
        });
        let lines: Vec<&str> = block.split('\n').collect();
        assert_eq!(lines[0], "<!-- >>> skillkeeper:hook a:b [h1] >>> -->");
        assert_eq!(lines[2], "<!-- <<< skillkeeper:hook a:b [h1] <<< -->");
    }

    #[test]
    fn insert_appends_to_empty_file() {
        let block = wrap_region(&opts("#", "id1", "a:b", "X"));
        assert_eq!(
            insert_region("", &block, InsertMode::Append),
            format!("{block}\n")
        );
    }

    #[test]
    fn insert_appends_after_existing_content() {
        let block = wrap_region(&opts("#", "id1", "a:b", "X"));
        assert_eq!(
            insert_region("existing line\n", &block, InsertMode::Append),
            format!("existing line\n{block}\n")
        );
    }

    #[test]
    fn insert_prepends_in_prepend_mode() {
        let block = wrap_region(&opts("#", "id1", "a:b", "X"));
        assert_eq!(
            insert_region("existing\n", &block, InsertMode::Prepend),
            format!("{block}\nexisting\n")
        );
    }

    #[test]
    fn insert_is_idempotent_for_same_id() {
        let block = wrap_region(&opts("#", "id1", "a:b", "X"));
        let once = insert_region("base\n", &block, InsertMode::Append);
        let twice = insert_region(&once, &block, InsertMode::Append);
        let count = twice.matches("[id1] >>>").count();
        assert_eq!(count, 1);
    }

    #[test]
    fn insert_adds_trailing_newline_when_missing_prepend() {
        let block = wrap_region(&opts("#", "id1", "a:b", "X"));
        assert_eq!(
            insert_region("no-newline", &block, InsertMode::Prepend),
            format!("{block}\nno-newline\n")
        );
    }

    #[test]
    fn insert_appends_to_file_without_trailing_newline() {
        let block = wrap_region(&opts("#", "id1", "a:b", "X"));
        assert_eq!(
            insert_region("no-newline", &block, InsertMode::Append),
            format!("no-newline\n{block}\n")
        );
    }

    #[test]
    fn insert_block_without_id_marker_takes_append_path() {
        let raw = "plain block without markers";
        assert_eq!(
            insert_region("base\n", raw, InsertMode::Append),
            format!("base\n{raw}\n")
        );
    }

    #[test]
    fn remove_removes_exact_block_leaving_surrounding_text() {
        let block = wrap_region(&opts("#", "target", "a:b", "gen"));
        let file = format!("before\n{block}\nafter\n");
        assert_eq!(remove_region(&file, "target"), "before\nafter\n");
    }

    #[test]
    fn remove_only_matching_id_when_several_present() {
        let b1 = wrap_region(&opts("#", "one", "a:b", "1"));
        let b2 = wrap_region(&opts("#", "two", "c:d", "2"));
        let file = format!("{b1}\n{b2}\n");
        let result = remove_region(&file, "one");
        assert!(!result.contains("[one]"));
        assert!(result.contains("[two]"));
    }

    #[test]
    fn remove_region_after_surrounding_content_changed() {
        let block = wrap_region(&opts("#", "keep", "a:b", "g"));
        let file = format!("head edited later\n\n{block}\n\ntail edited later\n");
        let result = remove_region(&file, "keep");
        assert!(!result.contains("skillkeeper:hook"));
        assert!(result.contains("head edited later"));
        assert!(result.contains("tail edited later"));
    }

    #[test]
    fn remove_returns_input_unchanged_when_absent() {
        let file = "nothing here\n";
        assert_eq!(remove_region(file, "absent"), file);
    }

    #[test]
    fn extract_returns_the_block_text() {
        let block = wrap_region(&opts("#", "e1", "a:b", "gen"));
        let file = format!("before\n{block}\nafter\n");
        assert_eq!(extract_region(&file, "e1"), Some(block));
        assert_eq!(extract_region(&file, "absent"), None);
    }

    #[test]
    fn lift_takes_our_region_and_leaves_the_rest() {
        let block = wrap_region(&opts("#", "l1", "a:b", "gen"));
        let file = format!("{{\n  \"theme\": \"dark\"\n}}\n{block}\n");
        let (remainder, regions) = lift_regions(&file);
        assert_eq!(remainder, "{\n  \"theme\": \"dark\"\n}\n");
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].block, block);
        assert!(!regions[0].leading);
        assert_eq!(restore_regions(&remainder, &regions), file);
    }

    #[test]
    fn lift_marks_a_region_above_all_content_as_leading() {
        let block = wrap_region(&opts("#", "l2", "a:b", "gen"));
        let file = format!("\n{block}\n{{}}\n");
        let (remainder, regions) = lift_regions(&file);
        assert_eq!(remainder, "\n{}\n");
        assert!(regions[0].leading);
        // The block goes back above the content, though the blank line the file
        // opened with is not reproduced.
        assert_eq!(restore_regions("{}", &regions), format!("{block}\n{{}}\n"));
    }

    #[test]
    fn lift_keeps_several_regions_in_order_on_their_own_side() {
        let leading = wrap_region(&opts("#", "first", "a:b", "1"));
        let leading2 = wrap_region(&opts("#", "second", "c:d", "2"));
        let trailing = wrap_region(&opts("#", "third", "e:f", "3"));
        let file = format!("{leading}\n{leading2}\nbody\n{trailing}\n");
        let (remainder, regions) = lift_regions(&file);
        assert_eq!(remainder, "body\n");
        assert_eq!(regions.len(), 3);
        assert_eq!(
            regions.iter().map(|r| r.leading).collect::<Vec<_>>(),
            vec![true, true, false]
        );
        assert_eq!(restore_regions(&remainder, &regions), file);
    }

    #[test]
    fn lift_leaves_a_region_missing_its_close_marker_in_place() {
        // A truncated or hand-mangled block is not ours to move: a caller that
        // parses the remainder must still see (and reject) the leftover text.
        let block = wrap_region(&opts("#", "t1", "a:b", "gen"));
        let truncated = block.split('\n').take(2).collect::<Vec<&str>>().join("\n");
        let file = format!("{{}}\n{truncated}\n");
        let (remainder, regions) = lift_regions(&file);
        assert!(regions.is_empty());
        assert_eq!(remainder, file);
    }

    #[test]
    fn lift_returns_nothing_for_a_file_without_regions() {
        for file in ["", "{}\n", "# an ordinary comment\n"] {
            let (remainder, regions) = lift_regions(file);
            assert_eq!(remainder, file);
            assert!(regions.is_empty());
        }
    }

    #[test]
    fn restore_puts_a_region_into_an_empty_result() {
        let block = wrap_region(&opts("#", "r1", "a:b", "gen"));
        let (_, regions) = lift_regions(&format!("{block}\n"));
        assert_eq!(restore_regions("", &regions), format!("{block}\n"));
    }

    #[test]
    fn encapsulate_round_trips_arbitrary_content() {
        for s in ["plain text", "", "multi\nline\ncontent", "has # comments"] {
            assert_eq!(
                decapsulate_foreign_delimiters(&encapsulate_foreign_delimiters(s)),
                s
            );
        }
    }

    #[test]
    fn encapsulate_neutralizes_open_delimiter() {
        let evil = "normal\n# >>> skillkeeper:hook fake:hook [xyz] >>>\ninjected\n";
        let enc = encapsulate_foreign_delimiters(evil);
        assert!(!enc.contains("skillkeeper:hook fake:hook [xyz] >>>"));
        assert_eq!(decapsulate_foreign_delimiters(&enc), evil);
    }

    #[test]
    fn encapsulate_neutralizes_close_delimiter() {
        let evil = "# <<< skillkeeper:hook fake:hook [xyz] <<<\n";
        let enc = encapsulate_foreign_delimiters(evil);
        assert!(!enc.contains("<<< skillkeeper:hook"));
        assert_eq!(decapsulate_foreign_delimiters(&enc), evil);
    }

    #[test]
    fn wrapped_encapsulated_content_cannot_be_falsely_removed() {
        let evil_content =
            "# >>> skillkeeper:hook fake:f [evil] >>>\npayload\n# <<< skillkeeper:hook fake:f [evil] <<<";
        let safe = encapsulate_foreign_delimiters(evil_content);
        let block = wrap_region(&opts("#", "real", "r:r", &safe));
        // The injected id must not be removable.
        assert_eq!(remove_region(&block, "evil"), block);
        // The real id removes the whole block.
        assert_eq!(remove_region(&block, "real"), "");
    }
}
