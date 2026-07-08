/**
 * OpenCode adapter.
 *
 * Path and hook choices are isolated to this module: when OpenCode's real
 * on-disk layout is confirmed, only the values below change, never their
 * consumers.
 *
 * - Skills: project `<project>/.opencode/skills/<name>/`, global
 *   `~/.config/opencode/skills/<name>/` (OpenCode follows the XDG convention for
 *   its per-user configuration).
 * - Hooks: `delimited-text` into the OpenCode config file. OpenCode's config is
 *   a comment-capable format, so SkillKeeper inserts an owned, comment-delimited
 *   region (comment token `#`) rather than merging JSON. This also exercises the
 *   delimited-text strategy across the built-in adapter set.
 */

import type { AgentTarget, HostEnv } from '@skillkeeper/core';
import { makeAdapter } from './makeAdapter.js';
import { baseDir, joinPath, requireProjectDir } from './paths.js';

/** OpenCode's base config directory differs between project and global scope. */
function opencodeDir(target: AgentTarget, env: HostEnv): string {
  return target.scope === 'project'
    ? joinPath(requireProjectDir(env), '.opencode')
    : joinPath(env.homeDir, '.config', 'opencode');
}

export const opencodeAdapter = makeAdapter({
  kind: 'opencode',
  skillsRoot: (target, env) => joinPath(opencodeDir(target, env), 'skills'),
  availabilityDir: (env) => joinPath(env.homeDir, '.config', 'opencode'),
  guidanceFile: async (target, env) => joinPath(baseDir(target, env), 'AGENTS.md'),
  hook: {
    strategy: 'delimited-text',
    commentToken: '#',
    async resolveTargetFile(target: AgentTarget, env: HostEnv): Promise<string> {
      return joinPath(opencodeDir(target, env), 'opencode.json');
    },
  },
});
