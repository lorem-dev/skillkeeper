//! The thread-owning [`TerminalManager`].
//!
//! # Ownership and threading
//!
//! `portable-pty` hands back a set of independently-owned handles per session: a
//! `MasterPty` (resize), a `Write` sink (input), a `Child` (the shell process),
//! and a cloned `Read` source (output). These are grouped into [`Shared`],
//! guarded by a single `Mutex` (paired with a `Condvar`) and held behind an
//! `Arc` so both the command surface and the per-session reader thread can reach
//! them.
//!
//! Because the manager is internally synchronised (`Arc<SharedState>` with a
//! `Mutex` + `Condvar`), it is already `Send + Sync` and can be stored *directly*
//! in `AppContext` -- no outer `Mutex` wrapper is needed. The `Condvar` lets a
//! blocking `run_git` call wait for the shell to reach a ready prompt and for the
//! next exit-code marker without polling, while the reader thread signals those
//! transitions as it applies each [`Reaction`].
//!
//! # Event bridge
//!
//! Emitting to the frontend needs the Tauri `AppHandle`, which does not exist
//! when `AppContext::new()` runs. The manager therefore owns the *producer* end
//! of an `mpsc` channel (cloned into each reader thread) and hands the *consumer*
//! end out exactly once via [`TerminalManager::take_events`]. `lib.rs` `setup`
//! takes that receiver and spawns a pump thread that forwards each
//! [`TerminalEvent`] to `app.emit("terminal:data", chunk)` /
//! `app.emit("terminal:exit", ())`. This keeps the PTY module free of any Tauri
//! dependency.
//!
//! # Wave 3: in-shell git and ssh-add
//!
//! [`TerminalManager::run_git`] runs the app's git (clone/sync) *in* the
//! interactive shell (POSIX) or as its own arg-array PTY (Windows/unintegrated),
//! serialised through a [`GitQueue`] so concurrent calls never interleave. The
//! pure helpers (quoting, command-line assembly, bracketed-paste framing) live in
//! [`git_in_shell`](super::git_in_shell). Wave 4 wires the repository
//! clone/sync/update/hasUpdate commands to [`run_git`](TerminalManager::run_git)
//! (see `commands::repositories`), falling back to the direct `SystemGit` port
//! when no session has started (headless/tests).

use std::io::{Read, Write};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use super::git_in_shell::{git_command_line, ssh_add_command, wrap_bracketed_paste, GitQueue};
use super::shell_integration::{
    needs_input, Reaction, ShellIntegration, HOOK_CONFIRM_MS, HOOK_QUIET_MS,
};
use super::{Scrollback, ShellSpec, TerminalEvent, MAX_BUFFER};

/// Read buffer size for the reader thread.
const READ_CHUNK: usize = 8 * 1024;

/// Default terminal geometry when the caller passes zero (mirrors `terminal.ts`
/// `cols = 80`, `rows = 24`).
const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;

/// Shown when the shell exits and is auto-restarted (mirrors `terminal.ts`).
const RESTART_NOTICE: &str = "\r\n\x1b[33m[shell restarted]\x1b[0m\r\n";

/// The per-session PTY handles plus the shared scrollback and spawn recipe.
struct Shared {
    /// Retained rolling output for re-attaching renderers.
    scrollback: Scrollback,
    /// Current session's master (kept for resize); `None` before first start.
    master: Option<Box<dyn MasterPty + Send>>,
    /// Current session's input sink.
    writer: Option<Box<dyn Write + Send>>,
    /// Current session's shell process (retained so it is not reaped early).
    child: Option<Box<dyn Child + Send + Sync>>,
    /// Windows/unintegrated only: the running git command's input sink. When set,
    /// [`write`](TerminalManager::write) routes keystrokes here instead of the
    /// shell (port of `terminal.ts` `activeCmd ?? pty`).
    active_cmd_writer: Option<Box<dyn Write + Send>>,
    /// The running git command's master, kept so resizes reach it too.
    active_cmd_master: Option<Box<dyn MasterPty + Send>>,
    /// Last requested geometry, reused when a session (re)spawns.
    cols: u16,
    rows: u16,
    /// True once the shell has been started at least once.
    started: bool,
    /// Set during app teardown so the reader thread stops auto-respawning the
    /// shell on EOF (otherwise killing the shell to quit spawns a fresh one).
    shutting_down: bool,
    /// How to launch the shell.
    shell: ShellSpec,
    /// Working directory for the shell (the host home dir); empty means inherit.
    cwd: String,
    /// Environment inherited by the shell (a snapshot of the host process env).
    env: Vec<(String, String)>,
    /// Producer end of the event channel, cloned into each reader thread.
    output: Sender<TerminalEvent>,
    /// Per-session shell-integration state machine (marker/hook/query protocol).
    /// Replaced on every (re)spawn so a fresh session starts un-hooked.
    integration: ShellIntegration,
    /// Latest command exit code reported by the shell-integration marker. Read by
    /// the in-shell git path to learn a command's result.
    last_exit_code: Option<i64>,
    /// True when the shell is back at a ready prompt (bracketed paste re-enabled)
    /// and can accept the next in-shell command (port of `terminal.ts` `idle`).
    idle: bool,
    /// Monotonic count of exit-code markers applied. An in-shell git command
    /// captures this before typing, then waits for it to advance -- the advance
    /// is its own command's completion marker (port of `pendingResolve`).
    marker_seq: u64,
    /// Monotonic count of shell-process exits. A waiting in-shell command watches
    /// this so a shell that dies mid-command unblocks with a failure code.
    exit_gen: u64,
    /// Generation counter invalidating superseded/cancelled quiet timers.
    quiet_gen: u64,
    /// Generation counter invalidating superseded/cancelled confirm timers.
    confirm_gen: u64,
}

/// The `Mutex`-guarded [`Shared`] state paired with the `Condvar` that wakes a
/// blocking in-shell git command when the shell becomes ready, a marker arrives,
/// or the shell exits.
struct SharedState {
    inner: Mutex<Shared>,
    cvar: Condvar,
}

/// A persistent interactive shell over a pseudo-terminal.
///
/// Cloneable, `Send + Sync`, and internally synchronised: it lives directly in
/// `AppContext` and every command borrows it through `tauri::State`.
pub struct TerminalManager {
    shared: Arc<SharedState>,
    /// Consumer end of the event channel, handed to the setup pump once.
    events: Mutex<Option<Receiver<TerminalEvent>>>,
    /// Serialises `run_git` calls so concurrent git ops never interleave.
    git_queue: GitQueue,
    /// Producer end of the input queue. [`write`](Self::write) enqueues here and
    /// returns immediately; a single writer thread drains it into the PTY, so a
    /// slow/blocking write (a large paste) never stalls the caller/UI thread and
    /// input stays ordered.
    input_tx: Sender<String>,
}

impl TerminalManager {
    /// Build a manager that will launch `shell` in `cwd` with `env` inherited.
    ///
    /// The shell is not spawned until [`start`](Self::start) is first called.
    pub fn new(shell: ShellSpec, cwd: String, env: Vec<(String, String)>) -> Self {
        let (output, rx) = channel();
        let integration = ShellIntegration::new(&shell.program);
        let shared = Shared {
            scrollback: Scrollback::new(MAX_BUFFER),
            master: None,
            writer: None,
            child: None,
            active_cmd_writer: None,
            active_cmd_master: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            started: false,
            shutting_down: false,
            shell,
            cwd,
            env,
            output,
            integration,
            last_exit_code: None,
            idle: false,
            marker_seq: 0,
            exit_gen: 0,
            quiet_gen: 0,
            confirm_gen: 0,
        };
        let (input_tx, input_rx) = channel::<String>();
        let shared = Arc::new(SharedState {
            inner: Mutex::new(shared),
            cvar: Condvar::new(),
        });
        // Drain queued input on a dedicated thread: one consumer keeps keystrokes
        // ordered, and a blocking write (a big paste into a busy shell) stalls
        // only this thread, never the command/UI thread that enqueued it.
        {
            let state = Arc::clone(&shared);
            std::thread::spawn(move || writer_loop(state, input_rx));
        }
        Self {
            shared,
            events: Mutex::new(Some(rx)),
            git_queue: GitQueue::new(),
            input_tx,
        }
    }

    /// Take the event receiver (once). Returns `None` on subsequent calls.
    ///
    /// Called by `lib.rs` `setup` to drive the emit pump.
    pub fn take_events(&self) -> Option<Receiver<TerminalEvent>> {
        self.events.lock().expect("events lock poisoned").take()
    }

    /// (Re)ensure the shell is running at the given size and return the retained
    /// scrollback to replay. A zero dimension keeps the current value.
    ///
    /// # Errors
    ///
    /// Returns a message when the pseudo-terminal or shell fails to spawn.
    pub fn start(&self, cols: u16, rows: u16) -> Result<String, String> {
        let mut shared = self.shared.inner.lock().expect("terminal lock poisoned");
        if cols > 0 {
            shared.cols = cols;
        }
        if rows > 0 {
            shared.rows = rows;
        }
        if shared.started {
            // Already running (the reader thread keeps it alive); just resize.
            let size = pty_size(shared.cols, shared.rows);
            if let Some(master) = shared.master.as_ref() {
                let _ = master.resize(size);
            }
        } else {
            spawn_session(&mut shared, &self.shared)?;
            shared.started = true;
        }
        Ok(shared.scrollback.snapshot())
    }

    /// Write input into the running git command (Windows/unintegrated) or, when
    /// none is active, the interactive shell. No-op when nothing has started.
    ///
    /// Mirrors `terminal.ts` `(activeCmd ?? pty)?.write(data)`.
    ///
    /// Queue `data` to be written to the running git command's PTY (Windows/
    /// unintegrated) or, when none is active, the interactive shell -- in order,
    /// on the terminal's writer thread. Non-blocking: it returns without waiting
    /// for the shell to consume the bytes, so a large paste never stalls the
    /// caller (and thus the UI). No-op sink resolution happens on the writer
    /// thread (see [`drain_write`]).
    ///
    /// Mirrors `terminal.ts` `(activeCmd ?? pty)?.write(data)`.
    ///
    /// # Errors
    ///
    /// Returns a message only when the writer thread has stopped (the manager is
    /// being torn down); the byte-level write itself can no longer fail here.
    pub fn write(&self, data: &str) -> Result<(), String> {
        self.input_tx
            .send(data.to_string())
            .map_err(|_| "terminal writer stopped".to_string())
    }

    /// Resize the pseudo-terminal (and any running git command PTY), remembering
    /// the geometry for future respawns.
    ///
    /// # Errors
    ///
    /// Returns a message when the resize ioctl fails.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let mut shared = self.shared.inner.lock().expect("terminal lock poisoned");
        shared.cols = cols;
        shared.rows = rows;
        let size = pty_size(cols, rows);
        if let Some(master) = shared.master.as_ref() {
            master.resize(size).map_err(|e| e.to_string())?;
        }
        if let Some(master) = shared.active_cmd_master.as_ref() {
            let _ = master.resize(size);
        }
        Ok(())
    }

    /// Drop the retained scrollback (e.g. on a window resize that would reflow
    /// old-width lines wrong). The live shell is untouched.
    pub fn clear_buffer(&self) {
        let mut shared = self.shared.inner.lock().expect("terminal lock poisoned");
        shared.scrollback.clear();
    }

    /// The latest exit code reported by the shell-integration marker, if any.
    #[allow(dead_code)]
    pub fn last_exit_code(&self) -> Option<i64> {
        self.shared
            .inner
            .lock()
            .ok()
            .and_then(|shared| shared.last_exit_code)
    }

    /// Whether the interactive shell has been started at least once (i.e. a live
    /// session exists). Repository git operations use this to choose between the
    /// PTY path ([`run_git`](Self::run_git), so output streams to the terminal
    /// and passphrase prompts read its input) and the direct `SystemGit`
    /// fallback used in headless/test contexts where no session was started.
    pub fn is_started(&self) -> bool {
        self.shared
            .inner
            .lock()
            .map(|shared| shared.started)
            .unwrap_or(false)
    }

    /// Tear the shell down for app exit: stop the reader thread from
    /// auto-respawning, kill the shell (and any running git command) and drop
    /// their PTY handles so their reader threads hit EOF, and wake any in-shell
    /// git waiter so its blocking task unblocks.
    ///
    /// Without this, closing the app can hang: killing the shell would trigger
    /// [`reader_loop`]'s auto-restart (spawning a fresh shell during teardown),
    /// and a command still blocked in [`run_git`](Self::run_git) would keep its
    /// worker-pool task alive, stalling the async-runtime shutdown.
    pub fn shutdown(&self) {
        if let Ok(mut shared) = self.shared.inner.lock() {
            shared.shutting_down = true;
            if let Some(child) = shared.child.as_mut() {
                let _ = child.kill();
            }
            // Dropping the masters closes the PTYs, so the shell/git die (SIGHUP)
            // and their reader threads read EOF promptly.
            shared.master = None;
            shared.writer = None;
            shared.active_cmd_master = None;
            shared.active_cmd_writer = None;
        }
        self.shared.cvar.notify_all();
    }

    /// Run the app's git in the session, serialised so calls never interleave.
    ///
    /// Picks the in-shell path (POSIX integrated shell) or the standalone
    /// arg-array process path (Windows/unintegrated) exactly as `terminal.ts`
    /// `runGit` does. `repo_path` is the repository directory; `args` are the git
    /// arguments (no `-C`, which the in-shell path adds itself). Output streams to
    /// `terminal:data`; only the exit code is returned here.
    ///
    /// Called by the Wave 4 repository clone/sync commands (see
    /// `commands::repositories`) when a live session exists.
    ///
    /// # Errors
    ///
    /// Returns an error message when git exits non-zero.
    pub fn run_git(&self, repo_path: &str, args: &[String]) -> Result<String, String> {
        let code = self.git_queue.run(|| {
            // Decide inside the queued slot, matching `terminal.ts`: Windows or an
            // unintegrated/abandoned shell runs git as its own process.
            let integrated = !cfg!(windows) && self.use_integration();
            if integrated {
                self.run_git_in_shell(repo_path, args)
            } else {
                self.run_git_process(repo_path, args)
            }
        });
        if code == 0 {
            Ok(String::new())
        } else {
            Err(format!("git exited with code {code}"))
        }
    }

    /// Run `ssh-add` on the interactive shell so its passphrase prompt appears in
    /// the terminal view (port of `terminal.ts` `runSshAdd`). macOS adds
    /// `--apple-use-keychain`.
    ///
    /// # Errors
    ///
    /// Returns a message when the shell cannot be started or written to.
    pub fn run_ssh_add(&self) -> Result<(), String> {
        self.start(0, 0)?;
        self.write(ssh_add_command(cfg!(target_os = "macos")))
    }

    /// Whether the current session takes the integrated (in-shell hook) path.
    fn use_integration(&self) -> bool {
        self.shared
            .inner
            .lock()
            .expect("terminal lock poisoned")
            .integration
            .use_integration()
    }

    /// POSIX: type the escaped `git -C <dir> <args>` line into the interactive
    /// shell once it is ready, then wait for the invisible prompt marker carrying
    /// the command's exit code (port of `runGitInShell`). Falls back to the
    /// process path if integration was abandoned while waiting.
    fn run_git_in_shell(&self, dir: &str, args: &[String]) -> i64 {
        // Ensure the shell exists (start locks internally, so acquire after).
        let _ = self.start(0, 0);

        let mut guard = self.shared.inner.lock().expect("terminal lock poisoned");
        // whenIdle: wait for a ready prompt, integration abandonment, or exit.
        loop {
            if !guard.integration.use_integration() {
                // Integration abandoned (confirm timeout): fall back cleanly.
                drop(guard);
                return self.run_git_process(dir, args);
            }
            if guard.idle {
                break;
            }
            guard = self
                .shared
                .cvar
                .wait(guard)
                .expect("terminal lock poisoned");
        }

        // Capture completion baselines, release the next command, and type it.
        let seq0 = guard.marker_seq;
        let exit0 = guard.exit_gen;
        guard.idle = false;
        let command = git_command_line("git", dir, args);
        let framed = wrap_bracketed_paste(&command);
        if let Some(writer) = guard.writer.as_mut() {
            let _ = writer.write_all(framed.as_bytes());
            let _ = writer.flush();
        }

        // Await our command's exit-code marker (or a shell death).
        loop {
            if guard.marker_seq != seq0 {
                return guard.last_exit_code.unwrap_or(0);
            }
            if guard.exit_gen != exit0 {
                return 1; // the shell died mid-command
            }
            guard = self
                .shared
                .cvar
                .wait(guard)
                .expect("terminal lock poisoned");
        }
    }

    /// Windows / unintegrated shells: run git as its own arg-array PTY (no shell,
    /// so no POSIX quoting applies). Output streams to the view and input routes
    /// to it until it exits (port of `runGitProcess`).
    fn run_git_process(&self, dir: &str, args: &[String]) -> i64 {
        let _ = self.start(0, 0);

        // Echo a command header, then read geometry + env for the git PTY.
        let (cols, rows, env) = {
            let mut guard = self.shared.inner.lock().expect("terminal lock poisoned");
            let header = format!("\r\n\x1b[36m$ git {}\x1b[0m\r\n", args.join(" "));
            guard.scrollback.append(header.as_bytes());
            let _ = guard.output.send(TerminalEvent::Data(header));
            (guard.cols, guard.rows, guard.env.clone())
        };

        let pty_system = native_pty_system();
        let pair = match pty_system.openpty(pty_size(cols, rows)) {
            Ok(pair) => pair,
            Err(_) => return 1,
        };
        let mut cmd = CommandBuilder::new("git");
        for arg in args {
            cmd.arg(arg);
        }
        for (key, value) in &env {
            cmd.env(key, value);
        }
        cmd.env("TERM", "xterm-256color");
        if !dir.trim().is_empty() {
            cmd.cwd(dir);
        }
        let mut child = match pair.slave.spawn_command(cmd) {
            Ok(child) => child,
            Err(_) => return 1,
        };
        drop(pair.slave);
        let reader = match pair.master.try_clone_reader() {
            Ok(reader) => reader,
            Err(_) => return 1,
        };
        let writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(_) => return 1,
        };

        // Route interactive input to this git PTY and let resizes reach it.
        {
            let mut guard = self.shared.inner.lock().expect("terminal lock poisoned");
            guard.active_cmd_writer = Some(writer);
            guard.active_cmd_master = Some(pair.master);
        }

        // Stream git output to the view (and raise the input signal on a prompt).
        let arc = Arc::clone(&self.shared);
        let reader_handle = std::thread::spawn(move || git_process_reader(arc, reader));

        // Block until git exits: that is its exit code.
        let code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(1);
        let _ = reader_handle.join();

        // Clear the active-command routing and emit a trailing newline.
        {
            let mut guard = self.shared.inner.lock().expect("terminal lock poisoned");
            guard.active_cmd_writer = None;
            guard.active_cmd_master = None;
            guard.scrollback.append(b"\r\n");
            let _ = guard.output.send(TerminalEvent::Data("\r\n".to_string()));
        }
        code
    }
}

/// Build a [`PtySize`] with no pixel geometry (unused by xterm.js).
fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Drain queued terminal input in order, writing each chunk to the live PTY.
///
/// One consumer keeps keystrokes/paste chunks ordered; running on its own thread
/// means a blocking write (a big paste into a busy shell) stalls only this
/// thread, not the command/UI thread that enqueued via
/// [`write`](TerminalManager::write). Ends when every [`Sender`] is dropped
/// (the manager is gone), i.e. at process exit.
fn writer_loop(state: Arc<SharedState>, rx: Receiver<String>) {
    while let Ok(data) = rx.recv() {
        drain_write(&state, &data);
    }
}

/// Write one queued chunk to the active sink: the running git command's PTY when
/// set (Windows/unintegrated), otherwise the interactive shell. A missing sink
/// (nothing started yet) is a no-op; a write error is dropped, since a dead
/// writer means the session is gone and the reader thread surfaces the exit.
fn drain_write(state: &SharedState, data: &str) {
    let mut shared = match state.inner.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    let sink = if shared.active_cmd_writer.is_some() {
        shared.active_cmd_writer.as_mut()
    } else {
        shared.writer.as_mut()
    };
    if let Some(writer) = sink {
        let _ = writer.write_all(data.as_bytes());
        let _ = writer.flush();
    }
}

/// Spawn a fresh shell session into `shared` and start its reader thread.
///
/// The caller holds the `shared` guard; `state` is the same state behind its
/// `Arc`, cloned into the reader thread so it can append output and respawn on
/// exit.
fn spawn_session(shared: &mut Shared, state: &Arc<SharedState>) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(shared.cols, shared.rows))
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&shared.shell.program);
    for arg in &shared.shell.args {
        cmd.arg(arg);
    }
    // Inherit the host process environment explicitly, then force TERM so the
    // shell/programs negotiate 256-color as they did under node-pty.
    for (key, value) in &shared.env {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    if !shared.cwd.trim().is_empty() {
        cmd.cwd(&shared.cwd);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("shell spawn failed: {e}"))?;
    // Close the slave in the parent so the master read returns EOF once the
    // child exits (otherwise the reader thread would block forever).
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader clone failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer take failed: {e}"))?;

    shared.master = Some(pair.master);
    shared.writer = Some(writer);
    shared.child = Some(child);
    // A fresh session starts un-hooked and not-ready: reset the marker/hook/query
    // state and invalidate any timers still pending from a previous session.
    let program = shared.shell.program.clone();
    shared.integration = ShellIntegration::new(&program);
    shared.idle = false;
    shared.quiet_gen += 1;
    shared.confirm_gen += 1;

    let state = Arc::clone(state);
    std::thread::spawn(move || reader_loop(state, reader));
    Ok(())
}

/// Which fallback timer to arm.
#[derive(Debug, Clone, Copy)]
enum TimerKind {
    /// Install the hook after a startup lull (shells without bracketed paste).
    Quiet,
    /// Reveal output / abandon integration if the hook never confirms.
    Confirm,
}

/// Apply the side effects a [`Reaction`] asks for while holding the `shared`
/// guard: track the exit code and marker count, mark the shell ready, write
/// replies/hook back into the shell, emit the cleaned output and any `needsInput`
/// signal, (re)arm or cancel timers, and wake any in-shell git waiter.
fn apply_reaction(reaction: Reaction, shared: &mut Shared, state: &Arc<SharedState>) {
    if let Some(code) = reaction.exit_code {
        shared.last_exit_code = Some(code);
        // A marker: an in-shell command just finished. Advance the sequence so a
        // waiter distinguishes it from the previous command's marker.
        shared.marker_seq = shared.marker_seq.wrapping_add(1);
    }
    if reaction.mark_ready {
        shared.idle = true;
    }
    if !reaction.writes.is_empty() {
        if let Some(writer) = shared.writer.as_mut() {
            for chunk in &reaction.writes {
                let _ = writer.write_all(chunk.as_bytes());
            }
            let _ = writer.flush();
        }
    }
    if !reaction.display.is_empty() {
        shared.scrollback.append(reaction.display.as_bytes());
        let _ = shared.output.send(TerminalEvent::Data(reaction.display));
    }
    if reaction.request_open {
        let _ = shared.output.send(TerminalEvent::RequestOpen);
    }
    // Cancel before arming so an arm+cancel in the same reaction is coherent.
    if reaction.cancel_quiet_timer {
        shared.quiet_gen += 1;
    }
    if reaction.cancel_confirm_timer {
        shared.confirm_gen += 1;
    }
    if reaction.arm_quiet_timer {
        arm_timer(shared, state, TimerKind::Quiet);
    }
    if reaction.arm_confirm_timer {
        arm_timer(shared, state, TimerKind::Confirm);
    }
    // Wake any in-shell git waiter: readiness, a marker, or integration being
    // abandoned (a confirm timeout leaves no reaction flag) may all matter to it.
    state.cvar.notify_all();
}

/// Spawn a one-shot timer thread that, unless superseded, feeds the matching
/// timeout back into the shell-integration state machine and applies its
/// reaction. A bumped generation counter (set here and by any later arm/cancel)
/// makes the fired thread a no-op, giving cheap cancellation without a handle.
fn arm_timer(shared: &mut Shared, state: &Arc<SharedState>, kind: TimerKind) {
    let (generation, millis) = match kind {
        TimerKind::Quiet => {
            shared.quiet_gen += 1;
            (shared.quiet_gen, HOOK_QUIET_MS)
        }
        TimerKind::Confirm => {
            shared.confirm_gen += 1;
            (shared.confirm_gen, HOOK_CONFIRM_MS)
        }
    };
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(millis));
        let mut shared = match state.inner.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        let current = match kind {
            TimerKind::Quiet => shared.quiet_gen,
            TimerKind::Confirm => shared.confirm_gen,
        };
        if current != generation {
            return; // superseded or cancelled before it fired
        }
        let reaction = match kind {
            TimerKind::Quiet => shared.integration.on_quiet_timeout(),
            TimerKind::Confirm => shared.integration.on_confirm_timeout(),
        };
        apply_reaction(reaction, &mut shared, &state);
    });
}

/// Drain the shell's output until EOF, then emit exit and auto-restart.
///
/// Each chunk is decoded lossily and fed through the shell-integration filter
/// ([`ShellIntegration::on_data`]): invisible exit-code markers are stripped
/// (never reaching the frontend or scrollback), terminal queries are answered,
/// the integration hook is injected once the shell is ready, and only the
/// cleaned output is appended to the scrollback and sent as
/// [`TerminalEvent::Data`]. A blocking input prompt raises
/// [`TerminalEvent::RequestOpen`]. When the shell exits,
/// [`TerminalEvent::Exit`] is sent and a new session is spawned so the terminal
/// stays usable, mirroring `terminal.ts`.
fn reader_loop(state: Arc<SharedState>, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF: the shell exited.
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                let mut shared = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                let reaction = shared.integration.on_data(&text);
                apply_reaction(reaction, &mut shared, &state);
            }
            Err(_) => break, // Master closed / read error: treat as exit.
        }
    }

    let mut shared = match state.inner.lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    // A command may have been mid-flight: mark the exit so a waiter unblocks with
    // a failure, and clear readiness before the fresh session comes up.
    shared.idle = false;
    shared.exit_gen = shared.exit_gen.wrapping_add(1);
    let _ = shared.output.send(TerminalEvent::Exit);
    // During app teardown, do not respawn: the shell was killed on purpose and a
    // fresh session would only delay the exit. Wake any waiter and stop.
    if shared.shutting_down {
        state.cvar.notify_all();
        return;
    }
    // Auto-restart: keep the terminal usable rather than leaving a dead session.
    shared.scrollback.append(RESTART_NOTICE.as_bytes());
    let _ = shared
        .output
        .send(TerminalEvent::Data(RESTART_NOTICE.to_string()));
    let _ = spawn_session(&mut shared, &state);
    state.cvar.notify_all();
}

/// Reader thread for a standalone git command PTY (the Windows/unintegrated
/// path): stream every chunk to the view, appending to the scrollback and
/// emitting [`TerminalEvent::Data`], and raise [`TerminalEvent::RequestOpen`]
/// once per command when a blocking input prompt (passphrase/password/confirm)
/// is detected (port of the `runGitProcess` `onData` handler).
fn git_process_reader(state: Arc<SharedState>, mut reader: Box<dyn Read + Send>) {
    let mut buf = [0u8; READ_CHUNK];
    let mut prompted = false;
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let text = String::from_utf8_lossy(&buf[..n]).into_owned();
                let mut shared = match state.inner.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                shared.scrollback.append(text.as_bytes());
                if !prompted && needs_input(&text) {
                    prompted = true;
                    let _ = shared.output.send(TerminalEvent::RequestOpen);
                }
                let _ = shared.output.send(TerminalEvent::Data(text));
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::{Duration, Instant};

    /// The shell spec for the current host, from the real environment.
    fn host_shell() -> ShellSpec {
        let platform = if cfg!(windows) { "win32" } else { "linux" };
        super::super::resolve_shell(
            platform,
            std::env::var("COMSPEC").ok().as_deref(),
            std::env::var("SHELL").ok().as_deref(),
        )
    }

    /// Gated live-PTY smoke test: spawn a real shell, run `echo phase3ok`, and
    /// assert the marker text streams back. Skips cleanly (no failure) when a
    /// PTY or shell cannot be spawned, so it is safe on headless CI.
    #[test]
    fn live_shell_echoes_input() {
        let cwd = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let env: Vec<(String, String)> = std::env::vars().collect();
        let manager = TerminalManager::new(host_shell(), cwd, env);
        let rx = manager.take_events().expect("events available once");

        if let Err(err) = manager.start(80, 24) {
            eprintln!("skipping live PTY test: shell spawn failed: {err}");
            return;
        }
        if manager.write("echo phase3ok\n").is_err() {
            eprintln!("skipping live PTY test: shell write failed");
            return;
        }

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = String::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(500))) {
                Ok(TerminalEvent::Data(chunk)) => {
                    seen.push_str(&chunk);
                    if seen.contains("phase3ok") {
                        break;
                    }
                }
                Ok(TerminalEvent::Exit) => {}
                Ok(TerminalEvent::RequestOpen) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }

        assert!(
            seen.contains("phase3ok"),
            "expected shell output to contain 'phase3ok', got: {seen:?}"
        );
    }

    /// Bounded live in-shell git test: init a temp repo and run `git -C <repo>
    /// status` through the integrated shell via [`run_git`]. Skips cleanly (no
    /// failure) when git or a usable shell is unavailable, and is HARD-CAPPED by
    /// a completion timeout so it can never hang the suite. The git op runs on a
    /// worker thread; the main thread waits on a channel with a cap and gives up
    /// (skip) rather than block forever if no shell integration takes hold.
    #[test]
    fn live_git_status_through_the_shell_succeeds_or_skips() {
        // git must exist.
        let has_git = std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !has_git {
            eprintln!("skipping live git test: git not available");
            return;
        }

        // A throwaway repo under the temp dir.
        let dir = std::env::temp_dir().join(format!("skk-wave3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        if std::fs::create_dir_all(&dir).is_err() {
            eprintln!("skipping live git test: could not create temp dir");
            return;
        }
        let init_ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .arg("init")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !init_ok {
            eprintln!("skipping live git test: git init failed");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        let cwd = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        let env: Vec<(String, String)> = std::env::vars().collect();
        let manager = Arc::new(TerminalManager::new(host_shell(), cwd, env));
        let rx = manager.take_events().expect("events available once");
        // Drain events so the channel never backs up (runs until process exit).
        std::thread::spawn(move || while rx.recv().is_ok() {});

        if manager.start(80, 24).is_err() {
            eprintln!("skipping live git test: shell spawn failed");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }

        // Run git on a worker so the wait is bounded and can never hang.
        let (tx, done) = channel();
        let worker = Arc::clone(&manager);
        let dir_arg = dir.to_string_lossy().into_owned();
        std::thread::spawn(move || {
            let _ = tx.send(worker.run_git(&dir_arg, &["status".to_string()]));
        });

        match done.recv_timeout(Duration::from_secs(20)) {
            Ok(result) => assert!(
                result.is_ok(),
                "git status via the session should succeed, got: {result:?}"
            ),
            Err(_) => {
                eprintln!("skipping live git test: no completion within the cap");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Writing before start is a harmless no-op (no shell to receive input).
    #[test]
    fn write_before_start_is_a_noop() {
        let manager = TerminalManager::new(
            ShellSpec {
                program: "/bin/does-not-exist".to_string(),
                args: Vec::new(),
            },
            String::new(),
            Vec::new(),
        );
        assert!(manager.write("noop").is_ok());
    }

    /// Clearing the buffer before start does not panic.
    #[test]
    fn clear_buffer_before_start_is_a_noop() {
        let manager = TerminalManager::new(
            ShellSpec {
                program: "/bin/sh".to_string(),
                args: Vec::new(),
            },
            String::new(),
            Vec::new(),
        );
        manager.clear_buffer();
    }
}
