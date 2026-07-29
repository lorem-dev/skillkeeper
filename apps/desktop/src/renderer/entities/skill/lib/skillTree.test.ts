import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE_ID } from '@/domain';
import type { AvailableSkill, InstallManifest, Project, Repository } from '@/services/bridge';
import {
  buildProjectTree,
  installedAgentsByProject,
  installedLeafIds,
  projectNodeId,
  projectSkillKey,
} from './skillTree';

const repo: Repository = {
  id: 'r1',
  name: 'Repo A',
  url: 'git@github.com:acme/a.git',
  kind: 'github',
  transport: 'ssh',
  lfs: false,
  localPath: '/tmp/a',
};

const projects: Project[] = [
  { id: 'p1', path: '/work/one', name: 'One', addedAt: '2026-01-01T00:00:00.000Z' },
];

const available: AvailableSkill[] = [{ repoId: 'r1', name: 'fmt' } as AvailableSkill];

const manifest = (scope: 'project' | 'global', projectId?: string): InstallManifest =>
  ({
    skillId: { name: 'fmt' },
    target: { agent: 'claude', scope, ...(projectId !== undefined ? { projectId } : {}) },
    destinationRoot: '/dest',
    sourceRepoId: 'r1',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    hookEdits: [],
  }) as InstallManifest;

describe('buildProjectTree', () => {
  it('puts the global root first, before every project', () => {
    const nodes = buildProjectTree(available, [repo], projects, 'Global');

    expect(nodes[0]!.id).toBe(projectNodeId(GLOBAL_SCOPE_ID));
    expect(nodes[0]!.label).toBe('Global');
    expect(nodes[0]!.selectable).toBe(false);
    expect(nodes[1]!.id).toBe(projectNodeId('p1'));
  });

  it('keys the global subtree leaves with the reserved id', () => {
    const nodes = buildProjectTree(available, [repo], projects, 'Global');
    const leaf = nodes[0]!.children![0]!.children![0]!;

    expect(leaf.id).toBe(projectSkillKey(GLOBAL_SCOPE_ID, 'r1', undefined, 'fmt'));
  });
});

describe('installedLeafIds', () => {
  it('buckets a global manifest under the reserved id', () => {
    expect(installedLeafIds([manifest('global')])).toEqual([
      projectSkillKey(GLOBAL_SCOPE_ID, 'r1', undefined, 'fmt'),
    ]);
  });

  it('leaves a project manifest keyed by its project', () => {
    expect(installedLeafIds([manifest('project', 'p1')])).toEqual([
      projectSkillKey('p1', 'r1', undefined, 'fmt'),
    ]);
  });

  it('skips a project manifest with no project id', () => {
    expect(installedLeafIds([manifest('project')])).toEqual([]);
  });
});

describe('installedAgentsByProject', () => {
  it('records the agents of the global scope under the reserved id', () => {
    expect(installedAgentsByProject([manifest('global')])).toEqual({
      [GLOBAL_SCOPE_ID]: ['claude'],
    });
  });
});
