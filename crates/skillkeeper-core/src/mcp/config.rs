//! `mcp.yml` parsing and validation (Rust port of
//! `packages/core/src/mcp/config.ts`).
//!
//! Parses the SkillKeeper MCP preset config: a `version: 1` document with a list
//! of server definitions. Validation mirrors the TypeScript `zod` schema: every
//! server needs a non-empty `name` and a valid `type`, and the transport gates
//! which fields are required (`stdio` needs `command`; `http`/`sse` need `url`).

use serde_yaml_ng::Value;
use thiserror::Error;

use crate::mcp::model::{McpServerDef, McpTransport};

/// A parsed `mcp.yml`: schema version plus the list of server definitions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpConfig {
    pub version: i64,
    pub servers: Vec<McpServerDef>,
    /// Notes about values [`crate::yaml_repair`] had to re-quote to read the
    /// file, each naming the line to fix. Empty for a file that parsed as
    /// written. Callers are expected to report these: a silently tolerated
    /// file and a silently skipped one look identical from the outside, which
    /// is precisely the confusion this exists to prevent.
    pub warnings: Vec<String>,
}

/// Raised when an `mcp.yml` is not valid. `field_path` is the dotted path to the
/// first offending field (empty string for document-level errors), matching the
/// TypeScript `McpConfigError.fieldPath`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{message}")]
pub struct McpConfigError {
    pub message: String,
    pub field_path: String,
}

impl McpConfigError {
    fn at(field_path: impl Into<String>) -> Self {
        let field_path = field_path.into();
        let message = if field_path.is_empty() {
            "Invalid mcp.yml YAML".to_string()
        } else {
            format!("Invalid mcp.yml at \"{field_path}\"")
        };
        Self {
            message,
            field_path,
        }
    }

    /// Same field path, with the deserializer's own complaint appended -- it
    /// names the offending key and the type it wanted, which the path alone
    /// does not ("servers.0" versus "headers: invalid type: map").
    fn at_detailed(field_path: impl Into<String>, detail: &str) -> Self {
        let mut err = Self::at(field_path);
        err.message = format!("{}: {detail}", err.message);
        err
    }
}

/// Parse and validate an `mcp.yml`. Returns the typed config, or an
/// [`McpConfigError`] carrying the field path of the first validation failure.
///
/// A file that fails is retried once with [`crate::yaml_repair`] applied, which
/// re-quotes the plain scalars YAML misreads -- above all a bare `{param}`
/// placeholder, which YAML takes for a flow mapping. A file rescued that way
/// parses, and says so through [`McpConfig::warnings`].
///
/// # Errors
///
/// Returns [`McpConfigError`] when the file is invalid even after that retry.
pub fn parse_mcp_config(text: &str) -> Result<McpConfig, McpConfigError> {
    match parse_strict(text) {
        Ok(config) => Ok(config),
        Err(err) => {
            // The retry has to cover BOTH failure modes: a bare `{param}` is
            // valid YAML, so it survives the parse and only fails later, when
            // a header mapping does not fit a string field.
            let Some(repaired) = crate::yaml_repair::repair(text) else {
                return Err(err);
            };
            match parse_strict(&repaired.text) {
                // Report the ORIGINAL error when the repair did not help: it
                // describes the file as the author wrote it.
                Err(_) => Err(err),
                Ok(config) => Ok(McpConfig {
                    warnings: repaired
                        .repairs
                        .iter()
                        .map(crate::yaml_repair::Repair::note)
                        .collect(),
                    ..config
                }),
            }
        }
    }
}

/// Parse and validate exactly as written, with no leniency.
fn parse_strict(text: &str) -> Result<McpConfig, McpConfigError> {
    let data: Value = serde_yaml_ng::from_str(text).map_err(|_| McpConfigError::at(""))?;
    let Value::Mapping(map) = data else {
        return Err(McpConfigError::at(""));
    };

    // version must be the literal 1.
    match map.get("version").and_then(Value::as_i64) {
        Some(1) => {}
        _ => return Err(McpConfigError::at("version")),
    }

    let Some(Value::Sequence(servers_raw)) = map.get("servers") else {
        return Err(McpConfigError::at("servers"));
    };

    let mut servers = Vec::with_capacity(servers_raw.len());
    for (index, item) in servers_raw.iter().enumerate() {
        let def: McpServerDef = serde_yaml_ng::from_value(item.clone())
            .map_err(|e| McpConfigError::at_detailed(format!("servers.{index}"), &e.to_string()))?;
        if def.name.is_empty() {
            return Err(McpConfigError::at(format!("servers.{index}.name")));
        }
        let ok = match def.transport {
            McpTransport::Stdio => def.command.is_some(),
            McpTransport::Http | McpTransport::Sse => def.url.is_some(),
        };
        if !ok {
            return Err(McpConfigError::at(format!("servers.{index}")));
        }
        servers.push(def);
    }

    Ok(McpConfig {
        version: 1,
        servers,
        warnings: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_http_server_with_headers_and_rules() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: github\n    type: http\n    url: \"https://{host}/mcp\"\n    headers: { Authorization: \"Bearer {token}\" }\n    rules: \"Use {host}.\"",
        )
        .unwrap();
        let server = &cfg.servers[0];
        assert_eq!(server.name, "github");
        assert_eq!(server.transport, McpTransport::Http);
        assert_eq!(server.url.as_deref(), Some("https://{host}/mcp"));
        assert_eq!(
            server.headers.as_ref().and_then(|h| h.get("Authorization")),
            Some(&"Bearer {token}".to_string())
        );
    }

    #[test]
    fn parses_a_stdio_server() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: fs\n    type: stdio\n    command: npx\n    args: [\"-y\", \"@acme/fs\"]\n    env: { KEY: \"{key}\" }",
        )
        .unwrap();
        let server = &cfg.servers[0];
        assert_eq!(server.transport, McpTransport::Stdio);
        assert_eq!(server.command.as_deref(), Some("npx"));
    }

    #[test]
    fn accepts_a_bare_placeholder_header_and_says_so() {
        // `{personal_token}` is valid YAML -- a flow mapping -- so this file
        // parses and then fails to deserialize. The retry has to reach it.
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: jira\n    type: http\n    url: https://example.com/mcp\n    headers:\n      X-Token: {personal_token}\n",
        )
        .unwrap();
        assert_eq!(
            cfg.servers[0]
                .headers
                .as_ref()
                .and_then(|h| h.get("X-Token")),
            Some(&"{personal_token}".to_string())
        );
        assert_eq!(cfg.warnings.len(), 1);
        assert!(cfg.warnings[0].contains("line 7"), "{}", cfg.warnings[0]);
        assert!(
            cfg.warnings[0].contains("{personal_token}"),
            "{}",
            cfg.warnings[0]
        );
    }

    /// A half-written `options:` must not take the file down with it.
    /// `parse_mcp_config` deserializes the WHOLE document, so one author
    /// typing the key before filling it in would otherwise drop every server
    /// declared beside it -- and a repository you merely consume has to
    /// resolve and install regardless of the state of one preset.
    #[test]
    fn a_bare_options_key_leaves_every_server_in_the_file_intact() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: half-written\n    type: http\n    url: https://example.com/{access}\n    parameters:\n      access:\n        options:\n  - name: innocent\n    type: stdio\n    command: npx\n",
        )
        .expect("a bare options key must not fail the document");
        assert_eq!(
            cfg.servers
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            vec!["half-written", "innocent"],
            "the sibling preset must survive its neighbour's unfinished key"
        );
        assert!(cfg.servers[0].parameters["access"].options.is_empty());
    }

    /// Same reasoning as the bare key above, one level down: a value written
    /// with no label yet.
    #[test]
    fn a_null_option_label_leaves_every_server_in_the_file_intact() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: half-written\n    type: http\n    url: https://example.com/{access}\n    parameters:\n      access:\n        options:\n          read:\n  - name: innocent\n    type: stdio\n    command: npx\n",
        )
        .expect("a null option label must not fail the document");
        assert_eq!(cfg.servers.len(), 2);
        assert_eq!(cfg.servers[0].parameters["access"].options[0].value, "read");
        assert_eq!(cfg.servers[0].parameters["access"].options[0].label, "");
    }

    #[test]
    fn a_repaired_placeholder_still_registers_as_a_parameter() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: s\n    type: http\n    url: https://x/mcp\n    headers:\n      A: {tok}\n",
        )
        .unwrap();
        assert_eq!(
            crate::mcp::params::parse_params(&cfg.servers[0]),
            vec!["tok"]
        );
    }

    #[test]
    fn one_bad_value_no_longer_costs_the_whole_file() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: a\n    type: http\n    url: https://x/mcp\n    headers:\n      A: {tok}\n  - name: b\n    type: http\n    url: https://y/mcp\n",
        )
        .unwrap();
        assert_eq!(cfg.servers.len(), 2);
    }

    #[test]
    fn reports_no_warnings_for_a_file_that_parses_as_written() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: s\n    type: http\n    url: \"https://x/mcp\"\n",
        )
        .unwrap();
        assert!(cfg.warnings.is_empty());
    }

    #[test]
    fn a_genuine_flow_mapping_is_still_read_as_a_mapping() {
        let cfg = parse_mcp_config(
            "version: 1\nservers:\n  - name: s\n    type: stdio\n    command: npx\n    env: { KEY: value }\n",
        )
        .unwrap();
        assert_eq!(
            cfg.servers[0].env.as_ref().and_then(|e| e.get("KEY")),
            Some(&"value".to_string())
        );
        assert!(cfg.warnings.is_empty());
    }

    #[test]
    fn the_error_carries_the_deserializer_complaint_not_just_a_path() {
        // `url` as a list cannot be repaired into anything, so this still
        // fails -- and the message has to say something about WHY. serde
        // reports the type mismatch but not the key it was reading (that would
        // need serde_path_to_error, a dependency this does not justify), so
        // the path locates the server and the detail explains the refusal.
        let err = parse_mcp_config(
            "version: 1\nservers:\n  - name: s\n    type: http\n    url:\n      - a\n      - b\n",
        )
        .unwrap_err();
        assert_eq!(err.field_path, "servers.0");
        assert_eq!(
            err.message,
            "Invalid mcp.yml at \"servers.0\": invalid type: sequence, expected a string"
        );
    }

    #[test]
    fn rejects_http_without_url() {
        let err = parse_mcp_config("version: 1\nservers: [{ name: x, type: http }]").unwrap_err();
        assert_eq!(err.field_path, "servers.0");
    }

    #[test]
    fn rejects_stdio_without_command() {
        let err = parse_mcp_config("version: 1\nservers: [{ name: x, type: stdio }]").unwrap_err();
        assert_eq!(err.field_path, "servers.0");
    }

    #[test]
    fn rejects_a_missing_or_wrong_version() {
        assert_eq!(
            parse_mcp_config("servers: []").unwrap_err().field_path,
            "version"
        );
        assert_eq!(
            parse_mcp_config("version: 2\nservers: []")
                .unwrap_err()
                .field_path,
            "version"
        );
    }

    #[test]
    fn rejects_a_missing_servers_list() {
        assert_eq!(
            parse_mcp_config("version: 1").unwrap_err().field_path,
            "servers"
        );
    }

    #[test]
    fn throws_on_invalid_yaml_with_empty_field_path() {
        let err = parse_mcp_config(":\n  bad").unwrap_err();
        assert_eq!(err.field_path, "");
    }
}
