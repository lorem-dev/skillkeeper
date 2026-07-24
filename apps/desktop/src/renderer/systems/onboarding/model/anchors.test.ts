import { describe, it, expect, vi } from 'vitest';
import { __registerAnchor, getAnchorElement, subscribeAnchors } from './anchors';

describe('anchor registry', () => {
  it('stores and clears an element, notifying subscribers', () => {
    const cb = vi.fn();
    const off = subscribeAnchors(cb);
    const el = {} as HTMLElement;
    __registerAnchor('add-project', el);
    expect(getAnchorElement('add-project')).toBe(el);
    expect(cb).toHaveBeenCalled();
    __registerAnchor('add-project', null);
    expect(getAnchorElement('add-project')).toBeNull();
    off();
  });
});
