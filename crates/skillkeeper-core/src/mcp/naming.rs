//! Deriving a native-config-safe instance name for an MCP server (Rust port of
//! `packages/core/src/mcp/naming.ts`).
//!
//! Snake_case the source name, then allocate the smallest free `<snake>_<n>`
//! suffix against the names already present in the target config.

use std::collections::HashSet;

use regex::Regex;

/// Convert an arbitrary display name into a snake_case identifier.
///
/// Rule (applied in order):
/// 1. Insert `_` before any uppercase letter that immediately follows a
///    lowercase letter or a digit -- this splits camelCase boundaries
///    (`GitHub` -> `Git_Hub`) while leaving runs of caps (`MCP`) intact.
/// 2. Lowercase the whole string.
/// 3. Replace every run of non-alphanumeric characters with a single `_`.
/// 4. Trim leading/trailing `_`.
///
/// Example: `"GitHub MCP"` -> `"Git_Hub MCP"` -> `"git_hub mcp"` ->
/// `"git_hub_mcp"`.
pub fn to_snake_case(name: &str) -> String {
    let camel_boundary = Regex::new(r"([a-z0-9])([A-Z])").expect("valid regex");
    let non_alnum = Regex::new(r"[^a-z0-9]+").expect("valid regex");
    let split = camel_boundary.replace_all(name, "${1}_${2}");
    let lowered = split.to_lowercase();
    let collapsed = non_alnum.replace_all(&lowered, "_");
    collapsed.trim_matches('_').to_string()
}

/// Allocate an instance name for a newly-added MCP server: snake_case the source
/// name, then append the smallest `_<n>` (n >= 1) not already present in
/// `existing`. `existing` must include every name already in the target native
/// config, whether or not SkillKeeper owns it, so the result never collides with
/// anything already there.
pub fn allocate_instance_name(source: &str, existing: &[String]) -> String {
    let base = to_snake_case(source);
    let taken: HashSet<&str> = existing.iter().map(String::as_str).collect();
    let mut n: u32 = 1;
    while taken.contains(format!("{base}_{n}").as_str()) {
        n += 1;
    }
    format!("{base}_{n}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn snake_cases_names() {
        assert_eq!(to_snake_case("GitHub MCP"), "git_hub_mcp");
    }

    #[test]
    fn leaves_an_all_lowercase_name_unchanged() {
        assert_eq!(to_snake_case("github"), "github");
    }

    #[test]
    fn allocates_the_first_free_numbered_name() {
        assert_eq!(allocate_instance_name("github", &[]), "github_1");
        assert_eq!(
            allocate_instance_name("github", &v(&["github_1", "github_2"])),
            "github_3"
        );
        assert_eq!(
            allocate_instance_name("github", &v(&["github_2"])),
            "github_1"
        );
    }

    #[test]
    fn snake_cases_the_source_before_allocating() {
        assert_eq!(allocate_instance_name("GitHub MCP", &[]), "git_hub_mcp_1");
    }
}
