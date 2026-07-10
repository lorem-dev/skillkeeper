import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { McpInstall } from '@/services/bridge';
import { buildProjectMcpPlan } from './mcpPlan';

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
    identity: { remote: 'r', source: 'github' },
    ...over,
  };
}

describe('buildProjectMcpPlan', () => {
  it('installs a distinct MCP instance for an agent newly added to the chosen set (no params required)', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude' })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor'], presets);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows).toHaveLength(1);
    expect(installRows[0]!.agents).toEqual(['cursor']);
    expect(installRows[0]!.needsParamPrompt).toBe(false);

    const cursorBatch = plan.batches.find((b) => b.agent === 'cursor');
    expect(cursorBatch?.install).toEqual([{ identity: { remote: 'r', source: 'github' }, def: presets[0]!.def, values: {} }]);
  });

  it('removes an installed instance for an agent dropped from the chosen set', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude' })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })];

    const plan = buildProjectMcpPlan(installs, 'p1', [], presets);

    const removeRows = plan.rows.filter((r) => r.action === 'remove');
    expect(removeRows).toHaveLength(1);
    expect(removeRows[0]!.agents).toEqual(['claude']);

    const claudeBatch = plan.batches.find((b) => b.agent === 'claude');
    expect(claudeBatch?.remove).toEqual([{ instanceName: 'github_1' }]);
    expect(claudeBatch?.install).toEqual([]);
  });

  it('excludes an agent whose native config cannot express the instance transport', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude' })];
    const presets = [
      preset({ id: 'p1', name: 'github', remote: 'r', def: { name: 'github', type: 'http', url: 'https://x' } }),
    ];

    // codex cannot express http; only stdio.
    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'codex'], presets);

    expect(plan.rows.filter((r) => r.action === 'install')).toEqual([]);
    expect(plan.batches.find((b) => b.agent === 'codex')).toBeUndefined();
  });

  it('groups multiple agents installed for the same identity into one row and one batch entry each', () => {
    const installs = [
      install({ instanceName: 'github_1', agent: 'claude' }),
      install({ instanceName: 'github_1', agent: 'cursor' }),
    ];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })];

    // opencode newly added; claude and cursor stay (no diff for them).
    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor', 'opencode'], presets);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows).toHaveLength(1);
    expect(installRows[0]!.agents).toEqual(['opencode']);
  });

  it('reuses an already-installed instance stored params when copying to a newly added agent', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude', hasParams: true })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r', params: ['token'] })];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor'], presets);

    const row = plan.rows.find((r) => r.action === 'install');
    expect(row?.needsParamPrompt).toBe(false);

    const cursorBatch = plan.batches.find((b) => b.agent === 'cursor');
    expect(cursorBatch?.install[0]?.copyParamsFrom).toEqual({ agent: 'claude', instanceName: 'github_1' });
  });

  it('flags a param prompt (and emits no batch entry) when the instance requires params but none are stored anywhere', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude', hasParams: false })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r', params: ['token'] })];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor'], presets);

    const row = plan.rows.find((r) => r.action === 'install');
    expect(row?.needsParamPrompt).toBe(true);
    expect(row?.preset).toBe(presets[0]);
    expect(plan.batches.find((b) => b.agent === 'cursor')).toBeUndefined();
  });

  it('never installs for an identity whose source repo/preset no longer exists (remove-only)', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude' })];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor'], []);

    expect(plan.rows.filter((r) => r.action === 'install')).toEqual([]);
    // Still untouched (claude stays chosen) -- no remove row either.
    expect(plan.rows).toEqual([]);
  });

  it('ignores installs belonging to other projects or the global (codex) scope', () => {
    const installs = [
      install({ instanceName: 'a', agent: 'claude', projectId: 'other' }),
      install({ instanceName: 'b', agent: 'codex', projectId: 'global' }),
    ];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'codex'], presets);

    expect(plan.rows).toEqual([]);
    expect(plan.batches).toEqual([]);
  });

  it('produces no rows/batches when the chosen set is unchanged', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude' })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude'], presets);

    expect(plan.rows).toEqual([]);
    expect(plan.batches).toEqual([]);
  });
});
