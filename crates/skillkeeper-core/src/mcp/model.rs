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

/// The transport used to reach an MCP server. `stdio` launches a local
/// process; `http` and `sse` connect to a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS, schemars::JsonSchema))]
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

/// OAuth client configuration for a remote MCP server.
///
/// Public-client fields only. A client secret is deliberately absent and must
/// never be added: SkillKeeper's config is committed and synchronized, so a
/// secret placed here leaks by construction. A user with a confidential client
/// supplies the secret through their agent's own command, which stores it in
/// the platform keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS, schemars::JsonSchema))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
#[serde(rename_all = "camelCase")]
pub struct McpOauth {
    /// Fixed loopback port for the redirect URI. Absent lets the agent choose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub callback_port: Option<u16>,
    /// Pre-registered OAuth client id. Absent leaves the agent to register
    /// dynamically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    /// Requested scopes, canonically a list because the agents disagree on the
    /// wire type: Claude Code takes one space-separated string, Cursor and
    /// Codex take arrays. A list converts to both without loss; a string does
    /// not, since splitting is not reversible when a scope contains a space.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
}

/// One selectable value for a parameter. `value` is what is stored and rendered
/// into the native config; `label` is what a reader sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS, schemars::JsonSchema))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/"
    )
)]
pub struct McpOption {
    pub label: String,
    pub value: String,
}

/// Authoring metadata for one `{param}` placeholder.
///
/// This is metadata, NOT a declaration: the parameter list still comes from
/// scanning every string field for placeholders, so a placeholder with no entry
/// here behaves exactly as it did before this existed and no existing `mcp.yml`
/// changes meaning.
///
/// `options` is authored as a YAML mapping (`value: label`) because that is
/// what an author wants to write, and modelled as an ordered list because
/// `canonical_mcp_json` sorts object keys but leaves array order alone. As a
/// map, reordering the options would not change the content hash -- yet the
/// order decides which option is "first" when a stored value disappears.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(ts_rs::TS, schemars::JsonSchema))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
pub struct McpParameter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(
        default,
        deserialize_with = "de_options",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub options: Vec<McpOption>,
}

/// Accept either a YAML mapping (`value: label`, order taken from the document)
/// or a list of `{value, label}`. `serde_yaml_ng`'s `Mapping` is an `IndexMap`,
/// so a `MapAccess` visitor receives entries in document order.
fn de_options<'de, D>(deserializer: D) -> Result<Vec<McpOption>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::{MapAccess, SeqAccess, Visitor};
    use std::fmt;

    struct OptionsVisitor;

    impl<'de> Visitor<'de> for OptionsVisitor {
        type Value = Vec<McpOption>;

        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a mapping of value to label, or a list of {value, label}")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some((value, label)) = map.next_entry::<String, String>()? {
                out.push(McpOption { label, value });
            }
            Ok(out)
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(item) = seq.next_element::<McpOption>()? {
                out.push(item);
            }
            Ok(out)
        }
    }

    deserializer.deserialize_any(OptionsVisitor)
}

/// A single MCP server definition. `type` selects the transport; the remaining
/// fields are populated per transport (`url`/`headers` for `http`/`sse`,
/// `command`/`args`/`env` for `stdio`). `rules` carries optional free-form
/// usage guidance.
/// Any string field may carry `{name}` placeholders; their values are asked for
/// at install time. Quote a value that STARTS with one -- a leading `{` opens a
/// flow mapping in YAML, so `X-Token: {tok}` is a map, not text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS, schemars::JsonSchema))]
#[cfg_attr(
    test,
    ts(
        export,
        export_to = "../../../apps/desktop/src/renderer/services/bridge/generated/core/",
        optional_fields
    )
)]
pub struct McpServerDef {
    /// Preset name, unique within the file. Becomes the basis of the installed
    /// instance's name.
    pub name: String,
    /// Transport: `stdio`, `http`, or `sse`. Selects which of the fields below
    /// apply.
    #[serde(rename = "type")]
    pub transport: McpTransport,
    /// Server URL. Required for `http` and `sse`; ignored for `stdio`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Request headers, for `http` and `sse`. Quote any value that starts with
    /// a `{placeholder}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    /// Executable to launch. Required for `stdio`; ignored otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Arguments passed to `command`, for `stdio`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// Environment variables for the launched process, for `stdio`. Quote any
    /// value that starts with a `{placeholder}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// Usage guidance written into the agent's guidance file on install, the
    /// same way skill guidance is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<String>,
    /// OAuth client configuration. Meaningful only for `http` and `sse`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<McpOauth>,
    /// A short summary of what this server is for. May contain one markup form,
    /// a link; see [`crate::mcp::markup`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Authoring metadata per `{param}` placeholder. Keyed by parameter name;
    /// this map's own order is irrelevant because the parameter list arrives
    /// sorted from the scanner, so a `BTreeMap` matches `headers` and `env`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub parameters: BTreeMap<String, McpParameter>,
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
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
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
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        let json = serde_json::to_string(&def).unwrap();
        assert!(json.contains("\"command\":\"cmd\""));
        // BTreeMap keys serialize sorted.
        assert!(json.contains("\"env\":{\"BAR\":\"2\",\"FOO\":\"1\"}"));
        assert_eq!(round_trip(&def), def);
    }

    #[test]
    fn an_oauth_block_round_trips_with_camel_case_keys() {
        let def = McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://mcp.example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: Some(McpOauth {
                client_id: Some("example-client".to_string()),
                callback_port: Some(8432),
                scopes: vec!["read".to_string(), "write".to_string()],
            }),
            description: None,
            parameters: BTreeMap::new(),
        };
        let json = serde_json::to_string(&def).expect("serialize");
        assert!(json.contains(r#""oauth":{"callbackPort":8432,"clientId":"example-client""#));
        assert_eq!(round_trip(&def), def);
    }

    #[test]
    fn empty_scopes_are_omitted_rather_than_serialized_as_an_empty_array() {
        let oauth = McpOauth {
            client_id: Some("example-client".to_string()),
            callback_port: None,
            scopes: Vec::new(),
        };
        let json = serde_json::to_string(&oauth).expect("serialize");
        assert_eq!(json, r#"{"clientId":"example-client"}"#);
    }

    #[test]
    fn options_deserialize_from_a_yaml_mapping_in_document_order() {
        let yaml = "
description: Pick one
options:
  zebra: Zebra
  apple: Apple
  mango: Mango
";
        let p: McpParameter = serde_yaml_ng::from_str(yaml).expect("deserialize");
        let order: Vec<&str> = p.options.iter().map(|o| o.value.as_str()).collect();
        assert_eq!(
            order,
            vec!["zebra", "apple", "mango"],
            "document order must survive; alphabetical order would break the first-option rule"
        );
        assert_eq!(p.options[0].label, "Zebra");
    }

    #[test]
    fn options_also_deserialize_from_a_list_so_a_round_trip_works() {
        let yaml = "
options:
  - value: b
    label: Bee
  - value: a
    label: Ay
";
        let p: McpParameter = serde_yaml_ng::from_str(yaml).expect("deserialize");
        assert_eq!(
            p.options
                .iter()
                .map(|o| o.value.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "a"]
        );
    }

    #[test]
    fn options_always_serialize_as_a_list() {
        let p = McpParameter {
            description: None,
            options: vec![
                McpOption {
                    value: "b".into(),
                    label: "Bee".into(),
                },
                McpOption {
                    value: "a".into(),
                    label: "Ay".into(),
                },
            ],
        };
        let json = serde_json::to_string(&p).expect("serialize");
        assert_eq!(
            json,
            r#"{"options":[{"label":"Bee","value":"b"},{"label":"Ay","value":"a"}]}"#
        );
    }

    #[test]
    fn an_absent_description_and_empty_parameters_are_omitted() {
        let def = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("c".to_string()),
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        let json = serde_json::to_string(&def).expect("serialize");
        assert!(!json.contains("description"), "got {json}");
        assert!(!json.contains("parameters"), "got {json}");
    }
}
