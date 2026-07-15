import { describe, expect, it } from 'vitest';
import { RepoConfigError, parseRepoConfig, repoConfigSchema } from './repoConfig.js';

describe('parseRepoConfig', () => {
  it('parses a full config with skills, defaults, include, and exclude', () => {
    const yaml = [
      'version: 1',
      'defaults:',
      '  group: shared',
      'skills:',
      '  - path: a/skill-one',
      '    name: one',
      '  - path: b/skill-two',
      '    group: other',
      'include:',
      '  - "src/**"',
      'exclude:',
      '  - "**/draft/**"',
    ].join('\n');
    const cfg = parseRepoConfig(yaml);
    expect(cfg.version).toBe(1);
    expect(cfg.defaults?.group).toBe('shared');
    expect(cfg.skills).toHaveLength(2);
    expect(cfg.skills?.[0]).toEqual({ path: 'a/skill-one', name: 'one' });
    expect(cfg.skills?.[1]).toEqual({ path: 'b/skill-two', group: 'other' });
    expect(cfg.include).toEqual(['src/**']);
    expect(cfg.exclude).toEqual(['**/draft/**']);
  });

  it('parses a minimal config (version only)', () => {
    const cfg = parseRepoConfig('version: 1');
    expect(cfg.version).toBe(1);
    expect(cfg.skills).toBeUndefined();
  });

  it('throws RepoConfigError when version is missing', () => {
    expect(() => parseRepoConfig('skills: []')).toThrow(RepoConfigError);
  });

  it('throws RepoConfigError when a skill entry lacks a path', () => {
    const yaml = ['version: 1', 'skills:', '  - name: nameonly'].join('\n');
    expect(() => parseRepoConfig(yaml)).toThrow(RepoConfigError);
    try {
      parseRepoConfig(yaml);
    } catch (err) {
      expect((err as RepoConfigError).fieldPath).toBe('skills.0.path');
    }
  });

  it('throws RepoConfigError on malformed YAML', () => {
    expect(() => parseRepoConfig('version: 1\n  bad: : :')).toThrow(RepoConfigError);
  });

  it('exposes the schema for reuse', () => {
    expect(repoConfigSchema.safeParse({ version: 1 }).success).toBe(true);
  });
});
