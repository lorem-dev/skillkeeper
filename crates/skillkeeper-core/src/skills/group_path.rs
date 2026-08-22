//! Group paths: a skill's group is a `/`-joined path of at most
//! [`MAX_GROUP_DEPTH`] segments (`platform`, `platform/lint`,
//! `platform/lint/rust`).
//!
//! This module owns the depth limit. Nothing else in the workspace should spell
//! the number out: the resolver scans [`MAX_SKILL_DEPTH`] levels, the repository
//! config validates against [`validate`], and MCP discovery walks
//! [`ancestors`]. Keeping one constant is what makes the limit changeable
//! without hunting for stray `2`s.

/// The most group segments a skill id may carry.
pub const MAX_GROUP_DEPTH: usize = 3;

/// The deepest directory a skill body may sit at: its group segments plus the
/// skill's own directory.
pub const MAX_SKILL_DEPTH: usize = MAX_GROUP_DEPTH + 1;

/// The segments of a group path. An empty string has no segments (rather than
/// one empty one), so `depth("")` is 0.
pub fn segments(group: &str) -> Vec<&str> {
    if group.is_empty() {
        return Vec::new();
    }
    group.split('/').collect()
}

/// Join segments back into a group path.
///
/// The parameter is `parts` rather than `segments` so it does not shadow this
/// module's own [`segments`] function for readers of the body.
pub fn join(parts: &[&str]) -> String {
    parts.join("/")
}

/// How many segments a group path has.
pub fn depth(group: &str) -> usize {
    segments(group).len()
}

/// Every proper directory prefix of a skill's `root_path`, shortest first and
/// excluding the skill's own directory: for `a/b/c/skill`, `a`, `a/b`, `a/b/c`.
///
/// These are exactly the directories that can hold a group-scoped `mcp.yml`. A
/// flat skill has none.
pub fn ancestors(root_path: &str) -> Vec<String> {
    let parts = segments(root_path);
    (1..parts.len()).map(|n| parts[..n].join("/")).collect()
}

/// Check a group path against the rules a declared group must satisfy.
///
/// The error is a human-readable reason with no field context; callers that know
/// the field prefix it themselves.
pub fn validate(group: &str) -> Result<(), String> {
    if group.is_empty() {
        return Err("group must not be empty".to_string());
    }
    let parts = segments(group);
    if parts.len() > MAX_GROUP_DEPTH {
        return Err(format!(
            "group is {} levels deep; at most {MAX_GROUP_DEPTH} are allowed",
            parts.len()
        ));
    }
    for part in &parts {
        validate_segment(part, "group")?;
    }
    Ok(())
}

/// Render a skill identity as the reference form used by
/// `skillkeeper.requires`: `group/name`, or just `name` when it has no group.
/// This is the single place that spelling is defined; a reference in a manifest
/// is compared against this string and nothing else.
pub fn skill_path(group: Option<&str>, name: &str) -> String {
    match group {
        Some(g) if !g.is_empty() => format!("{g}/{name}"),
        _ => name.to_string(),
    }
}

/// Validate one `skillkeeper.requires` entry. A reference is an absolute skill
/// path: an optional group of at most [`MAX_GROUP_DEPTH`] segments, followed by
/// the skill name. The same segment rules as [`validate`] apply to every
/// segment, name included -- a reference is a path, and a path with a `..`
/// segment or a stray backslash is a mistake wherever it appears.
///
/// # Errors
///
/// Returns a message naming what is wrong, suitable for a resolver warning.
pub fn validate_skill_ref(reference: &str) -> Result<(), String> {
    if reference.is_empty() {
        return Err("reference must not be empty".to_string());
    }
    let parts: Vec<&str> = reference.split('/').collect();
    // The last segment is the skill name; everything before it is the group.
    // Splitting first and validating the group through `validate` keeps one
    // rule set: no divergence between a declared group and a referenced one.
    let (name, group_parts) = parts
        .split_last()
        .expect("split always yields at least one part");
    if group_parts.is_empty() {
        return validate_segment(name, "reference");
    }
    validate(&join(group_parts))?;
    validate_segment(name, "reference")
}

/// The per-segment rules shared by a group segment and a skill name.
///
/// `what` names the caller's vocabulary for its error messages ("group" for
/// [`validate`], "reference" for [`validate_skill_ref`]) so a group-path
/// mistake reads as a group problem and a `skillkeeper.requires` mistake
/// reads as a reference problem, even though both run the same checks.
fn validate_segment(segment: &str, what: &str) -> Result<(), String> {
    if segment.is_empty() {
        return Err(format!("{what} must not contain an empty segment"));
    }
    if segment == "." || segment == ".." {
        return Err(if what == "group" {
            "group segment must not be \".\" or \"..\"".to_string()
        } else {
            format!("{what} must not contain a \"{segment}\" segment")
        });
    }
    if segment.contains('\\') {
        return Err(format!("{what} must not contain a backslash"));
    }
    if segment.trim() != segment {
        return Err(if what == "group" {
            "group segment must not have leading or trailing whitespace".to_string()
        } else {
            format!("{what} segment \"{segment}\" must not be padded with whitespace")
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_group_into_segments() {
        assert_eq!(segments("a"), vec!["a"]);
        assert_eq!(segments("a/b/c"), vec!["a", "b", "c"]);
        assert!(segments("").is_empty());
    }

    #[test]
    fn joins_and_measures_depth() {
        assert_eq!(join(&["a", "b"]), "a/b");
        assert_eq!(depth("a/b/c"), 3);
        assert_eq!(depth(""), 0);
    }

    #[test]
    fn lists_every_ancestor_shortest_first() {
        assert_eq!(ancestors("a/b/c/skill"), vec!["a", "a/b", "a/b/c"]);
        assert_eq!(ancestors("a/skill"), vec!["a"]);
        assert!(ancestors("skill").is_empty());
    }

    #[test]
    fn accepts_one_to_three_segments() {
        assert!(validate("a").is_ok());
        assert!(validate("a/b").is_ok());
        assert!(validate("a/b/c").is_ok());
    }

    #[test]
    fn rejects_a_group_deeper_than_the_limit() {
        let err = validate("a/b/c/d").unwrap_err();
        assert!(
            err.contains("4"),
            "error should name the actual depth: {err}"
        );
        assert!(err.contains("3"), "error should name the limit: {err}");
    }

    #[test]
    fn rejects_empty_and_malformed_segments() {
        assert!(validate("").is_err());
        assert!(validate("/a").is_err());
        assert!(validate("a/").is_err());
        assert!(validate("a//b").is_err());
        assert!(validate("a/./b").is_err());
        assert!(validate("a/../b").is_err());
        assert!(validate("a\\b").is_err());
        assert!(validate("a/ b").is_err());
        assert!(validate("a/b ").is_err());
    }

    #[test]
    fn keeps_group_error_wording_free_of_reference_language() {
        let err = validate("a//b").unwrap_err();
        assert!(err.contains("group"), "error should mention group: {err}");
        assert!(
            !err.contains("reference"),
            "error should not mention reference: {err}"
        );
    }

    #[test]
    fn renders_a_skill_path_from_its_identity() {
        assert_eq!(skill_path(None, "s"), "s");
        assert_eq!(skill_path(Some("a"), "s"), "a/s");
        assert_eq!(skill_path(Some("a/b/c"), "s"), "a/b/c/s");
    }

    #[test]
    fn accepts_a_reference_with_no_group_and_with_the_deepest_group() {
        assert!(validate_skill_ref("s").is_ok());
        assert!(validate_skill_ref("a/s").is_ok());
        assert!(validate_skill_ref("a/b/c/s").is_ok());
    }

    #[test]
    fn rejects_a_reference_whose_group_is_too_deep() {
        let err = validate_skill_ref("a/b/c/d/s").unwrap_err();
        assert!(err.contains("3"), "error should name the limit: {err}");
    }

    #[test]
    fn rejects_a_malformed_reference() {
        for bad in [
            "", " ", "/s", "s/", "a//s", "a/./s", "a/../s", "a\\s", "a/ s", "a/s ", "..", ".",
        ] {
            assert!(
                validate_skill_ref(bad).is_err(),
                "should have rejected {bad:?}"
            );
        }
    }
}
