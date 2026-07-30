import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE_ID } from '@/domain';
import type { AvailableSkill, InstallManifest, Project, Repository } from '@/services/bridge';
import {
  buildProjectModel,
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

  it('omits the global root entirely when the label is null', () => {
    // The install modal scopes the tree to the one project chosen in step 1. A
    // global root there is unreachable: its leaf ids carry another scope, which
    // `buildProjectPlan` drops, so its checkboxes showed an "add" badge and
    // produced no operation.
    const nodes = buildProjectTree(available, [repo], projects, null);

    expect(nodes.map((n) => n.id)).toEqual([projectNodeId('p1')]);
  });
});

describe('buildProjectModel', () => {
  const hashed = (contentHash: string): AvailableSkill =>
    ({ repoId: 'r1', name: 'fmt', contentHash }) as AvailableSkill;

  const withHash = (
    scope: 'project' | 'global',
    contentHash: string,
    projectId?: string,
  ): InstallManifest => ({ ...manifest(scope, projectId), contentHash }) as InstallManifest;

  const globalLeaf = projectSkillKey(GLOBAL_SCOPE_ID, 'r1', undefined, 'fmt');
  const projectLeaf = projectSkillKey('p1', 'r1', undefined, 'fmt');

  it('marks the global leaf present without touching the project leaves', () => {
    const model = buildProjectModel(
      [hashed('sha256:a')],
      [repo],
      [repo],
      projects,
      [withHash('global', 'sha256:a')],
      'Global',
    );

    expect(model.statusByLeaf.get(globalLeaf)).toBe('present');
    // The two scopes are independent: a project install exists precisely to
    // shadow a global one, so the project row still offers the install.
    expect(model.statusByLeaf.get(projectLeaf)).toBe('available');
  });

  it('marks the project leaf present without touching the global leaf', () => {
    const model = buildProjectModel(
      [hashed('sha256:a')],
      [repo],
      [repo],
      projects,
      [withHash('project', 'sha256:a', 'p1')],
      'Global',
    );

    expect(model.statusByLeaf.get(projectLeaf)).toBe('present');
    expect(model.statusByLeaf.get(globalLeaf)).toBe('available');
  });

  it('gives a stale global install an update carrying the global apply scope', () => {
    const model = buildProjectModel(
      [hashed('sha256:new')],
      [repo],
      [repo],
      projects,
      [withHash('global', 'sha256:old')],
      'Global',
    );

    expect(model.statusByLeaf.get(globalLeaf)).toBe('update');
    const ups = model.updatesByNode.get(globalLeaf);
    expect(ups).toHaveLength(1);
    // The update badge re-installs through `applySkills`, so it must carry the
    // scope, not a project id of "global": at project scope the remove no-ops
    // and the install dies in `destination_root`, leaving the skill permanently
    // un-updatable from the interface.
    expect(ups![0]!.target).toEqual({ scope: 'global', projectId: '', projectPath: '' });
    expect(ups![0]!.agents).toEqual(['claude']);
    expect(ups![0]!.ref).toEqual({ repoId: 'r1', group: undefined, name: 'fmt' });
    // The project subtree gains no update: nothing is installed there.
    expect(model.updatesByNode.get(projectLeaf)).toBeUndefined();
  });

  it('gives a stale project install an update carrying that project id and path', () => {
    const model = buildProjectModel(
      [hashed('sha256:new')],
      [repo],
      [repo],
      projects,
      [withHash('project', 'sha256:old', 'p1')],
      'Global',
    );

    const ups = model.updatesByNode.get(projectLeaf);
    expect(ups).toHaveLength(1);
    expect(ups![0]!.target).toEqual({
      scope: 'project',
      projectId: 'p1',
      projectPath: '/work/one',
    });
    expect(model.updatesByNode.get(globalLeaf)).toBeUndefined();
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
