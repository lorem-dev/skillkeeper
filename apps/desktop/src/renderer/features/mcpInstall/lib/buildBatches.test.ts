/**
 * Tests for `buildInstallBatches`: the pure builder that turns a chosen
 * preset + agent set + collected parameter values into `ApplyMcpArgs.batches`
 * (design spec "MCP support", section 5 "Install (per selected agent
 * target)" and section 8 "Install modal").
 */
import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import { buildInstallBatches } from './buildBatches';

const manualPreset: McpPreset = {
  id: 'manual-1',
  origin: 'manual',
  name: 'github',
  def: {
    name: 'github',
    type: 'stdio',
    command: 'github-mcp',
    args: ['--token', '{gh_token}'],
  },
  hash: 'sha256:manual',
  params: ['gh_token'],
  hasRules: false,
};

const repoPreset: McpPreset = {
  id: 'repo:repo-1:devtools:linear',
  origin: 'repo',
  name: 'linear',
  def: {
    name: 'linear',
    type: 'http',
    url: 'https://api.linear.app/{workspace}/mcp',
    headers: { Authorization: 'Bearer {token}' },
  },
  hash: 'sha256:repo',
  params: ['token', 'workspace'],
  hasRules: false,
  repoId: 'repo-1',
  remote: 'git@github.com:acme/mcps.git',
  group: 'devtools',
};

const repoRootPreset: McpPreset = {
  ...repoPreset,
  id: 'repo:repo-1::linear',
  group: undefined,
};

describe('buildInstallBatches', () => {
  it('builds one batch per agent, each with a single install request', () => {
    const values = { gh_token: 'abc123' };
    const batches = buildInstallBatches(manualPreset, ['claude', 'cursor'], values);

    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.agent)).toEqual(['claude', 'cursor']);
    for (const batch of batches) {
      expect(batch.install).toHaveLength(1);
      expect(batch.remove).toEqual([]);
      expect(batch.install[0]?.def).toBe(manualPreset.def);
      expect(batch.install[0]?.values).toEqual(values);
    }
  });

  it('uses {local: id, source: name} identity for a manual preset', () => {
    const [batch] = buildInstallBatches(manualPreset, ['claude'], {});
    expect(batch?.install[0]?.identity).toEqual({ local: 'manual-1', source: 'github' });
  });

  it('uses {remote, group, source} identity for a repo preset in a group', () => {
    const [batch] = buildInstallBatches(repoPreset, ['claude'], {});
    expect(batch?.install[0]?.identity).toEqual({
      remote: 'git@github.com:acme/mcps.git',
      group: 'devtools',
      source: 'linear',
    });
  });

  it('omits group from the identity for a repo-root preset', () => {
    const [batch] = buildInstallBatches(repoRootPreset, ['claude'], {});
    expect(batch?.install[0]?.identity).toEqual({
      remote: 'git@github.com:acme/mcps.git',
      source: 'linear',
    });
    expect(batch?.install[0]?.identity).not.toHaveProperty('group');
  });

  it('returns an empty array when no agents are selected', () => {
    expect(buildInstallBatches(manualPreset, [], {})).toEqual([]);
  });

  it('passes the same values object to every batch', () => {
    const values = { workspace: 'acme', token: 'xyz' };
    const batches = buildInstallBatches(repoPreset, ['claude', 'copilot', 'opencode'], values);
    for (const batch of batches) {
      expect(batch.install[0]?.values).toEqual(values);
    }
  });
});
