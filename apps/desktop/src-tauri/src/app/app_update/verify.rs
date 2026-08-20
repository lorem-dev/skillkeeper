//! Integrity of a downloaded artifact.
//!
//! The manifest carries the SHA-256 the release workflow computed, so a
//! truncated or tampered download is caught before anything is executed.

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of a file, streamed rather than buffered whole (these
/// are installer-sized files).
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Compare a file against its expected digest.
pub fn verify(path: &Path, expected: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual.eq_ignore_ascii_case(expected.trim()) {
        return Ok(());
    }
    Err(format!(
        "checksum mismatch for {}: expected {expected}, got {actual}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Counter making each temp path unique within the process.
    ///
    /// Keying the name on the CONTENTS is not enough: cargo runs these tests in
    /// parallel threads of one process, and two tests that hash the same bytes
    /// would then share a path -- so whichever finished first would delete the
    /// file the other was still reading.
    static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

    fn temp_with(contents: &[u8]) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "sk-verify-{}-{}",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(contents).unwrap();
        p
    }

    #[test]
    fn hashes_a_file() {
        let p = temp_with(b"abc");
        // Well-known SHA-256 of "abc".
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn accepts_a_matching_digest_case_insensitively() {
        let p = temp_with(b"abc");
        let upper = "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD";
        assert!(verify(&p, upper).is_ok());
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn rejects_a_mismatched_digest() {
        let p = temp_with(b"abcd");
        let err = verify(&p, "00").unwrap_err();
        assert!(
            err.contains("checksum"),
            "message should name the problem: {err}"
        );
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn reports_a_missing_file() {
        assert!(sha256_file(std::path::Path::new("/nope/nothing")).is_err());
    }
}
