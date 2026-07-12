import { describe, it, expect } from 'vitest';
import { isSearchEmpty } from './isSearchEmpty';

// `isSearchEmpty` is the collapse-on-blur decision: the field only shrinks back
// to a button when it is left empty. Everything else (focus tracking) is DOM
// wiring exercised via Storybook, not here.
describe('isSearchEmpty', () => {
  it('is true for an empty or whitespace-free absent value', () => {
    expect(isSearchEmpty('')).toBe(true);
    expect(isSearchEmpty(undefined)).toBe(true);
    expect(isSearchEmpty(null)).toBe(true);
    // A non-string controlled value (e.g. number) is treated as empty too.
    expect(isSearchEmpty(0)).toBe(true);
  });

  it('is false once the field holds any text', () => {
    expect(isSearchEmpty('a')).toBe(false);
    expect(isSearchEmpty(' ')).toBe(false);
    expect(isSearchEmpty('electron')).toBe(false);
  });
});
