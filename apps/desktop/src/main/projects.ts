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
import { detectProjectAgents } from './skills.js';
import { resolveProjectIcon } from './projectIcon.js';

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
  /** Number of agents detected in the project folder (by markers). */
  readonly agentCount: number;
  /**
   * A data URL for the project's own icon when the folder carries one (see
   * projectIcon.ts for the locations and the safety check); undefined otherwise,
   * so the card falls back to the default project glyph.
   */
  readonly iconDataUrl?: string;
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

/** Whether the project's folder still exists on disk (false if untracked/gone). */
export async function projectExists(deps: ProjectDeps, args: { id: string }): Promise<boolean> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const project = state.projects.find((p) => p.id === args.id);
    if (project === undefined) return false;
    return await deps.fs.exists(project.path);
  } catch {
    return false;
  }
}

/** Skill counts + detected-agent count for a project (for the card badges). */
export async function describeProject(deps: ProjectDeps, args: { id: string }): Promise<ProjectInfo> {
  try {
    const state = await loadState(deps.fs, deps.statePath);
    const installs = state.installs.filter((m) => m.target.projectId === args.id);
    const project = state.projects.find((p) => p.id === args.id);
    const agentCount = project !== undefined ? (await detectProjectAgents(deps.fs, project.path)).length : 0;
    const iconDataUrl = project !== undefined ? resolveProjectIcon(project.path) : undefined;
    return {
      skillCount: installs.length,
      fromReposCount: installs.filter((m) => m.sourceRepoId !== undefined).length,
      agentCount,
      iconDataUrl,
    };
  } catch {
    return { skillCount: 0, fromReposCount: 0, agentCount: 0 };
  }
}
