//! Re-quoting plain scalars that YAML reads as something the author did not
//! mean, so a hand-written document is not lost to a punctuation rule.
//!
//! Two shapes turn up constantly in SkillKeeper's own files and both are
//! unambiguous in intent:
//!
//! - **A second `": "` in a one-line value.** Prose does it all the time
//!   (`description: Covers the tool: how to run it`). YAML reads the second
//!   colon as the start of a nested mapping and rejects the document.
//! - **A value that opens with a `{param}` placeholder.** `{` starts a flow
//!   mapping, so `X-Token: {personal_token}` parses to the map
//!   `{personal_token: null}` rather than the placeholder string the parameter
//!   substitution expects.
//!
//! The second case is why this lives in the text layer rather than in a serde
//! adapter: by the time a field's type is known, the parser has already turned
//! `{personal_token}` into a mapping and the original spelling is gone. Nothing
//! downstream can recover it.
//!
//! [`repair`] is a RETRY step, never a preprocessor: callers parse strictly
//! first and come here only on failure, so a document that already parses is
//! never rewritten. Each rewrite is reported, so callers can tell the author
//! which line to quote.

use std::sync::OnceLock;

use regex::Regex;

/// One re-quoted value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repair {
    /// 1-based line within the text passed to [`repair`].
    pub line: usize,
    /// The mapping key whose value was re-quoted.
    pub key: String,
    /// The value as the author wrote it, before quoting.
    pub value: String,
}

impl Repair {
    /// A one-line note naming the line, the key, and how to silence it.
    #[must_use]
    pub fn note(&self) -> String {
        format!(
            "line {}: read \"{}\" as text; quote it to silence this",
            self.line, self.value
        )
    }
}

/// The rewritten document plus what was rewritten to get there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repaired {
    pub text: String,
    pub repairs: Vec<Repair>,
}

/// A value opening with a `{name}` placeholder -- the same grammar
/// `crate::mcp::params` scans for, so a genuine flow mapping
/// (`{FOO: bar}`, `{a, b}`, `{}`) never matches.
fn placeholder_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\{[A-Za-z0-9_]+\}").expect("valid placeholder regex"))
}

/// Whether `value` starts a YAML construct that quoting would destroy (an
/// anchor, alias, tag, flow collection, comment, or directive). Block scalars
/// and quotes are handled separately by the caller.
fn starts_yaml_construct(value: &str) -> bool {
    value
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '&' | '*' | '!' | '{' | '[' | '#' | '%' | '@' | '`'))
}

/// Byte offset just past a quoted key at the start of `s`, or `None` when `s`
/// does not open with a quote. Handles `''` and `\"` escapes; an unterminated
/// quote yields `None`.
fn quoted_key_end(s: &str) -> Option<usize> {
    let quote = match s.as_bytes().first() {
        Some(b'"') => b'"',
        Some(b'\'') => b'\'',
        _ => return None,
    };
    let bytes = s.as_bytes();
    let mut i = 1;
    while i < bytes.len() {
        if bytes[i] == b'\\' && quote == b'"' {
            i += 2;
            continue;
        }
        if bytes[i] == quote {
            // A doubled single quote is an escaped quote, not the terminator.
            if quote == b'\'' && bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return Some(i + 1);
        }
        i += 1;
    }
    None
}

/// Split `line` at the `key:` separator: the first colon that ends the line or
/// is followed by a space. Returns `(indent_and_key, value)`, or `None` when
/// the line is not a `key: value` mapping entry we may rewrite.
fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let trimmed = &line[indent..];
    // A list item, comment, or empty key is not a plain mapping key we can
    // safely rewrite. A sequence item's own block scalar is still TRACKED --
    // see `block_scalar_indent` -- just never repaired.
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    // Start the separator hunt after a quoted key, so `"a: b": 1` is not split
    // inside its own key -- which would mangle a perfectly valid line and cost
    // the whole file its chance at repair.
    let search_from = indent + quoted_key_end(trimmed).unwrap_or(0);
    let key_end = line[search_from..].char_indices().find_map(|(i, c)| {
        if c != ':' {
            return None;
        }
        let at = search_from + i;
        match line[at + 1..].chars().next() {
            None | Some(' ') | Some('\t') => Some(at),
            Some(_) => None,
        }
    })?;
    Some((
        &line[..key_end],
        line[key_end + 1..].trim_start_matches([' ', '\t']),
    ))
}

/// The indentation a block scalar's content must exceed, when `line` opens one.
///
/// Detected independently of whether the line is repairable: `- rules: |`
/// introduces a block on a sequence item, and missing that leaves the literal
/// content to be read as YAML and rewritten. Accepts the `|-`/`|+`/`>-` chomping
/// and indentation indicators, and a trailing comment.
fn block_scalar_indent(line: &str) -> Option<usize> {
    let mut indent = line.len() - line.trim_start_matches([' ', '\t']).len();
    let mut body = strip_comment(&line[indent..]).0.trim_end();
    // A sequence marker shifts the mapping in by its own width: in
    // `  - rules: |` the key sits at column 4, and so do its siblings. Measure
    // the block against THAT, or the next sibling key looks like block content
    // and is swallowed.
    while let Some(rest) = body.strip_prefix("- ") {
        indent += 2;
        let trimmed = rest.trim_start_matches([' ', '\t']);
        indent += rest.len() - trimmed.len();
        body = trimmed;
    }
    // Everything after the last `: ` separator on the line; for `- rules: |`
    // that is `|`, for a bare `- |` (a sequence of blocks) it is also `|`.
    let after_colon = match body.rfind(": ") {
        Some(at) => body[at + 2..].trim_start(),
        None => body.strip_suffix(':').map_or(body, |_| "").trim_start(),
    };
    let mut chars = after_colon.chars();
    match chars.next() {
        Some('|' | '>') => {}
        _ => return None,
    }
    // Only the chomping/indentation indicators may follow the marker.
    if chars.all(|c| matches!(c, '-' | '+' | '0'..='9')) {
        Some(indent)
    } else {
        None
    }
}

/// Split a plain scalar from a trailing `#` comment, using YAML's own rule: a
/// comment starts at a `#` preceded by a space or tab. `{tok}#x` has no such
/// break and stays one value.
///
/// Without this the comment is swallowed into the quoted string, so
/// `X-Token: {tok}  # from the vault` would install a header whose value ends
/// in ` # from the vault` -- valid YAML, silently wrong data, where the file
/// used to be rejected outright.
fn strip_comment(value: &str) -> (&str, &str) {
    let bytes = value.as_bytes();
    for i in 1..bytes.len() {
        if bytes[i] == b'#' && matches!(bytes[i - 1], b' ' | b'\t') {
            return (&value[..i], &value[i..]);
        }
    }
    (value, "")
}

/// Indentation width of `line`, in bytes. Only 1-byte space and tab are
/// trimmed, so this equals the character count for any line YAML accepts.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

/// Whether this value needs quoting, and therefore which rule caught it.
fn needs_quoting(value: &str) -> bool {
    if value.is_empty() || value.starts_with('"') || value.starts_with('\'') {
        return false;
    }
    // Placeholder first: it opens with `{`, which the construct guard below
    // would otherwise treat as a flow mapping and leave alone.
    if placeholder_re().is_match(value) {
        return true;
    }
    if starts_yaml_construct(value) {
        return false;
    }
    value.contains(": ") || value.ends_with(':')
}

/// Re-quote the plain scalars described in the module docs. Returns `None`
/// when there is nothing to rewrite, so a caller can distinguish "no repair
/// possible" from "repaired into something that still does not parse".
///
/// Lines belonging to a block scalar (`key: |`, `key: >`) are left verbatim --
/// their content is literal text, not YAML to reinterpret.
#[must_use]
pub fn repair(yaml: &str) -> Option<Repaired> {
    let mut out: Vec<String> = Vec::new();
    let mut repairs: Vec<Repair> = Vec::new();
    // Indentation a block scalar's content must exceed to still belong to it.
    let mut block_indent: Option<usize> = None;

    for (index, raw) in yaml.split('\n').enumerate() {
        // Keep CRLF intact: the split is on '\n', so a '\r' rides along.
        let (line, eol) = match raw.strip_suffix('\r') {
            Some(stripped) => (stripped, "\r"),
            None => (raw, ""),
        };

        if let Some(indent) = block_indent {
            if line.trim().is_empty() || indent_of(line) > indent {
                out.push(raw.to_string());
                continue;
            }
            block_indent = None;
        }

        // Block detection comes FIRST and is independent of repairability: a
        // sequence item can open one (`- rules: |`), and treating its literal
        // content as YAML would rewrite the author's prose.
        if let Some(indent) = block_scalar_indent(line) {
            block_indent = Some(indent);
            out.push(raw.to_string());
            continue;
        }

        let Some((key, value)) = split_key_value(line) else {
            out.push(raw.to_string());
            continue;
        };
        let (scalar, comment) = strip_comment(value);
        let scalar = scalar.trim_end_matches([' ', '\t']);
        if !needs_quoting(scalar) {
            out.push(raw.to_string());
            continue;
        }
        repairs.push(Repair {
            line: index + 1,
            key: key.trim().to_string(),
            value: scalar.to_string(),
        });
        let escaped = scalar.replace('\\', "\\\\").replace('"', "\\\"");
        // The comment is re-appended verbatim, still separated from the value.
        let tail = if comment.is_empty() {
            String::new()
        } else {
            format!("  {comment}")
        };
        out.push(format!("{key}: \"{escaped}\"{tail}{eol}"));
    }

    if repairs.is_empty() {
        return None;
    }
    Some(Repaired {
        text: out.join("\n"),
        repairs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_of(yaml: &str) -> Option<String> {
        repair(yaml).map(|r| r.text)
    }

    #[test]
    fn quotes_a_value_holding_a_second_colon() {
        assert_eq!(
            text_of("description: Covers the tool: run it").as_deref(),
            Some("description: \"Covers the tool: run it\"")
        );
    }

    #[test]
    fn quotes_a_value_ending_in_a_colon() {
        assert_eq!(
            text_of("description: see this:").as_deref(),
            Some("description: \"see this:\"")
        );
    }

    #[test]
    fn quotes_a_bare_placeholder() {
        assert_eq!(
            text_of("X-Token: {personal_token}").as_deref(),
            Some("X-Token: \"{personal_token}\"")
        );
    }

    #[test]
    fn quotes_a_placeholder_with_a_suffix() {
        assert_eq!(
            text_of("url: {host}/mcp/v2").as_deref(),
            Some("url: \"{host}/mcp/v2\"")
        );
    }

    #[test]
    fn keeps_a_trailing_comment_out_of_the_value() {
        // Swallowing it would install a header whose value ends in the comment
        // -- valid YAML, silently wrong data, where the file used to be
        // rejected outright.
        assert_eq!(
            text_of("X-Token: {tok}  # from the vault").as_deref(),
            Some("X-Token: \"{tok}\"  # from the vault")
        );
        assert_eq!(
            text_of("description: Covers the tool: run it # reword").as_deref(),
            Some("description: \"Covers the tool: run it\"  # reword")
        );
    }

    #[test]
    fn treats_a_hash_without_leading_space_as_part_of_the_value() {
        // YAML's own rule: a comment needs whitespace before the `#`.
        assert_eq!(
            text_of("X-Token: {tok}#fragment").as_deref(),
            Some("X-Token: \"{tok}#fragment\"")
        );
    }

    #[test]
    fn does_not_rewrite_a_block_scalar_opened_on_a_sequence_item() {
        // `- rules: |` was not recognized as opening a block, so its literal
        // content was read as YAML and rewritten -- injecting quote characters
        // into prose that ships to the agent's guidance file.
        let yaml = "servers:\n  - rules: |\n      Use this when: the tool needs auth: pass a token\n    url: {host}/mcp\n";
        let out = repair(yaml).unwrap();
        assert!(
            out.text
                .contains("Use this when: the tool needs auth: pass a token"),
            "block content was rewritten: {}",
            out.text
        );
        // The real offender on the last line is still repaired.
        assert!(out.text.contains("url: \"{host}/mcp\""), "{}", out.text);
        assert_eq!(out.repairs.len(), 1);
    }

    #[test]
    fn tracks_block_scalars_with_chomping_indicators() {
        for opener in ["rules: |-", "rules: |+", "rules: >-", "rules: |2"] {
            let yaml = format!("{opener}\n  a: b: c\nname: x\n");
            assert_eq!(text_of(&yaml), None, "rewrote the body of `{opener}`");
        }
    }

    #[test]
    fn leaves_a_quoted_key_containing_a_colon_alone() {
        // Splitting inside the key mangled a valid line, and the mangled
        // document then never parsed -- so one such key cost the whole file
        // its chance at repair.
        assert_eq!(text_of("\"a: b\": 1"), None);
        assert_eq!(text_of("'a: b': 1"), None);
    }

    #[test]
    fn still_repairs_the_value_of_a_quoted_key() {
        assert_eq!(
            text_of("\"a: b\": c: d").as_deref(),
            Some("\"a: b\": \"c: d\"")
        );
    }

    #[test]
    fn leaves_a_real_flow_mapping_alone() {
        assert_eq!(text_of("headers: { Authorization: Bearer x }"), None);
        assert_eq!(text_of("env: {a, b}"), None);
        assert_eq!(text_of("env: {}"), None);
    }

    #[test]
    fn leaves_a_flow_sequence_alone() {
        assert_eq!(text_of("args: [\"-y\", \"@acme/fs\"]"), None);
    }

    #[test]
    fn leaves_a_url_alone() {
        // No space after the colon, so it was never ambiguous.
        assert_eq!(text_of("url: https://example.com/a"), None);
    }

    #[test]
    fn leaves_quoted_values_alone() {
        assert_eq!(text_of("a: \"x: y\"\nb: '{tok}'"), None);
    }

    #[test]
    fn leaves_a_mid_scalar_placeholder_alone() {
        // `{` only opens a flow mapping at the START of a value.
        assert_eq!(text_of("Authorization: Bearer {token}"), None);
    }

    #[test]
    fn does_not_rewrite_block_scalar_content() {
        assert_eq!(text_of("rules: |\n  do this: then that\nname: x"), None);
    }

    #[test]
    fn reaches_nested_keys_and_keeps_crlf() {
        let out = text_of("servers:\r\n  headers:\r\n    X-Token: {tok}\r\n").unwrap();
        assert_eq!(out, "servers:\r\n  headers:\r\n    X-Token: \"{tok}\"\r\n");
    }

    #[test]
    fn skips_sequence_items_and_comments() {
        assert_eq!(text_of("- a: b: c"), None);
        assert_eq!(text_of("# note: a comment"), None);
    }

    #[test]
    fn returns_none_when_nothing_needs_repair() {
        assert_eq!(repair("name: x\nversion: \"1.0\"\n"), None);
    }

    #[test]
    fn reports_each_repair_with_its_line_and_key() {
        let out = repair("a: 1\nX-Token: {tok}\nb: see this: here\n").unwrap();
        assert_eq!(out.repairs.len(), 2);
        assert_eq!(out.repairs[0].line, 2);
        assert_eq!(out.repairs[0].key, "X-Token");
        assert_eq!(out.repairs[0].value, "{tok}");
        assert_eq!(out.repairs[1].line, 3);
        assert_eq!(out.repairs[1].key, "b");
        assert!(out.repairs[0].note().contains("line 2"));
        assert!(out.repairs[0].note().contains("{tok}"));
    }

    #[test]
    fn escapes_quotes_and_backslashes_it_wraps() {
        let out = text_of(r#"a: {tok}\path "q""#).unwrap();
        assert_eq!(out, r#"a: "{tok}\\path \"q\"""#);
    }
}
