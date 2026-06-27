/**
 * Injected I/O ports for SkillKeeper core.
 *
 * The domain core performs no direct `node:fs` or `node:child_process` I/O.
 * Every side effect goes through one of these interfaces, which keeps the core
 * unit-testable with in-memory fakes. This module declares interfaces only and
 * is excluded from the coverage gate.
 */

/** File metadata returned by {@link FsPort.stat}. */
export interface FileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** True when the owner-executable bit is set. */
  readonly executable: boolean;
  readonly size: number;
}

/**
 * Minimal filesystem abstraction. All paths are absolute (or resolved by the
 * caller before use). Reads and writes are UTF-8 text; binary handling is out
 * of scope for v1.
 */
export interface FsPort {
  /** Read a file as UTF-8 text. Rejects if it does not exist. */
  readFile(path: string): Promise<string>;
  /** Write a file as UTF-8 text, creating parent directories as needed. */
  writeFile(path: string, content: string): Promise<void>;
  /** List the immediate entry names of a directory. Rejects if missing. */
  list(path: string): Promise<string[]>;
  /** Stat a path, or return undefined when it does not exist. */
  stat(path: string): Promise<FileStat | undefined>;
  /** True when the path exists. */
  exists(path: string): Promise<boolean>;
  /** Create a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Remove a file. No-op when it does not exist. */
  remove(path: string): Promise<void>;
  /** Remove a directory only when it is empty. No-op when missing. */
  removeDirIfEmpty(path: string): Promise<void>;
  /** Set or clear the owner-executable bit. */
  chmod(path: string, executable: boolean): Promise<void>;
  /** Rename (move) a path. Used for atomic temp-then-rename writes. */
  rename(from: string, to: string): Promise<void>;
}

/** Result of a Git rev-parse style lookup. */
export interface GitRef {
  /** The resolved object id (commit hash). */
  readonly oid: string;
}

/** Options for a clone operation. */
export interface CloneOptions {
  readonly url: string;
  readonly destination: string;
  /** When true, run `git lfs` steps after clone. */
  readonly lfs?: boolean;
  /** Optional partial-clone filter, for example `blob:none`. */
  readonly filter?: string;
}

/**
 * Filesystem-and-network abstraction over the system `git` binary. The only
 * production implementation is `createSystemGit`, which shells out via
 * `execFile` with argument arrays (never a shell string).
 */
export interface GitPort {
  clone(options: CloneOptions): Promise<void>;
  fetch(repoPath: string): Promise<void>;
  /** Fast-forward only pull. */
  pull(repoPath: string): Promise<void>;
  /** Resolve a revision (for example `HEAD` or `@{upstream}`) to an oid. */
  revParse(repoPath: string, rev: string): Promise<GitRef>;
  /** Run `git lfs pull` in the given repository. */
  lfsPull(repoPath: string): Promise<void>;
}

/** Host environment values the adapters and ports need. */
export interface HostEnv {
  /** Absolute path to the current user's home directory. */
  readonly homeDir: string;
  /** Platform identifier, mirroring `process.platform`. */
  readonly platform: NodeJS.Platform;
  /** Selected environment variables (for example PATH lookups). */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Injectable clock so timer logic is deterministic under test. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}
