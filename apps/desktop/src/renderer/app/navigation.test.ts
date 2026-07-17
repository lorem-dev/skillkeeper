import { describe, it, expect, vi } from 'vitest';
import { preloadView, isView, groupForView, type View } from './navigation';

describe('preloadView', () => {
  it('invokes exactly the loader for the requested view', async () => {
    const calls: View[] = [];
    const make = (v: View) => () => {
      calls.push(v);
      return Promise.resolve({});
    };
    const loaders = {
      repositories: make('repositories'),
      'skills-components': make('skills-components'),
      'skills-management': make('skills-management'),
      projects: make('projects'),
      'mcp-components': make('mcp-components'),
      'mcp-management': make('mcp-management'),
      settings: make('settings'),
    };
    await preloadView('projects', loaders);
    expect(calls).toEqual(['projects']);
  });

  it('resolves after the loader promise settles', async () => {
    const spy = vi.fn(() => Promise.resolve({}));
    const loaders = Object.fromEntries(
      (
        [
          'repositories',
          'skills-components',
          'skills-management',
          'projects',
          'mcp-components',
          'mcp-management',
          'settings',
        ] as View[]
      ).map((v) => [v, spy]),
    ) as unknown as Record<View, () => Promise<unknown>>;
    await expect(preloadView('settings', loaders)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('isView', () => {
  it('accepts known views', () => {
    expect(isView('projects')).toBe(true);
    expect(isView('skills-components')).toBe(true);
    expect(isView('settings')).toBe(true);
  });
  it('rejects unknown strings', () => {
    expect(isView('about')).toBe(false);
    expect(isView('')).toBe(false);
    expect(isView('SETTINGS')).toBe(false);
  });
});

describe('groupForView', () => {
  it('maps skills sub-views to the skills group', () => {
    expect(groupForView('skills-components')).toBe('skills');
    expect(groupForView('skills-management')).toBe('skills');
  });
  it('maps mcp sub-views to the mcp group', () => {
    expect(groupForView('mcp-components')).toBe('mcp');
    expect(groupForView('mcp-management')).toBe('mcp');
  });
  it('returns null for top-level views', () => {
    expect(groupForView('projects')).toBeNull();
    expect(groupForView('repositories')).toBeNull();
    expect(groupForView('settings')).toBeNull();
  });
});
