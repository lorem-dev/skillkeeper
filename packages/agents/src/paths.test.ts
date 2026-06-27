import { describe, it, expect } from 'vitest';
import { createMemFs } from '@skillkeeper/core/testing';
import type { HostEnv } from '@skillkeeper/core';
import {
  PROJECT_DIR_ENV,
  baseDir,
  discoverSkillDirs,
  fsOf,
  joinPath,
  requireProjectDir,
} from './paths.js';

const HOME = '/home/carol';

function baseEnv(env: Record<string, string | undefined>): HostEnv {
  return { homeDir: HOME, platform: 'linux', env };
}

describe('joinPath', () => {
  it('joins segments with single slashes and trims stray ones', () => {
    expect(joinPath('/a/', '/b/', 'c')).toBe('/a/b/c');
  });

  it('drops empty segments', () => {
    expect(joinPath('/a', '', 'b')).toBe('/a/b');
  });
});

describe('requireProjectDir', () => {
  it('returns the configured project directory', () => {
    expect(requireProjectDir(baseEnv({ [PROJECT_DIR_ENV]: '/work/x' }))).toBe('/work/x');
  });

  it('throws when the project directory env var is missing', () => {
    expect(() => requireProjectDir(baseEnv({}))).toThrow(/project directory/i);
  });

  it('throws when the project directory env var is blank', () => {
    expect(() => requireProjectDir(baseEnv({ [PROJECT_DIR_ENV]: '   ' }))).toThrow(
      /project directory/i,
    );
  });
});

describe('baseDir', () => {
  it('uses the home directory for global scope', () => {
    expect(baseDir({ agent: 'claude', scope: 'global' }, baseEnv({}))).toBe(HOME);
  });

  it('uses the project directory for project scope', () => {
    expect(
      baseDir({ agent: 'claude', scope: 'project' }, baseEnv({ [PROJECT_DIR_ENV]: '/work/y' })),
    ).toBe('/work/y');
  });
});

describe('fsOf', () => {
  it('returns the injected FsPort from an adapter host environment', () => {
    const fs = createMemFs();
    expect(fsOf({ ...baseEnv({}), fs } as HostEnv)).toBe(fs);
  });

  it('throws when no FsPort is present on the environment', () => {
    expect(() => fsOf(baseEnv({}))).toThrow(/FsPort/);
  });
});

describe('discoverSkillDirs', () => {
  it('skips plain files that sit directly under the skills root', async () => {
    const fs = createMemFs({
      '/root/skills/loose-file.txt': 'not a skill dir',
      '/root/skills/good/SKILL.md': '# good',
    });
    const found = await discoverSkillDirs(fs, '/root/skills');
    expect(found.map((s) => s.name)).toEqual(['good']);
  });

  it('attaches a group label to every discovered skill when one is given', async () => {
    const fs = createMemFs({ '/root/skills/alpha/SKILL.md': '# alpha' });
    const found = await discoverSkillDirs(fs, '/root/skills', 'team');
    expect(found).toEqual([{ name: 'alpha', path: '/root/skills/alpha', group: 'team' }]);
  });
});
