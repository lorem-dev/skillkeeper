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
    match fetch_bounded(&endpoint, &token, prompt, HELPER_TIMEOUT) {
        Some(passphrase) => {
            println!("{passphrase}");
            0
        }
        None => 1,
    }
}

/// How long the helper waits for the app to answer before giving up.
///
/// The app is local and holds the passphrase in memory, so an answer takes
/// microseconds; this bound exists for the cases where there is no answer at
/// all. Generous enough that a loaded machine cannot trip it.
const HELPER_TIMEOUT: Duration = Duration::from_secs(10);

/// [`fetch`], but incapable of hanging.
///
/// Neither connecting to the endpoint nor reading from it has a timeout of its
/// own, and on Windows a named-pipe connect blocks while it waits for an
/// instance -- so a helper whose endpoint is gone, or whose server never
/// answers, would wait forever. `ssh` waits on its askpass program with no
/// bound of its own, and git waits on `ssh`, so that one blocked read stalled a
/// repository operation until the terminal's silence timeout killed it, with
/// nothing printed and no prompt to answer. Bounding it here turns that into a
/// fast, ordinary authentication failure.
///
/// The worker thread is left to its fate: it holds nothing the process needs,
/// and the process exits as soon as this returns.
fn fetch_bounded(endpoint: &str, token: &str, prompt: &str, wait: Duration) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let (endpoint, token, prompt) = (endpoint.to_string(), token.to_string(), prompt.to_string());
    std::thread::spawn(move || {
        let _ = tx.send(fetch(&endpoint, &token, &prompt));
    });
    rx.recv_timeout(wait).ok().flatten()
}

/// Flag selecting the round-trip self-check, for verifying this transport on a
/// machine the developer cannot run tests on (Windows, in practice).
pub const SELFTEST_FLAG: &str = "--skillkeeper-askpass-selftest";

/// Drive the whole askpass path in one process and report what happened.
///
/// Starts a server holding a known secret, mints a token, runs THIS binary the
/// way `ssh` would (one prompt argument, endpoint and token in the
/// environment), and compares what the helper printed with what the server
/// holds. Every step's outcome is printed, so a failure says which link broke
/// rather than only that the feature does not work.
///
/// Exists because the transport's Windows behaviour cannot be exercised from a
/// unix development machine: whether `ssh` calls the helper, whether a
/// GUI-subsystem binary can write to a captured stdout, and whether a
/// named-pipe connect succeeds are all platform answers.
pub fn selftest_main() -> i32 {
    let mut report = Report::new();
    let code = selftest_run(&mut report);
    report.flush();
    code
}

/// Where the self-check's own output goes.
///
/// The release build is a GUI-subsystem binary on Windows
/// (`windows_subsystem = "windows"`), so when it is started from a command
/// prompt it has no console and `println!` is discarded -- the first run of this
/// check printed nothing at all. Every line is therefore collected and written
/// BOTH to stdout (which works wherever a console or a redirect exists) and to a
/// file, whose path is fixed so it can be opened without having seen any output.
struct Report {
    lines: Vec<String>,
}

impl Report {
    fn new() -> Self {
        #[cfg(windows)]
        {
            // Borrow the console of whatever started us, so a GUI-subsystem
            // build can still print into an interactive terminal. Harmless when
            // stdout is already a pipe: this attaches a console, it does not
            // reassign the standard handles.
            extern "system" {
                fn AttachConsole(process_id: u32) -> i32;
            }
            const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
            unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
        }
        Self { lines: Vec::new() }
    }

    fn say(&mut self, line: String) {
        println!("{line}");
        self.lines.push(line);
    }

    /// The file the report is also written to.
    fn path() -> std::path::PathBuf {
        std::env::temp_dir().join("skillkeeper-askpass-selftest.log")
    }

    fn flush(&self) {
        let body = format!("{}\n", self.lines.join("\n"));
        let path = Self::path();
        match std::fs::write(&path, body) {
            Ok(()) => println!("report written to {}", path.display()),
            Err(e) => println!("could not write {}: {e}", path.display()),
        }
    }
}

fn selftest_run(report: &mut Report) -> i32 {
    const SECRET: &str = "selftest-passphrase";
    let server = match AskpassServer::start(Arc::new(|| Some(SECRET.to_string()))) {
        Ok(server) => server,
        Err(e) => {
            report.say(format!("FAIL: the askpass server did not start: {e}"));
            return 1;
        }
    };
    report.say(format!("ok: server listening on {}", server.endpoint()));

    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            report.say(format!("FAIL: cannot find this executable's own path: {e}"));
            return 1;
        }
    };
    report.say(format!("ok: helper is {}", exe.display()));

    let token = server.mint_token();
    let output = std::process::Command::new(&exe)
        .arg("Enter passphrase for key 'selftest': ")
        .env(ASKPASS_ENDPOINT_ENV, server.endpoint())
        .env(ASKPASS_TOKEN_ENV, &token)
        .output();
    let output = match output {
        Ok(output) => output,
        Err(e) => {
            report.say(format!("FAIL: cannot run the helper: {e}"));
            return 1;
        }
    };
    let printed = String::from_utf8_lossy(&output.stdout);
    let answer = printed.trim_end_matches(['\n', '\r']);
    if answer == SECRET {
        report.say("PASS: the helper answered the prompt from memory".to_string());
        return 0;
    }
    report.say("FAIL: the helper did not answer with the held secret".to_string());
    report.say(format!("  exit status : {:?}", output.status.code()));
    report.say(format!("  stdout      : {printed:?}"));
    println!(
        "  stderr      : {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    if answer.is_empty() {
        report.say("  nothing was printed: either the helper never reached the".to_string());
        report.say("  server (endpoint or token), or this binary cannot write to a".to_string());
        report.say("  captured stdout (a GUI-subsystem build on Windows).".to_string());
    }
    1
}

/// Why the server did not answer a request it received.
///
/// Recorded so an operation that then fails can say which of these happened
/// instead of leaving the user with `Permission denied (publickey)`, which is
/// what `ssh` reports for a helper that answered nothing AND for a key the host
/// rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The token presented was minted here and then RETIRED before the request
    /// arrived. Which of the two ways it retired is the whole diagnosis, so it
    /// is carried rather than flattened: `Expired` means the invocation never
    /// reached `ssh` within the TTL, `Revoked` means the request came from a
    /// process that outlived the invocation it belonged to.
    RetiredToken(RetiredReason),
    /// The token presented was never minted by this server at all -- a stale
    /// environment from an earlier run of the app, or another process entirely.
    UnknownToken,
    /// The prompt was not a passphrase prompt -- an unknown host key, or a
    /// server-supplied keyboard-interactive question. Carries the prompt text,
    /// which is what tells the user what to confirm in the terminal.
    NotAPassphrase(String),
    /// A live token asked for a passphrase the store no longer holds: the key
    /// was unlocked when the invocation started and is not now.
    NoPassphraseHeld,
}

/// How a token that this server did mint stopped being live.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetiredReason {
    /// Minted, never used, and the TTL elapsed: the invocation it was minted
    /// for never got as far as asking `ssh` for anything.
    Expired,
    /// Retired with its invocation, whose git subprocess had exited. A request
    /// presenting it therefore comes from something that outlived that
    /// invocation -- an `ssh` still finishing after git was killed, say.
    Revoked,
}

/// How many retired tokens are remembered, so a refusal can say which way the
/// token went. Small on purpose: only the most recent invocations can plausibly
/// be the source of a late request, and this is a diagnostic, not a ledger.
const RETIRED_MEMORY: usize = 16;

/// Bookkeeping for one minted token: when it was minted, and whether it has
/// ever answered a live request.
///
/// A token's lifetime is one git invocation, not one prompt: an LFS clone's
/// smudge filter opens its own `ssh`, which asks again with the same token,
/// so the token must go on answering after its first use. `used` is what lets
/// [`prune_expired`] tell an abandoned token (never used, subject to the TTL)
/// from a working one (used at least once, exempt from the TTL, retired only
/// by an explicit [`AskpassServer::revoke_token`] call once its invocation's
/// git subprocess has exited).
struct TokenState {
    minted: Instant,
    used: bool,
}

/// Server side of the askpass transport: one local socket, one accept-loop
/// thread for the process's lifetime that hands each connection off to its
/// own short-lived thread. Tokens live for one git invocation (see
/// [`TokenState`]), each with a TTL backstop against an invocation that never
/// actually asks.
pub struct AskpassServer {
    endpoint: String,
    tokens: Arc<Mutex<HashMap<String, TokenState>>>,
    /// The last few tokens this server retired and how, oldest first, so a
    /// request presenting one can be told apart from a request presenting a
    /// token that was never ours.
    retired: Arc<Mutex<Vec<(String, RetiredReason)>>>,
    refusal: Arc<Mutex<Option<Refusal>>>,
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
        let tokens: Arc<Mutex<HashMap<String, TokenState>>> = Arc::new(Mutex::new(HashMap::new()));
        let refusal: Arc<Mutex<Option<Refusal>>> = Arc::new(Mutex::new(None));
        let retired: Arc<Mutex<Vec<(String, RetiredReason)>>> = Arc::new(Mutex::new(Vec::new()));

        let accept_tokens = Arc::clone(&tokens);
        let accept_retired = Arc::clone(&retired);
        let accept_refusal = Arc::clone(&refusal);
        std::thread::spawn(move || {
            for connection in listener.incoming() {
                let Ok(stream) = connection else {
                    continue;
                };
                let tokens = Arc::clone(&accept_tokens);
                let retired = Arc::clone(&accept_retired);
                let refusal = Arc::clone(&accept_refusal);
                let secret = Arc::clone(&secret);
                std::thread::spawn(move || {
                    handle_connection(stream, &tokens, &retired, &refusal, &secret);
                });
            }
        });

        Ok(Self {
            endpoint,
            tokens,
            retired,
            refusal,
            _socket_dir: socket_dir,
        })
    }

    /// The local-socket name a helper connects to (see [`ASKPASS_ENDPOINT_ENV`]).
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Mint a fresh token for one git invocation, valid for [`TOKEN_TTL`]
    /// until it is first used.
    pub fn mint_token(&self) -> String {
        let mut tokens = self.tokens.lock().unwrap();
        prune_expired(&mut tokens, &self.retired);
        let token = uuid::Uuid::new_v4().to_string();
        tokens.insert(
            token.clone(),
            TokenState {
                minted: Instant::now(),
                used: false,
            },
        );
        token
    }

    /// Explicitly invalidate `token`, whether or not it was ever used.
    ///
    /// The lease that owns a token (`app::ssh_git::GitEnvLease`) calls this
    /// once its git invocation's subprocess has exited -- on every exit path,
    /// including an error or the silence-timeout kill -- so a token never
    /// outlives the one invocation it was minted for and can never answer a
    /// later, unrelated one.
    pub fn revoke_token(&self, token: &str) {
        if self.tokens.lock().unwrap().remove(token).is_some() {
            remember_retired(&self.retired, token, RetiredReason::Revoked);
        }
    }

    /// Why the server last refused to answer a request, if it did. Reading it
    /// clears it, so a later failure is not misattributed to an earlier refusal.
    ///
    /// This is the only account of a refusal there is. `ssh` reports a helper
    /// that answered nothing exactly as it reports a key the host rejected --
    /// `Permission denied (publickey)`, no mention of askpass -- so without this
    /// the two are indistinguishable from the outside, which is precisely the
    /// confusion it exists to end.
    pub fn take_refusal(&self) -> Option<Refusal> {
        self.refusal.lock().unwrap().take()
    }
}

/// Drop tokens that were minted and never used, once [`TOKEN_TTL`] has
/// elapsed.
///
/// A token that HAS answered at least one prompt is exempt from this sweep:
/// it is meant to live for the whole git invocation it was minted for (which
/// may run for many minutes and open more than one `ssh` connection -- an
/// LFS clone's smudge filter runs its own), and is retired only by an
/// explicit [`AskpassServer::revoke_token`] call. The TTL here is only the
/// backstop for a token that was minted and then abandoned -- the invocation
/// never actually reached `ssh`, or crashed before it could.
fn prune_expired(
    tokens: &mut HashMap<String, TokenState>,
    retired: &Mutex<Vec<(String, RetiredReason)>>,
) {
    let now = Instant::now();
    tokens.retain(|token, state| {
        let live = state.used || now.duration_since(state.minted) < TOKEN_TTL;
        if !live {
            remember_retired(retired, token, RetiredReason::Expired);
        }
        live
    });
}

/// Note that `token` is no longer live and why, keeping only the most recent
/// [`RETIRED_MEMORY`] entries: a request presenting a token from further back
/// than that is indistinguishable from one that was never ours, and saying so is
/// honest.
fn remember_retired(
    retired: &Mutex<Vec<(String, RetiredReason)>>,
    token: &str,
    reason: RetiredReason,
) {
    let mut retired = retired.lock().unwrap();
    retired.push((token.to_string(), reason));
    if retired.len() > RETIRED_MEMORY {
        let excess = retired.len() - RETIRED_MEMORY;
        retired.drain(..excess);
    }
}

/// How `token` was retired, if this server remembers retiring it.
fn retired_reason(
    retired: &Mutex<Vec<(String, RetiredReason)>>,
    token: &str,
) -> Option<RetiredReason> {
    retired
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|(known, _)| known == token)
        .map(|(_, reason)| *reason)
}

/// Handle one connection (on its own thread -- see [`AskpassServer::start`]):
/// read one `GET <token> <prompt...>` line and, when the token is live, the
/// prompt is a passphrase prompt, and a secret is held, write
/// `<passphrase>\n` back. Otherwise close without writing.
///
/// A live token is marked used but NOT removed here: it stays valid for
/// repeated reads -- covering an invocation that opens more than one `ssh` --
/// until its owner explicitly calls [`AskpassServer::revoke_token`], or (if
/// it was never used at all) its TTL backstop elapses.
fn handle_connection(
    mut stream: Stream,
    tokens: &Mutex<HashMap<String, TokenState>>,
    retired: &Mutex<Vec<(String, RetiredReason)>>,
    refusal: &Mutex<Option<Refusal>>,
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
        prune_expired(&mut tokens, retired);
        match tokens.get_mut(token) {
            Some(state) => {
                state.used = true;
                true
            }
            None => false,
        }
    };
    if !is_live {
        // Refused -- and that refusal is the whole explanation for the
        // authentication failure `ssh` is about to report, so record which kind
        // it is: a token this server retired (and how), or one it never minted.
        *refusal.lock().unwrap() = Some(match retired_reason(retired, token) {
            Some(reason) => Refusal::RetiredToken(reason),
            None => Refusal::UnknownToken,
        });
        return;
    }

    if !is_passphrase_prompt(prompt) {
        *refusal.lock().unwrap() = Some(Refusal::NotAPassphrase(prompt.to_string()));
        return;
    }

    let Some(passphrase) = secret() else {
        // The key was unlocked when the invocation started and is not now
        // (Forget passphrase, or the chosen key changed under it).
        *refusal.lock().unwrap() = Some(Refusal::NoPassphraseHeld);
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
impl AskpassServer {
    /// Test-only entry point for `app::ssh_git`'s own tests, which need to
    /// prove that dropping its `GitEnvLease` revokes the token it minted --
    /// without duplicating the wire protocol outside this module. Just
    /// `fetch`, exposed crate-internally.
    pub(crate) fn debug_fetch(endpoint: &str, token: &str, prompt: &str) -> Option<String> {
        fetch(endpoint, token, prompt)
    }

    /// Make a minted-but-never-used token look expired, without an actual
    /// multi-minute sleep, so the TTL backstop can be exercised directly.
    fn force_stale_for_test(&self, token: &str) {
        let mut tokens = self.tokens.lock().unwrap();
        if let Some(state) = tokens.get_mut(token) {
            state.minted = Instant::now() - TOKEN_TTL - Duration::from_secs(1);
        }
    }
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
    fn a_token_read_twice_still_answers_the_second_time() {
        // A token's lifetime is one git invocation, not one prompt: an LFS
        // clone's smudge filter opens its own `ssh`, which presents the same
        // token again, so a second live read must still get an answer.
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase for \"k\": "),
            Some("topsecret".to_string())
        );
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase for \"k\": "),
            Some("topsecret".to_string()),
            "a token stays valid across repeated reads until revoked"
        );
    }

    #[test]
    fn a_revoked_token_stops_answering() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase: "),
            Some("topsecret".to_string())
        );
        server.revoke_token(&token);
        assert_eq!(fetch(server.endpoint(), &token, "Enter passphrase: "), None);
    }

    #[test]
    fn an_unused_token_still_expires_on_the_ttl() {
        // The TTL is only the backstop for a token minted and then abandoned
        // (the invocation never reached ssh); a used token is exempt (see the
        // read-twice test above), so this must mint one and never read it.
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();
        server.force_stale_for_test(&token);
        assert_eq!(fetch(server.endpoint(), &token, "Enter passphrase: "), None);
    }

    /// Pins the other half of the exemption rule: once a token HAS answered
    /// a live read, backdating it past the TTL must have no effect at all --
    /// only an explicit `revoke_token` call retires it from then on.
    #[test]
    fn a_used_token_survives_past_the_ttl() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        let token = server.mint_token();
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase: "),
            Some("topsecret".to_string())
        );
        server.force_stale_for_test(&token);
        assert_eq!(
            fetch(server.endpoint(), &token, "Enter passphrase: "),
            Some("topsecret".to_string()),
            "a used token is exempt from the TTL; only revoke_token retires it"
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
        let Some(Refusal::NotAPassphrase(prompt)) = server.take_refusal() else {
            panic!("the declined prompt must be recorded, with its text");
        };
        assert!(prompt.contains("continue connecting"));
        // Reading it clears it, so a later failure is not misattributed.
        assert!(server.take_refusal().is_none());
    }

    /// A token this server never minted: a leftover environment from an earlier
    /// run of the app, and nothing this session can explain further.
    #[test]
    fn an_unknown_token_is_recorded_as_the_reason() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");
        assert_eq!(
            fetch(server.endpoint(), "not-a-token", "Enter passphrase: "),
            None
        );
        assert_eq!(server.take_refusal(), Some(Refusal::UnknownToken));
    }

    /// The two refusals that look identical from `ssh`'s side and mean quite
    /// different things on ours: a token retired WITH its invocation (so the
    /// request came from something that outlived it) versus one that expired
    /// unused (so the invocation never reached `ssh` in time). Telling them
    /// apart is the whole point of remembering retired tokens.
    #[test]
    fn a_retired_token_is_recorded_with_the_way_it_retired() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");

        let revoked = server.mint_token();
        server.revoke_token(&revoked);
        assert_eq!(
            fetch(server.endpoint(), &revoked, "Enter passphrase: "),
            None
        );
        assert_eq!(
            server.take_refusal(),
            Some(Refusal::RetiredToken(RetiredReason::Revoked))
        );

        let abandoned = server.mint_token();
        server.force_stale_for_test(&abandoned);
        // Minting sweeps the expired one out, which is where it is recorded.
        let _ = server.mint_token();
        assert_eq!(
            fetch(server.endpoint(), &abandoned, "Enter passphrase: "),
            None
        );
        assert_eq!(
            server.take_refusal(),
            Some(Refusal::RetiredToken(RetiredReason::Expired))
        );
    }

    #[test]
    fn no_secret_held_means_no_answer() {
        let server = AskpassServer::start(Arc::new(|| None)).expect("server");
        let token = server.mint_token();
        assert_eq!(fetch(server.endpoint(), &token, "Enter passphrase: "), None);
        // A live token that could not be answered is a refusal of its own: the
        // key was unlocked when the invocation started and is not now.
        assert_eq!(server.take_refusal(), Some(Refusal::NoPassphraseHeld));
    }

    #[test]
    fn an_oversized_request_gets_no_answer_instead_of_hanging() {
        let server =
            AskpassServer::start(Arc::new(|| Some("topsecret".to_string()))).expect("server");

        let mut stream = connect(server.endpoint()).expect("connect");
        // No trailing newline: without a cap on the read, `read_line` would
        // keep growing its buffer waiting for a newline that never comes.
        // This deliberately writes more than MAX_REQUEST_BYTES, so the server
        // is entitled to stop reading and close the connection as soon as its
        // bounded read hits the cap -- possibly before this write finishes
        // landing. Under contention that surfaces here as BrokenPipe (or,
        // depending on the platform/timing, ConnectionReset) on our own
        // write: that is a valid outcome of the very behaviour under test,
        // not a bug in the test, so it must not panic. Anything else is
        // unexpected and still fails the test.
        let oversized = "x".repeat(MAX_REQUEST_BYTES as usize * 2);
        match stream.write_all(oversized.as_bytes()) {
            Ok(()) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset
                ) => {}
            Err(e) => panic!("unexpected write error: {e}"),
        }

        // Do the read on another thread with a bounded wait so that, if the
        // cap regresses, this test fails instead of hanging the whole suite.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut response = String::new();
            let read = BufReader::new(&mut stream)
                .read_line(&mut response)
                .map_err(|e| e.kind());
            let _ = tx.send((read, response));
        });
        let (read, response) = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the bounded read must finish, not hang");
        // The property is "no answer", not the mechanism by which the peer went
        // away. A server that closes on an oversized request leaves the client
        // with a clean end of stream on some platforms and a reset on others:
        // Linux resets when it closes while our unread bytes are still queued,
        // macOS reports the clean end. Both are silence. Only bytes coming back
        // would be a leaked passphrase, and only a stall would be a missing cap.
        match read {
            Ok(0) => {}
            Err(std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe) => {}
            Ok(n) => panic!("oversized request was answered with {n} bytes: {response:?}"),
            Err(kind) => panic!("unexpected read error: {kind:?}"),
        }
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
    fn a_dead_endpoint_gives_up_instead_of_waiting() {
        // The bug this guards: `fetch` has no timeout of its own, and on Windows
        // a named-pipe connect blocks waiting for an instance -- so a helper
        // whose server is gone waited forever, `ssh` waited on the helper, git
        // waited on `ssh`, and the operation hung with nothing printed and no
        // prompt to answer.
        let started = Instant::now();
        let answer = fetch_bounded(
            "sk-askpass-nothing-is-listening-here",
            "token",
            "Enter passphrase for key 'k': ",
            Duration::from_millis(300),
        );
        assert_eq!(answer, None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "gave up after {:?}, so the wait is not bounded",
            started.elapsed()
        );
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
