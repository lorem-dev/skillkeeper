/**
 * Tests for `countInstalledLeaves`: the pure helper that counts
 * 'installed'-kind leaves in a tree node's subtree, used to show the
 * installed-MCP counter on branch nodes (project mode) in `McpPage`.
 */
import { describe, it, expect } from 'vitest';
import type { TreeNode } from '@/shared/ui';
import type { McpTreeItem } from './mcpTree';
import { countInstalledLeaves } from './mcpCounts';

function leaf(id: string): TreeNode {
  return { id, label: id };
}

function branch(id: string, children: TreeNode[]): TreeNode {
  return { id, label: id, children };
}

describe('countInstalledLeaves', () => {
  it('returns 0 for a leaf with no matching item', () => {
    const items = new Map<string, McpTreeItem>();
    expect(countInstalledLeaves(leaf('a'), items)).toBe(0);
  });

  it('returns 1 for a leaf whose item is installed', () => {
    const items = new Map<string, McpTreeItem>([['a', { kind: 'installed', installs: [], updatable: false }]]);
    expect(countInstalledLeaves(leaf('a'), items)).toBe(1);
  });

  it('does not count preset (manual-preset / repo-preset) leaves', () => {
    const items = new Map<string, McpTreeItem>([
      ['manual-1', { kind: 'manual-preset', preset: {} as never }],
      ['repo-1', { kind: 'repo-preset', preset: {} as never }],
    ]);
    const tree = branch('root', [leaf('manual-1'), leaf('repo-1')]);
    expect(countInstalledLeaves(tree, items)).toBe(0);
  });

  it('does not count unlinked leaves', () => {
    const items = new Map<string, McpTreeItem>([['u1', { kind: 'unlinked', installs: [] }]]);
    const tree = branch('root', [leaf('u1')]);
    expect(countInstalledLeaves(tree, items)).toBe(0);
  });

  it('sums installed leaves across a nested subtree', () => {
    const items = new Map<string, McpTreeItem>([
      ['i1', { kind: 'installed', installs: [], updatable: false }],
      ['i2', { kind: 'installed', installs: [], updatable: true }],
      ['u1', { kind: 'unlinked', installs: [] }],
    ]);
    const tree = branch('root', [
      branch('group', [leaf('i1'), leaf('u1')]),
      leaf('i2'),
    ]);
    expect(countInstalledLeaves(tree, items)).toBe(2);
  });

  it('returns 0 for an empty subtree', () => {
    const items = new Map<string, McpTreeItem>();
    expect(countInstalledLeaves(branch('root', []), items)).toBe(0);
  });
});
