//! Static analysis of a skill repository.
//!
//! Answers one question: will this repository install the way its author wrote
//! it? The dependency faults (a reference to a skill that does not exist, a
//! cycle) need the whole repository, which is why this is a pass rather than a
//! per-skill check. The rest are conditions that are silent today -- a declared
//! hook with no `HOOK.md`, an `executables:` entry matching no file -- plus the
//! resolver's own warnings, reclassified with a code and a severity so a caller
//! can turn them into an exit status.
//!
//! Reporting only. Nothing here changes what resolves or installs.

use crate::ports::FsPort;
use crate::skills::group_path::skill_path;
use crate::skills::requires::RequiresGraph;
use crate::skills::resolver::resolve_skills;

/// Whether a diagnostic means "this will not work" or "look at this".
///
/// `Error` is declared first so the derived [`Ord`] sorts errors before
/// warnings, which is what [`lint_repository`] relies on to put the most
/// serious findings first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// The repository does not install as written.
    Error,
    /// Worth fixing; the repository still installs.
    Warning,
}

/// One finding from [`lint_repository`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    /// The stable diagnostic code (`SK001`..`SK014`), fixed by the spec. A
    /// caller should match on this, not on `message`.
    pub code: &'static str,
    /// Whether this stops the repository from installing as written.
    pub severity: Severity,
    /// The skill this concerns, as its reference path. `None` for a
    /// repository-wide finding, or when a finding is derived from resolver
    /// prose that does not reliably name a single skill.
    pub path: Option<String>,
    /// The offending file, relative to the repository root, when known.
    pub file: Option<String>,
    /// Human-readable prose. Not stable: may be reworded between releases.
    pub message: String,
}

/// Classify one resolver warning into a code. The fallback is deliberately
/// `SK004`: an unrecognized resolver message still means a skill did not
/// resolve, and reporting it under a general code beats dropping it.
///
/// Every leniency note that can reach this function comes from one of two
/// producers: the manifest parser (`crate::skills::manifest`), whose notes
/// contain "ignoring " or "reading \""; or the frontmatter/yaml-repair retry
/// (`crate::frontmatter`, `crate::yaml_repair`), whose notes contain "quote
/// it to silence this". A leniency note never means the skill failed to
/// resolve -- the skill parsed, a field was just coerced, dropped, or
/// re-quoted -- so every one of those must classify as a warning code
/// (`SK010`-`SK014`), never as `SK003`/`SK004`.
///
/// The branch order below encodes three constraints. Each is load-bearing:
/// reordering the branches changes which code a message gets.
///
/// 1. The `"takes precedence"` branch (`SK011`) must run before the leniency
///    catch-all. The precedence note's own text is `"ignoring \"requires\":
///    \"skillkeeper.requires\" takes precedence"`; checked in the wrong
///    order it would be swallowed by the catch-all and reported as `SK014`.
/// 2. The `"duplicate skill reference"` branch (`SK012`) must run before the
///    leniency catch-all for the same reason: `"ignoring duplicate skill
///    reference \"b\""` also contains "ignoring ".
/// 3. The leniency catch-all must run before the strict-failure check
///    (`SK003`). The flat-`requires` self-reference drop note --
///    `"ignoring invalid skill reference \"a\" in \"requires\": a skill
///    cannot require itself"` -- is a harmless, resolving-skill leniency
///    note whose prose also says "a skill cannot require itself", which is
///    otherwise the signature of the strict, resolution-failing
///    self-reference check in `skillkeeper.requires`. Checking leniency
///    first is what keeps that note classified as `SK014` instead of
///    misclassified as `SK003`.
fn classify_resolver_warning(message: &str) -> &'static str {
    if message.contains("takes precedence") {
        "SK011"
    } else if message.contains("duplicate skill reference") {
        "SK012"
    } else if message.contains("reading \"")
        || message.contains("ignoring ")
        || message.contains("quote it to silence this")
    {
        // "ignoring " (with a trailing space, no quote) already matches
        // every "ignoring \"..." note, since that text is itself "ignoring "
        // followed by a quote -- a separate `contains("ignoring \"")` check
        // would be dead code.
        "SK014"
    } else if message.contains("\"skillkeeper.requires\"")
        || message.contains("cannot require itself")
    {
        "SK003"
    } else {
        "SK004"
    }
}

/// Lint one repository working tree.
///
/// Ordered errors first, then warnings, each group by skill path then code, so
/// the output is stable and the most serious findings are read first.
pub fn lint_repository(fs: &dyn FsPort, repo_root: &str) -> Vec<Diagnostic> {
    let resolved = resolve_skills(fs, repo_root);
    let mut out: Vec<Diagnostic> = Vec::new();

    // The resolver's own warnings, reclassified. The two dependency messages it
    // now emits are skipped here and re-derived from the graph below, so their
    // `path` field is populated rather than parsed back out of prose.
    for message in &resolved.warnings {
        if message.starts_with("Skill \"") && message.contains("does not exist in this repository")
        {
            continue;
        }
        if message.starts_with("Dependency cycle") {
            continue;
        }
        let code = classify_resolver_warning(message);
        let severity = match code {
            "SK011" | "SK012" | "SK014" => Severity::Warning,
            _ => Severity::Error,
        };
        out.push(Diagnostic {
            code,
            severity,
            path: None,
            file: None,
            message: message.clone(),
        });
    }

    let graph = RequiresGraph::build(&resolved.skills);
    for (from, target) in graph.missing() {
        out.push(Diagnostic {
            code: "SK001",
            severity: Severity::Error,
            path: Some(from.clone()),
            file: None,
            message: format!(
                "Skill \"{from}\" requires \"{target}\", which does not exist in this repository."
            ),
        });
    }
    for component in graph.cycles() {
        // `cycles()` returns strongly connected components, not
        // traversal-ordered simple cycles, so members are named rather than
        // chained with arrows -- an arrow chain would imply a specific edge
        // path that may not exist.
        out.push(Diagnostic {
            code: "SK002",
            severity: Severity::Error,
            path: component.first().cloned(),
            file: None,
            message: format!("Dependency cycle among: {}.", component.join(", ")),
        });
    }

    for skill in &resolved.skills {
        let path = skill_path(skill.id.group.as_deref(), &skill.id.name);
        let manifest_file = format!("{}/SKILL.md", skill.root_path);

        // A declared hook is only ever compared against the discovered ones
        // here: the resolver scans `hooks/*/HOOK.md` and never looks at the
        // manifest's list, so a typo installs nothing and says nothing.
        for declared in skill.manifest.hooks.as_deref().unwrap_or(&[]) {
            let found = skill
                .hooks
                .iter()
                .any(|h| h.manifest.name.as_str() == declared.as_str());
            if !found {
                out.push(Diagnostic {
                    code: "SK005",
                    severity: Severity::Error,
                    path: Some(path.clone()),
                    file: Some(manifest_file.clone()),
                    message: format!(
                        "Skill \"{path}\" declares hook \"{declared}\", but hooks/{declared}/HOOK.md was not found or did not parse."
                    ),
                });
            }
        }

        // `executables` entries are skill-relative; `files` are repo-relative.
        // A leading "./" is stripped before comparing: `files` never carries
        // one (the resolver walks and joins path segments directly), so
        // `./run.sh` compared unnormalized would never match `run.sh` and
        // report a false SK013 for a perfectly valid entry.
        for declared in skill.manifest.executables.as_deref().unwrap_or(&[]) {
            let normalized = declared.strip_prefix("./").unwrap_or(declared);
            let expected = format!("{}/{normalized}", skill.root_path);
            if !skill.files.iter().any(|f| *f == expected) {
                out.push(Diagnostic {
                    code: "SK013",
                    severity: Severity::Warning,
                    path: Some(path.clone()),
                    file: Some(manifest_file.clone()),
                    message: format!(
                        "Skill \"{path}\" declares executable \"{declared}\", which is not part of the skill body."
                    ),
                });
            }
        }

        // Declared via the flat field: `requires` is set but the namespaced
        // block was absent, which the parser records by leaving no precedence
        // note. Re-read the frontmatter rather than guessing.
        if let Some(list) = &skill.manifest.requires {
            if !list.is_empty() && uses_flat_requires(fs, repo_root, &manifest_file) {
                out.push(Diagnostic {
                    code: "SK010",
                    severity: Severity::Warning,
                    path: Some(path.clone()),
                    file: Some(manifest_file.clone()),
                    message: format!(
                        "Skill \"{path}\" declares dependencies with the flat \"requires\" field; prefer \"skillkeeper.requires\"."
                    ),
                });
            }
        }
    }

    out.sort_by(|a, b| {
        a.severity
            .cmp(&b.severity)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.code.cmp(&b.code))
    });
    out
}

/// Whether a `SKILL.md` declares dependencies with the flat field, i.e. has a
/// top-level `requires` and no `skillkeeper.requires`. Reads the file again
/// rather than threading the distinction through the manifest, which has no
/// place to carry "which spelling was used" and should not grow one for a lint.
fn uses_flat_requires(fs: &dyn FsPort, repo_root: &str, manifest_file: &str) -> bool {
    let Ok(text) = fs.read_file(&format!("{repo_root}/{manifest_file}")) else {
        return false;
    };
    let Ok(fm) = crate::frontmatter::split_frontmatter(&text) else {
        return false;
    };
    let Some(serde_yaml_ng::Value::Mapping(map)) = fm.data else {
        return false;
    };
    let has_flat = map.contains_key("requires");
    // An explicit `skillkeeper.requires: null` is what `namespaced_requires`
    // treats as absent (see manifest.rs), so the parser falls back to the
    // flat field exactly as if the whole block were missing. `contains_key`
    // alone does not see that: it is true for a present-but-null value, which
    // would make this function say "nested present" while the parser actually
    // took the flat branch, silently dropping the SK010 warning that flat
    // branch deserves.
    let has_nested = matches!(
        map.get("skillkeeper"),
        Some(serde_yaml_ng::Value::Mapping(block))
            if block.get("requires").is_some_and(|v| !v.is_null())
    );
    has_flat && !has_nested
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MemFs;

    fn codes(diags: &[Diagnostic]) -> Vec<&str> {
        diags.iter().map(|d| d.code).collect()
    }

    #[test]
    fn a_clean_repository_produces_nothing() {
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nskillkeeper:\n  requires:\n    - b\n---\nx\n",
            )
            .with_file("/repo/b/SKILL.md", "---\nname: b\n---\nx\n");
        assert!(lint_repository(&fs, "/repo").is_empty());
    }

    #[test]
    fn reports_a_missing_dependency_as_sk001() {
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\nskillkeeper:\n  requires:\n    - ghost\n---\nx\n",
        );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK001"]);
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[0].path.as_deref(), Some("a"));
        assert!(diags[0].message.contains("ghost"));
    }

    #[test]
    fn reports_a_cycle_as_sk002_naming_every_member() {
        // A three-member cycle so "every member" is not trivially satisfied by
        // a two-node fixture, and to confirm the message is not an arrow chain
        // implying edges that may not exist.
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nskillkeeper:\n  requires:\n    - b\n---\nx\n",
            )
            .with_file(
                "/repo/b/SKILL.md",
                "---\nname: b\nskillkeeper:\n  requires:\n    - c\n---\nx\n",
            )
            .with_file(
                "/repo/c/SKILL.md",
                "---\nname: c\nskillkeeper:\n  requires:\n    - a\n---\nx\n",
            );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK002"]);
        assert_eq!(diags[0].severity, Severity::Error);
        assert_eq!(diags[0].message, "Dependency cycle among: a, b, c.");
    }

    #[test]
    fn reports_strict_validation_failure_as_sk003() {
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\nskillkeeper:\n  requires: oops\n---\nx\n",
        );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK003"]);
        assert_eq!(diags[0].severity, Severity::Error);
    }

    #[test]
    fn reports_an_unresolvable_skill_as_sk004() {
        let fs = MemFs::new().with_file("/repo/a/SKILL.md", "---\nlicense: MIT\n---\nx\n");
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK004"]);
    }

    #[test]
    fn reports_a_declared_hook_with_no_hook_md_as_sk005() {
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\nhooks:\n  - on-save\n---\nx\n",
        );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK005"]);
        assert!(diags[0].message.contains("on-save"));
    }

    #[test]
    fn does_not_report_a_declared_hook_that_exists() {
        let fs = MemFs::new()
            .with_file("/repo/a/SKILL.md", "---\nname: a\nhooks:\n  - on-save\n---\nx\n")
            .with_file(
                "/repo/a/hooks/on-save/HOOK.md",
                "---\nname: on-save\ntarget:\n  agent: claude\n  filePattern: \"*.md\"\nstrategy: delimited-text\n---\nx\n",
            );
        assert!(lint_repository(&fs, "/repo").is_empty());
    }

    #[test]
    fn reports_the_flat_field_as_sk010() {
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nrequires:\n  - b\n---\nx\n",
            )
            .with_file("/repo/b/SKILL.md", "---\nname: b\n---\nx\n");
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK010"]);
        assert_eq!(diags[0].severity, Severity::Warning);
    }

    #[test]
    fn reports_the_flat_field_as_sk010_when_the_nested_block_is_an_explicit_null() {
        // Regression guard: `skillkeeper: { requires: null }` is what the
        // parser (manifest.rs's `namespaced_requires`) treats as an absent
        // block -- it falls back to the flat field exactly as if
        // `skillkeeper` were missing entirely. `uses_flat_requires` must
        // agree, or a repository that writes this shape gets no SK010 at
        // all even though the flat field is exactly what resolved.
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nrequires:\n  - b\nskillkeeper:\n  requires: null\n---\nx\n",
            )
            .with_file("/repo/b/SKILL.md", "---\nname: b\n---\nx\n");
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK010"]);
        assert_eq!(diags[0].severity, Severity::Warning);
    }

    #[test]
    fn reports_both_forms_as_sk011() {
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nrequires:\n  - b\nskillkeeper:\n  requires:\n    - b\n---\nx\n",
            )
            .with_file("/repo/b/SKILL.md", "---\nname: b\n---\nx\n");
        assert_eq!(codes(&lint_repository(&fs, "/repo")), vec!["SK011"]);
    }

    #[test]
    fn reports_a_duplicate_reference_as_sk012() {
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nskillkeeper:\n  requires:\n    - b\n    - b\n---\nx\n",
            )
            .with_file("/repo/b/SKILL.md", "---\nname: b\n---\nx\n");
        assert_eq!(codes(&lint_repository(&fs, "/repo")), vec!["SK012"]);
    }

    #[test]
    fn reports_a_missing_executable_as_sk013() {
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\nexecutables:\n  - run.sh\n---\nx\n",
        );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK013"]);
        assert!(diags[0].message.contains("run.sh"));
    }

    #[test]
    fn does_not_report_an_executable_that_exists() {
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nexecutables:\n  - run.sh\n---\nx\n",
            )
            .with_file("/repo/a/run.sh", "#!/bin/sh\n");
        assert!(lint_repository(&fs, "/repo").is_empty());
    }

    #[test]
    fn does_not_report_an_executable_declared_with_a_leading_dot_slash() {
        // Regression guard: `./run.sh` and `run.sh` name the same file. Before
        // normalizing, the comparison path was "a/./run.sh", which never
        // matched the resolver's "a/run.sh", so a perfectly valid entry
        // reported a false SK013.
        let fs = MemFs::new()
            .with_file(
                "/repo/a/SKILL.md",
                "---\nname: a\nexecutables:\n  - ./run.sh\n---\nx\n",
            )
            .with_file("/repo/a/run.sh", "#!/bin/sh\n");
        assert!(lint_repository(&fs, "/repo").is_empty());
    }

    #[test]
    fn reports_a_coerced_field_as_sk014() {
        let fs = MemFs::new().with_file("/repo/a/SKILL.md", "---\nname: a\nversion: 1.0\n---\nx\n");
        assert_eq!(codes(&lint_repository(&fs, "/repo")), vec!["SK014"]);
    }

    #[test]
    fn reports_a_lenient_self_reference_drop_as_sk014_not_sk003() {
        // Regression guard: the flat, lenient `requires` self-reference is
        // dropped with a note whose prose also says "cannot require itself" --
        // the same phrase the strict, resolution-failing check uses. The skill
        // still resolves here, so this must classify as SK014 (a dropped
        // field), not SK003 (a resolution failure).
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\nrequires:\n  - a\n---\nx\n",
        );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK014"]);
        assert_eq!(diags[0].severity, Severity::Warning);
    }

    #[test]
    fn reports_a_yaml_repair_note_as_sk014_not_sk004() {
        // Regression guard: an unquoted second colon in a scalar value (an
        // ordinary authoring mistake -- see the fixture in
        // crate::frontmatter's own tests) is silently repaired by
        // crate::yaml_repair and reported as a note, not a parse failure. The
        // skill resolves fine; a repository whose only sin is this must not
        // fail lint with an Error.
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\ndescription: Covers the tool: run it\n---\nx\n",
        );
        let diags = lint_repository(&fs, "/repo");
        assert_eq!(codes(&diags), vec!["SK014"]);
        assert_eq!(diags[0].severity, Severity::Warning);
    }

    #[test]
    fn errors_sort_before_warnings() {
        let fs = MemFs::new().with_file(
            "/repo/a/SKILL.md",
            "---\nname: a\nversion: 1.0\nskillkeeper:\n  requires:\n    - ghost\n---\nx\n",
        );
        assert_eq!(
            codes(&lint_repository(&fs, "/repo")),
            vec!["SK001", "SK014"]
        );
    }
}
