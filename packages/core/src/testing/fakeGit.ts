import type { CloneOptions, GitPort, GitRef } from '../kernel/ports.js';

/** A recorded git operation, for assertions in tests. */
export interface GitCall {
  readonly op:
    | 'clone'
    | 'fetch'
    | 'pull'
    | 'forcePull'
    | 'revParse'
    | 'currentBranch'
    | 'listBranches'
    | 'checkout'
    | 'lfsPull'
    | 'setRemoteUrl';
  readonly args: Record<string, unknown>;
}

/** Configuration for {@link createFakeGit}. */
export interface FakeGitOptions {
  /**
   * Map of `repoPath::rev` to the oid that {@link GitPort.revParse} returns.
   * Falls back to {@link FakeGitOptions.defaultOid}.
   */
  readonly refs?: Record<string, string>;
  readonly defaultOid?: string;
  /** Branch name returned by {@link GitPort.currentBranch}. Defaults to `main`. */
  readonly branch?: string;
  /** Branch names returned by {@link GitPort.listBranches}. Defaults to `[]`. */
  readonly branches?: readonly string[];
}

/** A fake {@link GitPort} that records calls and returns canned refs. */
export interface FakeGit extends GitPort {
  /** All recorded operations in call order. */
  readonly calls: GitCall[];
}

/**
 * Create an in-memory {@link GitPort} for tests. It performs no I/O: it records
 * each call and returns configured oids from {@link GitPort.revParse}.
 */
export function createFakeGit(options: FakeGitOptions = {}): FakeGit {
  const calls: GitCall[] = [];
  const refs = options.refs ?? {};
  const defaultOid = options.defaultOid ?? '0000000000000000000000000000000000000000';
  const branch = options.branch ?? 'main';

  return {
    calls,
    async clone(opts: CloneOptions): Promise<void> {
      calls.push({ op: 'clone', args: { ...opts } });
    },
    async fetch(repoPath: string): Promise<void> {
      calls.push({ op: 'fetch', args: { repoPath } });
    },
    async pull(repoPath: string): Promise<void> {
      calls.push({ op: 'pull', args: { repoPath } });
    },
    async forcePull(repoPath: string): Promise<void> {
      calls.push({ op: 'forcePull', args: { repoPath } });
    },
    async revParse(repoPath: string, rev: string): Promise<GitRef> {
      calls.push({ op: 'revParse', args: { repoPath, rev } });
      return { oid: refs[`${repoPath}::${rev}`] ?? defaultOid };
    },
    async currentBranch(repoPath: string): Promise<string> {
      calls.push({ op: 'currentBranch', args: { repoPath } });
      return branch;
    },
    async listBranches(repoPath: string): Promise<string[]> {
      calls.push({ op: 'listBranches', args: { repoPath } });
      return [...(options.branches ?? [])];
    },
    async checkout(repoPath: string, targetBranch: string): Promise<void> {
      calls.push({ op: 'checkout', args: { repoPath, branch: targetBranch } });
    },
    async lfsPull(repoPath: string): Promise<void> {
      calls.push({ op: 'lfsPull', args: { repoPath } });
    },
    async setRemoteUrl(repoPath: string, url: string): Promise<void> {
      calls.push({ op: 'setRemoteUrl', args: { repoPath, url } });
    },
  };
}
