/**
 * Repository management for the desktop main process: add/clone/edit/remove/sync
 * plus update detection, over the core state store and GitPort. Errors are
 * returned as result shapes; nothing throws across the IPC boundary.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { FsPort, GitPort, Repository } from '@skillkeeper/core';
import { loadState, saveState, parseRemote, repoHasUpdate, resolveSkills } from '@skillkeeper/core';

export interface RepoDeps {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly statePath: string;
  /** Directory clones live under: <appData>/repositories */
  readonly reposDir: string;
}

export type RepoResult = { ok: true; repository: Repository } | { ok: false; error: string };
export type RemoveResult = { ok: true } | { ok: false; error: string };

/** Branch + skill-count summary for a cloned repository (for the card badges). */
export interface RepoInfo {
  /** Current branch, or null when the clone is missing or detached-unknown. */
  readonly branch: string | null;
  /** Number of skills resolved in the working tree. */
  readonly skillCount: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Serialize the state read-modify-write critical section. IPC handlers run
// concurrently, and `saveState` overwrites the whole file, so two interleaved
// load-mutate-save sequences would lose an update (e.g. a slow background clone
// finishing after a second `add` writes its own snapshot). Slow git work stays
// OUTSIDE this lock; the locked sections always re-read fresh state.
let stateLock: Promise<unknown> = Promise.resolve();
function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = stateLock.then(fn, fn);
  stateLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Find a repo by id in fresh state (locked). */
async function findRepo(deps: RepoDeps, id: string): Promise<Repository | null> {
  return withStateLock(async () => {
    const state = await loadState(deps.fs, deps.statePath);
    return state.repositories.find((r) => r.id === id) ?? null;
  });
}

/** Re-read fresh state, replace this repo, and save -- all under the lock. */
async function persistRepo(deps: RepoDeps, id: string, patch: Partial<Repository>): Promise<RepoResult> {
  return withStateLock(async () => {
    const state = await loadState(deps.fs, deps.statePath);
    const current = state.repositories.find((r) => r.id === id);
    if (current === undefined) return { ok: false, error: 'not-found' };
    const updated: Repository = { ...current, ...patch };
    await saveState(deps.fs, deps.statePath, {
      ...state,
      repositories: state.repositories.map((r) => (r.id === id ? updated : r)),
    });
    return { ok: true, repository: updated };
  });
}

/** Add a repository record (no clone yet), so the card can appear immediately. */
export async function addRepository(deps: RepoDeps, args: { url: string; name: string }): Promise<RepoResult> {
  return withStateLock(async () => {
    try {
      const state = await loadState(deps.fs, deps.statePath);
      if (state.repositories.some((r) => r.url === args.url)) {
        return { ok: false, error: 'duplicate' };
      }
      const id = randomUUID();
      const { kind, transport } = parseRemote(args.url);
      const repository: Repository = {
        id,
        name: args.name.trim() === '' ? args.url : args.name.trim(),
        url: args.url,
        kind,
        transport,
        lfs: false,
        localPath: path.join(deps.reposDir, id),
      };
      await saveState(deps.fs, deps.statePath, {
        ...state,
        repositories: [...state.repositories, repository],
      });
      return { ok: true, repository };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  });
}

/** Clone an already-added repository into its localPath and stamp lastFetched. */
export async function cloneRepository(deps: RepoDeps, args: { id: string }): Promise<RepoResult> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null) return { ok: false, error: 'not-found' };
    // git clone runs in cwd=dirname(destination)=reposDir; that directory must
    // exist or execFile fails with "spawn git ENOENT" before git even starts.
    await deps.fs.mkdir(deps.reposDir);
    // Slow clone runs unlocked; the stamp re-reads fresh state under the lock.
    await deps.git.clone({ url: repo.url, destination: repo.localPath, lfs: repo.lfs });
    return await persistRepo(deps, args.id, { lastFetched: new Date().toISOString() });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Edit name and/or remote. Changing the URL re-points origin and re-derives kind/transport. */
export async function updateRepository(
  deps: RepoDeps,
  args: { id: string; name: string; url: string },
): Promise<RepoResult> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null) return { ok: false, error: 'not-found' };
    if (args.url !== repo.url) {
      try {
        await deps.git.setRemoteUrl(repo.localPath, args.url);
      } catch {
        // The clone may not exist yet (add/clone failed); the record still updates.
      }
    }
    const { kind, transport } = parseRemote(args.url);
    return await persistRepo(deps, args.id, {
      name: args.name.trim() === '' ? repo.name : args.name.trim(),
      url: args.url,
      kind,
      transport,
    });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Remove from state and delete the local clone directory. */
export async function removeRepository(deps: RepoDeps, args: { id: string }): Promise<RemoveResult> {
  try {
    const removed = await withStateLock(async () => {
      const state = await loadState(deps.fs, deps.statePath);
      const repo = state.repositories.find((r) => r.id === args.id);
      if (repo === undefined) return null;
      await saveState(deps.fs, deps.statePath, {
        ...state,
        repositories: state.repositories.filter((r) => r.id !== repo.id),
      });
      return repo;
    });
    if (removed === null) return { ok: false, error: 'not-found' };
    // Best-effort clone removal (outside the lock); the clone lives under reposDir.
    await rm(removed.localPath, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Fast-forward pull and stamp lastFetched. */
export async function syncRepository(deps: RepoDeps, args: { id: string }): Promise<RepoResult> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null) return { ok: false, error: 'not-found' };
    // Slow git work runs unlocked; the stamp re-reads fresh state under the lock.
    // If the clone dir is missing (e.g. an earlier clone failed), re-clone --
    // pulling in a non-existent cwd would fail with "spawn git ENOENT".
    if (await deps.fs.exists(repo.localPath)) {
      // Force the clone to match the remote exactly, discarding any local edits,
      // so an app-managed repo never diverges or hits merge conflicts.
      await deps.git.forcePull(repo.localPath);
      if (repo.lfs) await deps.git.lfsPull(repo.localPath);
    } else {
      await deps.fs.mkdir(deps.reposDir);
      await deps.git.clone({ url: repo.url, destination: repo.localPath, lfs: repo.lfs });
    }
    return await persistRepo(deps, args.id, { lastFetched: new Date().toISOString() });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Branch + skill count for a clone; zeros/null when missing or on any failure. */
export async function describeRepository(deps: RepoDeps, args: { id: string }): Promise<RepoInfo> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null || !(await deps.fs.exists(repo.localPath))) {
      return { branch: null, skillCount: 0 };
    }
    let branch: string | null = null;
    try {
      const b = await deps.git.currentBranch(repo.localPath);
      branch = b === '' || b === 'HEAD' ? null : b;
    } catch {
      branch = null;
    }
    const { skills } = await resolveSkills(deps.fs, repo.localPath);
    return { branch, skillCount: skills.length };
  } catch {
    return { branch: null, skillCount: 0 };
  }
}

/** Update availability; false on any failure (e.g. no upstream / fetch error). */
export async function hasRepoUpdate(deps: RepoDeps, args: { id: string }): Promise<boolean> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null) return false;
    return await repoHasUpdate(deps.git, repo);
  } catch {
    return false;
  }
}
