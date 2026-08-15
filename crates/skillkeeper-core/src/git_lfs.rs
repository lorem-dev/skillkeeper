//! Detecting whether a checked-out repository needs Git LFS.
//!
//! Without the `git-lfs` extension, `git clone` still succeeds on an LFS
//! repository -- it just leaves every tracked file as its pointer: three lines
//! of text where an image, font, or archive should be. Nothing fails, and the
//! skill installs with a placeholder in place of its content, which is far
//! harder to notice than an error.
//!
//! The check has to work WITHOUT the extension installed, so it cannot ask
//! `git lfs ls-files`. It reads what the repository itself declares: a
//! `.gitattributes` line routing a pattern through the `lfs` filter.

use crate::ports::{FsPort, PortResult};

/// The attribute a repository writes to route a pattern through Git LFS.
const LFS_FILTER: &str = "filter=lfs";

const GITATTRIBUTES: &str = ".gitattributes";

/// Directories never worth descending into when looking for `.gitattributes`.
const SKIPPED: [&str; 5] = [".git", "node_modules", "vendor", "target", "dist"];

/// Whether the working tree at `root` declares any Git LFS-tracked path.
///
/// # Errors
///
/// Returns the underlying [`crate::ports::PortError`] only when `root` itself
/// cannot be listed; an unreadable subdirectory is skipped, since a partial
/// answer is more useful here than none.
pub fn requires_lfs(fs: &dyn FsPort, root: &str) -> PortResult<bool> {
    let entries = fs.list(root)?;
    let mut dirs = Vec::new();
    for name in entries {
        let path = format!("{root}/{name}");
        let Ok(Some(stat)) = fs.stat(&path) else {
            continue;
        };
        if stat.is_directory {
            if !SKIPPED.contains(&name.as_str()) {
                dirs.push(path);
            }
            continue;
        }
        if name == GITATTRIBUTES && declares_lfs(fs, &path) {
            return Ok(true);
        }
    }
    for dir in dirs {
        // An unreadable subdirectory is not an answer, so keep looking.
        if requires_lfs(fs, &dir).unwrap_or(false) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether a `.gitattributes` file routes anything through the LFS filter.
/// A comment line is ignored, so a commented-out rule does not count.
fn declares_lfs(fs: &dyn FsPort, path: &str) -> bool {
    let Ok(text) = fs.read_file(path) else {
        return false;
    };
    text.lines().any(|line| {
        let line = line.trim();
        !line.starts_with('#') && line.contains(LFS_FILTER)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::MemFs;

    #[test]
    fn detects_lfs_declared_at_the_root() {
        let fs = MemFs::new().with_file(
            "/repo/.gitattributes",
            "*.png filter=lfs diff=lfs merge=lfs -text\n",
        );
        assert!(requires_lfs(&fs, "/repo").unwrap());
    }

    #[test]
    fn detects_lfs_declared_in_a_subdirectory() {
        let fs = MemFs::new().with_file("/repo/SKILL.md", "x").with_file(
            "/repo/group/skill/.gitattributes",
            "*.bin filter=lfs -text\n",
        );
        assert!(requires_lfs(&fs, "/repo").unwrap());
    }

    #[test]
    fn ignores_a_gitattributes_without_the_lfs_filter() {
        let fs = MemFs::new().with_file("/repo/.gitattributes", "* text=auto\n*.sh eol=lf\n");
        assert!(!requires_lfs(&fs, "/repo").unwrap());
    }

    #[test]
    fn ignores_a_commented_out_rule() {
        let fs = MemFs::new().with_file(
            "/repo/.gitattributes",
            "# *.png filter=lfs -text\n* text=auto\n",
        );
        assert!(!requires_lfs(&fs, "/repo").unwrap());
    }

    #[test]
    fn reports_false_for_a_repository_declaring_nothing() {
        let fs = MemFs::new().with_file("/repo/SKILL.md", "x");
        assert!(!requires_lfs(&fs, "/repo").unwrap());
    }

    #[test]
    fn does_not_descend_into_the_git_directory() {
        // A repository's own .git holds an attributes file of its own; it says
        // nothing about what the working tree tracks.
        let fs = MemFs::new().with_file("/repo/.git/info/.gitattributes", "* filter=lfs\n");
        assert!(!requires_lfs(&fs, "/repo").unwrap());
    }
}
