//! MCP server definition data model (Rust port of
//! `packages/core/src/mcp/model.ts`).
//!
//! Plain, framework-agnostic data types. [`McpServerDef`] round-trips
//! byte-compatibly with the TypeScript `McpServerDef` interface: the transport
//! discriminant is serialized under the JSON key `type`, and the free-form
//! `headers`/`env` maps use a sorted [`BTreeMap`] so serialization is
//! deterministic. Optional fields skip serialization when absent, matching
//! `JSON.stringify` dropping `undefined`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The transport used to reach an MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// Where an MCP preset was authored: by the user (`manual`) or discovered in a
/// repository (`repo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
#[serde(rename_all = "lowercase")]
pub enum McpPresetOrigin {
    Manual,
    Repo,
}

/// A single MCP server definition. `type` selects the transport; the remaining
/// fields are populated per transport (`url`/`headers` for `http`/`sse`,
/// `command`/`args`/`env` for `stdio`). `rules` carries optional free-form
/// usage guidance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
pub struct McpServerDef {
    pub name: String,
    #[serde(rename = "type")]
    pub transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T>(value: &T) -> T
    where
        T: Serialize + for<'de> Deserialize<'de>,
    {
        let json = serde_json::to_string(value).expect("serialize");
        serde_json::from_str(&json).expect("deserialize")
    }

    #[test]
    fn transport_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&McpTransport::Stdio).unwrap(),
            "\"stdio\""
        );
        assert_eq!(
            serde_json::to_string(&McpTransport::Http).unwrap(),
            "\"http\""
        );
        assert_eq!(
            serde_json::to_string(&McpTransport::Sse).unwrap(),
            "\"sse\""
        );
    }

    #[test]
    fn preset_origin_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&McpPresetOrigin::Manual).unwrap(),
            "\"manual\""
        );
        assert_eq!(
            serde_json::to_string(&McpPresetOrigin::Repo).unwrap(),
            "\"repo\""
        );
    }

    #[test]
    fn http_server_serializes_type_key_and_omits_absent_fields() {
        let def = McpServerDef {
            name: "github".to_string(),
            transport: McpTransport::Http,
            url: Some("https://example".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
        };
        let json = serde_json::to_string(&def).unwrap();
        assert!(json.contains("\"type\":\"http\""));
        assert!(json.contains("\"url\":\"https://example\""));
        assert!(!json.contains("command"));
        assert!(!json.contains("headers"));
        assert_eq!(round_trip(&def), def);
    }

    #[test]
    fn stdio_server_round_trips_with_maps_and_args() {
        let mut env = BTreeMap::new();
        env.insert("FOO".to_string(), "1".to_string());
        env.insert("BAR".to_string(), "2".to_string());
        let def = McpServerDef {
            name: "local".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("cmd".to_string()),
            args: Some(vec!["--a".to_string(), "--b".to_string()]),
            env: Some(env),
            rules: Some("be careful".to_string()),
        };
        let json = serde_json::to_string(&def).unwrap();
        assert!(json.contains("\"command\":\"cmd\""));
        // BTreeMap keys serialize sorted.
        assert!(json.contains("\"env\":{\"BAR\":\"2\",\"FOO\":\"1\"}"));
        assert_eq!(round_trip(&def), def);
    }
}
