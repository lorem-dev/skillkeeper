import { describe, expect, it } from 'vitest';
import { createLatestRequestGuard } from './latestRequest';

describe('createLatestRequestGuard', () => {
  it('treats a lone started request as current', () => {
    const guard = createLatestRequestGuard();
    const token = guard.start();
    expect(guard.isCurrent(token)).toBe(true);
  });

  it('invalidates an older token once a newer request starts', () => {
    const guard = createLatestRequestGuard();
    const first = guard.start();
    const second = guard.start();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('keeps a token valid across repeated checks until it is superseded', () => {
    const guard = createLatestRequestGuard();
    const token = guard.start();
    expect(guard.isCurrent(token)).toBe(true);
    expect(guard.isCurrent(token)).toBe(true);
    guard.start();
    expect(guard.isCurrent(token)).toBe(false);
  });
});
