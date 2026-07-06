/**
 * Project management for the desktop main process: add/edit/remove tracked
 * projects, plus a skill-count summary for the card badges, over the core state
 * store. Errors are returned as result shapes; nothing throws across IPC.
 *
 * A project is just a tracked folder on disk. Removing it only drops the record
 * from state -- the folder and its files are never touched.
 */
import { randomUUID } from 'node:crypto';
import type { FsPort, Project } from '@skillkeeper/core';
import { loadState, saveState } from '@skillkeeper/core';
import { withStateLock } from './stateLock.js';

export interface ProjectDeps {
  readonly fs: FsPort;
  readonly statePath: string;
}

export type ProjectResult = { ok: true; project: Project } | { ok: false; error: string };
export type RemoveResult = { ok: true } | { ok: false; error: string };

/** Skill-count summary for a project (for the card badges). */
export interface ProjectInfo {
  /** Total skills installed in the project (across agents). */
  readonly skillCount: number;
  /** Of those, how many were installed from a tracked repository. */
  readonly fromReposCount: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Add a tracked project for a chosen folder. */
export async function addProject(deps: ProjectDeps, args: { path: string; name: string }): Promise<ProjectResult> {
  return withStateLock(async () => {
    try {
      const state = await loadState(deps.fs, deps.statePath);
      if (state.projects.some((p) => p.path === args.path)) {
        return { ok: false, error: 'duplicate' };
      }
      const project: Project = {
        id: randomUUID(),
        path: args.path,
        name: args.name.trim() === '' ? args.path : args.name.trim(),
        addedAt: new Date().toISOString(),
      };
      await saveState(deps.fs, deps.statePath, {
        ...state,
        projects: [...state.projects, project],
      });
      return { ok: true, project };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  });
}

/** Update a project's folder and/or display name. */
export async function updateProject(
  deps: ProjectDeps,
  args: { id: string; path: string; name: string },
): Promise<ProjectResult> {
  return withStateLock(async () => {
    try {
      const state = await loadState(deps.fs, deps.statePath);
      const current = state.projects.find((p) => p.id === args.id);
      if (current === undefined) return { ok: false, error: 'not-found' };
      const updated: Project = {
        ...current,
        path: args.path.trim() === '' ? current.path : args.path,
        name: args.name.trim() === '' ? current.name : args.name.trim(),
      };
      await saveState(deps.fs, deps.statePath, {
        ...state,
        projects: state.projects.map((p) => (p.id === args.id ? updated : p)),
      });
      return { ok: true, project: updated };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  });
}

/** Stop tracking a project. The folder on disk is left untouched. */
export async function removeProject(deps: ProjectDeps, args: { id: string }): Promise<RemoveResult> {
  return withStateLock(async () => {
    try {
      const state = await loadState(deps.fs, deps.statePath);
      await saveState(deps.fs, deps.statePath, {
        ...state,
        projects: state.projects.filter((p) => p.id !== args.id),
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  });
}

/** Skill counts for a project, derived from the install manifests in state. */
export async function describeProject(deps: ProjectDeps, args: { id: string }): Promise<ProjectInfo> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const installs = state.installs.filter((m) => m.target.projectId === args.id);
    return {
      skillCount: installs.length,
      fromReposCount: installs.filter((m) => m.sourceRepoId !== undefined).length,
    };
  } catch {
    return { skillCount: 0, fromReposCount: 0 };
  }
}
