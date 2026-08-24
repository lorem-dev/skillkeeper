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
    // `then` pins the TYPE as well as presence. Every optional field derives as
    // `["string", "null"]`, and JSON Schema's `required` only checks that a key
    // exists -- so `url:` with an empty value satisfied `required` and the file
    // validated clean in the editor, then failed the transport check at sync
    // time and took every preset in it down. Intersecting with `"string"` here
    // makes the schema agree with `parse_strict`.
    let requires = |transport: Value, field: &str| {
        json!({
            "if": { "properties": { "type": transport }, "required": ["type"] },
            "then": {
                "required": [field],
                "properties": { field: { "type": "string" } }
            }
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
        // Derivation cannot express "non-empty"; `parse_strict` rejects an
        // empty name at `servers.N.name`, so the schema must too.
        if let Some(Value::Object(props)) = map.get_mut("properties") {
            if let Some(Value::Object(name)) = props.get_mut("name") {
                name.insert("minLength".to_string(), json!(1));
            }
        }
    }
    defs.insert("McpServerDef".to_string(), server);

    // `callback_port` derives from `u16`, so derivation says `minimum: 0` --
    // which published a schema that accepts a port both `repo lint` (SK017) and
    // the desktop editor reject. The schema is an AUTHORING surface, like the
    // editor, so it agrees with the editor: zero is not a port.
    if let Some(Value::Object(oauth)) = defs.get_mut("McpOauth") {
        if let Some(Value::Object(props)) = oauth.get_mut("properties") {
            if let Some(Value::Object(port)) = props.get_mut("callbackPort") {
                port.insert("minimum".to_string(), json!(1));
            }
        }
    }

    // `options` derives from the MODEL's type, an ordered `Vec<McpOption>`,
    // but `de_options` also accepts -- and the documentation teaches -- the
    // MAPPING form (`value: label`). The docs tell a reader to point their
    // editor at this schema, so a schema knowing only the list form flags the
    // documented example as invalid. Both forms are published; the list stays
    // first because it is the canonical serialized one.
    if let Some(Value::Object(parameter)) = defs.get_mut("McpParameter") {
        if let Some(Value::Object(props)) = parameter.get_mut("properties") {
            if let Some(Value::Object(options)) = props.get_mut("options") {
                let description = options.remove("description");
                options.remove("type");
                let items = options.remove("items").unwrap_or(json!({}));
                options.insert(
                    "anyOf".to_string(),
                    json!([
                        { "type": "array", "items": items },
                        {
                            "type": "object",
                            // A null label is the blank label, not a parse
                            // failure -- see `de_options`.
                            "additionalProperties": { "type": ["string", "null"] }
                        },
                        // A bare `options:`, which `de_options` reads as the
                        // empty list rather than dropping the whole file.
                        { "type": "null" },
                    ]),
                );
                if let Some(description) = description {
                    options.insert("description".to_string(), description);
                }
            }
        }
    }

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
        // Deliberately open. `parse_strict` reads `version` and `servers` and
        // ignores every other root key, so closing this would flag files
        // SkillKeeper accepts -- including one using the `$schema:` key, the
        // other way yaml-language-server attaches the very schema below.
        "properties": {
            "$schema": {
                "description":
                    "Optional: some editors attach a schema with this key instead of a \
                     yaml-language-server comment.",
                "type": "string"
            },
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
            [
                "args",
                "command",
                "description",
                "env",
                "headers",
                "name",
                "oauth",
                "parameters",
                "rules",
                "type",
                "url"
            ]
        );
    }

    /// Drift guard on the SHAPE, not just the key: `describes_every_field_the_parser_accepts`
    /// compares property names only, so a schema knowing one of the two forms
    /// `de_options` accepts passed it while flagging the authoring form the
    /// documentation's own worked example uses.
    #[test]
    fn accepts_both_option_forms_the_parser_accepts() {
        let options = build()["$defs"]["McpParameter"]["properties"]["options"].clone();
        assert!(
            options.get("type").is_none(),
            "a single `type` cannot describe both a mapping and a list"
        );
        let forms = options["anyOf"].as_array().expect("anyOf forms").clone();
        assert_eq!(
            forms
                .iter()
                .map(|f| f["type"].clone())
                .collect::<Vec<Value>>(),
            vec![json!("array"), json!("object"), json!("null")],
            "the canonical list, the authored mapping, and a bare `options:`"
        );
        assert_eq!(forms[0]["items"]["$ref"], json!("#/$defs/McpOption"));
        // A null label is the blank label, so the mapping's values are
        // nullable -- the schema has to agree with `de_options` about that
        // too, or the editor flags a file the parser reads.
        assert_eq!(
            forms[1]["additionalProperties"]["type"],
            json!(["string", "null"])
        );
    }

    #[test]
    fn rejects_a_zero_callback_port_like_every_other_authoring_surface() {
        let port = build()["$defs"]["McpOauth"]["properties"]["callbackPort"].clone();
        assert_eq!(port["minimum"], json!(1), "a port of 0 is not a port");
        assert_eq!(port["maximum"], json!(65535));
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
        // Assert the ENUM, not the serialized blob: the transport names also
        // appear in the type's description, so a `contains` check passed even
        // with a variant deleted.
        assert_eq!(
            build()["$defs"]["McpTransport"]["enum"],
            json!(["stdio", "http", "sse"])
        );
    }

    /// The schema must agree with `parse_strict` about what a valid file is.
    /// These pin the three places where derivation alone disagreed: an optional
    /// field derives as `["string","null"]` so `url:` left empty satisfied
    /// `required`; `name` had no length floor; and a closed root rejected keys
    /// the parser ignores.
    #[test]
    fn agrees_with_the_parser_on_what_it_rejects() {
        let schema = build();
        let server = &schema["$defs"]["McpServerDef"];

        // An empty name is refused at `servers.N.name`.
        assert_eq!(server["properties"]["name"]["minLength"], json!(1));

        // The transport's required field must be a string, not merely present.
        for (index, field) in [(0usize, "command"), (1, "url")] {
            let then = &server["allOf"][index]["then"];
            assert_eq!(then["required"], json!([field]));
            assert_eq!(
                then["properties"][field]["type"],
                json!("string"),
                "{field} may still be null"
            );
        }

        // The root stays open: `parse_strict` reads two keys and ignores the
        // rest, and an editor may attach the schema with a `$schema:` key.
        assert!(schema.get("additionalProperties").is_none());
        assert_eq!(schema["properties"]["$schema"]["type"], json!("string"));
    }
}
