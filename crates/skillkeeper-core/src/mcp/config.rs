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
}

/// Parse and validate an `mcp.yml`. Returns the typed config, or an
/// [`McpConfigError`] carrying the field path of the first validation failure.
pub fn parse_mcp_config(text: &str) -> Result<McpConfig, McpConfigError> {
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
            .map_err(|_| McpConfigError::at(format!("servers.{index}")))?;
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
