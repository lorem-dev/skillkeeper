import { describe, expect, it } from 'vitest';
import { GLOBAL_SCOPE_ID } from '@/domain';
import type { AgentTarget, AvailableSkill, InstallManifest, Project, Repository } from '@/services/bridge';
import {
  buildProjectModel,
  buildProjectTree,
  buildRepoTree,
  installedAgentsByProject,
  installedLeafIds,
  parseProjectSkillKey,
  parseRepoSkillKey,
  projectGroupNodeId,
  projectNodeId,
  projectSkillKey,
  repoGroupNodeId,
  repoSkillKey,
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

function repoFixture(over: Partial<Repository> & { id: string; name: string }): Repository {
  return {
    url: `git@example.com:acme/${over.id}.git`,
    kind: 'generic',
    transport: 'ssh',
    lfs: false,
    localPath: `/repos/${over.id}`,
    ...over,
  };
}

const r1 = repoFixture({ id: 'r1', name: 'acme/skills' });

function skill(name: string, group?: string, contentHash = 'sha256:a'): AvailableSkill {
  return {
    repoId: 'r1',
    repoName: 'acme/skills',
    remote: r1.url,
    group,
    name,
    contentHash,
    hasGuidance: false,
  };
}

describe('buildRepoTree with nested groups', () => {
  it('nests a three-level group as three branches under the repo', () => {
    const [repoNode] = buildRepoTree([skill('clippy', 'platform/lint/rust')], [r1]);

    const platform = repoNode!.children![0]!;
    expect(platform.label).toBe('platform');
    expect(platform.id).toBe(repoGroupNodeId('r1', 'platform'));

    const lint = platform.children![0]!;
    expect(lint.label).toBe('lint');
    expect(lint.id).toBe(repoGroupNodeId('r1', 'platform/lint'));

    const rust = lint.children![0]!;
    expect(rust.label).toBe('rust');
    expect(rust.children![0]!.label).toBe('clippy');
  });

  it('keeps a nested leaf key parseable back to its full group path', () => {
    const [repoNode] = buildRepoTree([skill('clippy', 'platform/lint/rust')], [r1]);
    const leaf = repoNode!.children![0]!.children![0]!.children![0]!.children![0]!;

    expect(parseRepoSkillKey(leaf.id)).toEqual({
      repoId: 'r1',
      group: 'platform/lint/rust',
      name: 'clippy',
    });
  });

  it('shares a branch between a one-level and a three-level skill', () => {
    const [repoNode] = buildRepoTree(
      [skill('clippy', 'platform/lint/rust'), skill('style', 'platform')],
      [r1],
    );

    expect(repoNode!.children).toHaveLength(1);
    // Inside `platform`: the `lint` branch, then `platform`'s own leaf.
    expect(repoNode!.children![0]!.children!.map((n) => n.label)).toEqual(['lint', 'style']);
  });
});

describe('buildProjectModel update roll-up', () => {
  const project: Project = {
    id: 'p1',
    name: 'app',
    path: '/projects/p1',
    addedAt: '2026-01-01T00:00:00.000Z',
  };

  const target: AgentTarget = { agent: 'claude', scope: 'project', projectId: 'p1' };

  const installed: InstallManifest = {
    skillId: { group: 'a/b/c', name: 'clippy' },
    target,
    destinationRoot: '/projects/p1/.claude/skills',
    sourceRepoId: 'r1',
    sourceRemote: r1.url,
    contentHash: 'sha256:old',
    installedAt: '2026-01-01T00:00:00.000Z',
    files: [],
    hookEdits: [],
  };

  it('rolls an update up through every ancestor group node', () => {
    const model = buildProjectModel(
      [skill('clippy', 'a/b/c', 'sha256:new')],
      [r1],
      [r1],
      [project],
      [installed],
      null,
    );

    const ids = [...model.updatesByNode.keys()];
    expect(ids).toContain(projectGroupNodeId('p1', 'r1', 'a'));
    expect(ids).toContain(projectGroupNodeId('p1', 'r1', 'a/b'));
    expect(ids).toContain(projectGroupNodeId('p1', 'r1', 'a/b/c'));
  });

  it('records no group node for an ungrouped skill', () => {
    const model = buildProjectModel(
      [skill('minimal', undefined, 'sha256:new')],
      [r1],
      [r1],
      [project],
      [{ ...installed, skillId: { name: 'minimal' } }],
      null,
    );

    // The old code emitted a bogus `projectGroupNodeId(scope, repo, '')` here.
    expect([...model.updatesByNode.keys()]).not.toContain(projectGroupNodeId('p1', 'r1', ''));
  });
});

describe('key encoding against separator collisions', () => {
  // The separator alone was not enough: nothing forbids `::` inside a group
  // segment or a skill name, so these two DIFFERENT skills used to produce one
  // identical key -- sharing a tree node and a checkbox, and making it
  // impossible to select either independently.
  it('gives two skills distinct keys when one carries the separator in its group', () => {
    const a = repoSkillKey('r1', 'a::b', 'c');
    const b = repoSkillKey('r1', 'a', 'b::c');

    expect(a).not.toBe(b);
  });

  it('round-trips a group containing the separator', () => {
    const key = repoSkillKey('r1', 'std::vec', 'parser');

    expect(parseRepoSkillKey(key)).toEqual({
      repoId: 'r1',
      group: 'std::vec',
      name: 'parser',
    });
  });

  it('round-trips a name containing the separator', () => {
    const key = repoSkillKey('r1', 'tooling', 'fmt::check');

    expect(parseRepoSkillKey(key)).toEqual({
      repoId: 'r1',
      group: 'tooling',
      name: 'fmt::check',
    });
  });

  it('round-trips a nested group alongside a separator-bearing name', () => {
    const key = projectSkillKey('p1', 'r1', 'platform/lint/rust', 'clippy::fixups');

    expect(parseProjectSkillKey(key)).toEqual({
      projectId: 'p1',
      repoId: 'r1',
      group: 'platform/lint/rust',
      name: 'clippy::fixups',
    });
  });

  it('keeps an absent group distinguishable from an empty one', () => {
    expect(parseRepoSkillKey(repoSkillKey('r1', undefined, 'solo')).group).toBeUndefined();
  });
});
