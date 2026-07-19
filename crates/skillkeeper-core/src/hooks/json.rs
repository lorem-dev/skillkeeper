//! JSON-merge hook strategy (Rust port of
//! `packages/core/src/hooks/hookJson.ts`).
//!
//! Merge a node into a JSON config (for example Claude `settings.json` under
//! `hooks`) and tag it with a reserved `_skillkeeper` ownership marker so it can
//! be verified and removed precisely. Existing user entries are preserved and
//! serialized key order is stable (recursively sorted), matching the
//! `JSON.stringify(sortKeys(x), null, 2)` output of the TypeScript source.

use serde_json::{Map, Value};
use thiserror::Error;

/// The reserved field that marks a SkillKeeper-owned JSON node.
pub const MARKER_FIELD: &str = "_skillkeeper";

/// Guard token used to neutralize foreign occurrences of the marker field.
const GUARD: &str = "SK7MARKERGUARD7";

/// Options identifying the owner of a merged node.
#[derive(Debug, Clone)]
pub struct MergeOptions {
    pub marker_id: String,
    pub label: String,
}

/// Errors raised by the JSON-merge strategy.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum HookJsonError {
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
    #[error("JSON root must be an object")]
    RootNotObject,
    #[error("Path segment \"{0}\" is not an object")]
    PathSegmentNotObject(String),
    #[error("Path \"{0}\" does not point to an array")]
    PathNotArray(String),
}

fn parse(json_text: &str) -> Result<Value, HookJsonError> {
    serde_json::from_str(json_text).map_err(|e| HookJsonError::InvalidJson(e.to_string()))
}

/// Recursively sort object keys for stable, deterministic serialization.
fn sort_keys(value: Value) -> Value {
    match value {
        Value::Array(arr) => Value::Array(arr.into_iter().map(sort_keys).collect()),
        Value::Object(obj) => {
            let mut entries: Vec<(String, Value)> = obj.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = Map::new();
            for (key, child) in entries {
                out.insert(key, sort_keys(child));
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Serialize with sorted keys and two-space indentation.
fn serialize(value: Value) -> String {
    serde_json::to_string_pretty(&sort_keys(value)).expect("serialize json value")
}

/// Canonical, compact serialization (sorted keys) for stable hashing.
pub fn canonical_json(value: &Value) -> String {
    serde_json::to_string(&sort_keys(value.clone())).expect("serialize canonical json")
}

/// The ownership id carried by `node`, when it is an owned node.
fn owner_id(node: &Value) -> Option<&str> {
    node.as_object()?
        .get(MARKER_FIELD)?
        .as_object()?
        .get("id")?
        .as_str()
}

fn find_walk<'a>(value: &'a Value, marker_id: &str) -> Option<&'a Value> {
    match value {
        Value::Array(arr) => {
            for entry in arr {
                if owner_id(entry) == Some(marker_id) {
                    return Some(entry);
                }
                if let Some(found) = find_walk(entry, marker_id) {
                    return Some(found);
                }
            }
            None
        }
        Value::Object(obj) => {
            for child in obj.values() {
                if let Some(found) = find_walk(child, marker_id) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

/// Find the owned node carrying `marker_id` anywhere in the parsed JSON, or
/// `None` when absent. Used by verify to recompute a node's content hash.
///
/// # Errors
///
/// Returns [`HookJsonError::InvalidJson`] on malformed input.
pub fn find_owned_node(json_text: &str, marker_id: &str) -> Result<Option<Value>, HookJsonError> {
    let root = parse(json_text)?;
    Ok(find_walk(&root, marker_id).cloned())
}

/// Merge a node into the array at `key_path` (dotted, for example
/// `hooks.PreToolUse`), tagging it with the ownership marker. Missing path
/// segments are created. An existing owned node with the same `marker_id` is
/// replaced rather than duplicated. Returns valid JSON with stable key order.
///
/// # Errors
///
/// Returns [`HookJsonError`] on malformed JSON, a non-object root, a
/// non-object intermediate segment, or a non-array target.
pub fn merge_hook_node(
    json_text: &str,
    key_path: &str,
    node: Map<String, Value>,
    opts: &MergeOptions,
) -> Result<String, HookJsonError> {
    let mut root = parse(json_text)?;
    let mut cursor = match root.as_object_mut() {
        Some(obj) => obj,
        None => return Err(HookJsonError::RootNotObject),
    };

    let segments: Vec<&str> = key_path.split('.').collect();
    for seg in &segments[..segments.len() - 1] {
        match cursor.get(*seg) {
            None => {
                cursor.insert((*seg).to_string(), Value::Object(Map::new()));
            }
            Some(v) if v.is_object() => {}
            Some(_) => return Err(HookJsonError::PathSegmentNotObject((*seg).to_string())),
        }
        cursor = cursor
            .get_mut(*seg)
            .expect("segment present")
            .as_object_mut()
            .expect("segment is object");
    }

    let last_seg = segments[segments.len() - 1];
    match cursor.get(last_seg) {
        None => {
            cursor.insert(last_seg.to_string(), Value::Array(Vec::new()));
        }
        Some(v) if v.is_array() => {}
        Some(_) => return Err(HookJsonError::PathNotArray(key_path.to_string())),
    }
    let target = cursor
        .get_mut(last_seg)
        .expect("target present")
        .as_array_mut()
        .expect("target is array");

    let mut marker = Map::new();
    marker.insert("id".to_string(), Value::String(opts.marker_id.clone()));
    marker.insert("label".to_string(), Value::String(opts.label.clone()));
    let mut owned = node;
    owned.insert(MARKER_FIELD.to_string(), Value::Object(marker));
    let owned = Value::Object(owned);

    match target
        .iter()
        .position(|entry| owner_id(entry) == Some(opts.marker_id.as_str()))
    {
        None => target.push(owned),
        Some(index) => target[index] = owned,
    }

    Ok(serialize(root))
}

/// Recursively remove owned nodes matching `marker_id`; prune empty arrays.
fn prune_owned(value: Value, marker_id: &str) -> Value {
    match value {
        Value::Array(arr) => {
            let kept: Vec<Value> = arr
                .into_iter()
                .filter(|entry| owner_id(entry) != Some(marker_id))
                .map(|entry| prune_owned(entry, marker_id))
                .collect();
            Value::Array(kept)
        }
        Value::Object(obj) => {
            let mut out = Map::new();
            for (key, child) in obj {
                let child_was_array = child.is_array();
                let pruned = prune_owned(child, marker_id);
                // Drop arrays that became empty as a result of removal.
                if child_was_array {
                    if let Value::Array(ref a) = pruned {
                        if a.is_empty() {
                            continue;
                        }
                    }
                }
                out.insert(key, pruned);
            }
            Value::Object(out)
        }
        other => other,
    }
}

/// Remove exactly the owned node(s) carrying `marker_id`, wherever they sit in
/// the tree, and prune any array left empty. Returns valid JSON with stable key
/// order. Unmatched ids leave the document structurally unchanged.
///
/// # Errors
///
/// Returns [`HookJsonError::InvalidJson`] on malformed input.
pub fn remove_hook_node(json_text: &str, marker_id: &str) -> Result<String, HookJsonError> {
    let root = parse(json_text)?;
    Ok(serialize(prune_owned(root, marker_id)))
}

/// Escape any foreign occurrence of the ownership marker field in arbitrary
/// content so it cannot be parsed as an owned node. Reversible via
/// [`decapsulate_foreign_markers`].
pub fn encapsulate_foreign_markers(content: &str) -> String {
    content
        .replace(GUARD, &format!("{GUARD}{GUARD}"))
        .replace(MARKER_FIELD, &format!("_{GUARD}skillkeeper"))
}

/// Inverse of [`encapsulate_foreign_markers`].
pub fn decapsulate_foreign_markers(content: &str) -> String {
    content
        .replace(&format!("_{GUARD}skillkeeper"), MARKER_FIELD)
        .replace(&format!("{GUARD}{GUARD}"), GUARD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(value: Value) -> Map<String, Value> {
        value.as_object().expect("object node").clone()
    }

    fn opts(marker_id: &str, label: &str) -> MergeOptions {
        MergeOptions {
            marker_id: marker_id.to_string(),
            label: label.to_string(),
        }
    }

    #[test]
    fn merge_adds_tagged_node_preserving_existing_user_entry() {
        let initial = serde_json::to_string(&json!({
            "hooks": {
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "user-thing" }] }],
            },
        }))
        .unwrap();
        let merged = merge_hook_node(
            &initial,
            "hooks.PreToolUse",
            node(json!({ "matcher": "Edit", "hooks": [{ "type": "command", "command": "sk-thing" }] })),
            &opts("mid1", "g/n:h"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&merged).unwrap();
        let arr = parsed["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["hooks"][0]["command"], json!("user-thing"));
        assert!(arr[0].get(MARKER_FIELD).is_none());
        assert_eq!(arr[1]["matcher"], json!("Edit"));
        assert_eq!(
            arr[1][MARKER_FIELD],
            json!({ "id": "mid1", "label": "g/n:h" })
        );
    }

    #[test]
    fn merge_creates_key_path_when_missing() {
        let merged = merge_hook_node(
            "{}",
            "hooks.PostToolUse",
            node(json!({ "matcher": "X", "hooks": [] })),
            &opts("m", "a:b"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&merged).unwrap();
        assert!(parsed["hooks"]["PostToolUse"].is_array());
        assert_eq!(
            parsed["hooks"]["PostToolUse"][0][MARKER_FIELD]["id"],
            json!("m")
        );
    }

    #[test]
    fn merge_emits_sorted_key_order() {
        let merged = merge_hook_node(
            "{}",
            "hooks.E",
            node(json!({ "zeta": 1, "alpha": 2 })),
            &opts("m", "l"),
        )
        .unwrap();
        let idx_alpha = merged.find("\"alpha\"").unwrap();
        let idx_zeta = merged.find("\"zeta\"").unwrap();
        assert!(idx_alpha < idx_zeta);
    }

    #[test]
    fn merge_replaces_existing_owned_node_with_same_id() {
        let json =
            merge_hook_node("{}", "hooks.E", node(json!({ "v": 1 })), &opts("same", "l")).unwrap();
        let json = merge_hook_node(
            &json,
            "hooks.E",
            node(json!({ "v": 2 })),
            &opts("same", "l"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["hooks"]["E"].as_array().unwrap().len(), 1);
        assert_eq!(parsed["hooks"]["E"][0]["v"], json!(2));
    }

    #[test]
    fn merge_output_has_no_trailing_newline_and_is_valid() {
        let merged =
            merge_hook_node("{}", "hooks.E", node(json!({ "v": 1 })), &opts("m", "l")).unwrap();
        assert!(!merged.ends_with('\n'));
        serde_json::from_str::<Value>(&merged).unwrap();
    }

    #[test]
    fn merge_errors_when_target_is_non_array() {
        let json = serde_json::to_string(&json!({ "hooks": { "E": "not-an-array" } })).unwrap();
        assert_eq!(
            merge_hook_node(&json, "hooks.E", node(json!({ "v": 1 })), &opts("m", "l")),
            Err(HookJsonError::PathNotArray("hooks.E".to_string()))
        );
    }

    #[test]
    fn merge_errors_on_malformed_json() {
        assert!(matches!(
            merge_hook_node("{bad", "hooks.E", Map::new(), &opts("m", "l")),
            Err(HookJsonError::InvalidJson(_))
        ));
    }

    #[test]
    fn merge_reuses_existing_object_along_path() {
        let initial = serde_json::to_string(&json!({ "hooks": { "existing": true } })).unwrap();
        let merged = merge_hook_node(
            &initial,
            "hooks.E",
            node(json!({ "v": 1 })),
            &opts("m", "l"),
        )
        .unwrap();
        let parsed: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(parsed["hooks"]["existing"], json!(true));
        assert_eq!(parsed["hooks"]["E"][0]["v"], json!(1));
    }

    #[test]
    fn merge_errors_when_intermediate_segment_is_not_object() {
        let initial = serde_json::to_string(&json!({ "hooks": "a-string" })).unwrap();
        assert_eq!(
            merge_hook_node(
                &initial,
                "hooks.E.deep",
                node(json!({ "v": 1 })),
                &opts("m", "l")
            ),
            Err(HookJsonError::PathSegmentNotObject("hooks".to_string()))
        );
    }

    #[test]
    fn merge_errors_when_root_is_not_object() {
        assert_eq!(
            merge_hook_node("[1,2,3]", "hooks.E", Map::new(), &opts("m", "l")),
            Err(HookJsonError::RootNotObject)
        );
    }

    #[test]
    fn remove_removes_only_owned_node_leaving_user_entry() {
        let initial = serde_json::to_string(&json!({
            "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "command": "user" }] }] },
        }))
        .unwrap();
        let with_owned = merge_hook_node(
            &initial,
            "hooks.PreToolUse",
            node(json!({ "matcher": "Edit" })),
            &opts("mid", "l"),
        )
        .unwrap();
        let removed = remove_hook_node(&with_owned, "mid").unwrap();
        let parsed: Value = serde_json::from_str(&removed).unwrap();
        let arr = parsed["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matcher"], json!("Bash"));
    }

    #[test]
    fn remove_prunes_array_that_becomes_empty() {
        let json =
            merge_hook_node("{}", "hooks.E", node(json!({ "v": 1 })), &opts("m", "l")).unwrap();
        let removed = remove_hook_node(&json, "m").unwrap();
        let parsed: Value = serde_json::from_str(&removed).unwrap();
        assert!(parsed["hooks"].get("E").is_none());
    }

    #[test]
    fn remove_returns_structurally_unchanged_when_id_absent() {
        let json =
            merge_hook_node("{}", "hooks.E", node(json!({ "v": 1 })), &opts("m", "l")).unwrap();
        let removed = remove_hook_node(&json, "other").unwrap();
        let a: Value = serde_json::from_str(&removed).unwrap();
        let b: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn remove_removes_owned_nodes_anywhere_in_tree() {
        let json =
            merge_hook_node("{}", "hooks.A", node(json!({ "v": 1 })), &opts("a", "l")).unwrap();
        let json =
            merge_hook_node(&json, "hooks.B", node(json!({ "v": 2 })), &opts("b", "l")).unwrap();
        let removed = remove_hook_node(&json, "b").unwrap();
        let parsed: Value = serde_json::from_str(&removed).unwrap();
        assert_eq!(parsed["hooks"]["A"].as_array().unwrap().len(), 1);
        assert!(parsed["hooks"].get("B").is_none());
    }

    #[test]
    fn remove_errors_on_malformed_json() {
        assert!(matches!(
            remove_hook_node("{bad", "m"),
            Err(HookJsonError::InvalidJson(_))
        ));
    }

    #[test]
    fn remove_finds_node_nested_beneath_non_owned_array_entries() {
        let json = serde_json::to_string(&json!({
            "groups": [
                { "name": "a", "items": [{ "plain": 1 }] },
                { "name": "b", "items": [{ "_skillkeeper": { "id": "deep", "label": "l" }, "v": 9 }] },
            ],
        }))
        .unwrap();
        let removed = remove_hook_node(&json, "deep").unwrap();
        let parsed: Value = serde_json::from_str(&removed).unwrap();
        assert!(parsed["groups"][1].get("items").is_none());
        assert_eq!(parsed["groups"][0]["items"], json!([{ "plain": 1 }]));
    }

    #[test]
    fn find_owned_node_nested_beneath_arrays_and_objects() {
        let json = serde_json::to_string(&json!({
            "a": [{ "plain": 1 }, { "nested": { "items": [{ "_skillkeeper": { "id": "x", "label": "l" }, "v": 1 }] } }],
        }))
        .unwrap();
        let node = find_owned_node(&json, "x").unwrap().unwrap();
        assert_eq!(node["v"], json!(1));
    }

    #[test]
    fn find_owned_node_returns_none_when_absent() {
        let json = serde_json::to_string(&json!({ "a": [{ "b": 1 }] })).unwrap();
        assert_eq!(find_owned_node(&json, "absent").unwrap(), None);
    }

    #[test]
    fn canonical_json_sorts_keys_deterministically() {
        assert_eq!(
            canonical_json(&json!({ "b": 1, "a": 2 })),
            canonical_json(&json!({ "a": 2, "b": 1 }))
        );
        assert_eq!(
            canonical_json(&json!({ "b": 1, "a": 2 })),
            r#"{"a":2,"b":1}"#
        );
    }

    #[test]
    fn canonical_json_passes_through_primitives_and_arrays() {
        assert_eq!(canonical_json(&json!([3, 1, 2])), "[3,1,2]");
        assert_eq!(canonical_json(&json!("x")), r#""x""#);
        assert_eq!(canonical_json(&Value::Null), "null");
    }

    #[test]
    fn encapsulate_markers_round_trips_arbitrary_content() {
        for s in [
            "plain",
            "",
            "has _skillkeeper word",
            r#"{"_skillkeeper":"x"}"#,
        ] {
            assert_eq!(
                decapsulate_foreign_markers(&encapsulate_foreign_markers(s)),
                s
            );
        }
    }

    #[test]
    fn encapsulate_neutralizes_foreign_marker_token() {
        let content = r#"{"hooks":{"E":[{"_skillkeeper":{"id":"forged"},"v":1}]}}"#;
        let enc = encapsulate_foreign_markers(content);
        assert!(!enc.contains("\"_skillkeeper\""));
        assert_eq!(decapsulate_foreign_markers(&enc), content);
    }

    #[test]
    fn embedded_forged_marker_cannot_be_removed() {
        let smuggled = encapsulate_foreign_markers(r#"{"_skillkeeper":{"id":"forged"}}"#);
        let json = merge_hook_node(
            "{}",
            "hooks.E",
            node(json!({ "payload": smuggled })),
            &opts("real", "l"),
        )
        .unwrap();
        let after_forged = remove_hook_node(&json, "forged").unwrap();
        let a: Value = serde_json::from_str(&after_forged).unwrap();
        let b: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(a, b);
        let after_real = remove_hook_node(&json, "real").unwrap();
        let parsed: Value = serde_json::from_str(&after_real).unwrap();
        assert!(parsed["hooks"].get("E").is_none());
    }
}
