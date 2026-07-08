import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import type { AgentAdapter } from './adapter.js';
import type { AgentKind } from './model.js';

function fakeAdapter(kind: AgentKind): AgentAdapter {
  return {
    kind,
    async isAvailable() {
      return true;
    },
    async destinationRoot() {
      return `/root/${kind}`;
    },
    async guidanceFile() {
      return `/root/${kind}/guidance.md`;
    },
    async discoverInstalled() {
      return [];
    },
  };
}

describe('AdapterRegistry', () => {
  it('registers and retrieves an adapter by kind', () => {
    const reg = new AdapterRegistry();
    const claude = fakeAdapter('claude');
    reg.register(claude);
    expect(reg.get('claude')).toBe(claude);
  });

  it('throws when registering a duplicate kind', () => {
    const reg = new AdapterRegistry();
    reg.register(fakeAdapter('codex'));
    expect(() => reg.register(fakeAdapter('codex'))).toThrow(/already registered/);
  });

  it('throws when getting an unregistered kind', () => {
    const reg = new AdapterRegistry();
    expect(() => reg.get('cursor')).toThrow(/no adapter registered/i);
  });

  it('lists registered adapters', () => {
    const reg = new AdapterRegistry();
    reg.register(fakeAdapter('claude'));
    reg.register(fakeAdapter('copilot'));
    expect(
      reg
        .list()
        .map((a) => a.kind)
        .sort(),
    ).toEqual(['claude', 'copilot']);
  });

  it('reports whether a kind is registered', () => {
    const reg = new AdapterRegistry();
    reg.register(fakeAdapter('opencode'));
    expect(reg.has('opencode')).toBe(true);
    expect(reg.has('cursor')).toBe(false);
  });

  it('returns an empty list when nothing is registered', () => {
    expect(new AdapterRegistry().list()).toEqual([]);
  });
});
