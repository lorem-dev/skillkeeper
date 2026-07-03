/**
 * Repository management for the desktop main process: add/clone/edit/remove/sync
 * plus update detection, over the core state store and GitPort. Errors are
 * returned as result shapes; nothing throws across the IPC boundary.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { FsPort, GitPort, Repository } from '@skillkeeper/core';
import { loadState, saveState, parseRemote, repoHasUpdate } from '@skillkeeper/core';

export interface RepoDeps {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly statePath: string;
  /** Directory clones live under: <appData>/repositories */
  readonly reposDir: string;
}

export type RepoResult = { ok: true; repository: Repository } | { ok: false; error: string };
export type RemoveResult = { ok: true } | { ok: false; error: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Add a repository record (no clone yet), so the card can appear immediately. */
export async function addRepository(deps: RepoDeps, args: { url: string; name: string }): Promise<RepoResult> {
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
    await saveState(deps.fs, deps.statePath, { ...state, repositories: [...state.repositories, repository] });
    return { ok: true, repository };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Clone an already-added repository into its localPath and stamp lastFetched. */
export async function cloneRepository(deps: RepoDeps, args: { id: string }): Promise<RepoResult> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const repo = state.repositories.find((r) => r.id === args.id);
    if (repo === undefined) return { ok: false, error: 'not-found' };
    await deps.git.clone({ url: repo.url, destination: repo.localPath, lfs: repo.lfs });
    const updated: Repository = { ...repo, lastFetched: new Date().toISOString() };
    await saveState(deps.fs, deps.statePath, {
      ...state,
      repositories: state.repositories.map((r) => (r.id === repo.id ? updated : r)),
    });
    return { ok: true, repository: updated };
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
    const state = await loadState(deps.fs, deps.statePath);
    const repo = state.repositories.find((r) => r.id === args.id);
    if (repo === undefined) return { ok: false, error: 'not-found' };
    const urlChanged = args.url !== repo.url;
    if (urlChanged) {
      try {
        await deps.git.setRemoteUrl(repo.localPath, args.url);
      } catch {
        // The clone may not exist yet (add failed); the record still updates.
      }
    }
    const { kind, transport } = parseRemote(args.url);
    const updated: Repository = { ...repo, name: args.name.trim() || repo.name, url: args.url, kind, transport };
    await saveState(deps.fs, deps.statePath, {
      ...state,
      repositories: state.repositories.map((r) => (r.id === repo.id ? updated : r)),
    });
    return { ok: true, repository: updated };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Remove from state and delete the local clone directory. */
export async function removeRepository(deps: RepoDeps, args: { id: string }): Promise<RemoveResult> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const repo = state.repositories.find((r) => r.id === args.id);
    if (repo === undefined) return { ok: false, error: 'not-found' };
    await saveState(deps.fs, deps.statePath, {
      ...state,
      repositories: state.repositories.filter((r) => r.id !== repo.id),
    });
    // Best-effort clone removal; the clone lives under our reposDir.
    await rm(repo.localPath, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Fast-forward pull and stamp lastFetched. */
export async function syncRepository(deps: RepoDeps, args: { id: string }): Promise<RepoResult> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const repo = state.repositories.find((r) => r.id === args.id);
    if (repo === undefined) return { ok: false, error: 'not-found' };
    await deps.git.pull(repo.localPath);
    const updated: Repository = { ...repo, lastFetched: new Date().toISOString() };
    await saveState(deps.fs, deps.statePath, {
      ...state,
      repositories: state.repositories.map((r) => (r.id === repo.id ? updated : r)),
    });
    return { ok: true, repository: updated };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Update availability; false on any failure (e.g. no upstream / fetch error). */
export async function hasRepoUpdate(deps: RepoDeps, args: { id: string }): Promise<boolean> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const repo = state.repositories.find((r) => r.id === args.id);
    if (repo === undefined) return false;
    return await repoHasUpdate(deps.git, repo);
  } catch {
    return false;
  }
}
