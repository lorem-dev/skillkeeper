import { describe, it, expect } from 'vitest';
import { isValidElement } from 'react';
import type { ReactElement } from 'react';
import { interleaveIcons } from './interleaveIcons';

/** The rendered `children` of a React element, for structural assertions. */
function elementChildren(node: unknown): unknown {
  return (node as ReactElement<{ children?: unknown }>).props.children;
}

describe('interleaveIcons', () => {
  it('returns the text unchanged (as a single-item array) when there is no token', () => {
    const out = interleaveIcons('No placeholders here', {});
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('No placeholders here');
  });

  it('splits a single token into [before, icon, after] when the icon is provided', () => {
    const icon = <i />;
    const out = interleaveIcons('Before {installed} after', { installed: icon });

    expect(out).toHaveLength(3);
    expect(out[0]).toBe('Before ');
    expect(typeof out[1]).toBe('object');
    expect(isValidElement(out[1])).toBe(true);
    expect(elementChildren(out[1])).toBe(icon);
    expect(out[2]).toBe(' after');
  });

  it('renders each of multiple distinct tokens as its own element', () => {
    const removeIcon = <i data-testid="remove" />;
    const installIcon = <i data-testid="install" />;
    const out = interleaveIcons('{remove} and {install}', { remove: removeIcon, install: installIcon });

    expect(out).toHaveLength(3);
    expect(isValidElement(out[0])).toBe(true);
    expect(elementChildren(out[0])).toBe(removeIcon);
    expect(out[1]).toBe(' and ');
    expect(isValidElement(out[2])).toBe(true);
    expect(elementChildren(out[2])).toBe(installIcon);
  });

  it('leaves an unknown token as literal text (the {token} substring survives)', () => {
    const out = interleaveIcons('Say {bogus} thing', {});

    expect(out).toHaveLength(3);
    expect(out[0]).toBe('Say ');
    // No matching icon: the placeholder is kept as literal text, wrapped in a
    // fragment rather than substituted with an icon element.
    expect(isValidElement(out[1])).toBe(true);
    expect(elementChildren(out[1])).toBe('{bogus}');
    expect(out[2]).toBe(' thing');
  });
});
