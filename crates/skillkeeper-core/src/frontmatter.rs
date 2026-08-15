//! Markdown YAML frontmatter splitting (Rust port of
//! `packages/core/src/kernel/frontmatter.ts`).
//!
//! The frontmatter must begin on the very first line, delimited by `---`
//! fences. When absent, `data` is `None` and `body` is the whole input. An
//! empty frontmatter block parses to `Value::Null` (matching the TS `null`).
//!
//! Two things make a rejected block actionable rather than opaque:
//!
//! - A failure carries the parser's own diagnostic, with the position restated
//!   relative to the whole file (the block starts on line 2, after the opening
//!   fence), so the message names the line to go fix.
//! - A plain scalar holding a second `": "` -- prose in a `description:` does
//!   it constantly -- is re-quoted and reparsed instead of rejected. YAML reads
//!   that colon as the start of a nested mapping and fails, which is never what
//!   the author meant on a one-line value.

use std::sync::OnceLock;

use regex::Regex;
use serde_yaml_ng::Value;
use thiserror::Error;

/// Lines the opening `---` fence occupies, so a position inside the YAML block
/// maps onto the line the reader sees in the file.
const FENCE_LINES: usize = 1;

/// Result of splitting a Markdown document into frontmatter and body.
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    /// Parsed YAML frontmatter, or `None` when the document has none.
    pub data: Option<Value>,
    /// The Markdown body following the frontmatter (or the whole input).
    pub body: String,
}

/// Returned when the frontmatter block contains invalid YAML.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
#[error("Invalid YAML frontmatter: {message}")]
pub struct FrontmatterError {
    /// The parser's diagnostic, positioned against the whole file.
    pub message: String,
    /// 1-based line in the whole document, when the parser reported one.
    pub line: Option<usize>,
    /// 1-based column, when the parser reported one.
    pub column: Option<usize>,
}

/// Restate a parser error against the whole document: its own position is
/// relative to the YAML block, which starts after the opening fence.
fn describe(err: &serde_yaml_ng::Error) -> FrontmatterError {
    let text = err.to_string();
    let Some(loc) = err.location() else {
        return FrontmatterError {
            message: text,
            line: None,
            column: None,
        };
    };
    let line = loc.line() + FENCE_LINES;
    let column = loc.column();
    // Drop the parser's own block-relative " at line L column C" tail before
    // restating the position, so the message never carries two of them.
    let head = match text.rfind(" at line ") {
        Some(at) => &text[..at],
        None => text.as_str(),
    };
    FrontmatterError {
        message: format!("{head} at line {line} column {column}"),
        line: Some(line),
        column: Some(column),
    }
}

/// Whether `value` starts a YAML construct that quoting would destroy (an
/// anchor, alias, tag, block scalar, flow collection, comment, or directive).
fn starts_yaml_construct(value: &str) -> bool {
    value.chars().next().is_some_and(|c| {
        matches!(
            c,
            '&' | '*' | '!' | '|' | '>' | '{' | '[' | '#' | '%' | '@' | '`' | '"' | '\''
        )
    })
}

/// Split `line` at the `key:` separator: the first colon that ends the line or
/// is followed by a space. Returns `(indent_and_key, value)`, or `None` when
/// the line is not a `key: value` mapping entry.
fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let key_end = line.char_indices().find_map(|(i, c)| {
        if c != ':' {
            return None;
        }
        match line[i + 1..].chars().next() {
            None | Some(' ') | Some('\t') => Some(i),
            Some(_) => None,
        }
    })?;
    let key = &line[..key_end];
    let trimmed = key.trim_start();
    // A list item, comment, or empty key is not a plain mapping key we can
    // safely rewrite.
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('-') {
        return None;
    }
    Some((key, line[key_end + 1..].trim_start_matches([' ', '\t'])))
}

/// Indentation width of `line`, in characters.
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

/// Re-quote plain scalars carrying a bare `": "` (or a trailing colon), which
/// YAML reads as a nested mapping and rejects. Returns `None` when there is
/// nothing to rewrite, so a document that already parses is never touched.
///
/// Lines belonging to a block scalar (`key: |`, `key: >`) are left verbatim --
/// their content is literal text, not YAML to reinterpret.
fn requote_inline_colons(yaml: &str) -> Option<String> {
    let mut out: Vec<String> = Vec::new();
    let mut changed = false;
    // Indentation a block scalar's content must exceed to still belong to it.
    let mut block_indent: Option<usize> = None;

    for raw in yaml.split('\n') {
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

        let Some((key, value)) = split_key_value(line) else {
            out.push(raw.to_string());
            continue;
        };
        if value.starts_with('|') || value.starts_with('>') {
            block_indent = Some(indent_of(line));
            out.push(raw.to_string());
            continue;
        }
        let value = value.trim_end_matches([' ', '\t']);
        let needs_quoting = !value.is_empty()
            && !starts_yaml_construct(value)
            && (value.contains(": ") || value.ends_with(':'));
        if !needs_quoting {
            out.push(raw.to_string());
            continue;
        }
        changed = true;
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        out.push(format!("{key}: \"{escaped}\"{eol}"));
    }

    changed.then(|| out.join("\n"))
}

/// Split a Markdown document into its optional YAML frontmatter block and body.
/// The frontmatter must start on the very first line. When absent, `data` is
/// `None` and `body` is the whole input.
///
/// # Errors
///
/// Returns [`FrontmatterError`] when the frontmatter block holds YAML that is
/// invalid even after unquoted `": "` values are re-quoted.
pub fn split_frontmatter(md: &str) -> Result<Frontmatter, FrontmatterError> {
    let Some(caps) = frontmatter_re().captures(md) else {
        return Ok(Frontmatter {
            data: None,
            body: md.to_string(),
        });
    };
    let yaml_text = caps.get(1).map_or("", |m| m.as_str());
    let body = caps.get(2).map_or("", |m| m.as_str()).to_string();
    let data: Value = match serde_yaml_ng::from_str(yaml_text) {
        Ok(data) => data,
        Err(err) => {
            // Retry with inline colons quoted; report the ORIGINAL error when
            // that does not help, since it describes the document as written.
            let repaired = requote_inline_colons(yaml_text)
                .and_then(|text| serde_yaml_ng::from_str(&text).ok());
            repaired.ok_or_else(|| describe(&err))?
        }
    };
    Ok(Frontmatter {
        data: Some(data),
        body,
    })
}

// Leading `---` line, YAML lines (lazily captured), then a closing `---` line.
fn frontmatter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$")
            .expect("valid frontmatter regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaml(s: &str) -> Value {
        serde_yaml_ng::from_str(s).expect("valid yaml")
    }

    #[test]
    fn splits_frontmatter_from_a_body() {
        let fm = split_frontmatter("---\nname: x\n---\nbody here\n").unwrap();
        assert_eq!(fm.data, Some(yaml("name: x")));
        assert_eq!(fm.body, "body here\n");
    }

    #[test]
    fn returns_empty_body_when_nothing_follows_closing_fence() {
        let fm = split_frontmatter("---\nname: x\n---").unwrap();
        assert_eq!(fm.data, Some(yaml("name: x")));
        assert_eq!(fm.body, "");
    }

    #[test]
    fn returns_none_data_and_whole_input_when_no_frontmatter() {
        let fm = split_frontmatter("# just markdown\n").unwrap();
        assert_eq!(fm.data, None);
        assert_eq!(fm.body, "# just markdown\n");
    }

    #[test]
    fn handles_an_empty_frontmatter_block() {
        let fm = split_frontmatter("---\n\n---\nbody\n").unwrap();
        assert_eq!(fm.data, Some(Value::Null));
    }

    #[test]
    fn errors_on_malformed_yaml() {
        let err = split_frontmatter("---\nname: \"open\n---\n").unwrap_err();
        assert!(!err.message.is_empty());
    }

    #[test]
    fn error_positions_are_relative_to_the_whole_file() {
        // The offending `@` sits on the file's THIRD line: fence, name, then it.
        let err = split_frontmatter("---\nname: x\n@bad\n---\n").unwrap_err();
        assert_eq!(err.line, Some(3));
        assert_eq!(err.column, Some(1));
        assert!(
            err.message.contains("at line 3 column 1"),
            "{}",
            err.message
        );
    }

    #[test]
    fn error_message_carries_the_parser_diagnostic_once() {
        let err = split_frontmatter("---\nname: x\n@bad\n---\n").unwrap_err();
        assert_eq!(err.message.matches(" at line ").count(), 1);
        assert!(err.to_string().starts_with("Invalid YAML frontmatter: "));
    }

    #[test]
    fn accepts_a_second_colon_in_an_unquoted_value() {
        let fm =
            split_frontmatter("---\nname: x\ndescription: Covers the tool: run it\n---\nbody\n")
                .unwrap();
        assert_eq!(
            fm.data,
            Some(yaml("name: x\ndescription: \"Covers the tool: run it\""))
        );
        assert_eq!(fm.body, "body\n");
    }

    #[test]
    fn accepts_several_colons_in_one_value() {
        let fm = split_frontmatter("---\ndescription: a: b: c\n---\n").unwrap();
        assert_eq!(fm.data, Some(yaml("description: \"a: b: c\"")));
    }

    #[test]
    fn accepts_a_value_ending_in_a_colon() {
        let fm = split_frontmatter("---\ndescription: see this:\n---\n").unwrap();
        assert_eq!(fm.data, Some(yaml("description: \"see this:\"")));
    }

    #[test]
    fn requoting_reaches_nested_and_crlf_lines() {
        let fm = split_frontmatter("---\r\nmeta:\r\n  note: a: b\r\n---\r\n").unwrap();
        assert_eq!(fm.data, Some(yaml("meta:\n  note: \"a: b\"")));
    }

    #[test]
    fn leaves_a_url_value_alone() {
        // `https://x` has no space after its colon, so it was never ambiguous.
        let fm = split_frontmatter("---\nurl: https://example.com/a\n---\n").unwrap();
        assert_eq!(fm.data, Some(yaml("url: https://example.com/a")));
    }

    #[test]
    fn leaves_quoted_and_flow_values_alone() {
        let fm = split_frontmatter("---\na: \"x: y\"\nb: [1, 2]\nc: 'p: q'\n---\n").unwrap();
        assert_eq!(fm.data, Some(yaml("a: \"x: y\"\nb: [1, 2]\nc: \"p: q\"")));
    }

    #[test]
    fn does_not_rewrite_block_scalar_content() {
        let md = "---\nname: x\nrules: |\n  do this: then that\n---\n";
        let fm = split_frontmatter(md).unwrap();
        assert_eq!(
            fm.data,
            Some(yaml("name: x\nrules: |\n  do this: then that"))
        );
    }

    #[test]
    fn still_reports_an_error_requoting_cannot_fix() {
        let err = split_frontmatter("---\nname: \"open\ndesc: a: b\n---\n").unwrap_err();
        assert!(err.line.is_some());
    }

    #[test]
    fn tolerates_crlf_line_endings() {
        let fm = split_frontmatter("---\r\nname: y\r\n---\r\nbody\r\n").unwrap();
        assert_eq!(fm.data, Some(yaml("name: y")));
        assert_eq!(fm.body, "body\r\n");
    }
}
