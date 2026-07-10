/**
 * Drift guard: pins the renderer-local `supportsTransport` (duplicated
 * because the renderer must not import `@skillkeeper/core`'s runtime code --
 * see supportsTransport.ts and architecture.md) against core's original for
 * every (agent, transport) pair. Mirrors the pattern in
 * `features/mcpEdit/lib/validate.test.ts` and the store's own drift-guard
 * block (`app/store/store.test.ts`).
 */
import { describe, it, expect } from 'vitest';
// Core IS importable in the Node/vitest env (unlike the sandboxed renderer);
// used only here to pin the renderer copy against the original.
import { supportsTransport as coreSupportsTransport } from '@skillkeeper/core';
import { ALL_AGENTS } from '@/domain';
import type { McpTransport } from '@/services/bridge';
import { supportsTransport } from './supportsTransport';

const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

describe('supportsTransport (drift guard vs core)', () => {
  for (const agent of ALL_AGENTS) {
    for (const transport of TRANSPORTS) {
      it(`matches core for (${agent}, ${transport})`, () => {
        expect(supportsTransport(agent, transport)).toBe(coreSupportsTransport(agent, transport));
      });
    }
  }

  it('codex supports only stdio', () => {
    expect(supportsTransport('codex', 'stdio')).toBe(true);
    expect(supportsTransport('codex', 'http')).toBe(false);
    expect(supportsTransport('codex', 'sse')).toBe(false);
  });

  it('every non-codex agent supports every transport', () => {
    for (const agent of ALL_AGENTS.filter((a) => a !== 'codex')) {
      for (const transport of TRANSPORTS) {
        expect(supportsTransport(agent, transport)).toBe(true);
      }
    }
  });
});
