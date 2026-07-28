import { describe, expect, it } from 'vitest';
import { clipHead, HEAD_ELLIPSIS } from './clipHead';

/** A fixed-width font: one unit per character, so widths are countable. */
const monospace = (s: string): number => s.length;

describe('clipHead', () => {
  it('leaves a path that already fits untouched', () => {
    expect(clipHead('/home/u/.ssh/id', 20, monospace)).toBe('/home/u/.ssh/id');
  });

  it('drops the beginning and keeps the file name', () => {
    const clipped = clipHead('/Users/donat/.ssh/id_rsa_wargaming', 24, monospace);
    expect(clipped.startsWith(HEAD_ELLIPSIS)).toBe(true);
    expect(clipped.endsWith('id_rsa_wargaming')).toBe(true);
    expect(monospace(clipped)).toBeLessThanOrEqual(24);
  });

  it('keeps as much of the path as fits', () => {
    // One unit narrower must not drop more than one character.
    const wide = clipHead('/Users/donat/.ssh/key', 15, monospace);
    const narrow = clipHead('/Users/donat/.ssh/key', 14, monospace);
    expect(wide.length - narrow.length).toBe(1);
  });

  it('never leaves a stray separator at the end', () => {
    // The defect this replaces: the CSS approach moved the path's own leading
    // slash to the far end, so the control read as if the path were a directory.
    expect(clipHead('/Users/donat/.ssh/id_rsa_wargaming', 24, monospace).endsWith('/')).toBe(false);
  });

  it('falls back to the marker alone when nothing fits beside it', () => {
    expect(clipHead('/Users/donat/.ssh/key', 3, monospace)).toBe(HEAD_ELLIPSIS);
    expect(clipHead('/Users/donat/.ssh/key', 1, monospace)).toBe(HEAD_ELLIPSIS);
  });

  it('treats an unmeasurable control as no constraint', () => {
    // A control with no layout yet (width 0) must show the path, not a marker.
    expect(clipHead('/home/u/.ssh/id', 0, monospace)).toBe('/home/u/.ssh/id');
  });
});
