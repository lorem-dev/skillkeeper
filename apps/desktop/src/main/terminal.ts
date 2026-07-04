/**
 * Single persistent PTY for the app session, backed by node-pty. Created lazily
 * on the first start(); kept alive until dispose() on quit so shell state + the
 * ssh-agent session persist across opening/closing the terminal overlay. A
 * bounded rolling buffer lets a re-attaching renderer replay recent output.
 */
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import os from 'node:os';
import { EventEmitter } from 'node:events';

const MAX_BUFFER = 256 * 1024; // retained scrollback (bytes)

function defaultShell(): string {
  if (process.platform === 'win32') return process.env['COMSPEC'] ?? 'powershell.exe';
  return process.env['SHELL'] ?? '/bin/bash';
}

class TerminalManager extends EventEmitter {
  private pty: IPty | undefined;
  private buffer = '';
  private cols = 80;
  private rows = 24;

  /** Create the PTY if needed, resize, and return the retained buffer. */
  start(cols: number, rows: number): string {
    this.cols = cols || this.cols;
    this.rows = rows || this.rows;
    if (this.pty === undefined) {
      const shell = defaultShell();
      const args = process.platform === 'win32' ? [] : ['-l'];
      this.pty = spawn(shell, args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
      });
      this.pty.onData((data) => {
        this.buffer = (this.buffer + data).slice(-MAX_BUFFER);
        this.emit('data', data);
      });
      this.pty.onExit(() => {
        this.pty = undefined;
        this.emit('exit');
      });
    } else {
      this.pty.resize(this.cols, this.rows);
    }
    return this.buffer;
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.pty?.resize(cols, rows);
  }

  /**
   * Echo an informational line into the terminal (app git activity). Display-only
   * and buffer-only: it does NOT spawn the PTY, so background git never starts a
   * shell. If the PTY is running (terminal opened), listeners see it live; either
   * way it is retained in the buffer and replayed when the terminal is opened.
   */
  echo(text: string): void {
    this.buffer = (this.buffer + text).slice(-MAX_BUFFER);
    this.emit('data', text);
  }

  /** Run ssh-add on the PTY so the passphrase prompt appears on its TTY. */
  runSshAdd(): void {
    this.start(this.cols, this.rows);
    const cmd = process.platform === 'darwin' ? 'ssh-add --apple-use-keychain\r' : 'ssh-add\r';
    this.pty?.write(cmd);
  }

  dispose(): void {
    this.pty?.kill();
    this.pty = undefined;
  }
}

let instance: TerminalManager | undefined;
export function getTerminal(): TerminalManager {
  instance ??= new TerminalManager();
  return instance;
}
