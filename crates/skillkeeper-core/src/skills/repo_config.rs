//! `skillkeeper.repo.yaml` parsing and validation (Rust port of
//! `packages/core/src/skills/repoConfig.ts`).
//!
//! The TypeScript source validates with zod; this port replaces zod with
//! explicit validation over a parsed YAML value. Error messages and the
//! reported dotted `field_path` (path to the first offending field) mirror the
//! TypeScript behavior: a YAML parse failure reports an empty field path, and a
//! schema violation reports `Invalid skillkeeper.repo.yaml at "<field.path>"`.

use serde_yaml_ng::Value;
use thiserror::Error;

/// A single skill entry in a repo config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoSkillEntry {
    pub path: String,
    pub name: Option<String>,
    pub group: Option<String>,
}

/// Optional defaults block.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RepoDefaults {
    pub group: Option<String>,
}

/// Parsed `skillkeeper.repo.yaml` configuration (scheme version 1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoConfig {
    /// Always `1` (the only accepted `version`).
    pub version: i64,
    pub defaults: Option<RepoDefaults>,
    pub skills: Option<Vec<RepoSkillEntry>>,
    pub include: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

/// Raised when `skillkeeper.repo.yaml` is malformed or fails validation.
#[derive(Debug, Error, PartialEq, Eq)]
#[error("{message}")]
pub struct RepoConfigError {
    pub message: String,
    /// Dotted path to the first offending field (empty for YAML parse errors).
    pub field_path: String,
}

impl RepoConfigError {
    fn schema(field_path: &str) -> Self {
        Self {
            message: format!("Invalid skillkeeper.repo.yaml at \"{field_path}\""),
            field_path: field_path.to_string(),
        }
    }

    fn yaml() -> Self {
        Self {
            message: "Invalid skillkeeper.repo.yaml YAML".to_string(),
            field_path: String::new(),
        }
    }
}

fn expect_string(value: &Value, field_path: &str) -> Result<String, RepoConfigError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| RepoConfigError::schema(field_path))
}

/// Optional string field: absent -> `None`; present-and-string -> `Some`;
/// present-but-wrong-type -> error at `field_path`.
fn optional_string(
    parent: &Value,
    key: &str,
    field_path: &str,
) -> Result<Option<String>, RepoConfigError> {
    match parent.get(key) {
        None => Ok(None),
        Some(v) => Ok(Some(expect_string(v, field_path)?)),
    }
}

fn optional_string_array(
    parent: &Value,
    key: &str,
) -> Result<Option<Vec<String>>, RepoConfigError> {
    let Some(value) = parent.get(key) else {
        return Ok(None);
    };
    let seq = value
        .as_sequence()
        .ok_or_else(|| RepoConfigError::schema(key))?;
    let mut out = Vec::with_capacity(seq.len());
    for (i, item) in seq.iter().enumerate() {
        out.push(expect_string(item, &format!("{key}.{i}"))?);
    }
    Ok(Some(out))
}

/// Validate a parsed YAML value against the repo-config schema. This is the
/// reusable analog of the exported zod `repoConfigSchema`.
///
/// # Errors
///
/// Returns [`RepoConfigError`] describing the first schema violation.
pub fn validate_repo_config(data: &Value) -> Result<RepoConfig, RepoConfigError> {
    if data.as_mapping().is_none() {
        return Err(RepoConfigError::schema(""));
    }

    // version: literal 1 (required).
    let version = match data.get("version").and_then(Value::as_i64) {
        Some(1) => 1,
        _ => return Err(RepoConfigError::schema("version")),
    };

    // defaults?: { group?: string }
    let defaults = match data.get("defaults") {
        None => None,
        Some(d) => {
            if d.as_mapping().is_none() {
                return Err(RepoConfigError::schema("defaults"));
            }
            Some(RepoDefaults {
                group: optional_string(d, "group", "defaults.group")?,
            })
        }
    };

    // skills?: { path: string (min 1), name?: string, group?: string }[]
    let skills = match data.get("skills") {
        None => None,
        Some(s) => {
            let seq = s
                .as_sequence()
                .ok_or_else(|| RepoConfigError::schema("skills"))?;
            let mut entries = Vec::with_capacity(seq.len());
            for (i, elem) in seq.iter().enumerate() {
                if elem.as_mapping().is_none() {
                    return Err(RepoConfigError::schema(&format!("skills.{i}")));
                }
                let path_fp = format!("skills.{i}.path");
                let path = match elem.get("path") {
                    Some(v) => {
                        let p = expect_string(v, &path_fp)?;
                        if p.is_empty() {
                            return Err(RepoConfigError::schema(&path_fp));
                        }
                        p
                    }
                    None => return Err(RepoConfigError::schema(&path_fp)),
                };
                let name = optional_string(elem, "name", &format!("skills.{i}.name"))?;
                let group = optional_string(elem, "group", &format!("skills.{i}.group"))?;
                entries.push(RepoSkillEntry { path, name, group });
            }
            Some(entries)
        }
    };

    let include = optional_string_array(data, "include")?;
    let exclude = optional_string_array(data, "exclude")?;

    Ok(RepoConfig {
        version,
        defaults,
        skills,
        include,
        exclude,
    })
}

/// Parse and validate the text of a `skillkeeper.repo.yaml` file.
///
/// # Errors
///
/// Returns [`RepoConfigError`] on malformed YAML or schema violations.
pub fn parse_repo_config(text: &str) -> Result<RepoConfig, RepoConfigError> {
    let data: Value = serde_yaml_ng::from_str(text).map_err(|_| RepoConfigError::yaml())?;
    validate_repo_config(&data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_config_with_skills_defaults_include_exclude() {
        let yaml = [
            "version: 1",
            "defaults:",
            "  group: shared",
            "skills:",
            "  - path: a/skill-one",
            "    name: one",
            "  - path: b/skill-two",
            "    group: other",
            "include:",
            "  - \"src/**\"",
            "exclude:",
            "  - \"**/draft/**\"",
        ]
        .join("\n");
        let cfg = parse_repo_config(&yaml).unwrap();
        assert_eq!(cfg.version, 1);
        assert_eq!(
            cfg.defaults.as_ref().unwrap().group.as_deref(),
            Some("shared")
        );
        let skills = cfg.skills.as_ref().unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(
            skills[0],
            RepoSkillEntry {
                path: "a/skill-one".to_string(),
                name: Some("one".to_string()),
                group: None,
            }
        );
        assert_eq!(
            skills[1],
            RepoSkillEntry {
                path: "b/skill-two".to_string(),
                name: None,
                group: Some("other".to_string()),
            }
        );
        assert_eq!(cfg.include, Some(vec!["src/**".to_string()]));
        assert_eq!(cfg.exclude, Some(vec!["**/draft/**".to_string()]));
    }

    #[test]
    fn parses_minimal_config_version_only() {
        let cfg = parse_repo_config("version: 1").unwrap();
        assert_eq!(cfg.version, 1);
        assert_eq!(cfg.skills, None);
    }

    #[test]
    fn errors_when_version_missing() {
        let err = parse_repo_config("skills: []").unwrap_err();
        assert_eq!(err.field_path, "version");
    }

    #[test]
    fn errors_when_a_skill_entry_lacks_a_path() {
        let yaml = ["version: 1", "skills:", "  - name: nameonly"].join("\n");
        let err = parse_repo_config(&yaml).unwrap_err();
        assert_eq!(err.field_path, "skills.0.path");
    }

    #[test]
    fn errors_on_malformed_yaml() {
        let err = parse_repo_config("version: 1\n  bad: : :").unwrap_err();
        assert_eq!(err.field_path, "");
        assert_eq!(err.message, "Invalid skillkeeper.repo.yaml YAML");
    }

    #[test]
    fn errors_on_empty_path_string() {
        let yaml = ["version: 1", "skills:", "  - path: \"\""].join("\n");
        let err = parse_repo_config(&yaml).unwrap_err();
        assert_eq!(err.field_path, "skills.0.path");
    }

    #[test]
    fn errors_when_root_is_not_a_mapping() {
        let err = parse_repo_config("- 1\n- 2").unwrap_err();
        assert_eq!(err.field_path, "");
    }

    #[test]
    fn exposes_the_schema_for_reuse() {
        let value: Value = serde_yaml_ng::from_str("version: 1").unwrap();
        assert!(validate_repo_config(&value).is_ok());
    }
}
