//! Ensure a project's `.gitignore` excludes the MCP parameter value files
//! (Rust port of `packages/core/src/mcp/gitignoreEnsure.ts`).
//!
//! The parameter value files (`.skmcp.params.yml` / `.skmcp.params.yaml`) hold
//! raw secrets and must never be committed. The operation is idempotent: it
//! writes only when a line is actually missing.

use regex::Regex;

use crate::ports::{FsPort, PortResult};

/// Name of the canonical MCP parameter value file.
///
/// Divergence: the TypeScript source imports `SKMCP_PARAMS_FILE` from
/// `./skmcp.js`. That module is not part of this Phase 1 port, so the constant
/// is redeclared here (identical value).
const SKMCP_PARAMS_FILE: &str = ".skmcp.params.yml";
/// Sibling `.yaml`-spelled variant of [`SKMCP_PARAMS_FILE`].
const SKMCP_PARAMS_FILE_YAML: &str = ".skmcp.params.yaml";

const GITIGNORE_COMMENT: &str = "# SkillKeeper MCP parameter values";
const GITIGNORE_LINES: [&str; 2] = [SKMCP_PARAMS_FILE, SKMCP_PARAMS_FILE_YAML];

/// Ensure `<project_path>/.gitignore` ignores both MCP parameter value files.
///
/// - Creates the file (comment + both lines) when absent.
/// - Appends missing lines when present but incomplete, preserving existing
///   content; the comment is only (re-)added when not already present.
/// - Performs no write when both lines are already present.
pub fn ensure_gitignore(fs: &dyn FsPort, project_path: &str) -> PortResult<()> {
    let path = format!("{project_path}/.gitignore");
    let exists = fs.exists(&path)?;
    let existing = if exists {
        fs.read_file(&path)?
    } else {
        String::new()
    };

    let line_sep = Regex::new(r"\r?\n").expect("valid regex");
    let existing_lines: Vec<&str> = line_sep.split(&existing).collect();
    let has_line = |line: &str| existing_lines.contains(&line);

    let missing: Vec<&str> = GITIGNORE_LINES
        .iter()
        .copied()
        .filter(|line| !has_line(line))
        .collect();

    if !exists {
        fs.write_file(
            &path,
            &format!("{GITIGNORE_COMMENT}\n{}\n", GITIGNORE_LINES.join("\n")),
        )?;
        return Ok(());
    }
    if missing.is_empty() {
        return Ok(());
    }

    let mut additions: Vec<&str> = Vec::new();
    if !has_line(GITIGNORE_COMMENT) {
        additions.push(GITIGNORE_COMMENT);
    }
    additions.extend(missing.iter().copied());

    let trailing = Regex::new(r"\r?\n+$").expect("valid regex");
    let trimmed = trailing.replace(&existing, "");
    let next = if trimmed.is_empty() {
        format!("{}\n", additions.join("\n"))
    } else {
        format!("{}\n{}\n", trimmed, additions.join("\n"))
    };
    fs.write_file(&path, &next)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{FileStat, PortError, PortResult};
    use crate::testing::MemFs;
    use std::cell::Cell;

    const PROJECT: &str = "/proj";
    const GITIGNORE: &str = "/proj/.gitignore";
    const COMMENT: &str = "# SkillKeeper MCP parameter values";
    const LINE_YML: &str = ".skmcp.params.yml";
    const LINE_YAML: &str = ".skmcp.params.yaml";

    /// Wraps an [`FsPort`], counting `write_file` calls without changing
    /// behavior (Rust analogue of the TypeScript `withWriteSpy` closure).
    struct WriteSpy<'a> {
        inner: &'a MemFs,
        writes: Cell<usize>,
        fail_writes: Cell<bool>,
    }

    impl<'a> WriteSpy<'a> {
        fn new(inner: &'a MemFs) -> Self {
            Self {
                inner,
                writes: Cell::new(0),
                fail_writes: Cell::new(false),
            }
        }
    }

    impl FsPort for WriteSpy<'_> {
        fn read_file(&self, path: &str) -> PortResult<String> {
            self.inner.read_file(path)
        }
        fn write_file(&self, path: &str, content: &str) -> PortResult<()> {
            if self.fail_writes.get() {
                return Err(PortError::Io("write failed".to_string()));
            }
            self.writes.set(self.writes.get() + 1);
            self.inner.write_file(path, content)
        }
        fn list(&self, path: &str) -> PortResult<Vec<String>> {
            self.inner.list(path)
        }
        fn stat(&self, path: &str) -> PortResult<Option<FileStat>> {
            self.inner.stat(path)
        }
        fn exists(&self, path: &str) -> PortResult<bool> {
            self.inner.exists(path)
        }
        fn mkdir(&self, path: &str) -> PortResult<()> {
            self.inner.mkdir(path)
        }
        fn remove(&self, path: &str) -> PortResult<()> {
            self.inner.remove(path)
        }
        fn remove_dir_if_empty(&self, path: &str) -> PortResult<()> {
            self.inner.remove_dir_if_empty(path)
        }
        fn chmod(&self, path: &str, executable: bool) -> PortResult<()> {
            self.inner.chmod(path, executable)
        }
        fn rename(&self, from: &str, to: &str) -> PortResult<()> {
            self.inner.rename(from, to)
        }
    }

    #[test]
    fn creates_gitignore_with_the_comment_and_both_lines_when_absent() {
        let fs = MemFs::new();
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn appends_missing_lines_under_a_new_comment_preserving_existing_content() {
        let fs = MemFs::new().with_file(GITIGNORE, "node_modules\ndist\n");
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("node_modules\ndist\n{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn appends_only_the_missing_line_when_the_comment_is_already_present() {
        let fs =
            MemFs::new().with_file(GITIGNORE, &format!("node_modules\n{COMMENT}\n{LINE_YML}\n"));
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("node_modules\n{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn handles_a_file_missing_a_trailing_newline() {
        let fs = MemFs::new().with_file(GITIGNORE, "node_modules");
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("node_modules\n{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn does_not_write_at_all_when_both_lines_are_already_present() {
        let fs =
            MemFs::new().with_file(GITIGNORE, &format!("{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n"));
        let spy = WriteSpy::new(&fs);
        ensure_gitignore(&spy, PROJECT).unwrap();
        assert_eq!(spy.writes.get(), 0);
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn is_idempotent_across_repeated_calls() {
        let fs = MemFs::new();
        ensure_gitignore(&fs, PROJECT).unwrap();
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn writes_both_lines_when_the_file_is_present_but_empty() {
        // Present-but-empty exercises the `trimmed.is_empty()` branch: the file
        // exists (so the append path runs) yet has no content to preserve.
        let fs = MemFs::new().with_file(GITIGNORE, "");
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn writes_both_lines_when_the_file_is_present_but_only_blank_lines() {
        let fs = MemFs::new().with_file(GITIGNORE, "\n\n");
        ensure_gitignore(&fs, PROJECT).unwrap();
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn issues_exactly_one_write_when_appending_a_missing_line() {
        let fs = MemFs::new().with_file(GITIGNORE, "node_modules\n");
        let spy = WriteSpy::new(&fs);
        ensure_gitignore(&spy, PROJECT).unwrap();
        assert_eq!(spy.writes.get(), 1);
        assert_eq!(
            fs.read_file(GITIGNORE).unwrap(),
            format!("node_modules\n{COMMENT}\n{LINE_YML}\n{LINE_YAML}\n")
        );
    }

    #[test]
    fn propagates_a_write_failure_when_creating_the_file() {
        // The create branch (file absent) still surfaces the underlying write
        // error rather than swallowing it.
        let fs = MemFs::new();
        let spy = WriteSpy::new(&fs);
        spy.fail_writes.set(true);
        let err = ensure_gitignore(&spy, PROJECT).unwrap_err();
        assert!(matches!(err, PortError::Io(_)));
        assert!(!fs.exists(GITIGNORE).unwrap());
    }

    #[test]
    fn propagates_a_write_failure_when_appending_lines() {
        let fs = MemFs::new().with_file(GITIGNORE, "node_modules\n");
        let spy = WriteSpy::new(&fs);
        spy.fail_writes.set(true);
        let err = ensure_gitignore(&spy, PROJECT).unwrap_err();
        assert!(matches!(err, PortError::Io(_)));
        // The original content is untouched on failure.
        assert_eq!(fs.read_file(GITIGNORE).unwrap(), "node_modules\n");
    }

    #[test]
    fn write_spy_transparently_delegates_every_fs_operation() {
        // Exercises the spy's passthrough methods so the test double is a
        // faithful `FsPort` (read/write/list/stat/exists/mkdir/remove/
        // remove_dir_if_empty/chmod/rename all delegate to the inner fake).
        let fs = MemFs::new();
        let spy = WriteSpy::new(&fs);
        spy.write_file("/d/a.txt", "hello").unwrap();
        assert_eq!(spy.read_file("/d/a.txt").unwrap(), "hello");
        assert!(spy.exists("/d/a.txt").unwrap());
        assert_eq!(spy.list("/d").unwrap(), vec!["a.txt".to_string()]);
        assert!(spy.stat("/d/a.txt").unwrap().unwrap().is_file);
        spy.chmod("/d/a.txt", true).unwrap();
        assert!(spy.stat("/d/a.txt").unwrap().unwrap().executable);
        spy.mkdir("/e").unwrap();
        assert!(spy.exists("/e").unwrap());
        spy.rename("/d/a.txt", "/d/b.txt").unwrap();
        assert!(spy.exists("/d/b.txt").unwrap());
        spy.remove("/d/b.txt").unwrap();
        assert!(!spy.exists("/d/b.txt").unwrap());
        spy.remove_dir_if_empty("/e").unwrap();
        assert!(!spy.exists("/e").unwrap());
    }
}
