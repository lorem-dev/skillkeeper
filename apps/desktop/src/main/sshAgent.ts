/**
 * Managed ssh-agent for the app session (sub-project B). Reuses an inherited
 * agent on any OS; otherwise, on macOS/Linux, spawns one and loads the default
 * keys once so ssh clones reuse credentials. Publishes SSH_AUTH_SOCK on
 * process.env, which the git subprocesses inherit. Windows relies on the OS
 * OpenSSH agent (a named pipe used by Windows OpenSSH ssh) and is only reused,
 * not spawned. No passphrase prompting (deferred).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseAgentEnv } from './sshAgentEnv.js';

const execFileAsync = promisify(execFile);

/** PID of an agent WE spawned (undefined when reusing an inherited one). */
let spawnedPid: string | undefined;

function hasInheritedAgent(): boolean {
  const sock = process.env['SSH_AUTH_SOCK'];
  return sock !== undefined && sock.trim() !== '';
}

/**
 * Load the default ssh keys once, without ever blocking on a passphrase. No TTY
 * (execFile is not a shell) plus SSH_ASKPASS_REQUIRE=never / empty SSH_ASKPASS /
 * DISPLAY means an encrypted key absent from the Keychain fails fast. macOS
 * loads Keychain-stored passphrases via --apple-use-keychain. Best-effort.
 */
async function loadKeys(): Promise<void> {
  try {
    const args = process.platform === 'darwin' ? ['--apple-use-keychain'] : [];
    await execFileAsync('ssh-add', args, {
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '', DISPLAY: '' },
    });
  } catch {
    // No keys, tool missing, or a passphrase-protected key without Keychain:
    // leave the agent as-is; https clones and already-loaded keys still work.
  }
}

/** Ensure an ssh-agent is available to git subprocesses via process.env. */
export async function ensureSshAgent(): Promise<void> {
  if (hasInheritedAgent()) {
    await loadKeys();
    return;
  }
  // Windows without an inherited socket: the OS OpenSSH agent uses a named pipe
  // consulted by Windows OpenSSH ssh directly; nothing to spawn here.
  if (process.platform === 'win32') return;

  try {
    const { stdout } = await execFileAsync('ssh-agent', ['-s']);
    const { sock, pid } = parseAgentEnv(stdout.toString());
    if (sock === undefined) return;
    process.env['SSH_AUTH_SOCK'] = sock;
    if (pid !== undefined) {
      process.env['SSH_AGENT_PID'] = pid;
      spawnedPid = pid;
    }
    await loadKeys();
  } catch {
    // ssh-agent unavailable: leave env untouched; https clones still work.
  }
}

/** Kill an agent we spawned (no-op when an inherited agent was reused). */
export function stopSshAgent(): void {
  if (spawnedPid === undefined) return;
  execFile('ssh-agent', ['-k'], { env: process.env }, () => {
    // Best-effort teardown on quit; ignore errors.
  });
  spawnedPid = undefined;
}
