import { describe, it, expect } from 'vitest';
import { createMemFs } from '@skillkeeper/core/testing';
import { AdapterRegistry } from '@skillkeeper/core';
import type { AgentKind, AgentTarget, FsPort } from '@skillkeeper/core';
import { registerBuiltinAgents } from './index.js';
import { codexAdapter } from './codex.js';
import { copilotAdapter } from './copilot.js';
import { cursorAdapter } from './cursor.js';
import { opencodeAdapter } from './opencode.js';
import { PROJECT_DIR_ENV, type AdapterHostEnv } from './paths.js';

const HOME = '/home/bob';
const PROJECT = '/work/proj';

function hostEnv(fs: FsPort): AdapterHostEnv {
  return {
    homeDir: HOME,
    platform: 'linux',
    env: { [PROJECT_DIR_ENV]: PROJECT },
    fs,
  };
}

const ALL_KINDS: AgentKind[] = ['claude', 'codex', 'copilot', 'cursor', 'opencode'];

describe('registerBuiltinAgents', () => {
  it('registers all five agent kinds', () => {
    const registry = new AdapterRegistry();
    registerBuiltinAgents(registry);
    for (const kind of ALL_KINDS) {
      expect(registry.has(kind)).toBe(true);
      expect(registry.get(kind).kind).toBe(kind);
    }
  });

  it('registers exactly the five builtin adapters', () => {
    const registry = new AdapterRegistry();
    registerBuiltinAgents(registry);
    expect(
      registry
        .list()
        .map((a) => a.kind)
        .sort(),
    ).toEqual([...ALL_KINDS].sort());
  });
});

describe('non-claude adapter paths', () => {
  const projectTarget: AgentTarget = { agent: 'codex', scope: 'project' };
  const globalTarget: AgentTarget = { agent: 'codex', scope: 'global' };

  it('codex resolves project and global skill roots', async () => {
    const env = hostEnv(createMemFs());
    expect(await codexAdapter.destinationRoot({ ...projectTarget, agent: 'codex' }, env)).toBe(
      `${PROJECT}/.codex/skills`,
    );
    expect(await codexAdapter.destinationRoot({ ...globalTarget, agent: 'codex' }, env)).toBe(
      `${HOME}/.codex/skills`,
    );
  });

  it('copilot resolves project and global skill roots', async () => {
    const env = hostEnv(createMemFs());
    expect(
      await copilotAdapter.destinationRoot({ agent: 'copilot', scope: 'project' }, env),
    ).toBe(`${PROJECT}/.github/copilot/skills`);
    expect(await copilotAdapter.destinationRoot({ agent: 'copilot', scope: 'global' }, env)).toBe(
      `${HOME}/.config/github-copilot/skills`,
    );
  });

  it('cursor resolves project and global skill roots', async () => {
    const env = hostEnv(createMemFs());
    expect(await cursorAdapter.destinationRoot({ agent: 'cursor', scope: 'project' }, env)).toBe(
      `${PROJECT}/.cursor/skills`,
    );
    expect(await cursorAdapter.destinationRoot({ agent: 'cursor', scope: 'global' }, env)).toBe(
      `${HOME}/.cursor/skills`,
    );
  });

  it('opencode resolves project and global skill roots', async () => {
    const env = hostEnv(createMemFs());
    expect(
      await opencodeAdapter.destinationRoot({ agent: 'opencode', scope: 'project' }, env),
    ).toBe(`${PROJECT}/.opencode/skills`);
    expect(
      await opencodeAdapter.destinationRoot({ agent: 'opencode', scope: 'global' }, env),
    ).toBe(`${HOME}/.config/opencode/skills`);
  });

  it('exposes a hook capability with a resolvable target file for each agent', async () => {
    const env = hostEnv(createMemFs());
    for (const adapter of [codexAdapter, copilotAdapter, cursorAdapter, opencodeAdapter]) {
      const support = adapter.hookSupport;
      expect(support).toBeDefined();
      const file = await support!.resolveTargetFile(
        { agent: adapter.kind, scope: 'global' },
        env,
      );
      expect(typeof file).toBe('string');
      expect(file.length).toBeGreaterThan(0);
    }
  });

  it('discovers external skills and reports availability for each agent', async () => {
    for (const adapter of [codexAdapter, copilotAdapter, cursorAdapter, opencodeAdapter]) {
      const globalT: AgentTarget = { agent: adapter.kind, scope: 'global' };
      const root = await adapter.destinationRoot(globalT, hostEnv(createMemFs()));
      const fs = createMemFs({ [`${root}/sample/SKILL.md`]: '# sample' });
      const env = hostEnv(fs);
      const found = await adapter.discoverInstalled(globalT, env);
      expect(found.map((s) => s.name)).toEqual(['sample']);
      expect(await adapter.isAvailable(env)).toBe(true);
      expect(await adapter.isAvailable(hostEnv(createMemFs()))).toBe(false);
    }
  });
});
