//! SkillKeeper MCP install ledger (`.skmcp.yml`) and parameter value file
//! (`.skmcp.params.yml`) serialization (Rust port of
//! `packages/core/src/mcp/skmcp.ts`).
//!
//! The ledger records every installed MCP server instance for one agent+scope so
//! installs can later be matched back to a repository or preset, checked for
//! updates, and removed by exact identity. The sibling params file holds the raw
//! per-instance parameter values (secrets) and is git-ignored.

use std::collections::BTreeMap;

use serde_yaml_ng::{Mapping, Value};

/// Name of the SkillKeeper MCP install ledger, dropped into the skills root.
pub const SKMCP_FILE: &str = ".skmcp.yml";

/// Name of the sibling file holding raw MCP parameter values for the ledger.
///
/// This is the canonical declaration of the constant;
/// [`crate::mcp::gitignore_ensure`] redeclares an identical value locally.
pub const SKMCP_PARAMS_FILE: &str = ".skmcp.params.yml";

/// Current `.skmcp.yml` schema version.
pub const SKMCP_SCHEMA: i64 = 1;

/// One installed MCP server instance recorded in `.skmcp.yml`. Identity for
/// update matching is `(normalize_remote(remote), group, source)` for repo
/// presets, or `(local, source)` for manual presets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkmcpEntry {
    /// Source repository remote URL (absent for manual presets).
    pub remote: Option<String>,
    /// Skill-group directory the preset lives in (absent at the repo root).
    pub group: Option<String>,
    /// Manual preset id (present only for manual presets).
    pub local: Option<String>,
    /// Server name as it appears in `mcp.yml`/the preset.
    pub source: String,
    /// Assigned snake_case instance name (the native config key).
    pub name: String,
    /// Hash of the raw server definition at install time.
    pub hash: String,
}

/// The SkillKeeper MCP install ledger. Records every installed MCP server
/// instance for one agent+scope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkmcpFile {
    pub schema: i64,
    pub servers: Vec<SkmcpEntry>,
}

const HEADER: &str = "# SkillKeeper MCP install ledger. Generated on install; do not edit.\n";
const PARAMS_HEADER: &str =
    "# SkillKeeper MCP parameter values. Generated on install; do not edit.\n";

/// Serialize a `.skmcp.yml`, omitting absent optional fields, with a header. Key
/// order per entry mirrors the TypeScript writer: `remote?`, `group?`, `local?`,
/// `source`, `name`, `hash`.
pub fn serialize_skmcp(file: &SkmcpFile) -> String {
    let mut servers = Vec::with_capacity(file.servers.len());
    for entry in &file.servers {
        let mut body = Mapping::new();
        if let Some(remote) = &entry.remote {
            body.insert("remote".into(), remote.clone().into());
        }
        if let Some(group) = &entry.group {
            body.insert("group".into(), group.clone().into());
        }
        if let Some(local) = &entry.local {
            body.insert("local".into(), local.clone().into());
        }
        body.insert("source".into(), entry.source.clone().into());
        body.insert("name".into(), entry.name.clone().into());
        body.insert("hash".into(), entry.hash.clone().into());
        servers.push(Value::Mapping(body));
    }
    let mut root = Mapping::new();
    root.insert("schema".into(), file.schema.into());
    root.insert("servers".into(), Value::Sequence(servers));
    let yaml = serde_yaml_ng::to_string(&Value::Mapping(root)).expect("serialize skmcp mapping");
    format!("{HEADER}{yaml}")
}

/// Parse a `.skmcp.yml`. Returns `None` when the text is not valid YAML, or is
/// missing any required field (`schema`, `servers`, or an entry's `source`,
/// `name`, `hash`).
pub fn parse_skmcp(text: &str) -> Option<SkmcpFile> {
    let data: Value = serde_yaml_ng::from_str(text).ok()?;
    let Value::Mapping(map) = data else {
        return None;
    };
    // `schema` must be a number; a string spelling (`schema: text`) is rejected.
    let schema = match map.get("schema") {
        Some(v) if v.is_i64() || v.is_u64() || v.is_f64() => v.as_i64()?,
        _ => return None,
    };
    let Some(Value::Sequence(servers_raw)) = map.get("servers") else {
        return None;
    };

    let mut servers = Vec::with_capacity(servers_raw.len());
    for item in servers_raw {
        let Value::Mapping(entry) = item else {
            return None;
        };
        let source = entry.get("source").and_then(Value::as_str)?;
        let name = entry.get("name").and_then(Value::as_str)?;
        let hash = entry.get("hash").and_then(Value::as_str)?;
        servers.push(SkmcpEntry {
            remote: entry
                .get("remote")
                .and_then(Value::as_str)
                .map(String::from),
            group: entry.get("group").and_then(Value::as_str).map(String::from),
            local: entry.get("local").and_then(Value::as_str).map(String::from),
            source: source.to_string(),
            name: name.to_string(),
            hash: hash.to_string(),
        });
    }

    Some(SkmcpFile { schema, servers })
}

/// Serialize the raw per-instance MCP parameter values, with a header. The outer
/// key is the instance name; the inner map is `param -> value`.
pub fn serialize_skmcp_params(map: &BTreeMap<String, BTreeMap<String, String>>) -> String {
    let yaml = serde_yaml_ng::to_string(map).expect("serialize skmcp params");
    format!("{PARAMS_HEADER}{yaml}")
}

/// Parse a `.skmcp.params.yml`. Returns an empty map when the text is not valid
/// YAML or not an object at the root; non-string leaf values are dropped.
pub fn parse_skmcp_params(text: &str) -> BTreeMap<String, BTreeMap<String, String>> {
    let mut out: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let Ok(data) = serde_yaml_ng::from_str::<Value>(text) else {
        return out;
    };
    let Value::Mapping(map) = data else {
        return out;
    };
    for (instance, value) in map {
        let Value::String(instance) = instance else {
            continue;
        };
        let Value::Mapping(inner) = value else {
            continue;
        };
        let mut params: BTreeMap<String, String> = BTreeMap::new();
        for (param, param_value) in inner {
            if let (Value::String(param), Value::String(param_value)) = (param, param_value) {
                params.insert(param, param_value);
            }
        }
        out.insert(instance, params);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn round_trips_a_repo_entry_with_remote_and_group() {
        let file = SkmcpFile {
            schema: SKMCP_SCHEMA,
            servers: vec![SkmcpEntry {
                remote: Some("git@github.com:acme/mcps.git".to_string()),
                group: Some("devtools".to_string()),
                local: None,
                source: "github".to_string(),
                name: "github_1".to_string(),
                hash: "sha256:abc".to_string(),
            }],
        };
        let text = serialize_skmcp(&file);
        assert!(text.starts_with('#'));
        assert_eq!(parse_skmcp(&text), Some(file));
    }

    #[test]
    fn round_trips_a_manual_entry_with_local_omitting_absent_remote_group() {
        let file = SkmcpFile {
            schema: 1,
            servers: vec![SkmcpEntry {
                remote: None,
                group: None,
                local: Some("preset-1".to_string()),
                source: "custom".to_string(),
                name: "custom_1".to_string(),
                hash: "sha256:def".to_string(),
            }],
        };
        let text = serialize_skmcp(&file);
        assert!(!text.contains("remote:"));
        assert!(!text.contains("group:"));
        assert_eq!(parse_skmcp(&text), Some(file));
    }

    #[test]
    fn omits_absent_optional_fields_when_no_remote_group_local() {
        let file = SkmcpFile {
            schema: 1,
            servers: vec![SkmcpEntry {
                remote: None,
                group: None,
                local: None,
                source: "github".to_string(),
                name: "github_1".to_string(),
                hash: "sha256:abc".to_string(),
            }],
        };
        let text = serialize_skmcp(&file);
        assert!(!text.contains("remote:"));
        assert!(!text.contains("group:"));
        assert!(!text.contains("local:"));
        assert_eq!(parse_skmcp(&text), Some(file));
    }

    #[test]
    fn returns_none_for_malformed_yaml() {
        assert_eq!(parse_skmcp(": : :"), None);
        assert_eq!(parse_skmcp("42"), None);
    }

    #[test]
    fn returns_none_when_required_fields_are_missing() {
        assert_eq!(parse_skmcp("servers: []"), None); // no schema
        assert_eq!(parse_skmcp("schema: 1"), None); // no servers
        assert_eq!(
            parse_skmcp("schema: 1\nservers:\n  - source: github\n    name: g1\n"),
            None
        ); // no hash
        assert_eq!(
            parse_skmcp("schema: 1\nservers:\n  - name: g1\n    hash: sha256:x\n"),
            None
        ); // no source
        assert_eq!(
            parse_skmcp("schema: 1\nservers:\n  - source: github\n    hash: sha256:x\n"),
            None
        ); // no name
    }

    #[test]
    fn rejects_a_non_numeric_schema() {
        assert_eq!(parse_skmcp("schema: text\nservers: []\n"), None);
    }

    #[test]
    fn accepts_an_empty_servers_list() {
        assert_eq!(
            parse_skmcp("schema: 1\nservers: []\n"),
            Some(SkmcpFile {
                schema: 1,
                servers: vec![],
            })
        );
    }

    #[test]
    fn round_trips_per_instance_param_maps() {
        let mut map: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        map.insert(
            "github_1".to_string(),
            params(&[("token", "abc"), ("org", "acme")]),
        );
        map.insert(
            "slack_1".to_string(),
            params(&[("webhook", "https://example.com/hook")]),
        );
        let text = serialize_skmcp_params(&map);
        assert!(text.starts_with('#'));
        assert_eq!(parse_skmcp_params(&text), map);
    }

    #[test]
    fn round_trips_an_empty_map() {
        let map: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
        let text = serialize_skmcp_params(&map);
        assert_eq!(parse_skmcp_params(&text), map);
    }

    #[test]
    fn returns_empty_for_malformed_yaml_or_non_object_roots() {
        assert!(parse_skmcp_params(": : :").is_empty());
        assert!(parse_skmcp_params("42").is_empty());
    }

    #[test]
    fn drops_non_string_leaf_values() {
        let parsed = parse_skmcp_params("github_1:\n  token: abc\n  count: 5\n");
        assert_eq!(parsed.get("github_1"), Some(&params(&[("token", "abc")])));
    }
}
