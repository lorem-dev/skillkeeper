//! Tolerant `SKILL.md` / `HOOK.md` frontmatter -> manifest conversion.
//!
//! A manifest is metadata a human hand-wrote, so this layer bends toward
//! keeping the skill rather than rejecting it:
//!
//! - **Unknown fields pass through untouched.** Skills are shared across
//!   agents, and each agent reads its own keys out of the same block
//!   (`allowed-tools`, `model`, `metadata`, ...). Serde already ignores them;
//!   nothing here narrows that.
//! - **A known field of the wrong YAML type is coerced, or dropped with a
//!   note -- never fatal.** `version: 1.0` is a float to YAML and a version
//!   string to everyone else; `executables: run.sh` means a list of one. Only
//!   fields whose meaning cannot be guessed stay strict: a hook's `target` and
//!   `strategy` decide where and how it edits an agent's config, so a
//!   malformed one is refused rather than assumed.
//! - **Only `name` is essential**, since it identifies the skill.
//!
//! Every coercion and drop is reported through [`Parsed::notes`], so the
//! resolver can surface it as a warning without losing the skill itself.

use serde_yaml_ng::{Mapping, Value};

use crate::models::{HookManifest, SkillManifest};

/// A manifest plus the leniencies applied to get it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed<T> {
    pub manifest: T,
    /// Human-readable notes about coerced or dropped fields; empty when the
    /// manifest was already well-formed.
    pub notes: Vec<String>,
}

/// The shape a known field is expected to hold.
#[derive(Debug, Clone, Copy)]
enum FieldKind {
    /// A single string.
    Text,
    /// A list of strings.
    TextList,
}

/// Render a YAML scalar as the string a manifest field wants. Sequences,
/// mappings, and null have no sensible rendering and yield `None`.
fn as_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// Coerce `value` to `kind`, or return `None` when it cannot be. A sequence
/// entry that is not a scalar is dropped (counted in `dropped`) rather than
/// sinking the whole list.
fn coerce(value: &Value, kind: FieldKind, dropped: &mut usize) -> Option<Value> {
    match kind {
        FieldKind::Text => as_text(value).map(Value::String),
        FieldKind::TextList => match value {
            // A bare scalar is the one-element list the author meant.
            Value::Sequence(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    match as_text(item) {
                        Some(text) => out.push(Value::String(text)),
                        None => *dropped += 1,
                    }
                }
                Some(Value::Sequence(out))
            }
            other => as_text(other).map(|text| Value::Sequence(vec![Value::String(text)])),
        },
    }
}

/// Bring `key` into the shape `kind` describes, in place. A field that cannot
/// be coerced is removed so deserialization sees it as absent, and either way
/// any change is recorded in `notes`.
fn normalize(map: &mut Mapping, key: &str, kind: FieldKind, notes: &mut Vec<String>) {
    let Some(value) = map.get(key) else { return };
    if value.is_null() {
        // An explicit null is the same as omitting the field.
        map.remove(key);
        return;
    }
    let mut dropped = 0usize;
    let Some(coerced) = coerce(value, kind, &mut dropped) else {
        let expected = match kind {
            FieldKind::Text => "a string",
            FieldKind::TextList => "a list of strings",
        };
        notes.push(format!("ignoring \"{key}\": expected {expected}"));
        map.remove(key);
        return;
    };
    if dropped > 0 {
        notes.push(format!(
            "ignoring {dropped} non-text entr{} in \"{key}\"",
            if dropped == 1 { "y" } else { "ies" }
        ));
    }
    if coerced != *value {
        if dropped == 0 {
            notes.push(format!("reading \"{key}\" as {}", describe(kind)));
        }
        map.insert(Value::String(key.to_string()), coerced);
    }
}

fn describe(kind: FieldKind) -> &'static str {
    match kind {
        FieldKind::Text => "text",
        FieldKind::TextList => "a list of text",
    }
}

/// The frontmatter mapping, with an absent or empty block read as `{}` (which
/// then fails on the missing `name`, with that as the message).
fn as_mapping(data: &Value) -> Result<Mapping, String> {
    match data {
        Value::Mapping(map) => Ok(map.clone()),
        Value::Null => Ok(Mapping::new()),
        _ => Err("frontmatter must be a mapping".to_string()),
    }
}

/// Require a non-empty `name`, coercing a scalar of any type to text.
fn normalize_name(map: &mut Mapping, notes: &mut Vec<String>) -> Result<(), String> {
    normalize(map, "name", FieldKind::Text, notes);
    match map.get("name").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => Ok(()),
        Some(_) => Err("name must not be empty".to_string()),
        None => Err("missing field \"name\"".to_string()),
    }
}

/// Parse `SKILL.md` frontmatter into a [`SkillManifest`], coercing or dropping
/// mistyped optional fields instead of rejecting the skill.
///
/// # Errors
///
/// Returns a message when the frontmatter is not a mapping, or when `name` is
/// missing or empty -- the only field the skill cannot be identified without.
pub fn parse_skill_manifest(data: &Value) -> Result<Parsed<SkillManifest>, String> {
    let mut map = as_mapping(data)?;
    let mut notes = Vec::new();
    normalize_name(&mut map, &mut notes)?;
    for (key, kind) in [
        ("version", FieldKind::Text),
        ("description", FieldKind::Text),
        ("license", FieldKind::Text),
        ("executables", FieldKind::TextList),
        ("hooks", FieldKind::TextList),
    ] {
        normalize(&mut map, key, kind, &mut notes);
    }
    let manifest: SkillManifest =
        serde_yaml_ng::from_value(Value::Mapping(map)).map_err(|e| e.to_string())?;
    Ok(Parsed { manifest, notes })
}

/// Parse `HOOK.md` frontmatter into a [`HookManifest`]. `target` and
/// `strategy` stay strict: they decide where and how the hook edits an agent's
/// configuration, and guessing either would write to the wrong place.
///
/// # Errors
///
/// Returns a message when the frontmatter is not a mapping, `name` is missing
/// or empty, or `target`/`strategy` are missing or malformed.
pub fn parse_hook_manifest(data: &Value) -> Result<Parsed<HookManifest>, String> {
    let mut map = as_mapping(data)?;
    let mut notes = Vec::new();
    normalize_name(&mut map, &mut notes)?;
    for key in ["version", "description"] {
        normalize(&mut map, key, FieldKind::Text, &mut notes);
    }
    let manifest: HookManifest =
        serde_yaml_ng::from_value(Value::Mapping(map)).map_err(|e| e.to_string())?;
    Ok(Parsed { manifest, notes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentKind, HookStrategy};

    fn yaml(s: &str) -> Value {
        serde_yaml_ng::from_str(s).expect("valid yaml")
    }

    fn skill(s: &str) -> Parsed<SkillManifest> {
        parse_skill_manifest(&yaml(s)).expect("manifest parses")
    }

    #[test]
    fn keeps_unknown_fields_from_costing_the_skill() {
        let parsed = skill("name: a\nallowed-tools: Read, Grep\nmetadata:\n  owner: team\n");
        assert_eq!(parsed.manifest.name, "a");
        assert!(parsed.notes.is_empty());
    }

    #[test]
    fn reads_a_numeric_version_as_text() {
        let parsed = skill("name: a\nversion: 1.0\n");
        assert_eq!(parsed.manifest.version.as_deref(), Some("1.0"));
        assert_eq!(parsed.notes, vec!["reading \"version\" as text"]);
    }

    #[test]
    fn reads_an_integer_version_as_text() {
        assert_eq!(
            skill("name: a\nversion: 1\n").manifest.version.as_deref(),
            Some("1")
        );
    }

    #[test]
    fn reads_a_bare_executable_as_a_one_element_list() {
        let parsed = skill("name: a\nexecutables: run.sh\n");
        assert_eq!(
            parsed.manifest.executables,
            Some(vec!["run.sh".to_string()])
        );
        assert_eq!(
            parsed.notes,
            vec!["reading \"executables\" as a list of text"]
        );
    }

    #[test]
    fn drops_a_field_that_cannot_be_coerced_and_keeps_the_skill() {
        let parsed = skill("name: a\ndescription:\n  - one\n  - two\n");
        assert_eq!(parsed.manifest.name, "a");
        assert_eq!(parsed.manifest.description, None);
        assert_eq!(
            parsed.notes,
            vec!["ignoring \"description\": expected a string"]
        );
    }

    #[test]
    fn drops_a_mapping_where_a_list_belongs() {
        let parsed = skill("name: a\nhooks:\n  on-save: yes\n");
        assert_eq!(parsed.manifest.hooks, None);
        assert_eq!(
            parsed.notes,
            vec!["ignoring \"hooks\": expected a list of strings"]
        );
    }

    #[test]
    fn drops_only_the_non_text_entries_of_a_list() {
        let parsed = skill("name: a\nexecutables:\n  - run.sh\n  - [nested]\n");
        assert_eq!(
            parsed.manifest.executables,
            Some(vec!["run.sh".to_string()])
        );
        assert_eq!(
            parsed.notes,
            vec!["ignoring 1 non-text entry in \"executables\""]
        );
    }

    #[test]
    fn reads_a_numeric_name_as_text() {
        assert_eq!(skill("name: 42\n").manifest.name, "42");
    }

    #[test]
    fn treats_an_explicit_null_as_an_absent_field() {
        let parsed = skill("name: a\ndescription: ~\n");
        assert_eq!(parsed.manifest.description, None);
        assert!(parsed.notes.is_empty());
    }

    #[test]
    fn requires_a_name() {
        let err = parse_skill_manifest(&yaml("license: MIT\n")).unwrap_err();
        assert_eq!(err, "missing field \"name\"");
    }

    #[test]
    fn rejects_an_empty_name() {
        let err = parse_skill_manifest(&yaml("name: \"  \"\n")).unwrap_err();
        assert_eq!(err, "name must not be empty");
    }

    #[test]
    fn rejects_a_non_mapping_block() {
        let err = parse_skill_manifest(&yaml("- one\n- two\n")).unwrap_err();
        assert_eq!(err, "frontmatter must be a mapping");
    }

    #[test]
    fn reads_an_empty_block_as_a_missing_name() {
        let err = parse_skill_manifest(&Value::Null).unwrap_err();
        assert_eq!(err, "missing field \"name\"");
    }

    #[test]
    fn hook_coerces_its_optional_fields_too() {
        let parsed = parse_hook_manifest(&yaml(
            "name: on-save\nversion: 2\ntarget:\n  agent: claude\n  filePattern: \"*.md\"\nstrategy: delimited-text\n",
        ))
        .expect("hook manifest parses");
        assert_eq!(parsed.manifest.version.as_deref(), Some("2"));
        assert_eq!(parsed.manifest.target.agent, AgentKind::Claude);
        assert_eq!(parsed.manifest.strategy, HookStrategy::DelimitedText);
    }

    #[test]
    fn hook_still_refuses_a_malformed_strategy() {
        let err = parse_hook_manifest(&yaml(
            "name: on-save\ntarget:\n  agent: claude\n  filePattern: \"*.md\"\nstrategy: sprinkle\n",
        ))
        .unwrap_err();
        assert!(err.contains("unknown variant `sprinkle`"), "{err}");
    }
}
