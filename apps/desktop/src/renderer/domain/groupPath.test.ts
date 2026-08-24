import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@/shared/ui';
import { groupSegments, nestByGroup } from './groupPath';

interface Item {
  readonly name: string;
  readonly group?: string;
}

/** Nest by group with a plain leaf per item and a plain branch per segment. */
function nest(items: readonly Item[]): TreeNode[] {
  return nestByGroup(items, {
    groupOf: (i) => i.group,
    compare: (a, b) => a.name.localeCompare(b.name),
    makeLeaves: (i) => [{ id: `leaf:${i.group ?? ''}:${i.name}`, label: i.name }],
    makeGroup: (path, label, children) => ({ id: `grp:${path}`, label, children }),
  });
}

describe('groupSegments', () => {
  it('splits a group path and treats absent or empty as none', () => {
    expect(groupSegments('a/b/c')).toEqual(['a', 'b', 'c']);
    expect(groupSegments('a')).toEqual(['a']);
    expect(groupSegments('')).toEqual([]);
    expect(groupSegments(undefined)).toEqual([]);
  });
});

describe('nestByGroup', () => {
  it('puts ungrouped items at the top level, sorted', () => {
    const nodes = nest([{ name: 'b' }, { name: 'a' }]);
    expect(nodes.map((n) => n.label)).toEqual(['a', 'b']);
  });

  it('nests a three-level group path one branch per segment', () => {
    const nodes = nest([{ name: 'deep', group: 'a/b/c' }]);

    expect(nodes).toHaveLength(1);
    const a = nodes[0]!;
    expect(a.label).toBe('a');
    const b = a.children![0]!;
    expect(b.label).toBe('b');
    const c = b.children![0]!;
    expect(c.label).toBe('c');
    expect(c.children![0]!.label).toBe('deep');
  });

  it('labels a branch with its last segment but ids it with the full path', () => {
    const nodes = nest([{ name: 'x', group: 'a/b' }]);
    const b = nodes[0]!.children![0]!;

    expect(b.label).toBe('b');
    expect(b.id).toBe('grp:a/b');
    expect(nodes[0]!.id).toBe('grp:a');
  });

  it('gives every branch level a distinct id even with a repeated segment name', () => {
    const nodes = nest([{ name: 'x', group: 'a/a' }]);

    expect(nodes[0]!.id).toBe('grp:a');
    expect(nodes[0]!.children![0]!.id).toBe('grp:a/a');
  });

  it('shares a parent branch between a shallow and a deep item', () => {
    const nodes = nest([
      { name: 'shallow', group: 'a' },
      { name: 'deep', group: 'a/b' },
    ]);

    expect(nodes).toHaveLength(1);
    const a = nodes[0]!;
    // Groups come before this level's own leaves.
    expect(a.children!.map((n) => n.label)).toEqual(['b', 'shallow']);
  });

  it('sorts sibling groups by label and puts them before leaves', () => {
    const nodes = nest([{ name: 'loose' }, { name: 'x', group: 'zeta' }, { name: 'y', group: 'alpha' }]);

    expect(nodes.map((n) => n.label)).toEqual(['alpha', 'zeta', 'loose']);
  });

  it('lets one item contribute several leaf rows', () => {
    const nodes = nestByGroup([{ name: 'x', group: 'a' }] as Item[], {
      groupOf: (i) => i.group,
      compare: (a, b) => a.name.localeCompare(b.name),
      makeLeaves: (i) => [
        { id: `${i.name}:1`, label: `${i.name} one` },
        { id: `${i.name}:2`, label: `${i.name} two` },
      ],
      makeGroup: (path, label, children) => ({ id: `grp:${path}`, label, children }),
    });

    expect(nodes[0]!.children!.map((n) => n.label)).toEqual(['x one', 'x two']);
  });
});
