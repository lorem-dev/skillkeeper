//! Fetching the release manifest and downloading an update artifact.
//!
//! A stable build reads the plain "latest" download URL. A candidate build
//! (a running prerelease version) instead asks the GitHub REST API for the
//! newest release, prereleases included, and reads the manifest from that
//! release's tag -- falling back to the plain "latest" URL if the API call
//! fails for any reason, since a broken newest-release lookup must never
//! turn into a broken check.
//!
//! "Newest" is decided HERE, by parsing the tags, not by trusting the order the
//! API returned. See `greatest_tag` for what that order actually is and what it
//! cost.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use skillkeeper_core::app_update::{Manifest, Version};

/// `owner/name` of the GitHub repository releases are published to.
pub const REPO: &str = "lorem-dev/skillkeeper";

/// Chunk size used both for streaming a download and for reporting progress.
const CHUNK_SIZE: usize = 64 * 1024;

/// GitHub rejects unauthenticated REST API requests with no `User-Agent`.
fn user_agent() -> String {
    format!("skillkeeper/{}", env!("CARGO_PKG_VERSION"))
}

/// The `versions.json` URL for a release: the plain "latest" alias when `tag`
/// is `None`, or a specific tag's download URL otherwise.
pub fn manifest_url(tag: Option<&str>) -> String {
    match tag {
        Some(tag) => format!("https://github.com/{REPO}/releases/download/{tag}/versions.json"),
        None => format!("https://github.com/{REPO}/releases/latest/download/versions.json"),
    }
}

/// The fields this module needs from a GitHub "list releases" entry.
#[derive(Debug, Deserialize)]
struct ReleaseSummary {
    tag_name: String,
    /// A draft is not published and must never be offered.
    #[serde(default)]
    draft: bool,
}

/// How many releases to read while looking for the newest one, and how many
/// pages of that size to walk. Enough to cover a long candidate series without
/// paging the whole history on every check.
const RELEASES_PER_PAGE: u32 = 100;
const RELEASE_PAGES: u32 = 3;

/// Pick the greatest tag by OUR version ordering, ignoring the order the API
/// returned them in.
///
/// This is the whole point of the function. GitHub lists releases ordered
/// LEXICOGRAPHICALLY by tag name, not by date: with rc.9 and rc.10 both
/// published, `v0.5.0-rc.10` sorts BELOW `v0.5.0-rc.3`, because as text "1" is
/// less than "3". Reading `[0]` from a `per_page=1` request therefore answered
/// "rc.9" while rc.10 was the newest release by any two minutes -- so an rc.9
/// build read rc.9's own manifest, found nothing newer, and could never be
/// offered rc.10 at all. Silently.
///
/// Sorting the candidates ourselves with `Version` removes the dependence on
/// an undocumented ordering entirely, rather than trading one assumption about
/// it for another.
fn greatest_tag(releases: Vec<ReleaseSummary>) -> Option<String> {
    releases
        .into_iter()
        .filter(|r| !r.draft)
        .filter_map(|r| Version::parse(&r.tag_name).map(|v| (v, r.tag_name)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, tag)| tag)
}

/// The tag of the newest release, prereleases included, or `None` if the
/// lookup fails for any reason (network error, non-2xx status, unexpected
/// response shape). A caller falls back to the plain "latest" URL on `None`.
pub fn newest_release_tag(agent: &ureq::Agent) -> Option<String> {
    let mut all: Vec<ReleaseSummary> = Vec::new();
    for page in 1..=RELEASE_PAGES {
        let url = format!(
            "https://api.github.com/repos/{REPO}/releases?per_page={RELEASES_PER_PAGE}&page={page}"
        );
        let Ok(mut response) = agent.get(&url).header("User-Agent", user_agent()).call() else {
            break;
        };
        let Ok(batch) = response.body_mut().read_json::<Vec<ReleaseSummary>>() else {
            break;
        };
        let short = batch.len() < RELEASES_PER_PAGE as usize;
        all.extend(batch);
        // A short page is the last one; asking for the next would just cost a
        // request against the rate limit to learn nothing.
        if short {
            break;
        }
    }
    greatest_tag(all)
}

/// Fetch and parse the release manifest.
///
/// A candidate build resolves the newest release's tag first and falls back
/// to the plain "latest" URL on any failure to resolve one.
pub fn fetch_manifest(agent: &ureq::Agent, prerelease_channel: bool) -> Result<Manifest, String> {
    let tag = if prerelease_channel {
        newest_release_tag(agent)
    } else {
        None
    };
    let url = manifest_url(tag.as_deref());
    let mut response = agent
        .get(&url)
        .header("User-Agent", user_agent())
        .call()
        .map_err(|e| e.to_string())?;
    response.body_mut().read_json().map_err(|e| e.to_string())
}

/// The sibling temp path a download streams into before the atomic rename
/// onto `dest`, so a mid-stream failure never leaves a partial file sitting
/// at the path a later step would treat as complete.
fn tmp_path_for(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().unwrap_or_default().to_os_string();
    name.push(".part");
    dest.with_file_name(name)
}

/// Download `url` into `dest`, streaming the response body in 64 KiB chunks
/// and reporting integer percent (derived from `Content-Length`) to
/// `on_progress`.
///
/// When the response carries no `Content-Length`, `on_progress` still fires
/// on every chunk, reporting 0 throughout: a fake percentage is worse than
/// none, but silence for the whole download is worse still.
///
/// The stream is written to a sibling `<dest>.part` file first; `dest` itself
/// is created only by the final rename, once the whole body has arrived, and
/// the temp file is removed on any error. A rename within one directory is
/// atomic on Linux, macOS, and Windows, so `dest` is always either absent or
/// complete, never half-written.
pub fn download(
    agent: &ureq::Agent,
    url: &str,
    dest: &Path,
    on_progress: &dyn Fn(u8),
) -> Result<(), String> {
    let response = agent
        .get(url)
        .header("User-Agent", user_agent())
        .call()
        .map_err(|e| e.to_string())?;
    let (_, body) = response.into_parts();
    let total = body.content_length().filter(|&n| n > 0);
    let mut reader = body.into_reader();

    let tmp = tmp_path_for(dest);
    let result = stream_to_temp(&mut reader, &tmp, total, on_progress);
    match result {
        Ok(()) => std::fs::rename(&tmp, dest).map_err(|e| {
            // The stream succeeded but the rename itself did not (e.g. `dest`
            // is an existing directory): `tmp` is removed here too, so the
            // "removed on every error path" invariant holds literally, not
            // just in effect.
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        }),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

/// Stream `reader` into a fresh file at `tmp`, reporting progress as it goes.
/// The caller owns cleanup of `tmp` on error.
fn stream_to_temp(
    reader: &mut impl Read,
    tmp: &Path,
    total: Option<u64>,
    on_progress: &dyn Fn(u8),
) -> Result<(), String> {
    let mut file = std::fs::File::create(tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut read_so_far: u64 = 0;
    on_progress(0);
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        read_so_far += n as u64;
        let percent = match total {
            Some(total) => ((read_so_far.min(total) * 100) / total) as u8,
            // Unknown length: still tick on every chunk rather than fall
            // silent for the rest of the download.
            None => 0,
        };
        on_progress(percent);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;

    /// A throwaway directory, removed on drop.
    struct TmpDir {
        path: PathBuf,
    }

    impl TmpDir {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "sk-fetch-download-{}-{}",
                std::process::id(),
                n
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
    }

    impl Drop for TmpDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Start a one-shot local HTTP server: accepts a single connection, reads
    /// (and discards) the request up to the blank line ending its headers,
    /// writes back the raw `response` bytes verbatim, then closes the
    /// connection. Returns the `host:port` to send the request to.
    fn spawn_one_shot_server(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let addr = listener.local_addr().expect("local addr");
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                loop {
                    match stream.read(&mut buf) {
                        Ok(n) if n > 0 => {
                            if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        _ => break,
                    }
                }
                let _ = stream.write_all(&response);
                // Dropping `stream` here closes the connection.
            }
        });
        format!("127.0.0.1:{}", addr.port())
    }

    fn summary(tag: &str, draft: bool) -> ReleaseSummary {
        ReleaseSummary {
            tag_name: tag.to_string(),
            draft,
        }
    }

    #[test]
    fn the_greatest_tag_is_chosen_numerically_not_lexicographically() {
        // The bug this exists for: GitHub returns releases ordered
        // lexicographically by tag, so rc.10 arrives BELOW rc.3 and taking the
        // first entry answered rc.9. Deliberately fed in that same wrong order.
        let releases = vec![
            summary("v0.5.0-rc.9", false),
            summary("v0.5.0-rc.8", false),
            summary("v0.5.0-rc.3", false),
            summary("v0.5.0-rc.10", false),
        ];
        assert_eq!(
            greatest_tag(releases).as_deref(),
            Some("v0.5.0-rc.10"),
            "rc.10 is the newest despite sorting last as text"
        );
    }

    #[test]
    fn a_final_release_outranks_its_own_candidates() {
        let releases = vec![
            summary("v0.5.0-rc.10", false),
            summary("v0.5.0", false),
            summary("v0.5.0-rc.2", false),
        ];
        assert_eq!(greatest_tag(releases).as_deref(), Some("v0.5.0"));
    }

    #[test]
    fn drafts_are_never_offered() {
        let releases = vec![summary("v0.9.0", true), summary("v0.5.0-rc.10", false)];
        assert_eq!(greatest_tag(releases).as_deref(), Some("v0.5.0-rc.10"));
    }

    #[test]
    fn an_unparseable_tag_is_skipped_rather_than_chosen() {
        let releases = vec![summary("nightly", false), summary("v0.5.0-rc.10", false)];
        assert_eq!(greatest_tag(releases).as_deref(), Some("v0.5.0-rc.10"));
    }

    #[test]
    fn no_parseable_release_yields_none() {
        assert!(greatest_tag(vec![summary("nightly", false)]).is_none());
        assert!(greatest_tag(Vec::new()).is_none());
    }

    #[test]
    fn a_stable_build_reads_the_latest_download_url() {
        assert_eq!(
            manifest_url(None),
            "https://github.com/lorem-dev/skillkeeper/releases/latest/download/versions.json"
        );
    }

    #[test]
    fn a_candidate_build_reads_a_specific_tag() {
        assert_eq!(
            manifest_url(Some("v0.6.0-rc.1")),
            "https://github.com/lorem-dev/skillkeeper/releases/download/v0.6.0-rc.1/versions.json"
        );
    }

    #[test]
    fn download_leaves_no_partial_file_on_a_truncated_response() {
        // Claims 1000 bytes, sends 10, then closes: the reader must error
        // partway through, exactly the failure this test guards against.
        let mut response =
            b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n".to_vec();
        response.extend_from_slice(&[0u8; 10]);
        let addr = spawn_one_shot_server(response);

        let dir = TmpDir::new();
        let dest = dir.path.join("artifact.bin");
        let agent = ureq::Agent::new_with_defaults();

        let err = download(&agent, &format!("http://{addr}/x"), &dest, &|_| {}).unwrap_err();
        assert!(!err.is_empty());
        assert!(
            !dest.exists(),
            "dest must not exist after a truncated download"
        );
        assert!(
            !tmp_path_for(&dest).exists(),
            "the .part temp file must be cleaned up on error"
        );
    }

    #[test]
    fn download_removes_the_part_file_when_the_final_rename_fails() {
        // The stream itself succeeds, but `dest` is an existing directory, so
        // the final `rename` onto it must fail on every platform.
        let body = b"hello world";
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        let addr = spawn_one_shot_server(response);

        let dir = TmpDir::new();
        let dest = dir.path.join("artifact.bin");
        std::fs::create_dir_all(&dest).unwrap();
        let agent = ureq::Agent::new_with_defaults();

        let err = download(&agent, &format!("http://{addr}/x"), &dest, &|_| {}).unwrap_err();
        assert!(!err.is_empty());
        assert!(
            !tmp_path_for(&dest).exists(),
            "the .part file must be cleaned up even when the rename itself fails"
        );
    }

    #[test]
    fn download_reports_zero_throughout_when_length_is_unknown() {
        // Larger than one 64 KiB chunk, so the unknown-length path must tick
        // more than once to cover it.
        let body = vec![7u8; (CHUNK_SIZE * 2) + 123];
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.extend_from_slice(&body);
        let addr = spawn_one_shot_server(response);

        let dir = TmpDir::new();
        let dest = dir.path.join("artifact.bin");
        let agent = ureq::Agent::new_with_defaults();

        let ticks: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let ticks_for_callback = Arc::clone(&ticks);
        let on_progress = move |p: u8| ticks_for_callback.lock().unwrap().push(p);

        download(&agent, &format!("http://{addr}/x"), &dest, &on_progress).unwrap();

        let recorded = ticks.lock().unwrap();
        assert!(
            recorded.len() >= 3,
            "expected progress to tick throughout, got {} calls",
            recorded.len()
        );
        assert!(
            recorded.iter().all(|&p| p == 0),
            "unknown length must report 0 throughout, got {recorded:?}"
        );
        drop(recorded);
        assert_eq!(std::fs::read(&dest).unwrap().len(), body.len());
    }
}
