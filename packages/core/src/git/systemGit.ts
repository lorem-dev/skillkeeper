import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import type { CloneOptions, GitPort, GitRef, HostEnv } from '../ports.js';

const execFileAsync = promisify(execFile);

/** Result of running a git subcommand. */
export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a git subcommand with an argument array in a working directory. */
export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<RunResult>;
}

/**
 * Build `git clone` arguments. The `--` separator guards against URLs or paths
 * that begin with a dash, and every value is a discrete argument so there is no
 * shell interpolation.
 */
export function buildCloneArgs(options: CloneOptions): string[] {
  const args = ['clone'];
  if (options.filter !== undefined) {
    args.push(`--filter=${options.filter}`);
  }
  args.push('--', options.url, options.destination);
  return args;
}

/** Build `git fetch` arguments (prune stale remote refs). */
export function buildFetchArgs(): string[] {
  return ['fetch', '--prune'];
}

/** Build `git pull` arguments (fast-forward only). */
export function buildPullArgs(): string[] {
  return ['pull', '--ff-only'];
}

/** Build `git rev-parse` arguments for a revision. */
export function buildRevParseArgs(rev: string): string[] {
  return ['rev-parse', rev];
}

/** Build `git lfs pull` arguments. */
export function buildLfsPullArgs(): string[] {
  return ['lfs', 'pull'];
}

/** Build `git remote set-url origin <url>` arguments. */
export function buildSetRemoteUrlArgs(url: string): string[] {
  return ['remote', 'set-url', 'origin', '--', url];
}

/** The default runner shells out via execFile (argument array, no shell). */
function defaultRunner(env: HostEnv, resolveGitPath: () => string): GitRunner {
  return {
    async run(args: readonly string[], cwd: string): Promise<RunResult> {
      const { stdout, stderr } = await execFileAsync(resolveGitPath(), [...args], {
        cwd,
        env: env.env,
      });
      return { stdout: stdout.toString(), stderr: stderr.toString() };
    },
  };
}

/**
 * Create a {@link GitPort} backed by the system `git` binary. Commands are run
 * via `execFile` with argument arrays only - never a shell string - so callers
 * cannot inject shell metacharacters through URLs or paths. A custom
 * {@link GitRunner} can be injected for tests.
 *
 * @param env Host environment (supplies the process env for the subprocess).
 * @param runner Optional runner override (defaults to an execFile-backed one).
 * @param resolveGitPath Resolves the git executable to spawn, evaluated per run
 *   so a configured path can change without rebuilding the port. Defaults to
 *   `"git"` (resolved via the subprocess PATH). Ignored when `runner` is given.
 */
export function createSystemGit(
  env: HostEnv,
  runner?: GitRunner,
  resolveGitPath: () => string = () => 'git',
): GitPort {
  const r = runner ?? defaultRunner(env, resolveGitPath);
  return {
    async clone(options: CloneOptions): Promise<void> {
      await r.run(buildCloneArgs(options), dirname(options.destination));
      if (options.lfs === true) {
        await r.run(buildLfsPullArgs(), options.destination);
      }
    },
    async fetch(repoPath: string): Promise<void> {
      await r.run(buildFetchArgs(), repoPath);
    },
    async pull(repoPath: string): Promise<void> {
      await r.run(buildPullArgs(), repoPath);
    },
    async revParse(repoPath: string, rev: string): Promise<GitRef> {
      const { stdout } = await r.run(buildRevParseArgs(rev), repoPath);
      return { oid: stdout.trim() };
    },
    async lfsPull(repoPath: string): Promise<void> {
      await r.run(buildLfsPullArgs(), repoPath);
    },
    async setRemoteUrl(repoPath: string, url: string): Promise<void> {
      await r.run(buildSetRemoteUrlArgs(url), repoPath);
    },
  };
}
