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
 * a precmd/PROMPT_COMMAND hook prints an INVISIBLE OSC sequence carrying the
 * last command's exit code right before each prompt. The hook is installed (and
 * its own line hidden) only when the shell enables bracketed paste
 * (ESC[?2004h) -- the exact moment its line editor is ready to read a command;
 * typing during the noisy startup would lose the input. The main process strips
 * the OSC from the view and uses it for the command's exit code, while the
 * bracketed-paste-enable is the "ready for the next command" signal, so a
 * command is typed only once the prompt is truly ready (no double echo, no
 * mangled input).
 *
 * If the hook is never confirmed, or on Windows (POSIX quoting does not apply),
 * git runs as its own arg-array PTY instead; output/input still share the view.
 * A bounded rolling buffer lets a re-attaching renderer replay recent output.
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

/** Fallback (shells without bracketed paste): silence this long => "at prompt". */
const HOOK_QUIET_MS = 2000;
/** Reveal output / give up on integration if no marker arrives this soon after. */
const HOOK_CONFIRM_MS = 3000;

/**
 * Terminal queries a shell/prompt (e.g. starship) sends at startup, with the
 * canned reply the main process writes back immediately. Answering here -- not
 * in the renderer -- means the shell reaches its prompt even before any xterm
 * is mounted (eager start), so it never stalls waiting for a reply that would
 * otherwise arrive late and echo as garbage at the prompt.
 */
const QUERY_REPLIES: ReadonlyArray<readonly [RegExp, string]> = [
  // eslint-disable-next-line no-control-regex
  [/\x1b\]10;\?(?:\x07|\x1b\\)/, '\x1b]10;rgb:d4d4/d4d4/d4d4\x07'], // foreground color
  // eslint-disable-next-line no-control-regex
  [/\x1b\]11;\?(?:\x07|\x1b\\)/, '\x1b]11;rgb:1e1e/1e1e/1e1e\x07'], // background color
  // eslint-disable-next-line no-control-regex
  [/\x1b\]12;\?(?:\x07|\x1b\\)/, '\x1b]12;rgb:d4d4/d4d4/d4d4\x07'], // cursor color
  // eslint-disable-next-line no-control-regex
  [/\x1b\[6n/, '\x1b[1;1R'], // cursor position report
  // eslint-disable-next-line no-control-regex
  [/\x1b\[0?c/, '\x1b[?1;2c'], // primary device attributes
];

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
  // Also enable "ignore space": commands typed with a leading space are kept out
  // of the shell history. Every command we inject is space-prefixed (see the
  // write sites), so the app's git commands never land in ~/.zsh_history and
  // never surface (via the up arrow) in the user's other shell sessions.
  // zle_highlight paste:none stops zsh from showing our bracketed-paste command
  // as an inverse-video "selected" region while it is inserted.
  if (/(^|\/)zsh$/.test(shell)) {
    return "setopt hist_ignore_space; zle_highlight=(paste:none); __skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; precmd_functions=(__skk_pc $precmd_functions)";
  }
  if (/(^|\/)(bash|sh)$/.test(shell)) {
    return "HISTCONTROL=ignorespace; __skk_pc() { local e=$?; printf '\\033]777;skk;%d\\007' \"$e\"; return $e; }; PROMPT_COMMAND=\"__skk_pc${PROMPT_COMMAND:+; $PROMPT_COMMAND}\"";
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
  private hookSent = false;
  /** True once a marker has proven the hook works. */
  private integrationConfirmed = false;
  /** Hides the hook-install line until the first marker confirms it. */
  private hideHook = false;
  private quietTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;
  /** Leftover bytes of a marker that was split across data chunks. */
  private markerCarry = '';
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

  /** Display shell output (dropping only the hidden hook-install line). */
  private show(text: string): void {
    if (text.length === 0 || this.hideHook) return;
    if (this.pendingResolve !== undefined && !this.pendingPrompted && NEEDS_INPUT.test(text)) {
      this.pendingPrompted = true;
      this.emit('needsInput');
    }
    this.append(text);
  }

  /** Wake anything waiting for the shell to be ready (or for integration to end). */
  private wakeIdleWaiters(): void {
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  /** The just-finished command's exit code arrived (emitted by precmd). */
  private onMarker(code: number): void {
    this.integrationConfirmed = true;
    this.hideHook = false;
    if (this.confirmTimer !== undefined) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = undefined;
    }
    if (this.pendingResolve !== undefined) {
      const resolve = this.pendingResolve;
      this.pendingResolve = undefined;
      this.pendingPrompted = false;
      resolve(code);
    }
  }

  /**
   * The line editor is ready to read a command (bracketed paste re-enabled).
   * This -- not the earlier precmd marker -- is when the next command may be
   * typed; typing on the marker races the prompt and mangles the input.
   */
  private markReady(): void {
    this.idle = true;
    this.wakeIdleWaiters();
  }

  /** Reply to any terminal queries in this chunk so the shell never stalls. */
  private answerQueries(chunk: string): void {
    for (const [pattern, reply] of QUERY_REPLIES) {
      if (pattern.test(chunk)) this.pty?.write(reply);
    }
  }

  /** Strip invisible markers from shell output; display + act on the rest. */
  private handleShellData(chunk: string): void {
    this.answerQueries(chunk);
    // The shell enables bracketed paste (ESC [ ? 2004 h) exactly when its line
    // editor is ready to read a command at the prompt: the reliable moment both
    // to install the hook and to release the next command. A mid-startup lull is
    // NOT ready (input is lost), so the quiet timer is only a fallback.
    const ready = chunk.includes('\x1b[?2004h');
    let justInstalled = false;
    if (this.useIntegration && !this.hookSent) {
      if (ready) {
        this.installHook();
        justInstalled = true;
      } else {
        this.armHookTimer();
      }
    }

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

    // Release the next command only once the shell is back at a ready prompt --
    // never on the same chunk that just installed the hook (still running it).
    if (ready && this.hookSent && !justInstalled) this.markReady();
  }

  /** (Re)start the quiet-timer that installs the integration hook. */
  private armHookTimer(): void {
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.installHook(), HOOK_QUIET_MS);
  }

  /** Type the hook once the shell is idle; hide its line; arm a confirm timeout. */
  private installHook(): void {
    if (this.hookSent || this.pty === undefined) return;
    if (this.quietTimer !== undefined) {
      clearTimeout(this.quietTimer);
      this.quietTimer = undefined;
    }
    const setup = integrationSetup(defaultShell());
    if (setup === undefined) {
      this.useIntegration = false;
      return;
    }
    this.hookSent = true;
    this.hideHook = true;
    // Leading space keeps the hook line out of history (hist_ignore_space).
    this.pty.write(` ${setup}\r`);
    // If the marker never comes, the hook did not take: reveal output and fall
    // back to the arg-array PTY path so git never hangs on a missing marker.
    this.confirmTimer = setTimeout(() => {
      if (this.integrationConfirmed) return; // a marker proved the hook works
      this.hideHook = false;
      this.useIntegration = false;
      this.wakeIdleWaiters();
    }, HOOK_CONFIRM_MS);
  }

  /** Resolves once the shell is ready, or once integration has been abandoned. */
  private whenIdle(): Promise<void> {
    if (this.idle || !this.useIntegration) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Spawn the interactive shell and auto-restart it if it exits (e.g. `exit`). */
  private spawnShell(): void {
    const shell = defaultShell();
    this.useIntegration = integrationSetup(shell) !== undefined;
    this.hookSent = false;
    this.integrationConfirmed = false;
    this.hideHook = false;
    this.idle = false;
    const args = process.platform === 'win32' ? [] : ['-l'];
    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: os.homedir(),
      env: process.env as Record<string, string>,
    });
    this.pty = pty;
    // The hook timer is armed by handleShellData once real output arrives, not
    // here: firing during the initial silence would type into a shell that is
    // not yet reading input, and the command would be lost.
    pty.onData((data) => this.handleShellData(data));
    pty.onExit(() => {
      if (this.pty === pty) this.pty = undefined;
      if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
      if (this.confirmTimer !== undefined) clearTimeout(this.confirmTimer);
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
   * ready for input. `git -C <dir>` runs in the repo directly (no cd/subshell),
   * so the line carries no shell operators; the exit code comes from the shell's
   * invisible prompt marker, keeping the command line clean.
   */
  private async runGitInShell(gitPath: string, args: readonly string[], cwd: string): Promise<number> {
    this.start(this.cols, this.rows);
    await this.whenIdle();
    // Integration may have been abandoned while waiting; fall back cleanly.
    if (!this.useIntegration) return this.runGitProcess(gitPath, args, cwd);
    return new Promise<number>((resolve) => {
      this.idle = false;
      this.pendingResolve = resolve;
      this.pendingPrompted = false;
      // `git -C <dir> ...` runs in the repo without cd/subshell.
      const command = [shq(gitPath), '-C', shq(cwd), ...args.map(shq)].join(' ');
      // Bracketed paste inserts the whole line at once. Without it the shell
      // echoes char-by-char and zsh-syntax-highlighting redraws each keystroke,
      // which under rapidly queued commands intermittently drops a glyph from
      // the display (e.g. `-C` or `&&`). We only type once the shell has
      // re-enabled bracketed paste (idle is set on ESC[?2004h), so the 200~/201~
      // wrappers are consumed rather than shown. The leading space keeps the
      // command out of history (hist_ignore_space); the trailing CR runs it.
      this.pty?.write(`\x1b[200~ ${command}\x1b[201~\r`);
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
    // Leading space keeps it out of history (hist_ignore_space).
    const cmd = process.platform === 'darwin' ? ' ssh-add --apple-use-keychain\r' : ' ssh-add\r';
    this.pty?.write(cmd);
  }

  dispose(): void {
    this.disposing = true;
    if (this.quietTimer !== undefined) clearTimeout(this.quietTimer);
    if (this.confirmTimer !== undefined) clearTimeout(this.confirmTimer);
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
