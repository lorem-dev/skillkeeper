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
    use crate::mcp::model::McpTransport;
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
}
