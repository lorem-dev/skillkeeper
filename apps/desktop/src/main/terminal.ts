/**
 * Terminal session for the app, backed by node-pty.
 *
 * A persistent interactive shell (started eagerly, kept until dispose() on
 * quit) is the session the user types into (and where `ssh-add` prompts).
 *
 * The app's git (clone/sync) runs via runGit(): each command is spawned as its
 * OWN PTY process with an argument array (NO shell), so there is no shell echo,
 * no quoting/escaping to get wrong, and no shell metacharacter injection -- the
 * repo URL and paths are passed as literal argv entries. Its real output streams
 * straight into the same terminal view, the exit code comes from the process,
 * and an ssh key passphrase prompt appears in that PTY (its controlling tty) so
 * input can be routed to it. Commands are serialized: one runs at a time.
 *
 * A bounded rolling buffer lets a re-attaching renderer replay recent output.
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

class TerminalManager extends EventEmitter {
  private pty: IPty | undefined;
  /** The currently-running git command PTY; input routes here while it runs. */
  private activeCmd: IPty | undefined;
  /** Serializes runGit() calls so commands run one after another. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Set on quit so the shell is not respawned after its final exit. */
  private disposing = false;
  private buffer = '';
  private cols = 80;
  private rows = 24;

  private append(data: string): void {
    this.buffer = (this.buffer + data).slice(-MAX_BUFFER);
    this.emit('data', data);
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
    pty.onData((data) => {
      // Surface a passphrase/host prompt from an interactively-typed `ssh-add`.
      if (this.activeCmd === undefined && NEEDS_INPUT.test(data)) this.emit('needsInput');
      this.append(data);
    });
    pty.onExit(() => {
      if (this.pty === pty) this.pty = undefined;
      if (this.disposing) {
        this.emit('exit');
        return;
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

  /** Route input to the running git command (for its prompts) or the shell. */
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
    const run = this.queue.then(() => this.runGitProcess(gitPath, args, cwd));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Run git as its own arg-array PTY (no shell) whose I/O shares the view.
   * The interactive shell is left running; its prompt simply sits idle above.
   */
  private runGitProcess(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    return new Promise<number>((resolve) => {
      // Ensure the view exists so a re-attaching renderer replays this output.
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
