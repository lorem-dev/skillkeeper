import { describe, expect, it } from 'vitest';
import { stripSvgRoot } from './stripSvgRoot';

describe('stripSvgRoot', () => {
  it('removes the root svg tags and returns the inner markup', () => {
    const svg = '<svg viewBox="0 0 24 24"><path d="M0 0h4" /></svg>';
    expect(stripSvgRoot(svg)).toBe('<path d="M0 0h4" />');
  });

  it('preserves multiple sibling elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="1" cy="1" r="1" /><path d="M0 0h4" /></svg>';
    expect(stripSvgRoot(svg)).toBe('<circle cx="1" cy="1" r="1" /><path d="M0 0h4" />');
  });

  it('trims whitespace and leaves no svg tag behind', () => {
    const svg = '\n<svg viewBox="0 0 24 24">\n  <path d="M0 0h4" />\n</svg>\n';
    const inner = stripSvgRoot(svg);
    expect(inner).not.toContain('<svg');
    expect(inner).not.toContain('</svg>');
    expect(inner.startsWith('<path')).toBe(true);
  });
});
