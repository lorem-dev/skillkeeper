//! `skillkeeper repo` command group: add, remove, list, update.
//!
//! Port of `packages/cli/src/commands/repo.ts`. Repositories are persisted in
//! the state store; git operations are delegated to the injected [`GitPort`].

use std::io::Write;
use std::path::Path;

use clap::Subcommand;
use skillkeeper_core::git_remote::parse_remote;
use skillkeeper_core::models::Repository;
use skillkeeper_core::ports::{Clock, CloneOptions, FsPort, GitPort};
use skillkeeper_core::skills::lint::{lint_repository, Diagnostic, Severity};
use skillkeeper_core::state::state::{load_state, save_state};
use skillkeeper_core::time::iso_from_millis;
use uuid::Uuid;

/// `repo <action>` subcommands.
#[derive(Debug, Subcommand)]
pub enum RepoAction {
    /// Add and clone a skill repository.
    Add {
        /// Remote URL to clone.
        url: String,
        /// Local destination path for the clone. Optional: defaults to a
        /// per-repository directory under the app's repositories folder (the
        /// same location the desktop app uses).
        local_path: Option<String>,
        /// Human-readable name for the repository.
        #[arg(long)]
        name: Option<String>,
        /// Enable Git LFS for this repository. Default: on when git-lfs is
        /// installed.
        #[arg(long, overrides_with = "no_lfs")]
        lfs: bool,
        /// Disable Git LFS even when git-lfs is installed.
        #[arg(long, overrides_with = "lfs")]
        no_lfs: bool,
    },
    /// Remove a tracked repository (does not delete the local clone).
    Remove {
        /// Repository id to remove.
        id: String,
    },
    /// List tracked repositories.
    List,
    /// Update one repository, or all repositories with --all.
    Update {
        /// Repository id to update (omit with --all).
        id: Option<String>,
        /// Update all tracked repositories.
        #[arg(long)]
        all: bool,
    },
    /// Report everything statically wrong with a skill repository's skills:
    /// missing dependencies, dependency cycles, unresolvable skills, and
    /// other static faults. This does not check for updates; see the
    /// top-level `check` command for that.
    Lint {
        /// Repository id to lint (omit with --all or --path).
        id: Option<String>,
        /// Lint every tracked repository.
        #[arg(long)]
        all: bool,
        /// Lint a directory that is not a tracked repository (for a skill
        /// author's own CI).
        #[arg(long)]
        path: Option<String>,
        /// Emit one JSON object per diagnostic instead of human output.
        #[arg(long)]
        json: bool,
    },
}

use crate::error::CliError;

/// Derive a default repository name from a remote URL, mirroring the TypeScript
/// `url.split('/').pop()?.replace(/\.git$/, '')`.
fn default_repo_name(url: &str) -> String {
    let last = url.rsplit('/').next().unwrap_or(url);
    last.strip_suffix(".git").unwrap_or(last).to_string()
}

/// `repo add <url> [localPath]`.
///
/// When `local_path` is omitted the clone goes to `<repositories_dir>/<id>` --
/// the same per-repository scheme the desktop app uses -- and that directory is
/// created if needed.
#[allow(clippy::too_many_arguments)]
pub fn add(
    fs: &dyn FsPort,
    git: &dyn GitPort,
    clock: &dyn Clock,
    state_path: &str,
    repositories_dir: &str,
    url: &str,
    local_path: Option<&str>,
    name: Option<&str>,
    lfs: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;
    if let Some(existing) = state
        .repositories
        .iter()
        .find(|r| r.url == url || local_path.is_some_and(|p| r.local_path == p))
    {
        writeln!(err, "Repository already tracked (id: {})", existing.id)?;
        return Ok(1);
    }

    let id = Uuid::new_v4().to_string();
    let destination = match local_path {
        Some(p) => p.to_string(),
        None => {
            // The clone runs in the parent dir (repositories_dir), so it must
            // exist first. `mkdir` is a no-op when it already does.
            fs.mkdir(repositories_dir)?;
            Path::new(repositories_dir)
                .join(&id)
                .to_string_lossy()
                .into_owned()
        }
    };

    git.clone(&CloneOptions {
        url: url.to_string(),
        destination: destination.clone(),
        lfs,
        filter: None,
    })?;

    let (kind, transport) = parse_remote(url);
    let name = name
        .map(str::to_string)
        .unwrap_or_else(|| default_repo_name(url));
    let last_fetched = iso_from_millis(clock.now());

    state.repositories.push(Repository {
        id: id.clone(),
        name: name.clone(),
        url: url.to_string(),
        kind,
        transport,
        lfs,
        local_path: destination,
        last_fetched: Some(last_fetched),
        branch: None,
    });
    save_state(fs, state_path, &state)?;
    writeln!(out, "Repository added: {name} ({id})")?;
    Ok(0)
}

/// `repo remove <id>`.
pub fn remove(
    fs: &dyn FsPort,
    state_path: &str,
    id: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;
    let Some(pos) = state.repositories.iter().position(|r| r.id == id) else {
        writeln!(err, "Repository not found: {id}")?;
        return Ok(1);
    };
    let removed = state.repositories.remove(pos);
    save_state(fs, state_path, &state)?;
    writeln!(out, "Repository removed: {}", removed.name)?;
    Ok(0)
}

/// `repo list`.
pub fn list(fs: &dyn FsPort, state_path: &str, out: &mut dyn Write) -> Result<i32, CliError> {
    let state = load_state(fs, state_path)?;
    if state.repositories.is_empty() {
        writeln!(out, "No repositories tracked.")?;
        return Ok(0);
    }
    for r in &state.repositories {
        writeln!(out, "{}  {}  {}  ({})", r.id, r.name, r.url, r.local_path)?;
    }
    Ok(0)
}

/// `repo update [id] [--all]`.
#[allow(clippy::too_many_arguments)]
pub fn update(
    fs: &dyn FsPort,
    git: &dyn GitPort,
    clock: &dyn Clock,
    state_path: &str,
    id: Option<&str>,
    all: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    let mut state = load_state(fs, state_path)?;

    let has_target = if all {
        !state.repositories.is_empty()
    } else {
        id.is_some_and(|wanted| state.repositories.iter().any(|r| r.id == wanted))
    };
    if !has_target {
        let msg = match id {
            Some(wanted) => format!("Repository not found: {wanted}"),
            None => "No repositories tracked.".to_string(),
        };
        writeln!(err, "{msg}")?;
        return Ok(1);
    }

    let now_iso = iso_from_millis(clock.now());
    let mut any_error = false;
    for repo in &mut state.repositories {
        let is_target = all || id == Some(repo.id.as_str());
        if !is_target {
            continue;
        }
        match git.pull(&repo.local_path) {
            Ok(()) => {
                repo.last_fetched = Some(now_iso.clone());
                writeln!(out, "Updated: {}", repo.name)?;
            }
            Err(e) => {
                writeln!(err, "Failed to update {}: {e}", repo.name)?;
                any_error = true;
            }
        }
    }
    save_state(fs, state_path, &state)?;
    Ok(if any_error { 1 } else { 0 })
}

/// What to lint. Exactly one of these; the caller (`run`) rejects any other
/// combination before constructing it, so `lint` itself only ever receives a
/// valid target.
#[derive(Debug, Clone, Copy)]
pub enum LintTarget<'a> {
    /// The tracked repository with this id.
    Id(&'a str),
    /// Every tracked repository.
    All,
    /// A directory that is not tracked, for a skill author's own CI.
    Path(&'a str),
}

/// Render one diagnostic as a human line: severity, code, the skill path
/// (when known), then the message, with the file appended when known.
///
/// Most diagnostics carry no path -- they are re-derived from resolver
/// warnings that do not reliably name a single skill -- so the path is only
/// shown when the diagnostic actually has one, never as an empty or
/// placeholder marker.
fn diagnostic_line(diag: &Diagnostic) -> String {
    let severity = diag.severity.as_str();
    let path = match &diag.path {
        Some(path) => format!(" [{path}]"),
        None => String::new(),
    };
    match &diag.file {
        Some(file) => format!(
            "  {severity} {}{path}: {} ({file})",
            diag.code, diag.message
        ),
        None => format!("  {severity} {}{path}: {}", diag.code, diag.message),
    }
}

/// One diagnostic in `--json` output, with its repository label attached.
///
/// Wraps [`Diagnostic`] rather than rebuilding its fields by hand:
/// `#[serde(flatten)]` inlines its fields at serialization time, so the
/// field list exists in exactly one place and a field added to
/// [`Diagnostic`] cannot silently go missing from this shape.
#[derive(serde::Serialize)]
struct JsonDiagnostic<'a> {
    repository: &'a str,
    #[serde(flatten)]
    diagnostic: &'a Diagnostic,
}

/// `repo lint [<id>] [--all] [--path <dir>] [--json]`.
///
/// Lints one or more repository working trees with [`lint_repository`] and
/// reports the findings, grouped by repository. Within an `--all` run, a
/// repository whose working tree is missing is reported on stderr and
/// skipped, rather than aborting the whole run -- the exit code is then
/// decided by the errors found in the repositories that did lint.
///
/// A *named* target (a repository id, or `--path <dir>`) that cannot be
/// linted at all is different: that is the whole request failing outright,
/// not one repository among several, so it is a usage/lookup failure (exit
/// `2`), never silently "no problems found".
///
/// Exit codes:
/// - `0`: no error was reported (warnings do not fail -- a repository with
///   warnings still installs), including `--all` finding zero tracked
///   repositories (nothing to do is not a failure).
/// - `1`: at least one error was reported among the repositories that were
///   linted.
/// - `2`: a usage or lookup failure -- an unknown repository id, or a named
///   target (`<id>` or `--path <dir>`) whose working tree does not exist or
///   is not readable.
///
/// In `--json` mode, stdout is always exactly one parseable JSON array, even
/// on a `2` exit: an empty array `[]` when nothing could be linted, so a
/// consumer that parses stdout before checking the exit code never sees an
/// empty or missing response.
///
/// # Errors
///
/// Returns [`CliError`] if the state file cannot be loaded, or if writing to
/// `out`/`err` fails.
pub fn lint(
    fs: &dyn FsPort,
    state_path: &str,
    target: LintTarget<'_>,
    json: bool,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    // A named target (an id or --path) that cannot be linted is a failure:
    // the gate never ran. `--all` is never "named" -- finding nothing
    // tracked, or skipping some of what is tracked, is not a usage failure.
    let named_target = !matches!(target, LintTarget::All);

    // (repository label, working tree root)
    let roots: Vec<(String, String)> = match target {
        LintTarget::Path(dir) => vec![(dir.to_string(), dir.to_string())],
        LintTarget::Id(id) => {
            let state = load_state(fs, state_path)?;
            match state.repositories.iter().find(|r| r.id == id) {
                Some(repo) => vec![(repo.name.clone(), repo.local_path.clone())],
                None => {
                    writeln!(err, "Repository not found: {id}")?;
                    if json {
                        writeln!(out, "[]")?;
                    }
                    return Ok(2);
                }
            }
        }
        LintTarget::All => {
            let state = load_state(fs, state_path)?;
            state
                .repositories
                .iter()
                .map(|r| (r.name.clone(), r.local_path.clone()))
                .collect()
        }
    };
    let no_tracked_repositories = matches!(target, LintTarget::All) && roots.is_empty();

    let mut all: Vec<(String, Diagnostic)> = Vec::new();
    let mut target_unreadable = false;
    for (label, root) in &roots {
        // A working tree is a DIRECTORY. `exists` is also true for a regular
        // file, so `--path ./SKILL.md` used to walk nothing, find nothing, and
        // report "No problems found." with exit 0 -- a mistyped path passing the
        // CI gate, which is the failure the named-target rule exists to prevent.
        // A file is therefore as unlintable as an absent path, and says so in
        // its own words rather than claiming the path is not there.
        let unusable = match fs.stat(root).unwrap_or(None) {
            None => Some(format!("Working tree not found: {root}")),
            Some(stat) if !stat.is_directory => Some(format!("Not a directory: {root}")),
            Some(_) => None,
        };
        if let Some(reason) = unusable {
            writeln!(err, "[{label}] {reason}")?;
            if named_target {
                target_unreadable = true;
            }
            continue;
        }
        for diag in lint_repository(fs, root) {
            all.push((label.clone(), diag));
        }
    }

    if target_unreadable {
        if json {
            writeln!(out, "[]")?;
        }
        return Ok(2);
    }

    let errors = all
        .iter()
        .filter(|(_, d)| d.severity == Severity::Error)
        .count();
    let warnings = all.len() - errors;

    if json {
        let items: Vec<JsonDiagnostic> = all
            .iter()
            .map(|(label, d)| JsonDiagnostic {
                repository: label,
                diagnostic: d,
            })
            .collect();
        writeln!(out, "{}", serde_json::to_string_pretty(&items)?)?;
    } else if no_tracked_repositories {
        writeln!(out, "No tracked repositories.")?;
    } else if all.is_empty() {
        writeln!(out, "No problems found.")?;
    } else {
        let mut current = String::new();
        for (label, diag) in &all {
            if *label != current {
                writeln!(out, "{label}")?;
                current = label.clone();
            }
            writeln!(out, "{}", diagnostic_line(diag))?;
        }
        writeln!(
            out,
            "{errors} error{}, {warnings} warning{}.",
            if errors == 1 { "" } else { "s" },
            if warnings == 1 { "" } else { "s" }
        )?;
    }

    Ok(if errors > 0 { 1 } else { 0 })
}

/// Dispatch a `repo` subcommand.
#[allow(clippy::too_many_arguments)]
pub fn run(
    action: &RepoAction,
    fs: &dyn FsPort,
    git: &dyn GitPort,
    clock: &dyn Clock,
    state_path: &str,
    repositories_dir: &str,
    out: &mut dyn Write,
    err: &mut dyn Write,
) -> Result<i32, CliError> {
    match action {
        RepoAction::Add {
            url,
            local_path,
            name,
            lfs,
            no_lfs,
        } => {
            // Default LFS on when git-lfs is installed; explicit flags win.
            let use_lfs = if *lfs {
                true
            } else if *no_lfs {
                false
            } else {
                git.lfs_available()
            };
            add(
                fs,
                git,
                clock,
                state_path,
                repositories_dir,
                url,
                local_path.as_deref(),
                name.as_deref(),
                use_lfs,
                out,
                err,
            )
        }
        RepoAction::Remove { id } => remove(fs, state_path, id, out, err),
        RepoAction::List => list(fs, state_path, out),
        RepoAction::Update { id, all } => {
            update(fs, git, clock, state_path, id.as_deref(), *all, out, err)
        }
        RepoAction::Lint {
            id,
            all,
            path,
            json,
        } => {
            // Mutual exclusion is enforced here, at the dispatch boundary, so
            // `lint` itself only ever receives a valid target.
            let chosen =
                usize::from(id.is_some()) + usize::from(*all) + usize::from(path.is_some());
            if chosen != 1 {
                writeln!(
                    err,
                    "Specify exactly one of: a repository id, --all, or --path <dir>."
                )?;
                return Ok(2);
            }
            let target = match (id.as_deref(), *all, path.as_deref()) {
                (Some(id), _, _) => LintTarget::Id(id),
                (_, true, _) => LintTarget::All,
                (_, _, Some(dir)) => LintTarget::Path(dir),
                _ => unreachable!("the count check above admits exactly one"),
            };
            lint(fs, state_path, target, *json, out, err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testutil::{FakeGit, FixedClock};
    use skillkeeper_core::testing::MemFs;

    const STATE_PATH: &str = "/data/state.json";
    const REPOS_DIR: &str = "/data/repos";
    // 2025-07-17T00:00:00.000Z
    const FIXED_MS: i64 = 1_752_710_400_000;

    fn clock() -> FixedClock {
        FixedClock(FIXED_MS)
    }

    #[test]
    fn default_repo_name_strips_git_suffix() {
        assert_eq!(
            default_repo_name("https://github.com/acme/skills.git"),
            "skills"
        );
        assert_eq!(default_repo_name("git@github.com:acme/tools"), "tools");
    }

    #[test]
    fn add_clones_and_persists_a_repository() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            "https://github.com/acme/skills.git",
            Some("/repos/skills"),
            None,
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let out = String::from_utf8(out).unwrap();
        assert!(out.starts_with("Repository added: skills ("));
        assert!(git
            .calls
            .borrow()
            .iter()
            .any(|c| c.contains("clone https://github.com/acme/skills.git -> /repos/skills")));

        let state = load_state(&fs, STATE_PATH).unwrap();
        assert_eq!(state.repositories.len(), 1);
        let repo = &state.repositories[0];
        assert_eq!(repo.name, "skills");
        assert_eq!(repo.local_path, "/repos/skills");
        assert_eq!(
            repo.last_fetched.as_deref(),
            Some("2025-07-17T00:00:00.000Z")
        );
    }

    #[test]
    fn add_uses_provided_name() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            "https://github.com/acme/skills.git",
            Some("/repos/skills"),
            Some("my-skills"),
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        let state = load_state(&fs, STATE_PATH).unwrap();
        assert_eq!(state.repositories[0].name, "my-skills");
        assert!(state.repositories[0].lfs);
    }

    #[test]
    fn add_rejects_a_duplicate_url() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            "https://github.com/acme/skills.git",
            Some("/repos/skills"),
            None,
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let mut out2 = Vec::new();
        let mut err2 = Vec::new();
        let code = add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            "https://github.com/acme/skills.git",
            Some("/repos/other"),
            None,
            false,
            &mut out2,
            &mut err2,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err2)
            .unwrap()
            .contains("Repository already tracked"));
    }

    #[test]
    fn remove_deletes_a_tracked_repository() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            "https://github.com/acme/skills.git",
            Some("/repos/skills"),
            None,
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let id = load_state(&fs, STATE_PATH).unwrap().repositories[0]
            .id
            .clone();

        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(&fs, STATE_PATH, &id, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("Repository removed: skills"));
        assert!(load_state(&fs, STATE_PATH).unwrap().repositories.is_empty());
    }

    #[test]
    fn remove_reports_missing_repository() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = remove(&fs, STATE_PATH, "nope", &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Repository not found: nope"));
    }

    #[test]
    fn list_reports_empty_and_populated() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        list(&fs, STATE_PATH, &mut out).unwrap();
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No repositories tracked."));

        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            "https://github.com/acme/skills.git",
            Some("/repos/skills"),
            None,
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        let mut out = Vec::new();
        list(&fs, STATE_PATH, &mut out).unwrap();
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains("skills"));
        assert!(out.contains("(/repos/skills)"));
    }

    fn seed_two(fs: &MemFs) -> (String, String) {
        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        for (url, dest) in [
            ("https://github.com/acme/a.git", "/repos/a"),
            ("https://github.com/acme/b.git", "/repos/b"),
        ] {
            add(
                fs,
                &git,
                &clock(),
                STATE_PATH,
                REPOS_DIR,
                url,
                Some(dest),
                None,
                false,
                &mut sink,
                &mut sink2,
            )
            .unwrap();
        }
        let state = load_state(fs, STATE_PATH).unwrap();
        (
            state.repositories[0].id.clone(),
            state.repositories[1].id.clone(),
        )
    }

    #[test]
    fn update_single_repository_by_id() {
        let fs = MemFs::new();
        let (id_a, _id_b) = seed_two(&fs);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            Some(&id_a),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let calls = git.calls.borrow();
        assert!(calls.iter().any(|c| c == "pull /repos/a"));
        assert!(!calls.iter().any(|c| c == "pull /repos/b"));
    }

    #[test]
    fn update_all_repositories() {
        let fs = MemFs::new();
        seed_two(&fs);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            None,
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let calls = git.calls.borrow();
        assert!(calls.iter().any(|c| c == "pull /repos/a"));
        assert!(calls.iter().any(|c| c == "pull /repos/b"));
    }

    #[test]
    fn update_reports_missing_id() {
        let fs = MemFs::new();
        seed_two(&fs);
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            Some("nope"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Repository not found: nope"));
    }

    #[test]
    fn update_reports_error_and_exits_one_on_pull_failure() {
        let fs = MemFs::new();
        let (id_a, _) = seed_two(&fs);
        let mut git = FakeGit::up_to_date();
        git.pull_fails.insert("/repos/a".to_string());
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            Some(&id_a),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err).unwrap().contains("Failed to update"));
    }

    #[test]
    fn update_empty_state_reports_no_repositories() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = update(
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            None,
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("No repositories tracked."));
    }

    #[test]
    fn run_add_defaults_local_path_under_repositories_dir() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();
        let action = RepoAction::Add {
            url: "https://github.com/acme/skills.git".to_string(),
            local_path: None,
            name: None,
            lfs: false,
            no_lfs: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &action,
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let repo = &load_state(&fs, STATE_PATH).unwrap().repositories[0];
        let expected = Path::new(REPOS_DIR).join(&repo.id);
        assert_eq!(repo.local_path, expected.to_string_lossy());
    }

    #[test]
    fn run_add_enables_lfs_when_git_lfs_is_available() {
        let fs = MemFs::new();
        let mut git = FakeGit::up_to_date();
        git.lfs_available = true;
        let action = RepoAction::Add {
            url: "https://github.com/acme/skills.git".to_string(),
            local_path: Some("/repos/skills".to_string()),
            name: None,
            lfs: false,
            no_lfs: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        run(
            &action,
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert!(load_state(&fs, STATE_PATH).unwrap().repositories[0].lfs);
    }

    #[test]
    fn run_add_no_lfs_overrides_autodetect() {
        let fs = MemFs::new();
        let mut git = FakeGit::up_to_date();
        git.lfs_available = true;
        let action = RepoAction::Add {
            url: "https://github.com/acme/skills.git".to_string(),
            local_path: Some("/repos/skills".to_string()),
            name: None,
            lfs: false,
            no_lfs: true,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        run(
            &action,
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert!(!load_state(&fs, STATE_PATH).unwrap().repositories[0].lfs);
    }

    /// Track a repository (via `add`) whose `local_path` is `local_path`,
    /// with `name` as its display name. Returns its id.
    fn seed_repo(fs: &MemFs, name: &str, local_path: &str) -> String {
        let git = FakeGit::up_to_date();
        let mut sink = Vec::new();
        let mut sink2 = Vec::new();
        add(
            fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &format!("https://github.com/acme/{name}.git"),
            Some(local_path),
            Some(name),
            false,
            &mut sink,
            &mut sink2,
        )
        .unwrap();
        load_state(fs, STATE_PATH).unwrap().repositories[0]
            .id
            .clone()
    }

    #[test]
    fn lint_reports_nothing_and_exits_zero_for_a_clean_repository() {
        let fs = MemFs::new().with_file("/repos/skills/a/SKILL.md", "---\nname: a\n---\nx\n");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("No problems found"), "{text}");
    }

    #[test]
    fn lint_exits_one_when_an_error_is_reported() {
        let fs = MemFs::new().with_file(
            "/repos/skills/a/SKILL.md",
            "---\nname: a\nskillkeeper:\n  requires:\n    - ghost\n---\nx\n",
        );
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("SK001"), "{text}");
        assert!(text.contains("ghost"), "{text}");
        assert!(text.contains("1 error"), "{text}");
    }

    #[test]
    fn lint_exits_zero_when_only_warnings_are_reported() {
        let fs = MemFs::new().with_file(
            "/repos/skills/a/SKILL.md",
            "---\nname: a\nversion: 1.0\n---\nx\n",
        );
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out).unwrap().contains("SK014"));
    }

    #[test]
    fn lint_json_emits_one_object_per_diagnostic() {
        let fs = MemFs::new().with_file(
            "/repos/skills/a/SKILL.md",
            "---\nname: a\nskillkeeper:\n  requires:\n    - ghost\n---\nx\n",
        );
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills"),
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        let parsed: serde_json::Value = serde_json::from_slice(&out).expect("valid JSON document");
        let items = parsed.as_array().expect("a JSON array");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["code"], "SK001");
        assert_eq!(items[0]["severity"], "error");
        assert_eq!(items[0]["path"], "a");
    }

    #[test]
    fn lint_reports_an_unknown_repository_id() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Id("nope"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Repository not found"));
    }

    #[test]
    fn lint_json_reports_an_empty_array_for_an_unknown_repository_id() {
        // The "--json => stdout is always one valid JSON document" guarantee
        // must hold even on a lookup failure, so a consumer that parses
        // stdout before checking the exit code does not crash.
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Id("nope"),
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        let parsed: serde_json::Value = serde_json::from_slice(&out).expect("valid JSON document");
        assert_eq!(parsed.as_array().expect("a JSON array").len(), 0);
    }

    #[test]
    fn lint_json_reports_an_empty_array_for_a_named_target_with_no_working_tree() {
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/definitely-not-here"),
            true,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        let parsed: serde_json::Value = serde_json::from_slice(&out).expect("valid JSON document");
        assert_eq!(parsed.as_array().expect("a JSON array").len(), 0);
    }

    #[test]
    fn lint_by_id_lints_the_tracked_repositorys_working_tree() {
        let fs = MemFs::new().with_file("/repos/a/x/SKILL.md", "---\nlicense: MIT\n---\nx\n");
        let id = seed_repo(&fs, "a", "/repos/a");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Id(&id),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 1);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("SK004"), "{text}");
        assert!(text.contains('a'), "{text}");
    }

    #[test]
    fn lint_all_lints_every_tracked_repository_grouped_by_repository() {
        let fs = MemFs::new()
            .with_file("/repos/a/x/SKILL.md", "---\nname: x\n---\nok\n")
            .with_file("/repos/b/y/SKILL.md", "---\nlicense: MIT\n---\noops\n");
        seed_repo(&fs, "repo-a", "/repos/a");
        seed_repo(&fs, "repo-b", "/repos/b");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(&fs, STATE_PATH, LintTarget::All, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("repo-b"), "{text}");
        assert!(text.contains("SK004"), "{text}");
        // The clean repository contributes no diagnostics, so it gets no
        // heading at all -- only repositories with findings are printed.
        assert!(!text.contains("repo-a"), "{text}");
    }

    #[test]
    fn lint_reports_a_missing_working_tree_and_continues_to_the_next_repository() {
        let fs = MemFs::new().with_file("/repos/b/y/SKILL.md", "---\nname: y\n---\nx\n");
        seed_repo(&fs, "repo-a", "/repos/a");
        seed_repo(&fs, "repo-b", "/repos/b");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(&fs, STATE_PATH, LintTarget::All, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Working tree not found: /repos/a"));
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No problems found"));
    }

    #[test]
    fn lint_all_still_fails_on_an_error_from_a_repository_that_did_lint() {
        // Bullet 3 of the controller ruling: `--all` where some repositories
        // are skipped and others lint keeps today's behaviour -- the skip is
        // a stderr note, and the exit code is decided by the errors found in
        // the repositories that did lint, not by the skip.
        let fs = MemFs::new().with_file(
            "/repos/b/x/SKILL.md",
            "---\nname: x\nskillkeeper:\n  requires:\n    - ghost\n---\nx\n",
        );
        seed_repo(&fs, "repo-a", "/repos/a");
        seed_repo(&fs, "repo-b", "/repos/b");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(&fs, STATE_PATH, LintTarget::All, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 1);
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Working tree not found: /repos/a"));
        assert!(String::from_utf8(out).unwrap().contains("SK001"));
    }

    #[test]
    fn lint_reports_no_tracked_repositories_distinctly_from_no_problems_found() {
        // Bullet 2: `--all` finding zero tracked repositories is not a
        // failure, but it is not "nothing to do" either -- the message must
        // let the operator tell the two apart.
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(&fs, STATE_PATH, LintTarget::All, false, &mut out, &mut err).unwrap();
        assert_eq!(code, 0);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("No tracked repositories."), "{text}");
        assert!(!text.contains("No problems found"), "{text}");
    }

    #[test]
    fn lint_fails_a_named_path_target_with_no_readable_working_tree() {
        // Bullet 1, the regression that matters: a mistyped `--path` must not
        // look like a clean repository. Exit 2, and stdout must not say "No
        // problems found." -- the gate never ran, so it must not look like it
        // passed.
        let fs = MemFs::new();
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/definitely-not-here"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        let out_text = String::from_utf8(out).unwrap();
        assert!(!out_text.contains("No problems found"), "{out_text}");
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Working tree not found: /definitely-not-here"));
    }

    #[test]
    fn lint_fails_a_named_path_target_that_is_a_file() {
        // `--path ./SKILL.md`: the path EXISTS, so an existence check passes it
        // through, the walk finds no skill directory, and the run reports a
        // clean repository. Same class of failure as a mistyped path, so it must
        // exit 2 and must not print the clean message.
        let fs = MemFs::new().with_file("/repos/skills/a/SKILL.md", "---\nname: a\n---\nx\n");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills/a/SKILL.md"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        let out_text = String::from_utf8(out).unwrap();
        assert!(!out_text.contains("No problems found"), "{out_text}");
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Not a directory: /repos/skills/a/SKILL.md"));
    }

    #[test]
    fn lint_fails_a_named_id_target_whose_clone_is_absent() {
        // Same failure mode as the path case, but for a tracked repository
        // whose recorded local_path no longer has a working tree on disk.
        let fs = MemFs::new();
        let id = seed_repo(&fs, "ghost-repo", "/repos/ghost");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = lint(
            &fs,
            STATE_PATH,
            LintTarget::Id(&id),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        let out_text = String::from_utf8(out).unwrap();
        assert!(!out_text.contains("No problems found"), "{out_text}");
        assert!(String::from_utf8(err)
            .unwrap()
            .contains("Working tree not found: /repos/ghost"));
    }

    #[test]
    fn lint_line_includes_the_skill_path_when_the_diagnostic_has_one() {
        let fs = MemFs::new().with_file(
            "/repos/skills/a/SKILL.md",
            "---\nname: a\nskillkeeper:\n  requires:\n    - ghost\n---\nx\n",
        );
        let mut out = Vec::new();
        let mut err = Vec::new();
        lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("SK001 [a]:"), "{text}");
    }

    #[test]
    fn lint_line_has_no_path_marker_when_the_diagnostic_lacks_one() {
        // SK004 (an unresolvable skill) never carries a path -- the resolver
        // warning it comes from does not reliably name a single skill. The
        // rendered line must not invent a placeholder for it.
        let fs = MemFs::new().with_file("/repos/skills/a/SKILL.md", "---\nlicense: MIT\n---\nx\n");
        let mut out = Vec::new();
        let mut err = Vec::new();
        lint(
            &fs,
            STATE_PATH,
            LintTarget::Path("/repos/skills"),
            false,
            &mut out,
            &mut err,
        )
        .unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains("SK004:"), "{text}");
        assert!(!text.contains('['), "{text}");
    }

    #[test]
    fn run_lint_rejects_zero_or_multiple_targets() {
        let fs = MemFs::new();
        let git = FakeGit::up_to_date();

        let action = RepoAction::Lint {
            id: None,
            all: false,
            path: None,
            json: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &action,
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
        assert!(String::from_utf8(err).unwrap().contains("exactly one"));

        let action = RepoAction::Lint {
            id: Some("x".to_string()),
            all: true,
            path: None,
            json: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &action,
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 2);
    }

    #[test]
    fn run_lint_dispatches_to_the_path_target() {
        let fs = MemFs::new().with_file("/repos/skills/a/SKILL.md", "---\nname: a\n---\nx\n");
        let git = FakeGit::up_to_date();
        let action = RepoAction::Lint {
            id: None,
            all: false,
            path: Some("/repos/skills".to_string()),
            json: false,
        };
        let mut out = Vec::new();
        let mut err = Vec::new();
        let code = run(
            &action,
            &fs,
            &git,
            &clock(),
            STATE_PATH,
            REPOS_DIR,
            &mut out,
            &mut err,
        )
        .unwrap();
        assert_eq!(code, 0);
        assert!(String::from_utf8(out)
            .unwrap()
            .contains("No problems found"));
    }
}
