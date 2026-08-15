//! JSON Schema for `mcp.yml`, generated from the Rust types.
//!
//! The schema ships as a release asset so an editor can validate and complete
//! an `mcp.yml` against it:
//!
//! ```yaml
//! # yaml-language-server: $schema=https://github.com/lorem-dev/skillkeeper/releases/latest/download/mcp.schema.json
//! ```
//!
//! It is generated rather than hand-written for the same reason the TypeScript
//! bindings are: a hand-written copy of a schema drifts from the code the
//! moment a field moves, and a schema that lies is worse than none. Field
//! names, types, and descriptions come from [`McpServerDef`] and its doc
//! comments; `schemars` is a dev-dependency, so nothing here reaches a shipped
//! binary.
//!
//! What derivation cannot express is added on top: `version` is the literal
//! `1`, and which fields are required depends on `type` -- both encoded here
//! and both checked by the tests below.

#![cfg(test)]

use serde_json::{json, Map, Value};

use crate::mcp::model::McpServerDef;

/// Canonical URL of the published schema, used as its `$id` and in the
/// `yaml-language-server` line the docs show. `releases/latest/download`
/// always redirects to the newest release, so an `mcp.yml` pinning it keeps
/// working without edits -- the same form the one-line installers use.
pub const SCHEMA_URL: &str =
    "https://github.com/lorem-dev/skillkeeper/releases/latest/download/mcp.schema.json";

/// Where the generated schema is written, relative to the repository root.
pub const SCHEMA_PATH: &str = "schemas/mcp.schema.json";

/// Require `name`, `type`, and one transport-specific field, chosen by `type`.
/// Derivation cannot see this rule: every field but `name` and `type` is
/// `Option` in Rust, because which ones matter depends on the transport.
fn transport_conditionals() -> Value {
    let requires = |transport: Value, field: &str| {
        json!({
            "if": { "properties": { "type": transport }, "required": ["type"] },
            "then": { "required": [field] }
        })
    };
    json!([
        requires(json!({ "const": "stdio" }), "command"),
        requires(json!({ "enum": ["http", "sse"] }), "url"),
    ])
}

/// The complete schema document for an `mcp.yml` file.
fn build() -> Value {
    let generated = serde_json::to_value(schemars::schema_for!(McpServerDef))
        .expect("schema serializes to JSON");

    // Lift the generated definitions to the root and point the server entry at
    // the type itself, so the document has one `$defs` rather than nested ones.
    let mut defs = Map::new();
    if let Some(Value::Object(inner)) = generated.get("$defs") {
        for (key, value) in inner {
            defs.insert(key.clone(), value.clone());
        }
    }
    let mut server = generated.clone();
    if let Value::Object(map) = &mut server {
        map.remove("$defs");
        map.remove("$schema");
        map.remove("title");
        map.insert("allOf".to_string(), transport_conditionals());
    }
    defs.insert("McpServerDef".to_string(), server);

    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": SCHEMA_URL,
        "title": "SkillKeeper mcp.yml",
        "description":
            "MCP server presets declared by a repository, at its root or in a \
             skill-group directory. See \
             https://github.com/lorem-dev/skillkeeper/blob/main/docs/usage/mcp.md",
        "type": "object",
        "required": ["version", "servers"],
        "additionalProperties": false,
        "properties": {
            "version": {
                "description": "Schema version. Always 1.",
                "const": 1
            },
            "servers": {
                "description": "The MCP server presets this file declares.",
                "type": "array",
                "items": { "$ref": "#/$defs/McpServerDef" }
            }
        },
        "$defs": defs,
    })
}

/// The schema as it should appear on disk: pretty-printed, newline-terminated.
fn rendered() -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(&build()).expect("schema serializes")
    )
}

/// Path to `SCHEMA_PATH` from this crate's directory.
fn schema_file() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(SCHEMA_PATH)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes the schema, the way the ts-rs exports in this workspace do: run
    /// `cargo test` and the generated artifact is up to date. A diff in
    /// `git status` afterwards is the signal that it needed regenerating.
    #[test]
    fn writes_the_schema_file() {
        let path = schema_file();
        std::fs::create_dir_all(path.parent().expect("schema dir")).expect("create schema dir");
        std::fs::write(&path, rendered()).expect("write schema");
    }

    #[test]
    fn every_field_carries_a_description() {
        let schema = build();
        let props = schema["$defs"]["McpServerDef"]["properties"]
            .as_object()
            .expect("server properties");
        assert!(!props.is_empty());
        for (name, value) in props {
            assert!(
                value.get("description").and_then(Value::as_str).is_some(),
                "{name} has no description; add a doc comment to the Rust field"
            );
        }
        for key in ["version", "servers"] {
            assert!(schema["properties"][key].get("description").is_some());
        }
    }

    #[test]
    fn describes_every_field_the_parser_accepts() {
        // Drift guard: the schema's property set must match the struct's serde
        // field names, or an editor would flag a field the parser accepts.
        let schema = build();
        let props = schema["$defs"]["McpServerDef"]["properties"]
            .as_object()
            .expect("server properties");
        let mut names: Vec<&str> = props.keys().map(String::as_str).collect();
        names.sort_unstable();
        assert_eq!(
            names,
            ["args", "command", "env", "headers", "name", "rules", "type", "url"]
        );
    }

    #[test]
    fn pins_the_version_to_the_literal_one() {
        assert_eq!(build()["properties"]["version"]["const"], json!(1));
    }

    #[test]
    fn requires_the_field_each_transport_needs() {
        let all_of = build()["$defs"]["McpServerDef"]["allOf"].clone();
        let rules = all_of.as_array().expect("conditionals");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0]["then"]["required"], json!(["command"]));
        assert_eq!(rules[1]["then"]["required"], json!(["url"]));
    }

    #[test]
    fn lists_the_three_transports() {
        let schema = build();
        let transport = schema["$defs"]["McpTransport"].clone();
        let listed = serde_json::to_string(&transport).expect("transport schema");
        for name in ["stdio", "http", "sse"] {
            assert!(listed.contains(name), "{name} missing from {listed}");
        }
    }
}
