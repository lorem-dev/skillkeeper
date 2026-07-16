import { describe, it, expect, vi } from 'vitest';
import { preloadView, type View } from './navigation';

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
