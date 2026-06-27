/**
 * Claude adapter: the reference implementation, supporting BOTH skills and
 * hooks.
 *
 * - Skills live under `<base>/.claude/skills/<name>/`, where `<base>` is the
 *   project directory (project scope) or the user home directory (global
 *   scope). `destinationRoot` returns the `skills` root; the install engine
 *   appends the per-skill directory.
 * - Hooks use the `json-merge` strategy into Claude `settings.json`
 *   (`<base>/.claude/settings.json`). The core `hookJson` functions perform the
 *   merge and carry the `_skillkeeper` ownership marker; this adapter only
 *   declares the capability and resolves the target file.
 * - External discovery lists skill directories already present under the skills
 *   root (those directly containing `SKILL.md`).
 */

import type { AgentAdapter, AgentTarget, DiscoveredSkill, HostEnv } from '@skillkeeper/core';
import { baseDir, discoverSkillDirs, fsOf, joinPath } from './paths.js';

/** `<base>/.claude` for the given target. */
function claudeDir(target: AgentTarget, env: HostEnv): string {
  return joinPath(baseDir(target, env), '.claude');
}

/** `<base>/.claude/skills` for the given target. */
function skillsRoot(target: AgentTarget, env: HostEnv): string {
  return joinPath(claudeDir(target, env), 'skills');
}

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',

  async isAvailable(env: HostEnv): Promise<boolean> {
    // Claude is considered usable when the user-level `.claude` directory
    // exists. Global scope is the right probe: a user with Claude configured
    // has `~/.claude` regardless of any single project.
    return fsOf(env).exists(joinPath(env.homeDir, '.claude'));
  },

  async destinationRoot(target: AgentTarget, env: HostEnv): Promise<string> {
    return skillsRoot(target, env);
  },

  async discoverInstalled(target: AgentTarget, env: HostEnv): Promise<DiscoveredSkill[]> {
    return discoverSkillDirs(fsOf(env), skillsRoot(target, env));
  },

  hookSupport: {
    strategy: 'json-merge',
    async resolveTargetFile(target: AgentTarget, env: HostEnv): Promise<string> {
      return joinPath(claudeDir(target, env), 'settings.json');
    },
  },
};
