import { describe, it, expect } from 'vitest';
import type { AgentKind, InstallManifest } from '@skillkeeper/core';
import { projectSkillCounts } from './projects.js';

/** Build a project-scoped install manifest for project 'p1'. */
function mk(over: { name: string; agent: AgentKind; repoId?: string; group?: string }): InstallManifest {
  return {
    skillId: { name: over.name, ...(over.group !== undefined ? { group: over.group } : {}) },
    target: { agent: over.agent, scope: 'project', projectId: 'p1' },
    destinationRoot: '/d',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    hookEdits: [],
    ...(over.repoId !== undefined ? { sourceRepoId: over.repoId } : {}),
  };
}

describe('projectSkillCounts', () => {
  const tracked = new Set(['r1', 'r2']);

  it('counts a skill installed for several agents as one skill', () => {
    const out = projectSkillCounts(
      [
        mk({ name: 'a', agent: 'claude', repoId: 'r1' }),
        mk({ name: 'a', agent: 'codex', repoId: 'r1' }),
        mk({ name: 'a', agent: 'cursor', repoId: 'r1' }),
      ],
      tracked,
    );
    expect(out.skillCount).toBe(1);
    expect(out.fromReposCount).toBe(1);
  });

  it('counts distinct skills by (repo, group, name)', () => {
    const out = projectSkillCounts(
      [
        mk({ name: 'a', agent: 'claude', repoId: 'r1' }),
        mk({ name: 'b', agent: 'claude', repoId: 'r1', group: 'web' }),
        mk({ name: 'a', agent: 'claude', repoId: 'r2' }), // same name, different repo -> distinct
      ],
      tracked,
    );
    expect(out.skillCount).toBe(3);
    expect(out.fromReposCount).toBe(3);
  });

  it('counts unmanaged and orphan skills as skills but not as from-repo', () => {
    const out = projectSkillCounts(
      [
        mk({ name: 'local', agent: 'claude', repoId: '' }), // unmanaged (empty repo id)
        mk({ name: 'orph', agent: 'claude', repoId: 'gone' }), // untracked repo
        mk({ name: 'a', agent: 'claude', repoId: 'r1' }), // tracked repo
      ],
      tracked,
    );
    expect(out.skillCount).toBe(3);
    expect(out.fromReposCount).toBe(1);
  });

  it('returns zeros for no installs', () => {
    expect(projectSkillCounts([], tracked)).toEqual({ skillCount: 0, fromReposCount: 0 });
  });
});
