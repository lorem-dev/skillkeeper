import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { McpInstall, Repository, Project } from '@/services/bridge';
import type { TreeNode } from '@/shared/ui';
import {
  buildMcpRepoTree,
  buildMcpProjectTree,
  mcpManualLeafId,
  mcpRepoRootId,
  mcpRepoGroupId,
  mcpRepoPresetLeafId,
  mcpProjectRootId,
  mcpProjectRepoNodeId,
  mcpProjectGroupNodeId,
} from './mcpTree';

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

describe('buildMcpRepoTree', () => {
  const repoA = repo({ id: 'r1', name: 'Repo A' });
  const repoB = repo({ id: 'r2', name: 'Repo B' });
  const repos = [repoA, repoB];

  it('places manual presets as top-level leaves, sorted by name, before the repo nodes', () => {
    const zebra = preset({ id: 'm-zebra', name: 'zebra', origin: 'manual' });
    const alpha = preset({ id: 'm-alpha', name: 'alpha', origin: 'manual' });
    const repoPreset = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });

    const { nodes, items } = buildMcpRepoTree([zebra, alpha, repoPreset], repos);

    expect(nodes[0]!.id).toBe(mcpManualLeafId('m-alpha'));
    expect(nodes[1]!.id).toBe(mcpManualLeafId('m-zebra'));
    expect(nodes[2]!.id).toBe(mcpRepoRootId('r1'));
    expect(items.get(mcpManualLeafId('m-alpha'))).toEqual({ kind: 'manual-preset', preset: alpha });
    expect(items.get(mcpManualLeafId('m-zebra'))).toEqual({ kind: 'manual-preset', preset: zebra });
  });

  it('nests a grouped repo preset under its repo/group node', () => {
    const p = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });

    const { nodes, items } = buildMcpRepoTree([p], repos);

    const groupNode = findNode(nodes, mcpRepoGroupId('r1', 'g'));
    expect(groupNode).toBeDefined();
    const leaf = groupNode!.children![0]!;
    expect(leaf.id).toBe(mcpRepoPresetLeafId(p.id));
    expect(items.get(leaf.id)).toEqual({ kind: 'repo-preset', preset: p });
  });

  it('nests an ungrouped repo preset directly under the repo root', () => {
    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });

    const { nodes } = buildMcpRepoTree([p], repos);

    const root = findNode(nodes, mcpRepoRootId('r1'));
    expect(root!.selectable).toBe(false);
    expect(root!.children).toHaveLength(1);
    expect(root!.children![0]!.id).toBe(mcpRepoPresetLeafId(p.id));
  });

  it('skips manual presets and presets whose repo is not in the given repo list when nesting', () => {
    const manual = preset({ id: 'm1', name: 'manual-tool', origin: 'manual' });
    const untracked = preset({ id: 'repo:r9::tool', name: 'tool', repoId: 'r9' });

    const { nodes } = buildMcpRepoTree([manual, untracked], repos);

    // Only the manual leaf shows -- no repo node for r9 since it is not in `repos`.
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe(mcpManualLeafId('m1'));
  });

  it('produces no duplicate ids', () => {
    const p1 = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });
    const p2 = preset({ id: 'repo:r1::other', name: 'other', repoId: 'r1' });
    const manual = preset({ id: 'm1', name: 'manual-tool', origin: 'manual' });

    const { nodes } = buildMcpRepoTree([p1, p2, manual], repos);
    const ids = allIds(nodes);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every leaf id in the tree through the items map', () => {
    const p1 = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g' });
    const manual = preset({ id: 'm1', name: 'manual-tool', origin: 'manual' });

    const { nodes, items } = buildMcpRepoTree([p1, manual], repos);

    const leafIds = [mcpManualLeafId('m1'), mcpRepoPresetLeafId('repo:r1:g:tool')];
    for (const id of leafIds) {
      expect(findNode(nodes, id)).toBeDefined();
      expect(items.get(id)).toBeDefined();
    }
  });
});

describe('buildMcpProjectTree', () => {
  const repoA = repo({ id: 'r1', name: 'Repo A' });
  const repos = [repoA];
  const p1 = project({ id: 'p1', name: 'Project One' });
  const projects = [p1];

  it('places manual presets as top-level leaves before the project nodes', () => {
    const manual = preset({ id: 'm1', name: 'manual-tool', origin: 'manual' });

    const { nodes } = buildMcpProjectTree([manual], [], projects, repos);

    expect(nodes[0]!.id).toBe(mcpManualLeafId('m1'));
    expect(nodes[1]!.id).toBe(mcpProjectRootId('p1'));
  });

  it('always renders a repo preset install row, even with no installed instance', () => {
    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1' });

    const { nodes, items } = buildMcpProjectTree([p], [], projects, repos);

    const repoNode = findNode(nodes, mcpProjectRepoNodeId('p1', 'r1'));
    expect(repoNode!.children).toHaveLength(1);
    const leaf = repoNode!.children![0]!;
    expect(items.get(leaf.id)).toEqual({ kind: 'repo-preset', preset: p });
  });

  it('keeps the install row after an instance is installed, and adds a named installed leaf beside it', () => {
    const grouped = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g', remote: repoA.url });
    const installs: McpInstall[] = [
      install({
        instanceName: 'tool_1',
        agent: 'claude',
        identity: { remote: repoA.url, group: 'g', source: 'tool' },
        hash: grouped.hash,
      }),
    ];

    const { nodes, items } = buildMcpProjectTree([grouped], installs, projects, repos);

    const groupNode = findNode(nodes, mcpProjectGroupNodeId('p1', 'r1', 'g'));
    expect(groupNode!.children).toHaveLength(2);
    const [installLeaf, installedLeaf] = groupNode!.children!;
    expect(items.get(installLeaf!.id)).toEqual({ kind: 'repo-preset', preset: grouped });
    expect(installedLeaf!.label).toBe('tool 1');
    expect(items.get(installedLeaf!.id)).toEqual({
      kind: 'installed',
      installs,
      updatable: false,
    });
  });

  it('sets updatable=true when the installed hash differs from the matching preset hash', () => {
    const grouped = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1', remote: repoA.url, hash: 'sha256:new' });
    const installs: McpInstall[] = [
      install({
        instanceName: 'tool_1',
        agent: 'claude',
        identity: { remote: repoA.url, source: 'tool' },
        hash: 'sha256:old',
      }),
    ];

    const { nodes, items } = buildMcpProjectTree([grouped], installs, projects, repos);

    const repoNode = findNode(nodes, mcpProjectRepoNodeId('p1', 'r1'));
    const installedLeaf = repoNode!.children!.find((c) => c.label === 'tool 1')!;
    expect(items.get(installedLeaf.id)).toEqual({ kind: 'installed', installs, updatable: true });
  });

  it('groups multi-agent installs of the same instance name into one named row', () => {
    const grouped = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1', remote: repoA.url });
    const installs: McpInstall[] = [
      install({ instanceName: 'tool_1', agent: 'claude', identity: { remote: repoA.url, source: 'tool' }, hash: grouped.hash }),
      install({ instanceName: 'tool_1', agent: 'cursor', identity: { remote: repoA.url, source: 'tool' }, hash: grouped.hash }),
    ];

    const { nodes, items } = buildMcpProjectTree([grouped], installs, projects, repos);

    const repoNode = findNode(nodes, mcpProjectRepoNodeId('p1', 'r1'));
    // Install row + one grouped row (not two).
    expect(repoNode!.children).toHaveLength(2);
    const installedLeaf = repoNode!.children!.find((c) => c.label === 'tool 1')!;
    expect(items.get(installedLeaf.id)).toEqual({ kind: 'installed', installs, updatable: false });
  });

  it('shows two distinct named rows when the same preset is installed twice', () => {
    const grouped = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1', remote: repoA.url });
    const installs: McpInstall[] = [
      install({ instanceName: 'tool_1', agent: 'claude', identity: { remote: repoA.url, source: 'tool' } }),
      install({ instanceName: 'tool_2', agent: 'claude', identity: { remote: repoA.url, source: 'tool' } }),
    ];

    const { nodes } = buildMcpProjectTree([grouped], installs, projects, repos);

    const repoNode = findNode(nodes, mcpProjectRepoNodeId('p1', 'r1'));
    expect(repoNode!.children).toHaveLength(3);
    const labels = repoNode!.children!.map((c) => c.label);
    expect(labels).toEqual(expect.arrayContaining(['tool', 'tool 1', 'tool 2']));
  });

  it('renders an installed instance with no matching preset as a muted leaf under a synthetic unlinked node', () => {
    const orphan = install({ instanceName: 'ghost_1', agent: 'claude', identity: { source: 'ghost' } });

    const { nodes, items } = buildMcpProjectTree([], [orphan], projects, repos);

    const projNode = findNode(nodes, mcpProjectRootId('p1'));
    const unlinkedNode = projNode!.children!.find((c) => c.muted === true);
    expect(unlinkedNode).toBeDefined();
    expect(unlinkedNode!.children).toHaveLength(1);
    const leaf = unlinkedNode!.children![0]!;
    expect(leaf.label).toBe('ghost 1');
    expect(leaf.muted).toBe(true);
    expect(items.get(leaf.id)).toEqual({ kind: 'unlinked', installs: [orphan] });
  });

  it('groups unlinked instances from the same source under one synthetic node', () => {
    const orphans: McpInstall[] = [
      install({ instanceName: 'ghost_1', agent: 'claude', identity: { source: 'ghost' } }),
      install({ instanceName: 'ghost_1', agent: 'cursor', identity: { source: 'ghost' } }),
      install({ instanceName: 'ghost_2', agent: 'claude', identity: { source: 'ghost' } }),
    ];

    const { nodes } = buildMcpProjectTree([], orphans, projects, repos);

    const projNode = findNode(nodes, mcpProjectRootId('p1'));
    const unlinkedNodes = projNode!.children!.filter((c) => c.muted === true);
    expect(unlinkedNodes).toHaveLength(1);
    expect(unlinkedNodes[0]!.children).toHaveLength(2);
  });

  it('always emits one node per project, even with no presets or installs at all', () => {
    const { nodes } = buildMcpProjectTree([], [], projects, repos);

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.id).toBe(mcpProjectRootId('p1'));
    expect(nodes[0]!.children).toEqual([]);
  });

  it('produces no duplicate ids across presets, installed instances, and unlinked leaves', () => {
    const p = preset({ id: 'repo:r1:g:tool', name: 'tool', repoId: 'r1', group: 'g', remote: repoA.url });
    const matched = install({
      instanceName: 'tool_1',
      agent: 'claude',
      identity: { remote: repoA.url, group: 'g', source: 'tool' },
    });
    const orphan = install({ instanceName: 'ghost_1', agent: 'claude', identity: { source: 'ghost' } });

    const { nodes } = buildMcpProjectTree([p], [matched, orphan], projects, repos);
    const ids = allIds(nodes);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every leaf id in the tree through the items map', () => {
    const manual = preset({ id: 'm1', name: 'manual-tool', origin: 'manual' });
    const p = preset({ id: 'repo:r1::tool', name: 'tool', repoId: 'r1', remote: repoA.url });
    const matched = install({
      instanceName: 'tool_1',
      agent: 'claude',
      identity: { remote: repoA.url, source: 'tool' },
    });
    const orphan = install({ instanceName: 'ghost_1', agent: 'claude', identity: { source: 'ghost' } });

    const { nodes, items } = buildMcpProjectTree([manual, p], [matched, orphan], projects, repos);

    for (const id of allIds(nodes)) {
      const node = findNode(nodes, id)!;
      if (node.children === undefined) {
        expect(items.get(id)).toBeDefined();
      }
    }
  });
});
