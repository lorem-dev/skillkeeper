//! In-memory [`FsPort`] fake for domain tests, mirroring the TypeScript
//! `packages/core` test fakes. Single-threaded (test-only); uses `RefCell`.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use crate::ports::{FileStat, FsPort, PortError, PortResult};

struct FileNode {
    content: String,
    executable: bool,
}

/// Absolute-path in-memory filesystem. Paths use `/` separators.
pub struct MemFs {
    files: RefCell<BTreeMap<String, FileNode>>,
    dirs: RefCell<BTreeSet<String>>,
}

impl Default for MemFs {
    fn default() -> Self {
        let mut dirs = BTreeSet::new();
        dirs.insert("/".to_string());
        Self {
            files: RefCell::new(BTreeMap::new()),
            dirs: RefCell::new(dirs),
        }
    }
}

impl MemFs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed a file (creating parent dirs), for concise test setup.
    pub fn with_file(self, path: &str, content: &str) -> Self {
        self.write_file(path, content).expect("seed file");
        self
    }

    fn ensure_dir(&self, path: &str) {
        let mut dirs = self.dirs.borrow_mut();
        let mut cur = normalize(path);
        loop {
            dirs.insert(cur.clone());
            if cur == "/" {
                break;
            }
            cur = parent(&cur);
        }
    }
}

fn normalize(path: &str) -> String {
    if path.len() > 1 {
        let trimmed = path.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    } else {
        path.to_string()
    }
}

fn parent(path: &str) -> String {
    let p = normalize(path);
    match p.rfind('/') {
        Some(0) => "/".to_string(),
        Some(idx) => p[..idx].to_string(),
        None => "/".to_string(),
    }
}

fn basename(path: &str) -> String {
    let p = normalize(path);
    match p.rfind('/') {
        Some(idx) => p[idx + 1..].to_string(),
        None => p,
    }
}

impl FsPort for MemFs {
    fn read_file(&self, path: &str) -> PortResult<String> {
        let key = normalize(path);
        self.files
            .borrow()
            .get(&key)
            .map(|f| f.content.clone())
            .ok_or(PortError::NotFound(key))
    }

    fn write_file(&self, path: &str, content: &str) -> PortResult<()> {
        let key = normalize(path);
        self.ensure_dir(&parent(&key));
        self.files.borrow_mut().insert(
            key,
            FileNode {
                content: content.to_string(),
                executable: false,
            },
        );
        Ok(())
    }

    fn list(&self, path: &str) -> PortResult<Vec<String>> {
        let key = normalize(path);
        if !self.dirs.borrow().contains(&key) {
            return Err(PortError::NotFound(key));
        }
        let mut names = BTreeSet::new();
        for f in self.files.borrow().keys() {
            if parent(f) == key {
                names.insert(basename(f));
            }
        }
        for d in self.dirs.borrow().iter() {
            if d != &key && parent(d) == key {
                names.insert(basename(d));
            }
        }
        Ok(names.into_iter().collect())
    }

    fn stat(&self, path: &str) -> PortResult<Option<FileStat>> {
        let key = normalize(path);
        if let Some(f) = self.files.borrow().get(&key) {
            return Ok(Some(FileStat {
                is_file: true,
                is_directory: false,
                executable: f.executable,
                size: f.content.len() as u64,
            }));
        }
        if self.dirs.borrow().contains(&key) {
            return Ok(Some(FileStat {
                is_file: false,
                is_directory: true,
                executable: false,
                size: 0,
            }));
        }
        Ok(None)
    }

    fn exists(&self, path: &str) -> PortResult<bool> {
        let key = normalize(path);
        Ok(self.files.borrow().contains_key(&key) || self.dirs.borrow().contains(&key))
    }

    fn mkdir(&self, path: &str) -> PortResult<()> {
        self.ensure_dir(path);
        Ok(())
    }

    fn remove(&self, path: &str) -> PortResult<()> {
        self.files.borrow_mut().remove(&normalize(path));
        Ok(())
    }

    fn remove_dir_if_empty(&self, path: &str) -> PortResult<()> {
        let key = normalize(path);
        if key == "/" {
            return Ok(());
        }
        let has_child = self.files.borrow().keys().any(|f| parent(f) == key)
            || self
                .dirs
                .borrow()
                .iter()
                .any(|d| d != &key && parent(d) == key);
        if !has_child {
            self.dirs.borrow_mut().remove(&key);
        }
        Ok(())
    }

    fn chmod(&self, path: &str, executable: bool) -> PortResult<()> {
        let key = normalize(path);
        match self.files.borrow_mut().get_mut(&key) {
            Some(f) => {
                f.executable = executable;
                Ok(())
            }
            None => Err(PortError::NotFound(key)),
        }
    }

    fn rename(&self, from: &str, to: &str) -> PortResult<()> {
        let from = normalize(from);
        let to = normalize(to);
        self.ensure_dir(&parent(&to));

        // File move.
        let node = self.files.borrow_mut().remove(&from);
        if let Some(node) = node {
            self.files.borrow_mut().insert(to, node);
            return Ok(());
        }

        // Directory subtree move.
        if self.dirs.borrow().contains(&from) {
            let prefix = format!("{from}/");
            let moved_files: Vec<(String, FileNode)> = {
                let mut files = self.files.borrow_mut();
                let keys: Vec<String> = files
                    .keys()
                    .filter(|k| k.starts_with(&prefix))
                    .cloned()
                    .collect();
                keys.into_iter()
                    .map(|k| {
                        let node = files.remove(&k).expect("key present");
                        let rest = &k[from.len()..];
                        (format!("{to}{rest}"), node)
                    })
                    .collect()
            };
            let moved_dirs: Vec<String> = {
                let mut dirs = self.dirs.borrow_mut();
                let keys: Vec<String> = dirs
                    .iter()
                    .filter(|d| *d == &from || d.starts_with(&prefix))
                    .cloned()
                    .collect();
                for k in &keys {
                    dirs.remove(k);
                }
                keys.into_iter()
                    .map(|k| format!("{to}{}", &k[from.len()..]))
                    .collect()
            };
            {
                let mut dirs = self.dirs.borrow_mut();
                for d in moved_dirs {
                    dirs.insert(d);
                }
            }
            let mut files = self.files.borrow_mut();
            for (k, node) in moved_files {
                files.insert(k, node);
            }
            return Ok(());
        }

        Err(PortError::NotFound(from))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_creates_parents_and_reads_back() {
        let fs = MemFs::new();
        fs.write_file("/a/b/c.txt", "hello").unwrap();
        assert_eq!(fs.read_file("/a/b/c.txt").unwrap(), "hello");
        assert!(fs.exists("/a/b").unwrap());
        assert!(fs.exists("/a").unwrap());
    }

    #[test]
    fn read_missing_is_not_found() {
        let fs = MemFs::new();
        assert!(matches!(
            fs.read_file("/nope").unwrap_err(),
            PortError::NotFound(_)
        ));
    }

    #[test]
    fn list_returns_immediate_children() {
        let fs = MemFs::new();
        fs.write_file("/d/a.txt", "1").unwrap();
        fs.write_file("/d/sub/b.txt", "2").unwrap();
        assert_eq!(fs.list("/d").unwrap(), vec!["a.txt", "sub"]);
    }

    #[test]
    fn stat_distinguishes_file_and_dir() {
        let fs = MemFs::new();
        fs.write_file("/d/a.txt", "abc").unwrap();
        let file = fs.stat("/d/a.txt").unwrap().unwrap();
        assert!(file.is_file && !file.is_directory && file.size == 3);
        let dir = fs.stat("/d").unwrap().unwrap();
        assert!(dir.is_directory && !dir.is_file);
        assert!(fs.stat("/missing").unwrap().is_none());
    }

    #[test]
    fn chmod_sets_executable_bit() {
        let fs = MemFs::new();
        fs.write_file("/x.sh", "#!/bin/sh").unwrap();
        fs.chmod("/x.sh", true).unwrap();
        assert!(fs.stat("/x.sh").unwrap().unwrap().executable);
    }

    #[test]
    fn rename_moves_file_and_dir_subtree() {
        let fs = MemFs::new();
        fs.write_file("/a/one.txt", "1").unwrap();
        fs.write_file("/a/sub/two.txt", "2").unwrap();
        fs.rename("/a", "/b").unwrap();
        assert!(!fs.exists("/a").unwrap());
        assert_eq!(fs.read_file("/b/one.txt").unwrap(), "1");
        assert_eq!(fs.read_file("/b/sub/two.txt").unwrap(), "2");
    }

    #[test]
    fn remove_dir_if_empty_only_when_empty() {
        let fs = MemFs::new();
        fs.mkdir("/d").unwrap();
        fs.write_file("/d/a.txt", "1").unwrap();
        fs.remove_dir_if_empty("/d").unwrap();
        assert!(fs.exists("/d").unwrap());
        fs.remove("/d/a.txt").unwrap();
        fs.remove_dir_if_empty("/d").unwrap();
        assert!(!fs.exists("/d").unwrap());
    }
}
