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

use crate::yaml_repair;

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
    /// Notes about values [`crate::yaml_repair`] had to re-quote to parse the
    /// block, each naming the line to fix. Empty for a block that parsed as
    /// written -- which is every block that does not lean on the leniency.
    pub notes: Vec<String>,
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

/// Split a Markdown document into its optional YAML frontmatter block and body.
/// The frontmatter must start on the very first line. When absent, `data` is
/// `None` and `body` is the whole input.
///
/// # Errors
///
/// Returns [`FrontmatterError`] when the frontmatter block holds YAML that is
/// invalid even after [`crate::yaml_repair`] re-quotes the plain scalars YAML
/// would misread.
pub fn split_frontmatter(md: &str) -> Result<Frontmatter, FrontmatterError> {
    let Some(caps) = frontmatter_re().captures(md) else {
        return Ok(Frontmatter {
            data: None,
            body: md.to_string(),
            notes: Vec::new(),
        });
    };
    let yaml_text = caps.get(1).map_or("", |m| m.as_str());
    let body = caps.get(2).map_or("", |m| m.as_str()).to_string();
    let (data, notes): (Value, Vec<String>) = match serde_yaml_ng::from_str(yaml_text) {
        Ok(data) => (data, Vec::new()),
        Err(err) => {
            // Retry re-quoted; report the ORIGINAL error when that does not
            // help, since it describes the document as the author wrote it.
            let repaired = yaml_repair::repair(yaml_text).and_then(|r| {
                serde_yaml_ng::from_str(&r.text)
                    .ok()
                    .map(|v| (v, r.repairs))
            });
            match repaired {
                // Repair line numbers are block-relative; restate them against
                // the file, the same shift `describe` applies to an error.
                Some((value, repairs)) => (
                    value,
                    repairs
                        .iter()
                        .map(|r| {
                            format!(
                                "line {}: read \"{}\" as text; quote it to silence this",
                                r.line + FENCE_LINES,
                                r.value
                            )
                        })
                        .collect(),
                ),
                None => return Err(describe(&err)),
            }
        }
    };
    Ok(Frontmatter {
        data: Some(data),
        body,
        notes,
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
    fn reports_a_repair_against_the_file_line() {
        // The repaired value sits on the file's THIRD line: fence, name, then it.
        let fm =
            split_frontmatter("---\nname: x\ndescription: Covers the tool: run it\n---\n").unwrap();
        assert_eq!(fm.notes.len(), 1);
        assert!(fm.notes[0].starts_with("line 3: "), "{}", fm.notes[0]);
    }

    #[test]
    fn reports_no_notes_for_a_block_that_parses_as_written() {
        let fm = split_frontmatter("---\nname: x\n---\nbody\n").unwrap();
        assert!(fm.notes.is_empty());
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
