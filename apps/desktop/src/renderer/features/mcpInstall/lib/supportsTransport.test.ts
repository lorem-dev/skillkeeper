/**
 * Tests for the renderer-local `supportsTransport`, duplicated because the
 * renderer must not import the domain layer's runtime code (see
 * supportsTransport.ts and architecture.md). The canonical rule lives in the
 * Rust `skillkeeper-core` crate (covered by its `cargo test` suite); these
 * tests pin the renderer copy to the expected (agent, transport) matrix.
 */
import { describe, it, expect } from 'vitest';
import { ALL_AGENTS } from '@/domain';
import type { McpTransport } from '@/services/bridge';
import { supportsTransport } from './supportsTransport';

const TRANSPORTS: readonly McpTransport[] = ['stdio', 'http', 'sse'];

describe('supportsTransport', () => {
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
