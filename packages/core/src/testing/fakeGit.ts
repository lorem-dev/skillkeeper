import type { CloneOptions, GitPort, GitRef } from '../ports.js';

/** A recorded git operation, for assertions in tests. */
export interface GitCall {
  readonly op: 'clone' | 'fetch' | 'pull' | 'revParse' | 'lfsPull' | 'setRemoteUrl';
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
    async revParse(repoPath: string, rev: string): Promise<GitRef> {
      calls.push({ op: 'revParse', args: { repoPath, rev } });
      return { oid: refs[`${repoPath}::${rev}`] ?? defaultOid };
    },
    async lfsPull(repoPath: string): Promise<void> {
      calls.push({ op: 'lfsPull', args: { repoPath } });
    },
    async setRemoteUrl(repoPath: string, url: string): Promise<void> {
      calls.push({ op: 'setRemoteUrl', args: { repoPath, url } });
    },
  };
}
