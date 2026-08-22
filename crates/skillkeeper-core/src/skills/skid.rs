//! `.skid.yml` identity file serialization (Rust port of
//! `packages/core/src/skills/skid.ts`).
//!
//! The SkillKeeper identity file records where an installed skill came from
//! (remote + name + optional group) plus a content hash of the skill body, so
//! an install can later be matched to a repository and checked for updates.

use serde_yaml_ng::{Mapping, Value};

pub use crate::hashing::SKID_FILE;

/// Current `.skid.yml` schema version.
///
/// 2 added the optional `requires` key. A schema-1 file still reads, as a skill
/// with no recorded dependencies -- which is exactly what it was.
pub const SKID_SCHEMA: i64 = 2;

/// Parsed `.skid.yml` contents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkidFile {
    pub schema: i64,
    /// Source repository remote URL (absent for local-path installs).
    pub remote: Option<String>,
    pub name: String,
    pub group: Option<String>,
    /// Skill paths this skill declared as dependencies at install time.
    ///
    /// Recorded here, and not only in the app's ledger, so an install whose
    /// source repository is gone still knows what it needed: that is the only
    /// way an orphan skill's broken dependency can be detected at all.
    pub requires: Option<Vec<String>>,
    /// Content hash of the skill body (see `content_hash`).
    pub version: String,
}

const HEADER: &str = "# SkillKeeper identity file. Generated on install; do not edit.\n";

/// Serialize a `.skid.yml`, omitting absent optional fields, with a header.
/// Key order mirrors the TypeScript writer for the schema-1 fields: `schema`,
/// `name`, `group?`, `remote?`, then the schema-2 `requires?`, then `version`.
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
    // Omitted when absent or empty: an empty list says nothing a reader could
    // act on, and writing it into every identity file is noise.
    if let Some(requires) = &skid.requires {
        if !requires.is_empty() {
            let items: Vec<Value> = requires.iter().map(|r| r.clone().into()).collect();
            body.insert("requires".into(), Value::Sequence(items));
        }
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
    // Tolerant on purpose: this file is ours. A value we cannot read means
    // "dependencies unknown", never "this install has no identity".
    let requires = match map.get("requires") {
        Some(Value::Sequence(items)) => {
            let list: Vec<String> = items
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect();
            (!list.is_empty()).then_some(list)
        }
        _ => None,
    };
    Some(SkidFile {
        schema,
        remote,
        name: name.to_string(),
        group,
        requires,
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
            requires: None,
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
                requires: None,
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
            requires: None,
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

    #[test]
    fn round_trips_a_dependency_list() {
        let text = serialize_skid(&SkidFile {
            schema: SKID_SCHEMA,
            remote: Some(REMOTE.to_string()),
            name: "s".to_string(),
            group: Some("g".to_string()),
            requires: Some(vec!["g/dep".to_string(), "other".to_string()]),
            version: "abc".to_string(),
        });
        assert!(text.contains("requires:"));
        let parsed = parse_skid(&text).expect("parses");
        assert_eq!(
            parsed.requires,
            Some(vec!["g/dep".to_string(), "other".to_string()])
        );
        assert_eq!(parsed.schema, 2);
    }

    #[test]
    fn omits_an_absent_dependency_list() {
        let text = serialize_skid(&SkidFile {
            schema: SKID_SCHEMA,
            remote: None,
            name: "s".to_string(),
            group: None,
            requires: None,
            version: "abc".to_string(),
        });
        assert!(!text.contains("requires:"));
    }

    #[test]
    fn omits_an_empty_dependency_list() {
        // An empty list carries no information a reader could act on, and
        // writing `requires: []` into every identity file is noise.
        let text = serialize_skid(&SkidFile {
            schema: SKID_SCHEMA,
            remote: None,
            name: "s".to_string(),
            group: None,
            requires: Some(Vec::new()),
            version: "abc".to_string(),
        });
        assert!(!text.contains("requires:"));
    }

    #[test]
    fn reads_a_schema_one_file_as_having_no_dependencies() {
        let parsed =
            parse_skid("schema: 1\nname: s\nremote: git@example.com:a/b.git\nversion: abc\n")
                .expect("parses");
        assert_eq!(parsed.schema, 1);
        assert_eq!(parsed.requires, None);
    }

    #[test]
    fn reads_a_schema_two_file_missing_the_key() {
        let parsed = parse_skid("schema: 2\nname: s\nversion: abc\n").expect("parses");
        assert_eq!(parsed.requires, None);
    }

    #[test]
    fn ignores_a_malformed_dependency_list_rather_than_failing_the_file() {
        // The identity file is ours, not the author's. A value we cannot read
        // means "unknown dependencies", not "this install is unidentifiable".
        let parsed =
            parse_skid("schema: 2\nname: s\nrequires: nope\nversion: abc\n").expect("parses");
        assert_eq!(parsed.name, "s");
        assert_eq!(parsed.requires, None);
    }
}
