import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { McpInstall, Repository, Project, AvailableSkill } from '@/services/bridge';
import {
  buildRepoTree,
  buildProjectModel,
  buildProjectPlan,
  repoGroupNodeId,
  repoNodeId,
  projectRepoNodeId,
  projectGroupNodeId,
  projectNodeId,
} from '@/entities/skill';
import type { TreeNode } from '@/shared/ui';
import { attachRepoMcpLeaves, attachProjectMcpLeaves } from './mcpTree';
import type { McpRowAction } from './mcpTree';

function repo(over: Partial<Repository> & { id: string; name: string }): Repository {
  return {
    url: `git@example.com:acme/${over.id}.git`,
    kind: 'generic',
    transport: 'ssh',
    lfs: false,
    localPath: `/repos/${over.id}`,
    ...over,
  };
}

function project(over: Partial<Project> & { id: string; name: string }): Project {
  return {
    path: `/projects/${over.id}`,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function skill(over: Partial<AvailableSkill> & { repoId: string; name: string }): AvailableSkill {
  return {
    repoName: over.repoId,
    remote: `git@example.com:acme/${over.repoId}.git`,
    hasGuidance: false,
    contentHash: 'h1',
    ...over,
  };
}

function preset(over: Partial<McpPreset> & { id: string; name: string }): McpPreset {
  return {
    origin: 'repo',
    def: { name: over.name, type: 'stdio', command: 'run' },
    hash: `sha256:${over.id}`,
    params: [],
    hasRules: false,
    ...over,
  };
}

function install(over: Partial<McpInstall> & { instanceName: string; agent: McpInstall['agent'] }): McpInstall {
  return {
    projectId: 'p1',
    hash: 'sha256:x',
    hasParams: false,
    identity: { source: 'unknown' },
    ...over,
  };
}

/** Find a node by id anywhere in the tree (depth-first). */
function findNode(nodes: readonly TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children !== undefined) {
      const found = findNode(n.children, id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Every node id in the tree, depth-first. */
function allIds(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.id);
    if (n.children !== undefined) out.push(...allIds(n.children));
  }
  return out;
}

describe('attachRepoMcpLeaves', () => {
  const repoA = repo({ id: 'r1', name: 'Repo A' });
  const repoB = repo({ id: 'r2', name: 'Repo B' });
  const repos = [repoA, repoB];

  it('places a grouped repo preset after the skill leaves in the matching group node', () => {
    const base = buildRepoTree(
      [skill({ repoId: 'r1', group: 'g', name: 'skill-a' })],
      repos,
    );
    const p = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });

    const out = attachRepoMcpLeaves(base, [p], repos, (preset) => preset.id);

    const groupNode = findNode(out, repoGroupNodeId('r1', 'g'));
    expect(groupNode).toBeDefined();
    const children = groupNode!.children ?? [];
    expect(children).toHaveLength(2);
    expect(children[0]!.id).not.toMatch(/^mcp::/);
    expect(children[1]!.trailing).toBe('repo:r1:g:tool');
    expect(children[1]!.id).toMatch(/^mcp::/);
  });

  it('appends an ungrouped repo preset directly under the repo root, after skill leaves', () => {
    const base = buildRepoTree(
      [skill({ repoId: 'r1', name: 'skill-a' })],
      repos,
    );
    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });

    const out = attachRepoMcpLeaves(base, [p], repos, (preset) => preset.id);

    const root = findNode(out, repoNodeId('r1'));
    const children = root!.children ?? [];
    expect(children.map((c) => c.id)).toEqual([
      expect.not.stringMatching(/^mcp::/),
      expect.stringMatching(/^mcp::/),
    ]);
  });

  it('creates a fresh repo root for a repo that has MCP presets but no skills at all', () => {
    const base = buildRepoTree([], repos); // no skills anywhere -> buildRepoTree returns []
    const p = preset({ id: 'repo:r2::tool', name: 'tool', repoId: 'r2' });

    const out = attachRepoMcpLeaves(base, [p], repos, () => 'x');

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(repoNodeId('r2'));
    expect(out[0]!.label).toBe('Repo B');
    expect(out[0]!.children).toHaveLength(1);
  });

  it('ignores manual-origin presets and presets for repos not in the given repo list', () => {
    const base = buildRepoTree([], repos);
    const manual = preset({ id: 'm1', name: 'manual-tool', origin: 'manual' });
    const untracked = preset({ id: 'repo:r9::tool', name: 'tool', repoId: 'r9' });

    const out = attachRepoMcpLeaves(base, [manual, untracked], repos, () => 'x');

    expect(out).toEqual([]);
  });

  it('never produces an id that collides with a skill leaf id', () => {
    const base = buildRepoTree(
      [skill({ repoId: 'r1', group: 'g', name: 'tool' })],
      repos,
    );
    const p = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });

    const out = attachRepoMcpLeaves(base, [p], repos, () => 'x');
    const ids = allIds(out);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('attachProjectMcpLeaves', () => {
  const repoA = repo({ id: 'r1', name: 'Repo A' });
  const repos = [repoA];
  const p1 = project({ id: 'p1', name: 'Project One' });
  const projects = [p1];

  it('groups multi-agent installs of the same preset into a single "remove" row nested under project/repo/group', () => {
    const base = buildProjectModel([], repos, repos, projects, []);
    const grouped = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });
    const installs: McpInstall[] = [
      install({
        instanceName: 'tool_1',
        agent: 'claude',
        identity: { remote: repoA.url, group: 'g', source: 'tool' },
      }),
      install({
        instanceName: 'tool_1',
        agent: 'cursor',
        identity: { remote: repoA.url, group: 'g', source: 'tool' },
      }),
    ];

    let seen: McpRowAction | undefined;
    const out = attachProjectMcpLeaves(base.nodes, [grouped], installs, projects, repos, (action) => {
      seen = action;
      return 'x';
    });

    const groupNode = findNode(out, projectGroupNodeId('p1', 'r1', 'g'));
    expect(groupNode!.children).toHaveLength(1);
    expect(seen).toEqual({ kind: 'remove', installs });
  });

  it('shows an uninstalled repo preset as an "install" row with the project preselected', () => {
    const base = buildProjectModel([], repos, repos, projects, []);
    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });

    let seen: McpRowAction | undefined;
    const out = attachProjectMcpLeaves(base.nodes, [p], [], projects, repos, (action) => {
      seen = action;
      return 'x';
    });

    const repoNode = findNode(out, projectRepoNodeId('p1', 'r1'));
    expect(repoNode!.children).toHaveLength(1);
    expect(seen).toEqual({ kind: 'install', preset: p, projectId: 'p1' });
  });

  it('places an installed instance with no matching preset directly under the project root (unmanaged-style)', () => {
    const base = buildProjectModel([], repos, repos, projects, []);
    const orphanInstall = install({
      instanceName: 'ghost_1',
      agent: 'claude',
      identity: { source: 'ghost' },
    });

    const out = attachProjectMcpLeaves(base.nodes, [], [orphanInstall], projects, repos, () => 'x');

    const projNode = findNode(out, projectNodeId('p1'));
    const rootLeaf = (projNode!.children ?? []).find((c) => c.label === 'ghost');
    expect(rootLeaf).toBeDefined();
    expect(rootLeaf!.trailing).toBe('x');
  });

  it('adds MCP children to a project node that buildProjectModel already created empty', () => {
    // buildProjectModel always emits one node per project, even with no
    // skills at all -- unlike buildRepoTree, which skips empty repos.
    const base = buildProjectModel([], repos, repos, projects, []);
    expect(base.nodes).toHaveLength(1);
    expect(base.nodes[0]!.children).toEqual([]);

    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });
    const out = attachProjectMcpLeaves(base.nodes, [p], [], projects, repos, () => 'x');

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(projectNodeId('p1'));
    expect(out[0]!.label).toBe('Project One');
    expect(out[0]!.children).toHaveLength(1);
  });

  it('creates a fresh project node when the base tree omits the project entirely', () => {
    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });
    const out = attachProjectMcpLeaves([], [p], [], projects, repos, () => 'x');

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(projectNodeId('p1'));
    expect(out[0]!.label).toBe('Project One');
    expect(out[0]!.children).toHaveLength(1);
  });

  it('never produces an id that collides with a skill leaf id', () => {
    const base = buildProjectModel(
      [skill({ repoId: 'r1', group: 'g', name: 'tool' })],
      repos,
      repos,
      projects,
      [],
    );
    const p = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });

    const out = attachProjectMcpLeaves(base.nodes, [p], [], projects, repos, () => 'x');
    const ids = allIds(out);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('MCP leaf ids never enter the checkbox / apply-plan math', () => {
  it('buildProjectPlan ignores an mcp-prefixed key even if it somehow ends up in checkedKeys', () => {
    const withoutMcp = buildProjectPlan('p1', ['p1::r1::g::tool'], [], ['claude']);
    const withMcp = buildProjectPlan(
      'p1',
      ['p1::r1::g::tool', 'mcp::p1::repo:r1:g:tool'],
      [],
      ['claude'],
    );
    expect(withMcp).toEqual(withoutMcp);
  });
});
