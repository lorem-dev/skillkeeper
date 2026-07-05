/**
 * Terminal session for the app, backed by node-pty.
 *
 * A persistent interactive shell (lazy, kept until dispose() on quit) is the
 * session. The app's git (clone/sync) runs runGit():
 * - POSIX (macOS/Linux): the command is typed literally INTO the interactive
 *   shell, so it is the shell's session -- output is the shell's output and an
 *   ssh key passphrase prompt reads the shell's input. Every interpolated value
 *   (git path, args incl. the repo URL, cwd) is single-quote shell-escaped, so
 *   URLs/paths cannot inject shell metacharacters. A unique end-marker printed
 *   with the command's `$?` lets us recover the exit code.
 * - Windows (cmd/powershell): POSIX quoting does not apply, so git runs as its
 *   own arg-array PTY (no shell) instead; output/input still share the view.
 *
 * Commands are serialized. A bounded rolling buffer lets a re-attaching renderer
 * replay recent output.
 */
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 256 * 1024; // retained scrollback (bytes)

/** git/ssh output that means the command is blocked waiting for user input. */
const NEEDS_INPUT = /enter passphrase|password:|\(yes\/no|continue connecting/i;

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] ?? 'powershell.exe';
  return process.env['SHELL'] ?? '/bin/bash';
}

/** POSIX single-quote escape: wraps in '...' and turns embedded ' into '\''. */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

class TerminalManager extends EventEmitter {
  private pty: IPty | undefined;
  /** Windows-only: the currently-running git command PTY; input routes here. */
  private activeCmd: IPty | undefined;
  /** Serializes runGit() calls so commands run one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set on quit so the shell is not respawned after its final exit. */
  private disposing = false;
  // POSIX in-shell command tracking (exit-code marker + prompt detection).
  private cmdSeq = 0;
  private pendingMarker: string | undefined;
  private pendingResolve: ((code: number) => void) | undefined;
  private pendingPrompted = false;
  private scanBuf = '';
  private buffer = '';
  private cols = 80;
  private rows = 24;

  private append(data: string): void {
    this.buffer = (this.buffer + data).slice(-MAX_BUFFER);
    this.emit('data', data);
  }

  /** Scan interactive-shell output for the in-shell command's end-marker + prompts. */
  private handleShellData(data: string): void {
    if (this.pendingMarker !== undefined) {
      this.scanBuf = (this.scanBuf + data).slice(-4096);
      const match = new RegExp(`${this.pendingMarker}:(\\d+)`).exec(this.scanBuf);
      if (match !== null) {
        const resolve = this.pendingResolve;
        const code = Number(match[1]);
        this.pendingMarker = undefined;
        this.pendingResolve = undefined;
        this.scanBuf = '';
        resolve?.(code);
      } else if (!this.pendingPrompted && NEEDS_INPUT.test(data)) {
        this.pendingPrompted = true;
        this.emit('needsInput');
      }
    }
    this.append(data);
  }

  /** Spawn the interactive shell and auto-restart it if it exits (e.g. `exit`). */
  private spawnShell(): void {
    const shell = defaultShell();
    const args = process.platform === 'win32' ? [] : ['-l'];
    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    this.pty = pty;
    pty.onData((data) => this.handleShellData(data));
    pty.onExit(() => {
      if (this.pty === pty) this.pty = undefined;
      if (this.disposing) {
        this.emit('exit');
        return;
      }
      // If a command was mid-flight when the shell died, unblock its promise.
      if (this.pendingResolve !== undefined) {
        const resolve = this.pendingResolve;
        this.pendingMarker = undefined;
        this.pendingResolve = undefined;
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
      process.platform === 'win32'
        ? this.runGitProcess(gitPath, args, cwd)
        : this.runGitInShell(gitPath, args, cwd),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** POSIX: type the escaped git command into the interactive shell. */
  private runGitInShell(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    this.start(this.cols, this.rows);
    return new Promise<number>((resolve) => {
      const marker = `__SKK_${String(this.cmdSeq++)}__`;
      const command = [shq(gitPath), ...args.map(shq)].join(' ');
      this.pendingMarker = marker;
      this.pendingResolve = resolve;
      this.pendingPrompted = false;
      this.scanBuf = '';
      // Run in a subshell so cd does not persist; print the marker + $? after it
      // (the trailing CR/erase hides the marker's own output line).
      this.pty?.write(
        `( cd ${shq(cwd)} && ${command} ) ; printf '\\r\\033[2K${marker}:%d\\r\\033[2K' "$?"\r`,
      );
    });
  }

  /** Windows: run git as its own arg-array PTY (no shell) sharing the view. */
  private runGitProcess(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    return new Promise<number>((resolve) => {
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
