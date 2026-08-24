//! `{param}` placeholder handling for MCP server definitions (Rust port of
//! `packages/core/src/mcp/params.ts`).
//!
//! Scans every string field of a definition for `{param}` placeholders,
//! validates placeholder syntax, and renders concrete values into a definition.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use regex::{Captures, Regex};
use thiserror::Error;

use crate::mcp::model::{McpOauth, McpServerDef};
use crate::mcp::writers::UpsertNote;

/// Matches a `{param}` placeholder; capture group 1 is the parameter name.
fn placeholder_re() -> Regex {
    Regex::new(r"\{([A-Za-z0-9_]+)\}").expect("valid regex")
}

/// Every string field of an MCP server definition that may contain `{param}`
/// placeholders: url, header values, command, args, env values, rules, and the
/// oauth client id and scopes. `oauth.callback_port` is numeric and is
/// deliberately not scanned.
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
    if let Some(oauth) = &def.oauth {
        if let Some(client_id) = &oauth.client_id {
            out.push(client_id);
        }
        out.extend(oauth.scopes.iter().map(String::as_str));
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
        oauth: def.oauth.as_ref().map(|oauth| McpOauth {
            callback_port: oauth.callback_port,
            client_id: oauth.client_id.as_deref().map(&render),
            scopes: oauth.scopes.iter().map(|s| render(s)).collect(),
        }),
        description: def.description.clone(),
        parameters: def.parameters.clone(),
    };

    let missing = missing.into_inner();
    if !missing.is_empty() {
        let joined = missing.into_iter().collect::<Vec<_>>().join(", ");
        return Err(MissingValuesError(joined));
    }
    Ok(out)
}

/// Stored values that name something outside their parameter's options.
/// A parameter with no options accepts anything. Sorted by parameter name.
#[must_use]
pub fn invalid_option_values(
    def: &McpServerDef,
    values: &BTreeMap<String, String>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (name, parameter) in &def.parameters {
        if parameter.options.is_empty() {
            continue;
        }
        if let Some(value) = values.get(name) {
            if !parameter.options.iter().any(|o| &o.value == value) {
                out.push((name.clone(), value.clone()));
            }
        }
    }
    out
}

/// Bring `values` back in line with `def`'s options, reporting every change.
///
/// A stored value outside a non-empty option set is replaced by the FIRST
/// option -- well defined because options are an ordered list. An empty option
/// set leaves the value untouched: clearing it would break an installation that
/// currently works, and an empty set is an authoring mistake rather than an
/// instruction.
#[must_use]
pub fn migrate_option_values(
    def: &McpServerDef,
    values: &mut BTreeMap<String, String>,
) -> Vec<UpsertNote> {
    let mut notes = Vec::new();
    for (name, parameter) in &def.parameters {
        let Some(current) = values.get(name).cloned() else {
            continue;
        };
        if parameter.options.iter().any(|o| o.value == current) {
            continue;
        }
        match parameter.options.first() {
            Some(first) => {
                values.insert(name.clone(), first.value.clone());
                notes.push(UpsertNote::OptionSubstituted {
                    parameter: name.clone(),
                    value: first.value.clone(),
                });
            }
            None => notes.push(UpsertNote::OptionsEmpty {
                parameter: name.clone(),
            }),
        }
    }
    notes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::{McpOption, McpParameter, McpTransport};

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// A minimal http-transport definition with no placeholders of its own, so
    /// oauth-focused tests can add exactly the placeholders they care about.
    fn http_def() -> McpServerDef {
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        }
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
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
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
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
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
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
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

    #[test]
    fn a_client_id_placeholder_is_a_parameter() {
        let mut def = http_def();
        def.oauth = Some(McpOauth {
            client_id: Some("{org_client}".to_string()),
            callback_port: Some(8432),
            scopes: vec!["{tier}_read".to_string()],
        });
        assert_eq!(
            parse_params(&def),
            vec!["org_client".to_string(), "tier".to_string()]
        );
    }

    #[test]
    fn rendering_substitutes_into_the_client_id_and_scopes() {
        let mut def = http_def();
        def.oauth = Some(McpOauth {
            client_id: Some("{org_client}".to_string()),
            callback_port: Some(8432),
            scopes: vec!["{tier}_read".to_string()],
        });
        let mut values = BTreeMap::new();
        values.insert("org_client".to_string(), "abc".to_string());
        values.insert("tier".to_string(), "admin".to_string());
        let out = render_params(&def, &values).expect("render");
        let oauth = out.oauth.expect("oauth survives rendering");
        assert_eq!(oauth.client_id.as_deref(), Some("abc"));
        assert_eq!(oauth.scopes, vec!["admin_read".to_string()]);
        assert_eq!(oauth.callback_port, Some(8432));
    }

    #[test]
    fn a_missing_oauth_parameter_is_reported_like_any_other() {
        let mut def = http_def();
        def.oauth = Some(McpOauth {
            client_id: Some("{org_client}".to_string()),
            callback_port: None,
            scopes: Vec::new(),
        });
        let err = render_params(&def, &BTreeMap::new()).expect_err("missing value");
        assert!(err.to_string().contains("org_client"));
    }

    /// Drift guard for the renderer's hand-written mirror of [`string_fields`]:
    /// `scanMcpParams` in `apps/desktop/src/renderer/app/store/store.ts`. The
    /// mirror exists because the install modal needs a preset's parameter list
    /// synchronously, before any backend call, so it cannot ask this crate.
    ///
    /// Nothing made the two fail together, and they drifted: `oauth` was added
    /// here and never there, so the modal rendered no input for a parameterized
    /// client id, enabled Confirm, and dead-ended the install on a backend
    /// `MissingValuesError` naming a value the UI never asked for.
    ///
    /// Pinned structurally rather than by example, because an example only
    /// catches the field someone thought to write a case for. Both function
    /// bodies are parsed for their `def.<field>` / `oauth.<field>` accesses and
    /// the two sets must be identical, so adding a scanned field on one side
    /// alone fails here.
    #[test]
    fn the_renderer_mirror_scans_exactly_the_same_fields() {
        /// `client_id` -> `clientId`, so the two languages' spellings of one
        /// field compare equal.
        fn camel(name: &str) -> String {
            let mut parts = name.split('_');
            let mut out = parts.next().unwrap_or_default().to_string();
            for part in parts {
                let mut chars = part.chars();
                if let Some(first) = chars.next() {
                    out.push(first.to_ascii_uppercase());
                    out.push_str(chars.as_str());
                }
            }
            out
        }

        /// The `def.*` / `oauth.*` field names read inside the function that
        /// `signature` opens, whose body is taken to end at the first `}` in
        /// column 0.
        fn scanned_fields(source: &str, signature: &str) -> BTreeSet<String> {
            let start = source.find(signature).unwrap_or_else(|| {
                panic!("{signature} not found -- this guard is reading the wrong function")
            });
            let body = &source[start..];
            let end = body
                .find("\n}")
                .unwrap_or_else(|| panic!("{signature} has no closing brace in column 0"));
            let re = Regex::new(r"\b(?:def|oauth)\.([A-Za-z_]+)").expect("valid regex");
            re.captures_iter(&body[..end])
                .map(|caps| camel(&caps[1]))
                .collect()
        }

        let rust = scanned_fields(
            include_str!("params.rs"),
            "fn string_fields(def: &McpServerDef) -> Vec<&str> {",
        );
        let mirror_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src/renderer/app/store/store.ts");
        let mirror_source = std::fs::read_to_string(&mirror_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", mirror_path.display()));
        let renderer = scanned_fields(
            &mirror_source,
            "export function scanMcpParams(def: McpServerDef): string[] {",
        );

        // Both extractions must have found something, or the assertion below
        // would pass on two empty sets after a harmless rename.
        assert!(
            rust.contains("oauth") && rust.contains("clientId") && rust.contains("scopes"),
            "the Rust field list did not parse as expected: {rust:?}"
        );
        assert_eq!(
            rust, renderer,
            "`scanMcpParams` and `string_fields` scan different fields; update \
             both or neither"
        );
    }

    fn choice_def(pairs: &[(&str, &str)]) -> McpServerDef {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "choice".to_string(),
            McpParameter {
                description: None,
                options: pairs
                    .iter()
                    .map(|(v, l)| McpOption {
                        value: (*v).to_string(),
                        label: (*l).to_string(),
                    })
                    .collect(),
            },
        );
        McpServerDef {
            parameters,
            ..http_def()
        }
    }

    fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    #[test]
    fn a_value_outside_the_options_is_invalid() {
        let def = choice_def(&[("a", "Ay"), ("b", "Bee")]);
        assert_eq!(
            invalid_option_values(&def, &values(&[("choice", "c")])),
            vec![("choice".to_string(), "c".to_string())]
        );
        assert!(invalid_option_values(&def, &values(&[("choice", "a")])).is_empty());
    }

    #[test]
    fn invalid_option_values_are_sorted_by_parameter_name() {
        // Two invalid parameters, inserted in reverse alphabetical order: a
        // regression from the `BTreeMap` iteration this documents to plain
        // insertion order would flip this result and nothing else would catch
        // it, since every other case here uses only one invalid parameter.
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "zulu".to_string(),
            McpParameter {
                description: None,
                options: vec![McpOption {
                    value: "z1".to_string(),
                    label: "Z1".to_string(),
                }],
            },
        );
        parameters.insert(
            "alpha".to_string(),
            McpParameter {
                description: None,
                options: vec![McpOption {
                    value: "a1".to_string(),
                    label: "A1".to_string(),
                }],
            },
        );
        let def = McpServerDef {
            parameters,
            ..http_def()
        };
        let bad = values(&[("zulu", "bad-z"), ("alpha", "bad-a")]);
        assert_eq!(
            invalid_option_values(&def, &bad),
            vec![
                ("alpha".to_string(), "bad-a".to_string()),
                ("zulu".to_string(), "bad-z".to_string()),
            ],
            "entries must come out sorted by parameter name"
        );
    }

    #[test]
    fn a_parameter_without_options_accepts_anything() {
        let def = choice_def(&[]);
        assert!(invalid_option_values(&def, &values(&[("choice", "whatever")])).is_empty());
    }

    #[test]
    fn a_removed_option_falls_back_to_the_first_and_is_reported() {
        let def = choice_def(&[("a", "Ay"), ("b", "Bee")]);
        let mut v = values(&[("choice", "gone")]);
        let notes = migrate_option_values(&def, &mut v);
        assert_eq!(
            v.get("choice").map(String::as_str),
            Some("a"),
            "first option, in document order"
        );
        assert_eq!(
            notes,
            vec![UpsertNote::OptionSubstituted {
                parameter: "choice".to_string(),
                value: "a".to_string()
            }],
            "silently rewriting a value the user chose is exactly what must not happen"
        );
    }

    #[test]
    fn an_empty_option_set_leaves_the_stored_value_alone_and_warns() {
        let def = choice_def(&[]);
        let mut v = values(&[("choice", "kept")]);
        let notes = migrate_option_values(&def, &mut v);
        assert_eq!(
            v.get("choice").map(String::as_str),
            Some("kept"),
            "clearing would break a working install"
        );
        assert_eq!(
            notes,
            vec![UpsertNote::OptionsEmpty {
                parameter: "choice".to_string()
            }]
        );
    }

    #[test]
    fn a_still_valid_value_is_neither_changed_nor_reported() {
        let def = choice_def(&[("a", "Ay"), ("b", "Bee")]);
        let mut v = values(&[("choice", "b")]);
        assert!(migrate_option_values(&def, &mut v).is_empty());
        assert_eq!(v.get("choice").map(String::as_str), Some("b"));
    }
}
