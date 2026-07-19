//! Markdown YAML frontmatter splitting (Rust port of
//! `packages/core/src/kernel/frontmatter.ts`).
//!
//! The frontmatter must begin on the very first line, delimited by `---`
//! fences. When absent, `data` is `None` and `body` is the whole input. An
//! empty frontmatter block parses to `Value::Null` (matching the TS `null`).

use std::sync::OnceLock;

use regex::Regex;
use serde_yaml_ng::Value;
use thiserror::Error;

/// Result of splitting a Markdown document into frontmatter and body.
#[derive(Debug, Clone, PartialEq)]
pub struct Frontmatter {
    /// Parsed YAML frontmatter, or `None` when the document has none.
    pub data: Option<Value>,
    /// The Markdown body following the frontmatter (or the whole input).
    pub body: String,
}

/// Returned when the frontmatter block contains invalid YAML.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("Invalid YAML frontmatter")]
pub struct FrontmatterError;

// Leading `---` line, YAML lines (lazily captured), then a closing `---` line.
fn frontmatter_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$")
            .expect("valid frontmatter regex")
    })
}

/// Split a Markdown document into its optional YAML frontmatter block and body.
/// The frontmatter must start on the very first line. When absent, `data` is
/// `None` and `body` is the whole input.
///
/// # Errors
///
/// Returns [`FrontmatterError`] when the frontmatter block holds invalid YAML.
pub fn split_frontmatter(md: &str) -> Result<Frontmatter, FrontmatterError> {
    let Some(caps) = frontmatter_re().captures(md) else {
        return Ok(Frontmatter {
            data: None,
            body: md.to_string(),
        });
    };
    let yaml_text = caps.get(1).map_or("", |m| m.as_str());
    let body = caps.get(2).map_or("", |m| m.as_str()).to_string();
    let data: Value = serde_yaml_ng::from_str(yaml_text).map_err(|_| FrontmatterError)?;
    Ok(Frontmatter {
        data: Some(data),
        body,
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
        assert_eq!(
            split_frontmatter("---\nname: \"open\n---\n"),
            Err(FrontmatterError)
        );
    }

    #[test]
    fn tolerates_crlf_line_endings() {
        let fm = split_frontmatter("---\r\nname: y\r\n---\r\nbody\r\n").unwrap();
        assert_eq!(fm.data, Some(yaml("name: y")));
        assert_eq!(fm.body, "body\r\n");
    }
}
