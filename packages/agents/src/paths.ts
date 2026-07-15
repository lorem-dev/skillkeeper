/**
 * Shared helpers for the built-in agent adapters.
 *
 * The core {@link AgentAdapter} interface deliberately keeps its method
 * signatures free of an explicit `FsPort` parameter (see
 * `@skillkeeper/core/src/adapters/adapter.ts`). Filesystem-backed methods
 * (`isAvailable`, `discoverInstalled`) therefore read the {@link FsPort} from
 * the host environment they are handed. {@link AdapterHostEnv} is the concrete
 * shape the front ends pass in: a {@link HostEnv} plus the injected `FsPort`.
 * This keeps the adapters off `node:fs` entirely while still conforming to the
 * exact core interface signatures.
 */

import type { AgentTarget, FsPort, HostEnv } from '@skillkeeper/core';

/**
 * Environment variable carrying the absolute path of the active project
 * directory. The CLI/desktop wiring sets it when operating on a project-scope
 * target, since {@link AgentTarget} only carries a `projectId`, not a path.
 */
export const PROJECT_DIR_ENV = 'SKILLKEEPER_PROJECT_DIR';

/**
 * The host environment the built-in adapters consume: the core {@link HostEnv}
 * plus the injected {@link FsPort}. Front ends construct this; the adapters
 * never touch `node:fs` directly.
 */
export interface AdapterHostEnv extends HostEnv {
  readonly fs: FsPort;
}

/** Join path segments with a single forward slash, trimming stray slashes. */
export function joinPath(...segments: string[]): string {
  return segments
    .map((segment, index) =>
      index === 0 ? segment.replace(/\/+$/, '') : segment.replace(/^\/+|\/+$/g, ''),
    )
    .filter((segment) => segment.length > 0)
    .join('/');
}

/**
 * Resolve the project directory for a project-scope target from the host
 * environment. Throws a clear error when it is absent, so a project-scope
 * operation never silently falls back to a wrong location.
 */
export function requireProjectDir(env: HostEnv): string {
  const dir = env.env[PROJECT_DIR_ENV];
  if (dir === undefined || dir.trim() === '') {
    throw new Error(
      `No project directory available: set ${PROJECT_DIR_ENV} for project-scope operations`,
    );
  }
  return dir;
}

/**
 * Resolve the base directory for a target: the project directory for project
 * scope, the home directory for global scope.
 */
export function baseDir(target: AgentTarget, env: HostEnv): string {
  return target.scope === 'project' ? requireProjectDir(env) : env.homeDir;
}

/** Narrow a {@link HostEnv} to an {@link AdapterHostEnv}, asserting the fs. */
export function fsOf(env: HostEnv): FsPort {
  const fs = (env as Partial<AdapterHostEnv>).fs;
  if (fs === undefined) {
    throw new Error('Adapter host environment is missing an injected FsPort');
  }
  return fs;
}

/**
 * List immediate subdirectories of `skillsRoot` that directly contain a
 * `SKILL.md`. This is the on-disk view of installed skills; deciding which of
 * them SkillKeeper did not install (the "external" ones) is the core's job,
 * which compares this list against its install manifests.
 *
 * @param group Optional group label to attach to each discovered skill (used by
 *   agents that nest skills one level under a group directory).
 */
export async function discoverSkillDirs(
  fs: FsPort,
  skillsRoot: string,
  group?: string,
): Promise<{ name: string; path: string; group?: string }[]> {
  if (!(await fs.exists(skillsRoot))) return [];
  const entries = await fs.list(skillsRoot);
  const out: { name: string; path: string; group?: string }[] = [];
  for (const name of entries.sort()) {
    const dir = joinPath(skillsRoot, name);
    const stat = await fs.stat(dir);
    if (stat?.isDirectory !== true) continue;
    if (!(await fs.exists(joinPath(dir, 'SKILL.md')))) continue;
    out.push(group === undefined ? { name, path: dir } : { name, path: dir, group });
  }
  return out;
}
