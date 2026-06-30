import { describe, it, expect } from 'vitest';
import { formatDate, formatVersion } from './format';

describe('formatDate', () => {
  it('returns the date portion of an ISO timestamp', () => {
    expect(formatDate('2026-01-02T03:04:05.000Z')).toBe('2026-01-02');
  });
  it('returns empty string for undefined', () => {
    expect(formatDate(undefined)).toBe('');
  });
});

describe('formatVersion', () => {
  it('prefixes a version with v', () => {
    expect(formatVersion('1.2.3')).toBe('v1.2.3');
  });
  it('returns null when no version', () => {
    expect(formatVersion(undefined)).toBeNull();
  });
});
