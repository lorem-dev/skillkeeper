/**
 * Cursor adapter.
 *
 * Path and hook choices are isolated to this module: when Cursor's real on-disk
 * layout is confirmed, only the values below change, never their consumers.
 *
 * - Skills: project `<project>/.cursor/skills/<name>/`, global
 *   `~/.cursor/skills/<name>/` (Cursor keeps per-user state under `~/.cursor`).
 * - Hooks: `json-merge` into `<base>/.cursor/settings.json` under `hooks`.
 *   Cursor configuration is JSON with no comment syntax, so a JSON merge with an
 *   ownership marker is the appropriate strategy.
 */

import type { AgentTarget, HostEnv } from '@skillkeeper/core';
import { makeAdapter } from './makeAdapter.js';
import { baseDir, fsOf, joinPath } from './paths.js';

function cursorDir(target: AgentTarget, env: HostEnv): string {
  return joinPath(baseDir(target, env), '.cursor');
}

export const cursorAdapter = makeAdapter({
  kind: 'cursor',
  skillsRoot: (target, env) => joinPath(cursorDir(target, env), 'skills'),
  availabilityDir: (env) => joinPath(env.homeDir, '.cursor'),
  guidanceFile: async (target, env) => {
    // Prefer an existing legacy .cursorrules; otherwise the modern rules file.
    const base = baseDir(target, env);
    const legacy = joinPath(base, '.cursorrules');
    if (await fsOf(env).exists(legacy)) return legacy;
    return joinPath(base, '.cursor', 'rules', 'skillkeeper.mdc');
  },
  hook: {
    strategy: 'json-merge',
    async resolveTargetFile(target: AgentTarget, env: HostEnv): Promise<string> {
      return joinPath(cursorDir(target, env), 'settings.json');
    },
  },
});
