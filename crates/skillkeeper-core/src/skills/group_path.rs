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
pub fn join(segments: &[&str]) -> String {
    segments.join("/")
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
    if group.contains('\\') {
        return Err("group must not contain a backslash".to_string());
    }
    let parts = segments(group);
    if parts.len() > MAX_GROUP_DEPTH {
        return Err(format!(
            "group is {} levels deep; at most {MAX_GROUP_DEPTH} are allowed",
            parts.len()
        ));
    }
    for part in &parts {
        if part.is_empty() {
            return Err("group must not contain an empty segment".to_string());
        }
        if *part == "." || *part == ".." {
            return Err("group segment must not be \".\" or \"..\"".to_string());
        }
        if part.trim() != *part {
            return Err(
                "group segment must not have leading or trailing whitespace".to_string(),
            );
        }
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
        assert!(err.contains("4"), "error should name the actual depth: {err}");
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
}
