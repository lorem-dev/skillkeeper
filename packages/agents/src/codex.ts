/**
 * Codex adapter.
 *
 * Path and hook choices are isolated to this module: when Codex's real on-disk
 * layout is confirmed, only the values below change, never their consumers.
 *
 * - Skills: project `<project>/.codex/skills/<name>/`, global
 *   `~/.codex/skills/<name>/`.
 * - Hooks: `json-merge` into `<base>/.codex/settings.json` under `hooks`.
 *   Codex stores configuration as a structured settings file with no comment
 *   syntax, so JSON merge with an ownership marker is the appropriate strategy.
 */

import type { AgentTarget, HostEnv } from '@skillkeeper/core';
import { makeAdapter } from './makeAdapter.js';
import { baseDir, joinPath } from './paths.js';

function codexDir(target: AgentTarget, env: HostEnv): string {
  return joinPath(baseDir(target, env), '.codex');
}

export const codexAdapter = makeAdapter({
  kind: 'codex',
  skillsRoot: (target, env) => joinPath(codexDir(target, env), 'skills'),
  availabilityDir: (env) => joinPath(env.homeDir, '.codex'),
  hook: {
    strategy: 'json-merge',
    async resolveTargetFile(target: AgentTarget, env: HostEnv): Promise<string> {
      return joinPath(codexDir(target, env), 'settings.json');
    },
  },
});
