/**
 * GitHub Copilot adapter.
 *
 * Path and hook choices are isolated to this module: when Copilot's real on-disk
 * layout is confirmed, only the values below change, never their consumers.
 *
 * - Skills: project `<project>/.github/copilot/skills/<name>/` (Copilot reads
 *   project configuration from `.github`), global
 *   `~/.config/github-copilot/skills/<name>/` (Copilot's per-user config lives
 *   under `~/.config/github-copilot`).
 * - Hooks: `json-merge` into the Copilot config JSON under `hooks`. The
 *   per-user config file is `~/.config/github-copilot/hooks.json`; the project
 *   file mirrors it under `.github/copilot/`.
 */

import type { AgentTarget, HostEnv } from '@skillkeeper/core';
import { makeAdapter } from './makeAdapter.js';
import { baseDir, joinPath, requireProjectDir } from './paths.js';

/** Copilot's base config directory differs between project and global scope. */
function copilotDir(target: AgentTarget, env: HostEnv): string {
  return target.scope === 'project'
    ? joinPath(requireProjectDir(env), '.github', 'copilot')
    : joinPath(env.homeDir, '.config', 'github-copilot');
}

export const copilotAdapter = makeAdapter({
  kind: 'copilot',
  skillsRoot: (target, env) => joinPath(copilotDir(target, env), 'skills'),
  availabilityDir: (env) => joinPath(env.homeDir, '.config', 'github-copilot'),
  guidanceFile: async (target, env) =>
    joinPath(baseDir(target, env), '.github', 'copilot-instructions.md'),
  hook: {
    strategy: 'json-merge',
    async resolveTargetFile(target: AgentTarget, env: HostEnv): Promise<string> {
      return joinPath(copilotDir(target, env), 'hooks.json');
    },
  },
});
