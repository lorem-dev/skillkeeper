/**
 * Tests for `resolveDetailsPreset`: the pure lookup the MCP page's details
 * modal uses to turn a tree leaf's resolved `McpTreeItem` into the
 * `McpPreset` it should render (or `undefined` when there is none to show).
 */
import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { McpInstall } from '@/services/bridge';
import type { McpTreeItem } from './mcpTree';
import { resolveDetailsPreset } from './mcpItemPreset';

const manualPreset: McpPreset = {
  id: 'manual-1',
  origin: 'manual',
  name: 'local-filesystem',
  def: { name: 'local-filesystem', type: 'stdio', command: 'npx' },
  hash: 'sha256:manual',
  params: [],
  hasRules: false,
};

const repoPreset: McpPreset = {
  id: 'repo:repo-1::linear',
  origin: 'repo',
  name: 'linear',
  def: { name: 'linear', type: 'http', url: 'https://api.linear.app/mcp' },
  hash: 'sha256:repo',
  params: [],
  hasRules: false,
  repoId: 'repo-1',
  remote: 'git@github.com:acme/mcps.git',
};

function install(over: Partial<McpInstall> & { instanceName: string; agent: McpInstall['agent'] }): McpInstall {
  return {
    projectId: 'p1',
    hash: 'sha256:x',
    hasParams: false,
    identity: { source: 'unknown' },
    ...over,
  };
}

describe('resolveDetailsPreset', () => {
  it('returns the preset directly for a manual-preset item', () => {
    const item: McpTreeItem = { kind: 'manual-preset', preset: manualPreset };
    expect(resolveDetailsPreset(item, [manualPreset])).toBe(manualPreset);
  });

  it('returns the preset directly for a repo-preset item', () => {
    const item: McpTreeItem = { kind: 'repo-preset', preset: repoPreset };
    expect(resolveDetailsPreset(item, [repoPreset])).toBe(repoPreset);
  });

  it('resolves an installed item through its matched preset', () => {
    const inst = install({
      agent: 'claude',
      instanceName: 'linear_1',
      identity: { remote: 'git@github.com:acme/mcps.git', source: 'linear' },
    });
    const item: McpTreeItem = { kind: 'installed', installs: [inst], updatable: false };
    expect(resolveDetailsPreset(item, [repoPreset])).toBe(repoPreset);
  });

  it('returns undefined for an installed item whose preset was since removed', () => {
    const inst = install({
      agent: 'claude',
      instanceName: 'linear_1',
      identity: { remote: 'git@github.com:acme/mcps.git', source: 'linear' },
    });
    const item: McpTreeItem = { kind: 'installed', installs: [inst], updatable: false };
    expect(resolveDetailsPreset(item, [])).toBeUndefined();
  });

  it('returns undefined for an unlinked item (no preset by definition)', () => {
    const inst = install({ agent: 'claude', instanceName: 'orphan_1' });
    const item: McpTreeItem = { kind: 'unlinked', installs: [inst] };
    expect(resolveDetailsPreset(item, [manualPreset, repoPreset])).toBeUndefined();
  });
});
