/**
 * Terminal session for the app, backed by node-pty.
 *
 * A persistent interactive shell (started eagerly, kept until dispose() on
 * quit) IS the session. The app's git (clone/sync) runs runGit() literally in
 * that shell, so it is the shell's session: output is the shell's output and an
 * ssh key passphrase prompt reads the shell's input. Every interpolated value
 * (git path, args incl. the repo URL, cwd) is single-quote shell-escaped, so
 * URLs/paths cannot inject shell metacharacters.
 *
 * Clean display is achieved with shell integration instead of a visible marker:
 * a precmd/PROMPT_COMMAND hook (installed once at start) prints an INVISIBLE OSC
 * sequence carrying the last command's exit code right before each prompt. The
 * main process strips that sequence from the view and uses it for two things:
 * the command's exit code, and an "idle / prompt is ready" signal so the next
 * command is only typed once the shell is ready (no double echo, no races).
 *
 * On shells without a supported hook (or on Windows, where POSIX quoting does
 * not apply) git runs as its own arg-array PTY instead; output/input still
 * share the view. A bounded rolling buffer lets a re-attaching renderer replay.
 */
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 256 * 1024; // retained scrollback (bytes)

/** git/ssh output that means the command is blocked waiting for user input. */
const NEEDS_INPUT = /enter passphrase|password:|\(yes\/no|continue connecting/i;

/** Invisible per-prompt marker: ESC ] 777 ; skk ; <exitCode> BEL. */
const MARKER_PREFIX = '\x1b]777;skk;';
// eslint-disable-next-line no-control-regex -- matches the OSC/BEL marker bytes.
const MARKER_RE = /\x1b\]777;skk;(\d+)\x07/g;

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] ?? 'powershell.exe';
  return process.env['SHELL'] ?? '/bin/bash';
}

/** POSIX single-quote escape: wraps in '...' and turns embedded ' into '\''. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The one-line hook that makes the shell emit the invisible exit-code marker
 * before every prompt, or undefined for shells we do not integrate with. The
 * hook runs FIRST (prepended) and restores $? so it does not disturb the user's
 * own prompt (e.g. starship's error indicator).
 */
function integrationSetup(shell: string): string | undefined {
  if (/(^|\/)zsh$/.test(shell)) {
    return "__skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; precmd_functions=(__skk_pc $precmd_functions)";
  }
  if (/(^|\/)(bash|sh)$/.test(shell)) {
    return "__skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; PROMPT_COMMAND=\"__skk_pc${PROMPT_COMMAND:+; $PROMPT_COMMAND}\"";
  }
  return undefined;
}

class TerminalManager extends EventEmitter {
  private pty: IPty | undefined;
  /** Windows-only: the currently-running git command PTY; input routes here. */
  private activeCmd: IPty | undefined;
  /** Serializes runGit() calls so commands run one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set on quit so the shell is not respawned after its final exit. */
  private disposing = false;

  // Shell-integration state (POSIX in-shell execution).
  private useIntegration = integrationSetup(defaultShell()) !== undefined;
  /** Leftover bytes of a marker that was split across data chunks. */
  private markerCarry = '';
  /** True while startup noise (hook install, shell banner) is being hidden. */
  private suppressStartup = false;
  /** True when the shell is at a prompt and ready for the next command. */
  private idle = false;
  private idleWaiters: Array<() => void> = [];
  /** The in-flight in-shell command awaiting its exit-code marker. */
  private pendingResolve: ((code: number) => void) | undefined;
  private pendingPrompted = false;

  private buffer = '';
  private cols = 80;
  private rows = 24;

  private append(data: string): void {
    this.buffer = (this.buffer + data).slice(-MAX_BUFFER);
    this.emit('data', data);
  }

  /** Display shell output (dropping it while startup noise is suppressed). */
  private show(text: string): void {
    if (text.length === 0 || this.suppressStartup) return;
    if (this.pendingResolve !== undefined && !this.pendingPrompted && NEEDS_INPUT.test(text)) {
      this.pendingPrompted = true;
      this.emit('needsInput');
    }
    this.append(text);
  }

  /** A prompt is (re)appearing with the last command's exit code. */
  private onMarker(code: number): void {
    this.suppressStartup = false;
    if (this.pendingResolve !== undefined) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      this.pendingPrompted = false;
      resolve(code);
    }
    this.idle = true;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Strip invisible markers from shell output; display + act on the rest. */
  private handleShellData(chunk: string): void {
    const stream = this.markerCarry + chunk;
    this.markerCarry = '';
    MARKER_RE.lastIndex = 0;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKER_RE.exec(stream)) !== null) {
      this.show(stream.slice(cursor, match.index));
      this.onMarker(Number(match[1]));
      cursor = MARKER_RE.lastIndex;
    }
    let rest = stream.slice(cursor);
    // Hold back a partial marker at the very end so it is never shown or split.
    const esc = rest.lastIndexOf('\x1b');
    if (esc !== -1) {
      const tail = rest.slice(esc);
      const partial =
        MARKER_PREFIX.startsWith(tail) ||
        (tail.startsWith(MARKER_PREFIX) && /^\d*$/.test(tail.slice(MARKER_PREFIX.length)));
      if (partial) {
        this.markerCarry = tail;
        rest = rest.slice(0, esc);
      }
    }
    this.show(rest);
  }

  /** Resolves once the shell is at a prompt and ready for the next command. */
  private whenIdle(): Promise<void> {
    if (this.idle) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Spawn the interactive shell and auto-restart it if it exits (e.g. `exit`). */
  private spawnShell(): void {
    const shell = defaultShell();
    const setup = integrationSetup(shell);
    this.useIntegration = setup !== undefined;
    const args = process.platform === 'win32' ? [] : ['-l'];
    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    this.pty = pty;
    this.idle = false;
    pty.onData((data) => this.handleShellData(data));
    if (setup !== undefined) {
      // Hide the hook install + shell banner; the view starts at the first
      // clean prompt (the first marker), which also flips the shell to idle.
      this.suppressStartup = true;
      pty.write(`${setup}\r`);
    }
    pty.onExit(() => {
      if (this.pty === pty) this.pty = undefined;
      if (this.disposing) {
        this.emit('exit');
        return;
      }
      // If a command was mid-flight when the shell died, unblock its promise.
      if (this.pendingResolve !== undefined) {
        const resolve = this.pendingResolve;
        this.pendingResolve = undefined;
        this.pendingPrompted = false;
        resolve(1);
      }
      // The shell ended (e.g. the user typed `exit`); keep the terminal usable
      // by restarting it rather than leaving a dead session.
      this.append('\r\n\x1b[33m[shell restarted]\x1b[0m\r\n');
      this.spawnShell();
    });
  }

  /** Create the interactive shell if needed, resize, and return the buffer. */
  start(cols: number, rows: number): string {
    this.cols = cols || this.cols;
    this.rows = rows || this.rows;
    if (this.pty === undefined) {
      this.spawnShell();
    } else {
      this.pty.resize(this.cols, this.rows);
    }
    return this.buffer;
  }

  /** Route input to the active git command (Windows) or the interactive shell. */
  write(data: string): void {
    (this.activeCmd ?? this.pty)?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty?.resize(cols, rows);
    this.activeCmd?.resize(cols, rows);
  }

  /** Display-only, buffer-only echo (does NOT spawn anything). */
  echo(text: string): void {
    this.append(text);
  }

  /** Run git in the session, sequentially. Resolves with the exit code. */
  runGit(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    const run = this.queue.then(() =>
      process.platform === 'win32' || !this.useIntegration
        ? this.runGitProcess(gitPath, args, cwd)
        : this.runGitInShell(gitPath, args, cwd),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * POSIX: type the escaped git command into the interactive shell, once it is
   * ready for input. A subshell keeps `cd` from persisting; the exit code comes
   * from the shell's invisible prompt marker, so the command line stays clean.
   */
  private async runGitInShell(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    this.start(this.cols, this.rows);
    await this.whenIdle();
    return new Promise<number>((resolve) => {
      this.idle = false;
      this.pendingResolve = resolve;
      this.pendingPrompted = false;
      const command = [shq(gitPath), ...args.map(shq)].join(' ');
      // Bracketed paste inserts the line atomically (no per-char autosuggest /
      // re-highlight redraw); the trailing CR accepts and runs it.
      this.pty?.write(`\x1b[200~( cd ${shq(cwd)} && ${command} )\x1b[201~\r`);
    });
  }

  /** Windows / unintegrated shells: run git as its own arg-array PTY (no shell). */
  private runGitProcess(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    return new Promise<number>((resolve) => {
      this.start(this.cols, this.rows);
      this.echo(`\r\n\x1b[36m$ git ${args.join(' ')}\x1b[0m\r\n`);
      const cmd = spawn(gitPath, [...args], {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd,
        env: process.env as Record<string, string>,
      });
      this.activeCmd = cmd;
      let promptedForInput = false;
      cmd.onData((data) => {
        this.append(data);
        if (!promptedForInput && NEEDS_INPUT.test(data)) {
          promptedForInput = true;
          this.emit('needsInput');
        }
      });
      cmd.onExit(({ exitCode }) => {
        if (this.activeCmd === cmd) this.activeCmd = undefined;
        this.append('\r\n');
        resolve(exitCode);
      });
    });
  }

  /** Run ssh-add on the interactive shell so its passphrase prompt shows here. */
  runSshAdd(): void {
    this.start(this.cols, this.rows);
    const cmd = process.platform === 'darwin' ? 'ssh-add --apple-use-keychain\r' : 'ssh-add\r';
    this.pty?.write(cmd);
  }

  dispose(): void {
    this.disposing = true;
    this.activeCmd?.kill();
    this.activeCmd = undefined;
    this.pty?.kill();
    this.pty = undefined;
  }
}

let instance: TerminalManager | undefined;
export function getTerminal(): TerminalManager {
  instance ??= new TerminalManager();
  return instance;
}
