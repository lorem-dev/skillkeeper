/**
 * Install scopes as the interface knows them. A tracked project is identified
 * by its own id; the user-wide scope is identified by one reserved id, which is
 * a label on the wire and in tree/selector ids only -- `state.json` never holds
 * a project with it.
 */
import type { AgentTarget, Project, Scope } from '@/services/bridge';

/** The reserved id of the user-wide scope. */
export const GLOBAL_SCOPE_ID = 'global';

/** Whether a tree/selector id denotes the user-wide scope. */
export function isGlobalScope(id: string): boolean {
  return id === GLOBAL_SCOPE_ID;
}

/** The scope fields the apply contracts take. */
export interface ApplyScope {
  readonly scope: Scope;
  readonly projectId: string;
  readonly projectPath: string;
}

/**
 * Turn a tree/selector id into apply arguments: the global scope carries no
 * project fields, a tracked project carries its own id and path. `null` when the
 * id is neither -- the caller skips that group rather than guessing a path.
 */
export function applyScope(id: string, projects: readonly Project[]): ApplyScope | null {
  if (isGlobalScope(id)) return { scope: 'global', projectId: '', projectPath: '' };
  const project = projects.find((p) => p.id === id);
  if (project === undefined) return null;
  return { scope: 'project', projectId: project.id, projectPath: project.path };
}

/**
 * The tree/selector id an installed manifest belongs under: the reserved global
 * id for a user-wide target, otherwise the project's id. `undefined` when a
 * project-scope target carries no id, which the caller skips.
 */
export function scopeIdOf(target: AgentTarget): string | undefined {
  if (target.scope === 'global') return GLOBAL_SCOPE_ID;
  return target.projectId;
}
