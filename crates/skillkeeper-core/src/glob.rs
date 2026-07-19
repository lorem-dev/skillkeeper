//! The tiny glob matcher shared by skill resolution and the install engine
//! (Rust port of `kernel/glob.ts`'s `matchesAny`).
//!
//! Supports `*` (within a path segment), `**` (across segments, with `a/**`
//! also matching `a` itself), and `?` (a single non-separator character).

use regex::Regex;

/// Translate a glob to a [`Regex`] anchored to the whole path. Supports `*`
/// (within a segment), `**` (across segments, with `a/**` also matching `a`),
/// and `?` (a single non-separator character). Mirrors `kernel/glob.ts`.
pub fn glob_to_regex(glob: &str) -> Regex {
    let chars: Vec<char> = glob.chars().collect();
    let mut re = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '/' && chars.get(i + 1) == Some(&'*') && chars.get(i + 2) == Some(&'*') {
            // `/**` matches the parent directory itself and any descendant.
            re.push_str("(?:/.*)?");
            i += 2;
            if chars.get(i + 1) == Some(&'/') {
                i += 1;
            }
        } else if ch == '*' {
            if chars.get(i + 1) == Some(&'*') {
                // A leading `**` matches across path separators.
                re.push_str(".*");
                i += 1;
                if chars.get(i + 1) == Some(&'/') {
                    i += 1;
                }
            } else {
                // `*` matches within a single path segment.
                re.push_str("[^/]*");
            }
        } else if ch == '?' {
            re.push_str("[^/]");
        } else if ".+^${}()|[]\\".contains(ch) {
            re.push('\\');
            re.push(ch);
        } else {
            re.push(ch);
        }
        i += 1;
    }
    re.push('$');
    Regex::new(&re).expect("valid glob regex")
}

/// True when `path` matches any of the given globs.
pub fn matches_any(path: &str, globs: &[String]) -> bool {
    globs.iter().any(|g| glob_to_regex(g).is_match(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn globs(patterns: &[&str]) -> Vec<String> {
        patterns.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn star_matches_within_a_single_segment_only() {
        assert!(glob_to_regex("*.sh").is_match("run.sh"));
        assert!(!glob_to_regex("*.sh").is_match("bin/run.sh"));
    }

    #[test]
    fn double_star_matches_across_segments() {
        assert!(glob_to_regex("bin/**").is_match("bin/tool"));
        assert!(glob_to_regex("bin/**").is_match("bin/nested/tool"));
        // `a/**` also matches the parent directory itself.
        assert!(glob_to_regex("bin/**").is_match("bin"));
    }

    #[test]
    fn leading_double_star_matches_any_prefix() {
        assert!(glob_to_regex("**/x").is_match("a/b/x"));
        assert!(glob_to_regex("**/x").is_match("x"));
    }

    #[test]
    fn question_mark_matches_one_non_separator_char() {
        assert!(glob_to_regex("a?c").is_match("abc"));
        assert!(!glob_to_regex("a?c").is_match("a/c"));
    }

    #[test]
    fn special_regex_characters_are_escaped() {
        assert!(glob_to_regex("a.b+c").is_match("a.b+c"));
        assert!(!glob_to_regex("a.b+c").is_match("axbxc"));
    }

    #[test]
    fn matches_any_is_true_when_any_glob_matches() {
        assert!(matches_any("bin/tool", &globs(&["src/**", "bin/**"])));
        assert!(!matches_any("lib/x", &globs(&["src/**", "bin/**"])));
        assert!(!matches_any("anything", &globs(&[])));
    }
}
