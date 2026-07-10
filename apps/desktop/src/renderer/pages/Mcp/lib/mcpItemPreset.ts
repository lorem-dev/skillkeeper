/**
 * Pure lookup: resolves the `McpPreset` that backs one tree leaf's details
 * view, given the `McpTreeItem` the page's `items` map resolved that leaf id
 * to. A preset-kind item (`manual-preset`/`repo-preset`) carries its preset
 * directly; an `installed` instance resolves through its matched preset via
 * `matchMcpPreset` (guaranteed to exist -- that match is exactly what makes it
 * "installed" rather than "unlinked" in the tree builder); an `unlinked`
 * instance has no preset by definition and resolves to `undefined` -- the
 * page treats that as "no details to show" rather than inventing one.
 */
import { matchMcpPreset } from '@/app/store';
import type { McpPreset } from '@/app/store';
import type { McpTreeItem } from './mcpTree';

export function resolveDetailsPreset(
  item: McpTreeItem,
  presets: readonly McpPreset[],
): McpPreset | undefined {
  switch (item.kind) {
    case 'manual-preset':
    case 'repo-preset':
      return item.preset;
    case 'installed': {
      const first = item.installs[0];
      return first !== undefined ? matchMcpPreset(first, presets) : undefined;
    }
    case 'unlinked':
      return undefined;
  }
}
