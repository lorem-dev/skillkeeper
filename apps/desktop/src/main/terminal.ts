/**
 * Terminal session for the app, backed by node-pty. Two kinds of PTY share one
 * view:
 * - a persistent interactive shell (lazy, kept until dispose() on quit) for
 *   manual use and ssh-add prompts;
 * - short-lived git command PTYs run via runGit(), so the app's git executes
 *   sequentially IN this session -- its output is the session's output and its
 *   prompts (e.g. an ssh key passphrase) read the session's input -- instead of
 *   running out-of-band and having output echoed asynchronously (which mixed
 *   with the shell). git is spawned with an argument array (no shell), so repo
 *   URLs/paths cannot inject shell metacharacters.
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
  /** The currently-running git command PTY, if any; input routes here. */
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
    pty.onData((data) => this.append(data));
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

  /** Route input to the active git command (e.g. for its ssh prompt) or the shell. */
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

  /**
   * Run `git <args>` in cwd as its own PTY, in this session, sequentially. The
   * command echoes into the view, its output streams live, and its input (an
   * ssh passphrase prompt) reads the terminal's input. Resolves with the exit
   * code. Argument array only -- never a shell string -- so no injection.
   */
  runGit(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    const run = this.queue.then(
      () =>
        new Promise<number>((resolve) => {
          this.echo(`\r\n\x1b[36m$ git ${args.join(' ')}\x1b[0m\r\n`);
          const cmd = spawn(gitPath, [...args], {
            name: 'xterm-256color',
            cols: this.cols,
            rows: this.rows,
            cwd,
            env: process.env as Record<string, string>,
          });
          this.activeCmd = cmd;
          // Runs in the background; the terminal is only surfaced if git actually
          // asks for input (ssh key passphrase, password, host-key confirmation).
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
        }),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
