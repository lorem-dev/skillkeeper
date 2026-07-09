/**
 * Repository management for the desktop main process: add/clone/edit/remove/sync
 * plus update detection, over the core state store and GitPort. Errors are
 * returned as result shapes; nothing throws across the IPC boundary.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { FsPort, GitPort, Repository } from '@skillkeeper/core';
import {
  loadState,
  saveState,
  parseRemote,
  repoHasUpdate,
  resolveSkills,
  resolvedContentHash,
} from '@skillkeeper/core';
import { withStateLock } from './stateLock.js';

export interface RepoDeps {
  readonly fs: FsPort;
  readonly git: GitPort;
  readonly statePath: string;
  /** Directory clones live under: <appData>/repositories */
  readonly reposDir: string;
  /**
   * A GitPort that runs user-initiated clone/sync IN the embedded terminal
   * session (its output is the terminal's output, and an ssh key passphrase
   * prompt reads the terminal's input) instead of out-of-band. Optional so
   * existing RepoDeps test construction (and the CLI) still work; when absent,
   * clone/sync fall back to `git`. Update checks always use `git` (silent).
   */
  readonly terminalGit?: GitPort;
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
    // Runs in the terminal session (arg-array, no shell). It stays in the
    // background unless git asks for input (then the terminal surfaces itself).
    const git = deps.terminalGit ?? deps.git;
    await git.clone({ url: repo.url, destination: repo.localPath, lfs: repo.lfs });
    return await persistRepo(deps, args.id, { lastFetched: new Date().toISOString() });
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

/** Edit name and/or remote. Changing the URL re-points origin and re-derives kind/transport. */
export async function updateRepository(
  deps: RepoDeps,
  args: { id: string; name: string; url: string; branch?: string },
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
    const branch = args.branch !== undefined && args.branch !== '' ? args.branch : undefined;
    if (branch !== undefined && (await deps.fs.exists(repo.localPath))) {
      // Force-checkout the chosen branch in the terminal (visible, discards local
      // edits) so the repo tracks it. If the clone is missing the branch is still
      // recorded below and sync applies it on the next run.
      try {
        await (deps.terminalGit ?? deps.git).checkout(repo.localPath, branch);
      } catch (err) {
        return { ok: false, error: message(err) };
      }
    }
    return await persistRepo(deps, args.id, {
      name: args.name.trim() === '' ? repo.name : args.name.trim(),
      url: args.url,
      kind,
      transport,
      ...(branch !== undefined ? { branch } : {}),
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
    // Runs in the terminal session (background unless git needs input). The
    // update check uses the silent execFile git.
    const git = deps.terminalGit ?? deps.git;
    // If the clone dir is missing (e.g. an earlier clone failed), re-clone --
    // pulling in a non-existent cwd would fail with "spawn git ENOENT".
    if (await deps.fs.exists(repo.localPath)) {
      // Force-switch to the tracked branch first (if set) so forcePull's
      // `reset --hard @{u}` applies that branch's upstream. Force the clone to
      // match the remote exactly, discarding any local edits, so an app-managed
      // repo never diverges or hits merge conflicts.
      if (repo.branch !== undefined && repo.branch !== '') {
        await git.checkout(repo.localPath, repo.branch);
      }
      await git.forcePull(repo.localPath);
      if (repo.lfs) await git.lfsPull(repo.localPath);
    } else {
      await deps.fs.mkdir(deps.reposDir);
      await git.clone({ url: repo.url, destination: repo.localPath, lfs: repo.lfs });
      // A fresh clone lands on the remote default branch; switch to the tracked one.
      if (repo.branch !== undefined && repo.branch !== '') {
        await git.checkout(repo.localPath, repo.branch);
      }
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

/** One skill available in a repository's working tree (for the Skills page tree). */
export interface AvailableSkill {
  readonly repoId: string;
  readonly repoName: string;
  /** Source repository remote URL; the stable identity for matching installs. */
  readonly remote: string;
  /** Optional one-level group (SkillId.group). */
  readonly group?: string;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Content hash of the skill body (excludes `.skid.yml`), for update detection. */
  readonly contentHash: string;
  /** The skill ships a GUIDE.md/RULES.md guidance file (drives the "rules" badge). */
  readonly hasGuidance: boolean;
}

/**
 * Every skill available across all cloned repositories, resolved from each
 * working tree. Repos whose clone is missing or fails to resolve are skipped.
 */
export async function listAvailableSkills(deps: RepoDeps): Promise<AvailableSkill[]> {
  const out: AvailableSkill[] = [];
  let repos: readonly Repository[];
  try {
    repos = (await loadState(deps.fs, deps.statePath)).repositories;
  } catch {
    return out;
  }
  for (const repo of repos) {
    try {
      if (!(await deps.fs.exists(repo.localPath))) continue;
      const { skills } = await resolveSkills(deps.fs, repo.localPath);
      for (const skill of skills) {
        out.push({
          repoId: repo.id,
          repoName: repo.name,
          remote: repo.url,
          group: skill.id.group,
          name: skill.id.name,
          version: skill.manifest.version,
          description: skill.manifest.description,
          contentHash: await resolvedContentHash(deps.fs, repo.localPath, skill),
          hasGuidance:
            skill.files.includes(`${skill.rootPath}/GUIDE.md`) ||
            skill.files.includes(`${skill.rootPath}/RULES.md`),
        });
      }
    } catch {
      // Skip a repo that cannot be resolved; others still list.
    }
  }
  return out;
}

/** Local + origin branch names for a clone; empty when missing or on any failure. */
export async function listBranches(deps: RepoDeps, args: { id: string }): Promise<string[]> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null || !(await deps.fs.exists(repo.localPath))) return [];
    return await deps.git.listBranches(repo.localPath);
  } catch {
    return [];
  }
}

/** Update availability; false on any failure (e.g. no upstream / fetch error). */
export async function hasRepoUpdate(deps: RepoDeps, args: { id: string }): Promise<boolean> {
  try {
    const repo = await findRepo(deps, args.id);
    if (repo === null) return false;
    // Run the fetch in the terminal (visible, ssh-capable) like a pull; the
    // rev-parse comparisons stay on the silent port.
    return await repoHasUpdate(deps.git, repo, deps.terminalGit ?? deps.git);
  } catch {
    return false;
  }
}
