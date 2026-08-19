/**
 * Group-path vocabulary for the renderer. A skill's (or an MCP preset's) group is
 * a `/`-joined path of up to three segments, mirroring the core's
 * `skills/group_path.rs`.
 *
 * `nestByGroup` is the one place that turns a flat list of grouped items into
 * nested tree branches. Both the skills tree and the MCP tree render the same
 * shape, and neither may import the other, so the helper lives here in `domain`
 * where both can reach it.
 */
import type { TreeNode } from '@/shared/ui';

/** Segments of a group path. An absent or empty group has no segments. */
export function groupSegments(group: string | undefined): string[] {
  if (group === undefined || group === '') return [];
  return group.split('/');
}

export interface NestByGroupOptions<T> {
  /** The item's group path; `undefined` or `''` means ungrouped. */
  readonly groupOf: (item: T) => string | undefined;
  /** Sort order for the leaves that sit directly at one level. */
  readonly compare: (a: T, b: T) => number;
  /** The row(s) one item contributes. Usually exactly one. */
  readonly makeLeaves: (item: T) => TreeNode[];
  /**
   * Build a group branch. `path` is the full prefix (`a/b`), `label` its last
   * segment (`b`). The caller owns the id, icon, and any extra props, so a
   * branch can stay non-selectable or muted as that tree requires.
   */
  readonly makeGroup: (path: string, label: string, children: TreeNode[]) => TreeNode;
}

/**
 * Nest `items` under one branch per group segment.
 *
 * At every level, group branches come first sorted by segment, then the items
 * whose group path ends at this level, sorted by `compare`. An item grouped `a`
 * and one grouped `a/b` therefore share the `a` branch, with the shallow one
 * rendering as a leaf beside the `b` branch.
 */
export function nestByGroup<T>(items: readonly T[], opts: NestByGroupOptions<T>): TreeNode[] {
  const build = (entries: readonly T[], prefix: string, level: number): TreeNode[] => {
    const groups = new Map<string, T[]>();
    const here: T[] = [];
    for (const item of entries) {
      // `noUncheckedIndexedAccess`: past the end of the path this is undefined,
      // which is exactly the "this item stops here" case.
      const segment = groupSegments(opts.groupOf(item))[level];
      if (segment === undefined) {
        here.push(item);
        continue;
      }
      const list = groups.get(segment);
      if (list !== undefined) list.push(item);
      else groups.set(segment, [item]);
    }

    const out: TreeNode[] = [];
    for (const [segment, group] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = prefix === '' ? segment : `${prefix}/${segment}`;
      out.push(opts.makeGroup(path, segment, build(group, path, level + 1)));
    }
    for (const item of [...here].sort(opts.compare)) out.push(...opts.makeLeaves(item));
    return out;
  };
  return build(items, '', 0);
}
