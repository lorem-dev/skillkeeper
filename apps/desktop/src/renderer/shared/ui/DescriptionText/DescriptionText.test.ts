import { describe, expect, it } from 'vitest';
import { spansToKeyedParts } from './DescriptionText';
import type { DescriptionSpan } from './DescriptionText';

describe('spansToKeyedParts', () => {
  it('keeps text and link spans in order with stable keys', () => {
    const spans: DescriptionSpan[] = [
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'docs', url: 'https://example.com/d' },
    ];
    const parts = spansToKeyedParts(spans);
    expect(parts.map((p) => p.key)).toEqual(['0', '1']);
    expect(parts[1]?.kind).toBe('link');
  });

  it("keeps each part's own fields alongside the added key", () => {
    const spans: DescriptionSpan[] = [
      { kind: 'text', text: 'plain' },
      { kind: 'link', text: 'docs', url: 'https://example.com/d' },
    ];
    const parts = spansToKeyedParts(spans);
    expect(parts[0]).toMatchObject({ kind: 'text', text: 'plain' });
    expect(parts[1]).toMatchObject({ kind: 'link', text: 'docs', url: 'https://example.com/d' });
  });

  it('gives every part a distinct key even when two links repeat', () => {
    const link: DescriptionSpan = { kind: 'link', text: 'a', url: 'https://example.com/a' };
    const parts = spansToKeyedParts([link, link, link]);
    expect(new Set(parts.map((p) => p.key)).size).toBe(3);
  });

  it('returns an empty list for an empty input', () => {
    expect(spansToKeyedParts([])).toEqual([]);
  });
});
