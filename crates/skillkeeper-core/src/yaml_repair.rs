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
        if !needs_quoting(value) {
            out.push(raw.to_string());
            continue;
        }
        repairs.push(Repair {
            line: index + 1,
            key: key.trim().to_string(),
            value: value.to_string(),
        });
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        out.push(format!("{key}: \"{escaped}\"{eol}"));
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
