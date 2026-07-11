/**
 * Pure helper for the MCP page's branch counters: how many currently-
 * INSTALLED instances (as opposed to presets or unlinked instances) sit
 * under a given tree node. Used by `McpPage`'s `decorate` walk to set
 * `node.detail` on every branch (project root, repo node, group node) to the
 * count of installed leaves in its subtree, mirroring the skills tree's
 * branch counts (`TreeView`'s `renderCount`).
 */
import type { TreeNode } from '@/shared/ui';
import type { McpTreeItem } from './mcpTree';

/**
 * Counts 'installed'-kind leaves in `node`'s subtree (including `node`
 * itself, if it is such a leaf). Preset leaves ('manual-preset' /
 * 'repo-preset') and 'unlinked' leaves are not counted -- only actually-
 * installed instances are.
 */
export function countInstalledLeaves(node: TreeNode, items: ReadonlyMap<string, McpTreeItem>): number {
  if (node.children === undefined || node.children.length === 0) {
    const item = items.get(node.id);
    return item !== undefined && item.kind === 'installed' ? 1 : 0;
  }
  let total = 0;
  for (const child of node.children) total += countInstalledLeaves(child, items);
  return total;
}
