//! `.skid.yml` identity file serialization (Rust port of
//! `packages/core/src/skills/skid.ts`).
//!
//! The SkillKeeper identity file records where an installed skill came from
//! (remote + name + optional group) plus a content hash of the skill body, so
//! an install can later be matched to a repository and checked for updates.

use serde_yaml_ng::{Mapping, Value};

pub use crate::hashing::SKID_FILE;

/// Current `.skid.yml` schema version.
pub const SKID_SCHEMA: i64 = 1;

/// Parsed `.skid.yml` contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkidFile {
    pub schema: i64,
    /// Source repository remote URL (absent for local-path installs).
    pub remote: Option<String>,
    pub name: String,
    pub group: Option<String>,
    /// Content hash of the skill body (see `content_hash`).
    pub version: String,
}

const HEADER: &str = "# SkillKeeper identity file. Generated on install; do not edit.\n";

/// Serialize a `.skid.yml`, omitting absent optional fields, with a header.
/// Key order mirrors the TypeScript writer: `schema`, `name`, `group?`,
/// `remote?`, `version`.
pub fn serialize_skid(skid: &SkidFile) -> String {
    let mut body = Mapping::new();
    body.insert("schema".into(), skid.schema.into());
    body.insert("name".into(), skid.name.clone().into());
    if let Some(group) = &skid.group {
        body.insert("group".into(), group.clone().into());
    }
    if let Some(remote) = &skid.remote {
        body.insert("remote".into(), remote.clone().into());
    }
    body.insert("version".into(), skid.version.clone().into());
    let yaml = serde_yaml_ng::to_string(&Value::Mapping(body)).expect("serialize skid mapping");
    format!("{HEADER}{yaml}")
}

/// Parse a `.skid.yml`. Returns `None` when the text is not a valid skid.
pub fn parse_skid(text: &str) -> Option<SkidFile> {
    let data: Value = serde_yaml_ng::from_str(text).ok()?;
    let Value::Mapping(map) = data else {
        return None;
    };
    let name = map.get("name").and_then(Value::as_str)?;
    let version = map.get("version").and_then(Value::as_str)?;
    let schema = map
        .get("schema")
        .and_then(Value::as_i64)
        .unwrap_or(SKID_SCHEMA);
    let remote = map.get("remote").and_then(Value::as_str).map(String::from);
    let group = map.get("group").and_then(Value::as_str).map(String::from);
    Some(SkidFile {
        schema,
        remote,
        name: name.to_string(),
        group,
        version: version.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const REMOTE: &str = "git@github.com:acme/skills.git";

    #[test]
    fn round_trips_omitting_absent_optional_fields() {
        let text = serialize_skid(&SkidFile {
            schema: 1,
            remote: Some(REMOTE.to_string()),
            name: "s".to_string(),
            group: None,
            version: "abc".to_string(),
        });
        assert!(text.starts_with('#'));
        assert!(!text.contains("group:"));
        assert_eq!(
            parse_skid(&text),
            Some(SkidFile {
                schema: 1,
                remote: Some(REMOTE.to_string()),
                name: "s".to_string(),
                group: None,
                version: "abc".to_string(),
            })
        );
    }

    #[test]
    fn carries_the_group_when_present() {
        let skid = SkidFile {
            schema: 1,
            remote: Some(REMOTE.to_string()),
            name: "s".to_string(),
            group: Some("fmt".to_string()),
            version: "h".to_string(),
        };
        assert_eq!(parse_skid(&serialize_skid(&skid)), Some(skid));
    }

    #[test]
    fn returns_none_for_non_skid_or_malformed_yaml() {
        assert_eq!(parse_skid("name: only"), None); // no version
        assert_eq!(parse_skid(": : :"), None);
        assert_eq!(parse_skid("42"), None);
    }

    #[test]
    fn defaults_schema_when_missing_or_non_numeric() {
        let skid = parse_skid("name: s\nversion: v\n").unwrap();
        assert_eq!(skid.schema, SKID_SCHEMA);
        let skid = parse_skid("schema: text\nname: s\nversion: v\n").unwrap();
        assert_eq!(skid.schema, SKID_SCHEMA);
    }
}
