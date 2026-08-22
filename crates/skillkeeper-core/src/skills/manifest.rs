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
use crate::skills::group_path;

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

/// Read the strict, namespaced `skillkeeper.requires`.
///
/// Returns `Ok(None)` when the block or the field is absent, so the caller
/// falls back to the flat field. Unknown keys inside the block are ignored
/// (with a note) rather than rejected: a repository written for a newer
/// SkillKeeper must stay readable by an older one.
///
/// # Errors
///
/// Returns a message when the block is not a mapping, the field is not a list
/// of strings, or an entry is not a valid reference. Strictness is the point:
/// an author who opted into this form asked to be held to it, so nothing here
/// is coerced.
fn namespaced_requires(
    map: &Mapping,
    own_path: &str,
    notes: &mut Vec<String>,
) -> Result<Option<Vec<String>>, String> {
    let Some(block) = map.get("skillkeeper") else {
        return Ok(None);
    };
    if block.is_null() {
        return Ok(None);
    }
    let Value::Mapping(block) = block else {
        return Err("\"skillkeeper\" must be a mapping".to_string());
    };
    for (key, _) in block {
        let name = key.as_str().unwrap_or_default();
        if name != "requires" {
            notes.push(format!("ignoring unknown \"skillkeeper\" field \"{name}\""));
        }
    }
    let Some(value) = block.get("requires") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Value::Sequence(items) = value else {
        return Err("\"skillkeeper.requires\" must be a list of strings".to_string());
    };
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Value::String(reference) = item else {
            return Err("\"skillkeeper.requires\" must be a list of strings".to_string());
        };
        if let Err(reason) = group_path::validate_skill_ref(reference) {
            return Err(format!(
                "invalid skill reference \"{reference}\" in \"skillkeeper.requires\": {reason}"
            ));
        }
        if reference == own_path {
            return Err(format!("skill \"{own_path}\" cannot require itself"));
        }
        if out.iter().any(|kept| kept == reference) {
            notes.push(format!("ignoring duplicate skill reference \"{reference}\""));
            continue;
        }
        out.push(reference.clone());
    }
    Ok(Some(out))
}

/// Read the lenient, flat `requires` after the shared `TextList` normalization
/// has run. Anything that is not a usable reference is dropped with a note; the
/// skill always survives.
fn flat_requires(map: &Mapping, own_path: &str, notes: &mut Vec<String>) -> Option<Vec<String>> {
    let Some(Value::Sequence(items)) = map.get("requires") else {
        return None;
    };
    let mut out: Vec<String> = Vec::with_capacity(items.len());
    for item in items {
        let Some(reference) = item.as_str() else {
            continue;
        };
        if reference == own_path {
            notes.push(format!(
                "ignoring invalid skill reference \"{reference}\" in \"requires\": a skill cannot require itself"
            ));
            continue;
        }
        if let Err(_reason) = group_path::validate_skill_ref(reference) {
            notes.push(format!(
                "ignoring invalid skill reference \"{reference}\" in \"requires\""
            ));
            continue;
        }
        if out.iter().any(|kept| kept == reference) {
            notes.push(format!("ignoring duplicate skill reference \"{reference}\""));
            continue;
        }
        out.push(reference.to_string());
    }
    Some(out)
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

    // The declaring skill's own reference form, needed to reject a self
    // reference. `name` is guaranteed present and non-empty by
    // `normalize_name` above. The group is not part of the frontmatter -- it
    // comes from the directory layout -- so a self reference can only be caught
    // for an ungrouped skill here; the resolver catches the grouped case
    // (it is also a one-element cycle, reported as such).
    let own_path = map
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let requires = match namespaced_requires(&map, &own_path, &mut notes)? {
        Some(list) => {
            if map.contains_key("requires") {
                notes.push(
                    "ignoring \"requires\": \"skillkeeper.requires\" takes precedence".to_string(),
                );
            }
            Some(list)
        }
        None => {
            normalize(&mut map, "requires", FieldKind::TextList, &mut notes);
            flat_requires(&map, &own_path, &mut notes)
        }
    };

    // `skillkeeper` and `requires` are consumed here; drop both so the derived
    // deserialization below never sees them (it has no field for either, and
    // the value we computed is authoritative).
    map.remove("skillkeeper");
    map.remove("requires");

    let mut manifest: SkillManifest =
        serde_yaml_ng::from_value(Value::Mapping(map)).map_err(|e| e.to_string())?;
    manifest.requires = requires;
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

    #[test]
    fn reads_a_namespaced_requires_list() {
        let parsed = skill("name: a\nskillkeeper:\n  requires:\n    - g/b\n    - c\n");
        assert_eq!(
            parsed.manifest.requires,
            Some(vec!["g/b".to_string(), "c".to_string()])
        );
        assert!(parsed.notes.is_empty());
    }

    #[test]
    fn reads_an_empty_namespaced_requires_as_no_dependencies() {
        let parsed = skill("name: a\nskillkeeper:\n  requires: []\n");
        assert_eq!(parsed.manifest.requires, Some(Vec::new()));
    }

    #[test]
    fn namespaced_requires_takes_precedence_over_the_flat_field() {
        let parsed = skill("name: a\nrequires:\n  - flat\nskillkeeper:\n  requires:\n    - nested\n");
        assert_eq!(parsed.manifest.requires, Some(vec!["nested".to_string()]));
        assert_eq!(
            parsed.notes,
            vec!["ignoring \"requires\": \"skillkeeper.requires\" takes precedence"]
        );
    }

    #[test]
    fn ignores_an_unknown_key_inside_the_namespaced_block() {
        let parsed = skill("name: a\nskillkeeper:\n  requires:\n    - b\n  future: 1\n");
        assert_eq!(parsed.manifest.requires, Some(vec!["b".to_string()]));
        assert_eq!(
            parsed.notes,
            vec!["ignoring unknown \"skillkeeper\" field \"future\""]
        );
    }

    #[test]
    fn drops_a_duplicate_reference_with_a_note() {
        let parsed = skill("name: a\nskillkeeper:\n  requires:\n    - b\n    - b\n");
        assert_eq!(parsed.manifest.requires, Some(vec!["b".to_string()]));
        assert_eq!(
            parsed.notes,
            vec!["ignoring duplicate skill reference \"b\""]
        );
    }

    #[test]
    fn rejects_a_non_mapping_skillkeeper_block() {
        let err = parse_skill_manifest(&yaml("name: a\nskillkeeper: nope\n")).unwrap_err();
        assert_eq!(err, "\"skillkeeper\" must be a mapping");
    }

    #[test]
    fn rejects_a_scalar_where_the_namespaced_list_belongs() {
        // Deliberately NOT coerced: the strict field means what it says.
        let err = parse_skill_manifest(&yaml("name: a\nskillkeeper:\n  requires: b\n")).unwrap_err();
        assert_eq!(err, "\"skillkeeper.requires\" must be a list of strings");
    }

    #[test]
    fn rejects_a_non_string_entry_in_the_namespaced_list() {
        let err = parse_skill_manifest(&yaml("name: a\nskillkeeper:\n  requires:\n    - [x]\n"))
            .unwrap_err();
        assert_eq!(err, "\"skillkeeper.requires\" must be a list of strings");
    }

    #[test]
    fn rejects_an_invalid_reference_in_the_namespaced_list() {
        let err = parse_skill_manifest(&yaml("name: a\nskillkeeper:\n  requires:\n    - ../x\n"))
            .unwrap_err();
        assert!(
            err.starts_with("invalid skill reference \"../x\" in \"skillkeeper.requires\""),
            "{err}"
        );
    }

    #[test]
    fn rejects_a_self_reference() {
        let err = parse_skill_manifest(&yaml("name: a\nskillkeeper:\n  requires:\n    - a\n"))
            .unwrap_err();
        assert_eq!(err, "skill \"a\" cannot require itself");
    }

    #[test]
    fn reads_a_bare_flat_requires_as_a_one_element_list() {
        let parsed = skill("name: a\nrequires: b\n");
        assert_eq!(parsed.manifest.requires, Some(vec!["b".to_string()]));
        assert_eq!(parsed.notes, vec!["reading \"requires\" as a list of text"]);
    }

    #[test]
    fn drops_an_invalid_flat_reference_and_keeps_the_skill() {
        let parsed = skill("name: a\nrequires:\n  - b\n  - ../x\n");
        assert_eq!(parsed.manifest.requires, Some(vec!["b".to_string()]));
        assert_eq!(
            parsed.notes,
            vec!["ignoring invalid skill reference \"../x\" in \"requires\""]
        );
    }

    #[test]
    fn drops_a_flat_self_reference_and_keeps_the_skill() {
        let parsed = skill("name: a\nrequires:\n  - a\n");
        assert_eq!(parsed.manifest.requires, Some(Vec::new()));
        assert_eq!(
            parsed.notes,
            vec!["ignoring invalid skill reference \"a\" in \"requires\": a skill cannot require itself"]
        );
    }
}
