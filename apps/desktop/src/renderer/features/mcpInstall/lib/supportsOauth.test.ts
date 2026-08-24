/**
 * Tests for the renderer-local `supportsOauth`, duplicated because the
 * renderer must not import the domain layer's runtime code (see
 * supportsOauth.ts and architecture.md). The canonical rule lives in the Rust
 * `skillkeeper-core` crate (covered by its `cargo test` suite); this test
 * pins the renderer copy to the expected agent matrix.
 */
import { describe, it, expect } from 'vitest';
import { ALL_AGENTS } from '@/domain';
import { supportsOauth } from './supportsOauth';

describe('supportsOauth', () => {
  it('only copilot cannot store an oauth client', () => {
    expect(supportsOauth('copilot')).toBe(false);
    for (const agent of ALL_AGENTS.filter((a) => a !== 'copilot')) {
      expect(supportsOauth(agent)).toBe(true);
    }
  });
});
