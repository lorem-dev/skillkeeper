import { describe, it, expect } from 'vitest';
import type { InstalledSkillView } from '@/entities/skill';
import { filterSkills } from './filterSkills';

const v = (over: Partial<InstalledSkillView> & { key: string; name: string }): InstalledSkillView => ({
  agents: ['claude'], scopes: ['global'], hasHooks: false, installedAt: '2026-01-01',
  fileCount: 0, hookCount: 0, destinationRoot: '/d', ...over,
});

describe('filterSkills', () => {
  const all = [v({ key: 'a', name: 'alpha' }), v({ key: 'b', name: 'beta', agents: ['codex'] })];
  it('matches by name substring, case-insensitive', () => {
    expect(filterSkills(all, { query: 'ALP', agent: 'all' }).map((s) => s.key)).toEqual(['a']);
  });
  it('filters by agent', () => {
    expect(filterSkills(all, { query: '', agent: 'codex' }).map((s) => s.key)).toEqual(['b']);
  });
  it('returns all with empty query and agent=all', () => {
    expect(filterSkills(all, { query: '', agent: 'all' })).toHaveLength(2);
  });
});
