//! `{param}` placeholder handling for MCP server definitions (Rust port of
//! `packages/core/src/mcp/params.ts`).
//!
//! Scans every string field of a definition for `{param}` placeholders,
//! validates placeholder syntax, and renders concrete values into a definition.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use regex::{Captures, Regex};
use thiserror::Error;

use crate::mcp::model::McpServerDef;

/// Matches a `{param}` placeholder; capture group 1 is the parameter name.
fn placeholder_re() -> Regex {
    Regex::new(r"\{([A-Za-z0-9_]+)\}").expect("valid regex")
}

/// Every string field of an MCP server definition that may contain `{param}`
/// placeholders: url, header values, command, args, env values, and rules.
fn string_fields(def: &McpServerDef) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    if let Some(url) = &def.url {
        out.push(url);
    }
    if let Some(headers) = &def.headers {
        out.extend(headers.values().map(String::as_str));
    }
    if let Some(command) = &def.command {
        out.push(command);
    }
    if let Some(args) = &def.args {
        out.extend(args.iter().map(String::as_str));
    }
    if let Some(env) = &def.env {
        out.extend(env.values().map(String::as_str));
    }
    if let Some(rules) = &def.rules {
        out.push(rules);
    }
    out
}

/// Scans all fields of an MCP server definition for `{param}` placeholders,
/// returning the unique parameter names sorted ascending.
pub fn parse_params(def: &McpServerDef) -> Vec<String> {
    let re = placeholder_re();
    let mut names: BTreeSet<String> = BTreeSet::new();
    for text in string_fields(def) {
        for caps in re.captures_iter(text) {
            names.insert(caps[1].to_string());
        }
    }
    names.into_iter().collect()
}

/// The parameter names required by `def` that are absent from `stored_values`
/// (a `None` map counts every parameter as missing). Result is sorted and
/// de-duplicated, mirroring [`parse_params`]. A stored key with an empty string
/// value still counts as present.
pub fn missing_params(
    def: &McpServerDef,
    stored_values: Option<&BTreeMap<String, String>>,
) -> Vec<String> {
    parse_params(def)
        .into_iter()
        .filter(|name| match stored_values {
            Some(stored) => !stored.contains_key(name),
            None => true,
        })
        .collect()
}

/// Outcome of [`validate_param_syntax`]: either well-formed, or the byte index
/// and reason of the first malformed placeholder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamSyntaxResult {
    Ok,
    Invalid { index: usize, reason: String },
}

/// Validates that every `{` in the text opens a well-formed placeholder: a
/// non-empty run of `[A-Za-z0-9_]` characters followed by `}`.
pub fn validate_param_syntax(text: &str) -> ParamSyntaxResult {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'{' {
            i += 1;
            continue;
        }
        match text[i + 1..].find('}') {
            None => {
                return ParamSyntaxResult::Invalid {
                    index: i,
                    reason: "unclosed {".to_string(),
                };
            }
            Some(rel) => {
                let close = i + 1 + rel;
                let name = &text[i + 1..close];
                if name.is_empty() {
                    return ParamSyntaxResult::Invalid {
                        index: i,
                        reason: "empty {}".to_string(),
                    };
                }
                if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return ParamSyntaxResult::Invalid {
                        index: i,
                        reason: format!("illegal character in {{{name}}}"),
                    };
                }
                i = close + 1;
            }
        }
    }
    ParamSyntaxResult::Ok
}

/// Raised by [`render_params`] when one or more referenced parameters have no
/// value. The message lists the missing names, sorted and comma-separated,
/// matching the TypeScript error string.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Missing values for mcp params: {0}")]
pub struct MissingValuesError(pub String);

/// Renders `{param}` placeholders across every field of an MCP server
/// definition, substituting from `values`. Returns an error if any referenced
/// param has no value.
pub fn render_params(
    def: &McpServerDef,
    values: &BTreeMap<String, String>,
) -> Result<McpServerDef, MissingValuesError> {
    let re = placeholder_re();
    let missing: RefCell<BTreeSet<String>> = RefCell::new(BTreeSet::new());

    let render = |text: &str| -> String {
        re.replace_all(text, |caps: &Captures| match values.get(&caps[1]) {
            Some(value) => value.clone(),
            None => {
                missing.borrow_mut().insert(caps[1].to_string());
                String::new()
            }
        })
        .into_owned()
    };

    let render_record =
        |record: &Option<BTreeMap<String, String>>| -> Option<BTreeMap<String, String>> {
            record.as_ref().map(|map| {
                map.iter()
                    .map(|(key, value)| (key.clone(), render(value)))
                    .collect()
            })
        };

    let out = McpServerDef {
        name: def.name.clone(),
        transport: def.transport,
        url: def.url.as_deref().map(&render),
        headers: render_record(&def.headers),
        command: def.command.as_deref().map(&render),
        args: def
            .args
            .as_ref()
            .map(|args| args.iter().map(|arg| render(arg)).collect()),
        env: render_record(&def.env),
        rules: def.rules.as_deref().map(&render),
    };

    let missing = missing.into_inner();
    if !missing.is_empty() {
        let joined = missing.into_iter().collect::<Vec<_>>().join(", ");
        return Err(MissingValuesError(joined));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::McpTransport;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn sample_def() -> McpServerDef {
        McpServerDef {
            name: "github".to_string(),
            transport: McpTransport::Http,
            url: Some("https://{host}/mcp".to_string()),
            headers: Some(map(&[("Authorization", "Bearer {token}")])),
            command: None,
            args: None,
            env: None,
            rules: Some("host={host}".to_string()),
        }
    }

    #[test]
    fn scans_params_across_fields_unique_and_sorted() {
        assert_eq!(parse_params(&sample_def()), vec!["host", "token"]);
    }

    #[test]
    fn scans_stdio_args_and_env() {
        let def = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("run".to_string()),
            args: Some(vec!["{a}".to_string()]),
            env: Some(map(&[("E", "{b}")])),
            rules: None,
        };
        assert_eq!(parse_params(&def), vec!["a", "b"]);
    }

    #[test]
    fn validates_syntax() {
        assert_eq!(validate_param_syntax("ok {a}"), ParamSyntaxResult::Ok);
        assert!(matches!(
            validate_param_syntax("bad {}"),
            ParamSyntaxResult::Invalid { .. }
        ));
        assert!(matches!(
            validate_param_syntax("bad {a"),
            ParamSyntaxResult::Invalid { .. }
        ));
        assert!(matches!(
            validate_param_syntax("bad {a-b}"),
            ParamSyntaxResult::Invalid { .. }
        ));
    }

    #[test]
    fn renders_values_into_stdio_args() {
        let def = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("run".to_string()),
            args: Some(vec!["{a}".to_string()]),
            env: None,
            rules: None,
        };
        let out = render_params(&def, &map(&[("a", "A")])).unwrap();
        assert_eq!(out.args, Some(vec!["A".to_string()]));
    }

    #[test]
    fn renders_values_into_every_field() {
        let out = render_params(&sample_def(), &map(&[("host", "h"), ("token", "t")])).unwrap();
        assert_eq!(out.url.as_deref(), Some("https://h/mcp"));
        assert_eq!(
            out.headers.as_ref().and_then(|h| h.get("Authorization")),
            Some(&"Bearer t".to_string())
        );
        assert_eq!(out.rules.as_deref(), Some("host=h"));
    }

    #[test]
    fn throws_listing_missing_params() {
        let err = render_params(&sample_def(), &map(&[("host", "h")])).unwrap_err();
        assert!(err.to_string().contains("token"));
    }

    #[test]
    fn missing_params_returns_sorted_names_absent_from_stored_values() {
        let def = sample_def();
        assert_eq!(
            missing_params(&def, Some(&map(&[("host", "h")]))),
            vec!["token"]
        );
        assert!(missing_params(&def, Some(&map(&[("host", "h"), ("token", "t")]))).is_empty());
        // None stored values -> every param is missing.
        assert_eq!(missing_params(&def, None), vec!["host", "token"]);
        // A stored key present but empty still counts as present (not missing).
        assert!(missing_params(&def, Some(&map(&[("host", "h"), ("token", "")]))).is_empty());
    }
}
