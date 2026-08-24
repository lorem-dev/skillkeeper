//! Content hashing for MCP server definitions (Rust port of
//! `packages/core/src/mcp/hashing.ts`).
//!
//! The hash excludes `name` so renaming a server does not change its identity
//! hash, and is stable regardless of object key order (matters for
//! `headers`/`env`, whose keys come from user-authored config and may differ in
//! order between reads). The digest matches the TypeScript output byte-for-byte.

use serde_json::Value;

use crate::hashing::sha256;
use crate::mcp::model::McpServerDef;

/// Recursively sort object keys for stable, deterministic serialization.
///
/// `serde_json`'s default `Map` is a `BTreeMap`, so parsing/serializing already
/// yields sorted keys at every depth; this mirrors the TypeScript `sortKeys`
/// helper explicitly and, in doing so, also strips any `null` children (the
/// canonical form never carries them because absent fields are omitted).
fn sort_keys(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(sort_keys).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, child) in map {
                out.insert(key, sort_keys(child));
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Canonical serialization of an MCP server def for hashing: `name` is stripped
/// (identity should survive a rename) and keys are sorted recursively so key
/// order never affects the result.
pub fn canonical_mcp_json(def: &McpServerDef) -> String {
    let mut value = serde_json::to_value(def).expect("McpServerDef serializes");
    if let Value::Object(map) = &mut value {
        map.remove("name");
    }
    serde_json::to_string(&sort_keys(value)).expect("canonical json serializes")
}

/// Content hash of an MCP server def, excluding `name`. Formatted as
/// `sha256:<hex>` to match the TypeScript `hashMcpDef`.
pub fn hash_mcp_def(def: &McpServerDef) -> String {
    format!("sha256:{}", sha256(&canonical_mcp_json(def)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::model::{McpOauth, McpOption, McpParameter, McpTransport};
    use std::collections::BTreeMap;

    fn http(name: &str, url: Option<&str>, rules: Option<&str>) -> McpServerDef {
        McpServerDef {
            name: name.to_string(),
            transport: McpTransport::Http,
            url: url.map(str::to_string),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: rules.map(str::to_string),
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        }
    }

    fn http_oauth_def(scopes: Vec<String>) -> McpServerDef {
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://mcp.example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: Some(McpOauth {
                client_id: None,
                callback_port: None,
                scopes,
            }),
            description: None,
            parameters: BTreeMap::new(),
        }
    }

    #[test]
    fn excludes_name_from_the_hash() {
        let a = http("github", Some("u"), None);
        let b = http("renamed", Some("u"), None);
        assert_eq!(hash_mcp_def(&a), hash_mcp_def(&b));
    }

    #[test]
    fn is_stable_across_key_order() {
        let mut h1 = BTreeMap::new();
        h1.insert("B".to_string(), "1".to_string());
        h1.insert("A".to_string(), "2".to_string());
        let mut h2 = BTreeMap::new();
        h2.insert("A".to_string(), "2".to_string());
        h2.insert("B".to_string(), "1".to_string());
        let a = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Http,
            url: Some("u".to_string()),
            headers: Some(h1),
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        let b = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Http,
            url: Some("u".to_string()),
            headers: Some(h2),
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        assert_eq!(canonical_mcp_json(&a), canonical_mcp_json(&b));
    }

    #[test]
    fn changes_when_url_or_rules_change() {
        let base = http("x", Some("u"), None);
        assert_ne!(
            hash_mcp_def(&base),
            hash_mcp_def(&http("x", Some("v"), None))
        );
        assert_ne!(
            hash_mcp_def(&base),
            hash_mcp_def(&http("x", Some("u"), Some("be careful")))
        );
    }

    #[test]
    fn produces_a_sha256_prefixed_hex_digest() {
        let hash = hash_mcp_def(&http("x", Some("u"), None));
        let hex = hash.strip_prefix("sha256:").expect("sha256: prefix");
        assert_eq!(hex.len(), 64);
        assert!(hex
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn is_stable_across_env_and_args_key_order_for_stdio_servers() {
        let mut e1 = BTreeMap::new();
        e1.insert("FOO".to_string(), "1".to_string());
        e1.insert("BAR".to_string(), "2".to_string());
        let mut e2 = BTreeMap::new();
        e2.insert("BAR".to_string(), "2".to_string());
        e2.insert("FOO".to_string(), "1".to_string());
        let a = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("cmd".to_string()),
            args: Some(vec!["--a".to_string(), "--b".to_string()]),
            env: Some(e1),
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        let b = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("cmd".to_string()),
            args: Some(vec!["--a".to_string(), "--b".to_string()]),
            env: Some(e2),
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        assert_eq!(hash_mcp_def(&a), hash_mcp_def(&b));
    }

    #[test]
    fn does_not_sort_array_element_order() {
        let a = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("cmd".to_string()),
            args: Some(vec!["--a".to_string(), "--b".to_string()]),
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        let b = McpServerDef {
            name: "x".to_string(),
            transport: McpTransport::Stdio,
            url: None,
            headers: None,
            command: Some("cmd".to_string()),
            args: Some(vec!["--b".to_string(), "--a".to_string()]),
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters: BTreeMap::new(),
        };
        assert_ne!(hash_mcp_def(&a), hash_mcp_def(&b));
    }

    /// Exact byte-for-byte digest of a known def, pinning parity with the TS
    /// `createHash('sha256').update(canonicalMcpJson(def)).digest('hex')` over
    /// `{"type":"http","url":"u"}`.
    #[test]
    fn matches_the_typescript_digest_for_a_known_def() {
        let def = http("x", Some("u"), None);
        assert_eq!(canonical_mcp_json(&def), r#"{"type":"http","url":"u"}"#);
        assert_eq!(
            hash_mcp_def(&def),
            format!("sha256:{}", sha256(r#"{"type":"http","url":"u"}"#))
        );
    }

    /// The renderer builds a manual preset's def in TypeScript, where
    /// `parameters` and `options` are non-optional and therefore present as
    /// empty collections. Serde skips all three of these when empty, so the
    /// renderer has to drop them before hashing or the two digests diverge --
    /// which is exactly what made every installed manual preset read as
    /// permanently out of date. Pinned as bytes, with the same digest asserted
    /// in `omits an empty options list and empty oauth scopes, as Rust does`
    /// in `apps/desktop/src/renderer/app/store/store.test.ts`.
    #[test]
    fn matches_the_typescript_digest_for_a_def_with_empty_collections() {
        let mut parameters = BTreeMap::new();
        parameters.insert("p".to_string(), McpParameter::default());
        let def = McpServerDef {
            oauth: Some(McpOauth::default()),
            parameters,
            ..http("x", Some("u"), None)
        };
        let canonical = r#"{"oauth":{},"parameters":{"p":{}},"type":"http","url":"u"}"#;
        assert_eq!(canonical_mcp_json(&def), canonical);
        assert_eq!(hash_mcp_def(&def), format!("sha256:{}", sha256(canonical)));
    }

    #[test]
    fn changing_a_scope_changes_the_hash() {
        let mut a = http_oauth_def(vec!["read".to_string()]);
        let b = http_oauth_def(vec!["read".to_string(), "write".to_string()]);
        assert_ne!(hash_mcp_def(&a), hash_mcp_def(&b));
        a.oauth.as_mut().expect("oauth").scopes = vec!["write".to_string(), "read".to_string()];
        assert_ne!(
            hash_mcp_def(&a),
            hash_mcp_def(&b),
            "scope order is significant and must not be sorted away"
        );
    }

    /// The design asks for "any oauth field" to move the hash, not just the
    /// scopes: the update flow is the only way a user learns that a preset's
    /// auth changed under them, and a client id or callback port they cannot
    /// see change is a preset that stays silently stale.
    #[test]
    fn changing_the_client_id_changes_the_hash() {
        let none = http_oauth_def(Vec::new());
        let mut with_id = http_oauth_def(Vec::new());
        with_id.oauth.as_mut().expect("oauth").client_id = Some("example-client".to_string());
        let mut other_id = http_oauth_def(Vec::new());
        other_id.oauth.as_mut().expect("oauth").client_id = Some("other-client".to_string());

        assert_ne!(hash_mcp_def(&none), hash_mcp_def(&with_id));
        assert_ne!(hash_mcp_def(&with_id), hash_mcp_def(&other_id));
    }

    #[test]
    fn changing_the_callback_port_changes_the_hash() {
        let none = http_oauth_def(Vec::new());
        let mut with_port = http_oauth_def(Vec::new());
        with_port.oauth.as_mut().expect("oauth").callback_port = Some(8432);
        let mut other_port = http_oauth_def(Vec::new());
        other_port.oauth.as_mut().expect("oauth").callback_port = Some(8433);

        assert_ne!(hash_mcp_def(&none), hash_mcp_def(&with_port));
        assert_ne!(hash_mcp_def(&with_port), hash_mcp_def(&other_port));
    }

    #[test]
    fn adding_an_oauth_block_at_all_changes_the_hash() {
        let without = http("remote", Some("https://mcp.example.com/mcp"), None);
        let mut with = without.clone();
        with.oauth = Some(McpOauth {
            client_id: Some("example-client".to_string()),
            callback_port: Some(8432),
            scopes: vec!["read".to_string()],
        });
        assert_ne!(hash_mcp_def(&without), hash_mcp_def(&with));
    }

    fn def_with_options(pairs: Vec<(&str, &str)>) -> McpServerDef {
        let mut parameters = BTreeMap::new();
        parameters.insert(
            "choice".to_string(),
            McpParameter {
                description: Some("Pick".to_string()),
                options: pairs
                    .into_iter()
                    .map(|(v, l)| McpOption {
                        value: v.to_string(),
                        label: l.to_string(),
                    })
                    .collect(),
            },
        );
        McpServerDef {
            name: "remote".to_string(),
            transport: McpTransport::Http,
            url: Some("https://mcp.example.com/mcp".to_string()),
            headers: None,
            command: None,
            args: None,
            env: None,
            rules: None,
            oauth: None,
            description: None,
            parameters,
        }
    }

    #[test]
    fn reordering_options_changes_the_hash() {
        let mut a = def_with_options(vec![("a", "Ay"), ("b", "Bee")]);
        let b = def_with_options(vec![("b", "Bee"), ("a", "Ay")]);
        assert_ne!(
            hash_mcp_def(&a),
            hash_mcp_def(&b),
            "option order decides which option is 'first' on migration, so it must be part of the hash"
        );
        a.parameters.clear();
        assert_ne!(hash_mcp_def(&a), hash_mcp_def(&b));
    }

    #[test]
    fn a_description_change_changes_the_hash() {
        let mut a = def_with_options(vec![("a", "Ay")]);
        let b = McpServerDef {
            description: Some("changed".to_string()),
            ..a.clone()
        };
        assert_ne!(hash_mcp_def(&a), hash_mcp_def(&b));
        a.description = Some("changed".to_string());
        assert_eq!(hash_mcp_def(&a), hash_mcp_def(&b));
    }
}
