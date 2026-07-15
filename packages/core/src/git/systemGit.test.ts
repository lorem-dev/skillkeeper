import { describe, expect, it, vi } from 'vitest';
import {
  buildCloneArgs,
  buildCleanArgs,
  buildCurrentBranchArgs,
  buildFetchArgs,
  buildLfsPullArgs,
  buildPullArgs,
  buildResetHardArgs,
  buildRevParseArgs,
  buildSetRemoteUrlArgs,
  buildBranchListArgs,
  parseBranchList,
  buildForceCheckoutArgs,
  createSystemGit,
} from './systemGit.js';
import type { HostEnv } from '../kernel/ports.js';

const ENV: HostEnv = { homeDir: '/home/u', platform: 'linux', env: { PATH: '/usr/bin' } };

describe('git argument builders', () => {
  it('builds clone args for a plain url without lfs', () => {
    expect(buildCloneArgs({ url: 'https://x/y.git', destination: '/dst' })).toEqual([
      'clone',
      '--',
      'https://x/y.git',
      '/dst',
    ]);
  });

  it('builds clone args for an ssh url with a partial-clone filter', () => {
    const args = buildCloneArgs({
      url: 'git@github.com:org/repo.git',
      destination: '/dst',
      filter: 'blob:none',
    });
    expect(args).toEqual([
      'clone',
      '--filter=blob:none',
      '--',
      'git@github.com:org/repo.git',
      '/dst',
    ]);
  });

  it('contains no shell metacharacters in any clone argument', () => {
    const args = buildCloneArgs({ url: 'git@h:o/r.git', destination: '/d' });
    // Each element is a discrete argument; none should be a packed shell string.
    for (const a of args) {
      expect(a).not.toMatch(/[;&|`$()<>]/);
      expect(a).not.toContain(' && ');
    }
  });

  it('builds fetch args targeting the default remote', () => {
    expect(buildFetchArgs()).toEqual(['fetch', '--prune']);
  });

  it('builds pull args with --ff-only', () => {
    expect(buildPullArgs()).toEqual(['pull', '--ff-only']);
  });

  it('builds reset --hard args targeting the upstream', () => {
    expect(buildResetHardArgs()).toEqual(['reset', '--hard', '@{u}']);
  });

  it('builds clean args that drop untracked files and directories', () => {
    expect(buildCleanArgs()).toEqual(['clean', '-fd']);
  });

  it('builds rev-parse args for a revision', () => {
    expect(buildRevParseArgs('HEAD')).toEqual(['rev-parse', 'HEAD']);
    expect(buildRevParseArgs('@{upstream}')).toEqual(['rev-parse', '@{upstream}']);
  });

  it('builds current-branch args', () => {
    expect(buildCurrentBranchArgs()).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('builds lfs pull args', () => {
    expect(buildLfsPullArgs()).toEqual(['lfs', 'pull']);
  });

  it('builds set-url args with a -- guard', () => {
    expect(buildSetRemoteUrlArgs('git@x:y.git')).toEqual(['remote', 'set-url', 'origin', '--', 'git@x:y.git']);
  });

  it('builds branch-list args over local + origin refs', () => {
    expect(buildBranchListArgs()).toEqual([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes/origin',
    ]);
  });

  it('builds force-checkout args', () => {
    expect(buildForceCheckoutArgs('develop')).toEqual(['checkout', '-f', 'develop']);
  });

  it('parses branch lists: strips origin/, drops origin/HEAD, dedupes, sorts', () => {
    const stdout = ['main', 'develop', 'origin/main', 'origin/develop', 'origin/release', 'origin/HEAD', ''].join(
      '\n',
    );
    expect(parseBranchList(stdout)).toEqual(['develop', 'main', 'release']);
  });
});

describe('createSystemGit', () => {
  it('invokes the runner with clone args and the parent of the destination as cwd', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git = createSystemGit(ENV, {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: '', stderr: '' };
      },
    });
    await git.clone({ url: 'https://x/y.git', destination: '/a/b/repo' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['clone', '--', 'https://x/y.git', '/a/b/repo']);
    expect(calls[0]!.cwd).toBe('/a/b');
  });

  it('runs lfs pull after clone when lfs is requested', async () => {
    const argSets: Array<readonly string[]> = [];
    const git = createSystemGit(ENV, {
      run: async (args) => {
        argSets.push(args);
        return { stdout: '', stderr: '' };
      },
    });
    await git.clone({ url: 'u', destination: '/d/repo', lfs: true });
    expect(argSets[0]![0]).toBe('clone');
    expect(argSets[1]).toEqual(['lfs', 'pull']);
  });

  it('fetch, pull, and lfsPull run in the given repo path', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git = createSystemGit(ENV, {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: '', stderr: '' };
      },
    });
    await git.fetch('/repo');
    await git.pull('/repo');
    await git.lfsPull('/repo');
    expect(calls.map((c) => c.cwd)).toEqual(['/repo', '/repo', '/repo']);
    expect(calls[0]!.args).toEqual(['fetch', '--prune']);
    expect(calls[1]!.args).toEqual(['pull', '--ff-only']);
    expect(calls[2]!.args).toEqual(['lfs', 'pull']);
  });

  it('forcePull fetches, hard-resets to upstream, then cleans -- all in the repo path', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git = createSystemGit(ENV, {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: '', stderr: '' };
      },
    });
    await git.forcePull('/repo');
    expect(calls.map((c) => c.cwd)).toEqual(['/repo', '/repo', '/repo']);
    expect(calls.map((c) => c.args)).toEqual([
      ['fetch', '--prune'],
      ['reset', '--hard', '@{u}'],
      ['clean', '-fd'],
    ]);
  });

  it('revParse trims runner stdout into an oid', async () => {
    const git = createSystemGit(ENV, {
      run: async () => ({ stdout: 'deadbeef\n', stderr: '' }),
    });
    const ref = await git.revParse('/repo', 'HEAD');
    expect(ref.oid).toBe('deadbeef');
  });

  it('currentBranch runs abbrev-ref and trims the branch name', async () => {
    const calls: Array<readonly string[]> = [];
    const git = createSystemGit(ENV, {
      run: async (args) => {
        calls.push(args);
        return { stdout: 'main\n', stderr: '' };
      },
    });
    const branch = await git.currentBranch('/repo');
    expect(branch).toBe('main');
    expect(calls[0]).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('listBranches runs for-each-ref in the repo and normalizes the output', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git = createSystemGit(ENV, {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: 'main\norigin/main\norigin/dev\norigin/HEAD\n', stderr: '' };
      },
    });
    const branches = await git.listBranches('/repo');
    expect(calls[0]!.args).toEqual(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']);
    expect(calls[0]!.cwd).toBe('/repo');
    expect(branches).toEqual(['dev', 'main']);
  });

  it('checkout force-switches to the branch in the repo', async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const git = createSystemGit(ENV, {
      run: async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: '', stderr: '' };
      },
    });
    await git.checkout('/repo', 'develop');
    expect(calls[0]!.args).toEqual(['checkout', '-f', 'develop']);
    expect(calls[0]!.cwd).toBe('/repo');
  });

  it('defaults to a real execFile-backed runner when none is injected', () => {
    // Construct with the default runner to cover the wiring; we do not invoke a
    // network or process here, only assert the port shape.
    const git = createSystemGit(ENV);
    expect(typeof git.clone).toBe('function');
    expect(typeof git.revParse).toBe('function');
  });

  it('surfaces runner errors', async () => {
    const git = createSystemGit(ENV, {
      run: async () => {
        throw new Error('git exploded');
      },
    });
    await expect(git.fetch('/repo')).rejects.toThrow('git exploded');
  });

  it('the default runner rejects for a clearly invalid invocation', async () => {
    // Exercises the real execFile path without a network: rev-parse in a
    // non-repository directory exits non-zero.
    const git = createSystemGit({ ...ENV, env: process.env });
    await expect(git.revParse('/', 'HEAD')).rejects.toBeInstanceOf(Error);
    vi.restoreAllMocks();
  });
});
