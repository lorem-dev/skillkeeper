//! Local-socket askpass transport: the server that answers `ssh`'s passphrase
//! prompt from an in-memory secret, and the helper entry point that `ssh`
//! invokes (as this same binary, via `SSH_ASKPASS`) to ask for it.
//!
//! `ssh` never runs the helper through a shell and appends no arguments of its
//! own beyond the prompt, so the helper cannot be selected by a flag inside
//! `SSH_ASKPASS` itself -- see [`is_helper_invocation`]. This module owns the
//! wire protocol, the accept loop, prompt classification, and the helper's
//! `main`-equivalent; it does not know where the secret comes from (that is
//! the passphrase store, a later piece) and never touches Tauri, the config,
//! or any log, since the helper runs as a plain subprocess with no window.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use interprocess::local_socket::{prelude::*, Listener, ListenerOptions, Stream};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};

pub use skillkeeper_core::ssh_env::{ASKPASS_ENDPOINT_ENV, ASKPASS_TOKEN_ENV};

/// Explicit flag selecting helper mode, for manual invocation and testing.
///
/// The real `ssh`-driven path cannot use this: `SSH_ASKPASS` must be a bare
/// executable path (`ssh` neither appends its own arguments there nor invokes
/// it through a shell), so [`is_helper_invocation`] recognises that form
/// structurally instead.
pub const HELPER_FLAG: &str = "--skillkeeper-askpass";

/// Time a minted token remains valid. Long enough to cover ssh's connection
/// setup and the time a user takes to notice a prompt; short enough that a
/// token leaked or left lying around cannot be replayed much later.
const TOKEN_TTL: Duration = Duration::from_secs(120);

/// Upper bound on one request's bytes (`GET <token> <prompt>\n`). Far more
/// than any real token or prompt needs; caps `read_line` so a peer that never
/// sends a newline cannot grow the buffer without limit.
const MAX_REQUEST_BYTES: u64 = 8192;

/// How long a connection may sit with no data before it is given up on.
///
/// Only takes effect on unix: `interprocess` returns "unsupported" for
/// `set_recv_timeout` on Windows named pipes (checked in its own source), so
/// this is best-effort there and the per-connection thread below is what
/// actually keeps a stuck peer from affecting anyone else.
const READ_TIMEOUT: Duration = Duration::from_secs(5);

/// True when `prompt` is asking for an SSH key passphrase, as opposed to any
/// other confirmation routed to this helper.
///
/// `SSH_ASKPASS_REQUIRE=force` also sends the unknown-host-key confirmation
/// here (verified against OpenSSH 10.2); answering that would mean silently
/// trusting an unknown host, so it is deliberately excluded.
///
/// A plain `contains("passphrase")` is not enough: with `force`, OpenSSH also
/// routes server-supplied keyboard-interactive prompts through this same
/// helper, and that text comes verbatim from the remote host. A malicious
/// server could offer a keyboard-interactive prompt that merely mentions the
/// word to fish the stored passphrase out and relay it onward. Anchoring on
/// OpenSSH's own local wording -- "Enter passphrase for ..." or exactly
/// "Enter passphrase: " -- narrows this to the prompts the local client
/// itself generates when unlocking a key file.
pub fn is_passphrase_prompt(prompt: &str) -> bool {
    let lower = prompt.trim().to_lowercase();
    if lower.contains("continue connecting") {
        return false;
    }
    lower.starts_with("enter passphrase for") || lower.starts_with("enter passphrase:")
}

/// True when `args` is how `ssh` (or a manual test) invokes this binary as its
/// askpass helper: the explicit [`HELPER_FLAG`] form, or the real `ssh` form --
/// exactly one argument (the prompt, which `ssh` always passes whole) with the
/// askpass endpoint present in the environment.
pub fn is_helper_invocation(args: &[String]) -> bool {
    if args.len() == 2 && args[0] == HELPER_FLAG {
        return true;
    }
    args.len() == 1 && std::env::var_os(ASKPASS_ENDPOINT_ENV).is_some()
}

/// Entry point when this binary is invoked as the askpass helper.
///
/// Reads the endpoint and single-use token from the environment, fetches the
/// passphrase for the prompt `ssh` passed as the last argument, and prints it
/// alone to stdout with a trailing newline. Prints nothing and returns `1`
/// when there is no answer, so `ssh` fails fast rather than hanging.
pub fn helper_main(args: &[String]) -> i32 {
    let Some(prompt) = args.last() else {
        return 1;
    };
    let (Ok(endpoint), Ok(token)) = (
        std::env::var(ASKPASS_ENDPOINT_ENV),
        std::env::var(ASKPASS_TOKEN_ENV),
    ) else {
        return 1;
    };
    match fetch(&endpoint, &token, prompt) {
        Some(passphrase) => {
            println!("{passphrase}");
            0
        }
        None => 1,
    }
}

/// Server side of the askpass transport: one local socket, one accept-loop
/// thread for the process's lifetime that hands each connection off to its
/// own short-lived thread, single-use tokens with a TTL.
pub struct AskpassServer {
    endpoint: String,
    tokens: Arc<Mutex<HashMap<String, Instant>>>,
    declined_prompt: Arc<Mutex<Option<String>>>,
    /// Owns the private socket directory on platforms that use a filesystem
    /// path (unix); removed on drop. `None` on Windows, whose namespaced named
    /// pipe needs no directory of ours.
    _socket_dir: Option<SocketDirGuard>,
}

impl AskpassServer {
    /// Bind a local socket and spawn the accept-loop thread.
    ///
    /// `secret` is called fresh for every request that reaches a live,
    /// well-formed `GET` for a passphrase prompt; returning `None` (no
    /// passphrase currently held) closes the connection without an answer,
    /// same as an unknown token or a declined prompt.
    ///
    /// Each accepted connection is handed to its own short-lived thread
    /// rather than handled inline on the accept loop: a peer that connects
    /// and never sends a line (or never disconnects) would otherwise block
    /// `accept()` forever, wedging every later legitimate request for the
    /// rest of the app session with no way to recover short of a restart.
    /// With per-connection threads, a stuck peer only ever blocks its own
    /// thread.
    pub fn start(secret: Arc<dyn Fn() -> Option<String> + Send + Sync>) -> Result<Self, String> {
        let (listener, endpoint, socket_dir) = make_listener()?;
        let tokens: Arc<Mutex<HashMap<String, Instant>>> = Arc::new(Mutex::new(HashMap::new()));
        let declined_prompt: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let accept_tokens = Arc::clone(&tokens);
        let accept_declined = Arc::clone(&declined_prompt);
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else {
                    continue;
                };
                let tokens = Arc::clone(&accept_tokens);
                let declined = Arc::clone(&accept_declined);
                let secret = Arc::clone(&secret);
                std::thread::spawn(move || {
                    handle_connection(stream, &tokens, &declined, &secret);
                });
            }
        });

        Ok(Self {
            endpoint,
            tokens,
            declined_prompt,
            _socket_dir: socket_dir,
        })
    }

    /// The local-socket name a helper connects to (see [`ASKPASS_ENDPOINT_ENV`]).
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Mint a fresh single-use token, valid for [`TOKEN_TTL`].
    pub fn mint_token(&self) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        prune_expired(&mut tokens);
        let token = uuid::Uuid::new_v4().to_string();
        tokens.insert(token.clone(), Instant::now());
        token
    }

    /// The most recent prompt the server declined to answer (because it was
    /// not a passphrase prompt), if any. Reading it clears it, so a later
    /// failure is not misattributed to an earlier decline.
    pub fn take_declined_prompt(&self) -> Option<String> {
        self.declined_prompt.lock().unwrap().take()
    }
}

/// Drop tokens whose TTL has elapsed, so the map never grows unbounded and an
/// expired token is treated the same as an unknown one.
fn prune_expired(tokens: &mut HashMap<String, Instant>) {
    let now = Instant::now();
    tokens.retain(|_, minted| now.duration_since(*minted) < TOKEN_TTL);
}

/// Handle one connection (on its own thread -- see [`AskpassServer::start`]):
/// read one `GET <token> <prompt...>` line and, when the token is live, the
/// prompt is a passphrase prompt, and a secret is held, write
/// `<passphrase>\n` back. Otherwise close without writing.
///
/// The token is consumed (removed) as soon as it is found live, regardless of
/// what happens next, so a retry -- with a wrong passphrase, say -- gets
/// nothing and `ssh` fails fast instead of allowing another guess.
fn handle_connection(
    mut stream: Stream,
    tokens: &Mutex<HashMap<String, Instant>>,
    declined_prompt: &Mutex<Option<String>>,
    secret: &Arc<dyn Fn() -> Option<String> + Send + Sync>,
) {
    // Best-effort: bounds how long this connection's own thread can be stuck
    // on unix (unsupported on Windows named pipes, where the per-connection
    // thread above is the actual safeguard).
    let _ = stream.set_recv_timeout(Some(READ_TIMEOUT));

    let mut line = String::new();
    {
        // `.take()` caps total bytes read so a peer that never sends a
        // newline cannot grow `line` without bound; combined with the
        // timeout above, this connection gives up instead of hanging.
        let mut reader = BufReader::new((&mut stream).take(MAX_REQUEST_BYTES));
        if reader.read_line(&mut line).is_err() {
            return;
        }
    }
    let line = line.trim_end_matches(['\n', '\r']);
    let mut parts = line.splitn(3, ' ');
    let (Some("GET"), Some(token), Some(prompt)) = (parts.next(), parts.next(), parts.next())
    else {
        return;
    };

    let is_live = {
        let mut tokens = tokens.lock().unwrap();
        prune_expired(&mut tokens);
        tokens.remove(token).is_some()
    };
    if !is_live {
        return;
    }

    if !is_passphrase_prompt(prompt) {
        *declined_prompt.lock().unwrap() = Some(prompt.to_string());
        return;
    }

    let Some(passphrase) = secret() else {
        return;
    };
    let _ = writeln!(stream, "{passphrase}");
}

/// Connect to the server, present `token` and `prompt`, and return the
/// passphrase if one comes back. Shared by [`helper_main`] and the tests.
///
/// Returns `None` on any error, refusal, or empty read -- there is nothing
/// more specific to report, and this must never risk echoing the passphrase
/// (or anything derived from a failed attempt) into an error value that could
/// end up logged.
fn fetch(endpoint: &str, token: &str, prompt: &str) -> Option<String> {
    let mut stream = connect(endpoint).ok()?;
    // The wire protocol is one line each way; a prompt can itself contain a
    // newline (the host-key confirmation is multi-line), so fold those into
    // spaces rather than let them split the request.
    let single_line_prompt = prompt.replace(['\n', '\r'], " ");
    writeln!(stream, "GET {token} {single_line_prompt}").ok()?;

    let mut line = String::new();
    let read = {
        let mut reader = BufReader::new(&mut stream);
        reader.read_line(&mut line).ok()?
    };
    if read == 0 {
        return None;
    }
    let answer = line.trim_end_matches(['\n', '\r']);
    if answer.is_empty() {
        None
    } else {
        Some(answer.to_string())
    }
}

/// Removes the private socket directory (and the socket file inside it) when
/// the server that owns it is dropped. Only used on platforms that fall back
/// to a filesystem-path socket (see [`make_listener`]).
struct SocketDirGuard(std::path::PathBuf);

impl Drop for SocketDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Connect to `endpoint` using the same name mapping [`make_listener`] used to
/// bind it.
#[cfg(windows)]
fn connect(endpoint: &str) -> std::io::Result<Stream> {
    let name = endpoint.to_string().to_ns_name::<GenericNamespaced>()?;
    Stream::connect(name)
}

#[cfg(unix)]
fn connect(endpoint: &str) -> std::io::Result<Stream> {
    let name = std::path::Path::new(endpoint).to_fs_name::<GenericFilePath>()?;
    Stream::connect(name)
}

/// Bind a fresh local socket and return its listener, the endpoint name a
/// client uses to reach it, and (on platforms that need one) the directory
/// guard that cleans up after it.
///
/// Windows gets a namespaced name, which resolves to a named pipe with no
/// filesystem entry at all; the pipe's ACL is the OS's own, tied to the
/// creating process. Unix -- both macOS and Linux -- gets a filesystem-path
/// socket instead, deliberately *not* a namespaced one: on Linux, `interprocess`
/// maps a namespaced name to the abstract socket namespace, which carries no
/// access control of its own (any local process, any uid, can connect). The
/// filesystem socket is placed inside a directory created with mode `0o700`
/// under [`std::env::temp_dir`], so only this uid can even resolve the path to
/// reach it; the directory (and the socket file in it) is removed when the
/// returned guard drops.
#[cfg(windows)]
fn make_listener() -> Result<(Listener, String, Option<SocketDirGuard>), String> {
    let name = format!("skillkeeper-askpass-{}", uuid::Uuid::new_v4());
    let ns_name = name
        .clone()
        .to_ns_name::<GenericNamespaced>()
        .map_err(|e| e.to_string())?;
    let listener = ListenerOptions::new()
        .name(ns_name)
        .create_sync()
        .map_err(|e| e.to_string())?;
    Ok((listener, name, None))
}

#[cfg(unix)]
fn make_listener() -> Result<(Listener, String, Option<SocketDirGuard>), String> {
    use std::os::unix::fs::PermissionsExt;

    // `sockaddr_un.sun_path` is only 104 bytes on Darwin (108 on Linux), and a
    // real `$TMPDIR` on macOS is already a long per-user path
    // (`/var/folders/.../T/`), so both the directory name and the socket file
    // name are kept short: a full UUID (with or without hyphens) would not
    // leave enough room there.
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let dir = std::env::temp_dir().join(format!("sk-ap-{}", &unique[..12]));
    std::fs::create_dir(&dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;

    let socket_path = dir.join("s");
    let endpoint = socket_path.to_string_lossy().into_owned();
    let fs_name = socket_path
        .as_path()
        .to_fs_name::<GenericFilePath>()
        .map_err(|e| e.to_string())?;
    let listener = ListenerOptions::new()
        .name(fs_name)
        .create_sync()
        .map_err(|e| e.to_string())?;
    Ok((listener, endpoint, Some(SocketDirGuard(dir))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_passphrase_prompts_are_answered() {
        assert!(is_passphrase_prompt("Enter passphrase for \"enc_key\": "));
        assert!(is_passphrase_prompt(
            "Enter passphrase for key '/home/u/.ssh/id': "
        ));
        assert!(is_passphrase_prompt("Enter passphrase: "));
        // Verified against OpenSSH 10.2: with SSH_ASKPASS_REQUIRE=force the
        // host-key confirmation is routed to the helper too, and answering it
        // would mean trusting an unknown host silently.
        assert!(!is_passphrase_prompt(
            "The authenticity of host 'github.com (140.82.121.3)' can't be established.\n\
             Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        ));
        assert!(!is_passphrase_prompt(
            "Password for 'https://example.com': "
        ));
    }

    #[test]
    fn a_prompt_that_only_mentions_passphrase_is_rejected() {
        // With SSH_ASKPASS_REQUIRE=force, a remote server's own
        // keyboard-interactive prompt text also reaches this helper verbatim.
        // A prompt must match OpenSSH's own local "unlocking a key" wording,
        // not merely contain the word, or a hostile server could fish the
        // stored passphrase out through a crafted prompt and relay it onward.
        assert!(!is_passphrase_prompt(
            "Please enter your passphrase to continue: "
        ));
        assert!(!is_passphrase_prompt("passphrase required for access"));
    }

    #[test]
    fn a_minted_token_yields_the_secret_exactly_once() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase for \"k\": "),
            Some("topsecret".to_string())
        );
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase for \"k\": "),
            None,
            "a token must not be reusable"
        );
    }

    #[test]
    fn an_unknown_token_gets_nothing() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        assert_eq!(
            fetch(server.endpoint(), "not-a-token", "Enter passphrase: "),
            None
        );
    }

    #[test]
    fn a_declined_prompt_is_recorded_for_the_error_message() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();
        assert_eq!(
            fetch(
                server.endpoint(),
                &token,
                "Are you sure you want to continue connecting? "
            ),
            None
        );
        let declined = server.take_declined_prompt().expect("prompt recorded");
        assert!(declined.contains("continue connecting"));
        // Reading it clears it, so a later failure is not misattributed.
        assert!(server.take_declined_prompt().is_none());
    }

    #[test]
    fn no_secret_held_means_no_answer() {
        let server = AskpassServer::start(Arc::new(|| None)).expect("server");
        let token = server.mint_token();
        assert_eq!(fetch(server.endpoint(), &token, "Enter passphrase: "), None);
    }

    #[test]
    fn an_oversized_request_gets_no_answer_instead_of_hanging() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");

        let mut stream = connect(server.endpoint()).expect("connect");
        // No trailing newline: without a cap on the read, `read_line` would
        // keep growing its buffer waiting for a newline that never comes.
        let oversized = "x".repeat(MAX_REQUEST_BYTES as usize * 2);
        stream.write_all(oversized.as_bytes()).expect("write");

        // Do the read on another thread with a bounded wait so that, if the
        // cap regresses, this test fails instead of hanging the whole suite.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut response = String::new();
            let read = BufReader::new(&mut stream).read_line(&mut response);
            let _ = tx.send(read.ok());
        });
        let read = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the bounded read must finish, not hang");
        assert_eq!(read, Some(0), "malformed, oversized request gets no answer");
    }

    #[test]
    fn a_stuck_connection_does_not_block_other_requests() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();

        std::thread::scope(|scope| {
            // A peer that connects and never sends a line (and never
            // disconnects) must not block the accept loop: each connection
            // now gets its own thread instead of being handled inline (see
            // AskpassServer::start). Held well past the assertion's own wait
            // budget below, so this test can only pass if the second request
            // truly is not waiting on this connection at all.
            let endpoint_for_stuck_peer = server.endpoint().to_string();
            scope.spawn(move || {
                let stuck = connect(&endpoint_for_stuck_peer).expect("connect");
                std::thread::sleep(Duration::from_secs(3));
                drop(stuck);
            });
            // Give the stuck connection a head start so it is the one the
            // accept loop sees first.
            std::thread::sleep(Duration::from_millis(100));

            let endpoint = server.endpoint().to_string();
            let (tx, rx) = std::sync::mpsc::channel();
            scope.spawn(move || {
                let _ = tx.send(fetch(&endpoint, &token, "Enter passphrase: "));
            });
            let answer = rx
                .recv_timeout(Duration::from_secs(1))
                .expect("a concurrent request must not be blocked by a stuck connection");
            assert_eq!(answer, Some("topsecret".to_string()));
        });
    }

    #[test]
    fn a_plain_launch_is_not_a_helper_invocation() {
        // No arguments and no endpoint: the normal way the app starts.
        assert!(!is_helper_invocation(&[]));
        assert!(!is_helper_invocation(&["Enter passphrase: ".to_string()]));
        assert!(is_helper_invocation(&[
            HELPER_FLAG.to_string(),
            "Enter passphrase: ".to_string()
        ]));
    }
}
