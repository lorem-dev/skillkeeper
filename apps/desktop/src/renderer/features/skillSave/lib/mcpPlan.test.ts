import { describe, it, expect } from 'vitest';
import type { McpPreset } from '@/app/store';
import type { McpInstall } from '@/services/bridge';
import { GLOBAL_SCOPE_ID } from '@/domain';
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
      preset({ id: 'p1', name: 'github', remote: 'r', def: { name: 'github', type: 'sse', url: 'https://x' } }),
    ];

    // codex accepts stdio and http but rejects sse; cursor accepts every
    // transport, so it must still get the install -- proving this assertion
    // exercises the transport gate rather than an emptied candidate list.
    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor', 'codex'], presets);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows).toHaveLength(1);
    expect(installRows[0]!.agents).toEqual(['cursor']);
    expect(plan.batches.find((b) => b.agent === 'codex')).toBeUndefined();
  });

  it('excludes an agent that cannot express an OAuth client from a preset carrying one', () => {
    const installs = [install({ instanceName: 'remote_1', agent: 'claude', identity: { remote: 'r', source: 'remote' } })];
    const presets = [
      preset({
        id: 'p1',
        name: 'remote',
        remote: 'r',
        def: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          oauth: { clientId: 'example-client', scopes: ['read'] },
        },
      }),
    ];

    // copilot takes http fine but cannot store an OAuth client, so the backend
    // declines the install. Planning it anyway would show the user an install
    // row that then silently does not happen.
    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'copilot'], presets);

    expect(plan.rows.filter((r) => r.action === 'install')).toEqual([]);
    expect(plan.batches.find((b) => b.agent === 'copilot')).toBeUndefined();
  });

  it('still plans an install for an agent that CAN express an OAuth client', () => {
    const installs = [install({ instanceName: 'remote_1', agent: 'claude', identity: { remote: 'r', source: 'remote' } })];
    const presets = [
      preset({
        id: 'p1',
        name: 'remote',
        remote: 'r',
        def: {
          name: 'remote',
          type: 'http',
          url: 'https://mcp.example.com/mcp',
          oauth: { clientId: 'example-client', scopes: ['read'] },
        },
      }),
    ];

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'cursor'], presets);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows).toHaveLength(1);
    expect(installRows[0]!.agents).toEqual(['cursor']);
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

  // Codex has project-scoped MCP config just like every other agent, so it is
  // a project-scoped install candidate the same as any other agent (subject
  // to the same `supportsTransport`/`supportsOauth` gates everyone else gets).
  it('allows codex as an install candidate at a project scope', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude' })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })]; // stdio -- codex-compatible

    const plan = buildProjectMcpPlan(installs, 'p1', ['claude', 'codex'], presets);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows).toHaveLength(1);
    expect(installRows[0]!.agents).toEqual(['codex']);
    const codexBatch = plan.batches.find((b) => b.agent === 'codex');
    expect(codexBatch?.install).toEqual([
      { identity: { remote: 'r', source: 'github' }, def: presets[0]!.def, values: {} },
    ]);
  });

  // Regression: `SkillSaveModal`'s per-scope review previously only ever
  // called this for tracked projects, so a global-scope MCP instance never
  // appeared in the Save modal's rows or its apply loop. `McpInstall.projectId`
  // already stores the literal `'global'` string for a user-wide instance (the
  // plain-equality filter above needs no change for that half), so the two
  // tests below exercise `buildProjectMcpPlan` directly at the global scope --
  // the same "produces a real op" shape as the `applyPlan.ts` regressions.
  it('removes an installed global-scope instance for an agent dropped from the chosen set', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude', projectId: GLOBAL_SCOPE_ID })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })];

    const plan = buildProjectMcpPlan(installs, GLOBAL_SCOPE_ID, [], presets);

    const removeRows = plan.rows.filter((r) => r.action === 'remove');
    expect(removeRows).toHaveLength(1);
    expect(removeRows[0]!.agents).toEqual(['claude']);
    const claudeBatch = plan.batches.find((b) => b.agent === 'claude');
    expect(claudeBatch?.remove).toEqual([{ instanceName: 'github_1' }]);
  });

  // Codex has project-scoped MCP config just like every other agent, so
  // `buildProjectMcpPlan`'s install-candidate list is `ALL_AGENTS` regardless
  // of scope; the only remaining per-agent gates are `supportsTransport` and
  // `supportsOauth` (exercised by the tests above). This test exercises the
  // global scope specifically, confirming a newly-chosen codex there still
  // receives an already-installed instance's install op.
  it('allows codex as an install candidate at the global scope', () => {
    const installs = [install({ instanceName: 'github_1', agent: 'claude', projectId: GLOBAL_SCOPE_ID })];
    const presets = [preset({ id: 'p1', name: 'github', remote: 'r' })]; // stdio -- codex-compatible

    const plan = buildProjectMcpPlan(installs, GLOBAL_SCOPE_ID, ['claude', 'codex'], presets);

    const installRows = plan.rows.filter((r) => r.action === 'install');
    expect(installRows).toHaveLength(1);
    expect(installRows[0]!.agents).toEqual(['codex']);
    const codexBatch = plan.batches.find((b) => b.agent === 'codex');
    expect(codexBatch?.install).toEqual([
      { identity: { remote: 'r', source: 'github' }, def: presets[0]!.def, values: {} },
    ]);
  });
});
