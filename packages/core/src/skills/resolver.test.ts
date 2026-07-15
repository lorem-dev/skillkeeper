import { describe, expect, it } from 'vitest';
import { resolveSkills } from './resolver.js';
import { createMemFs } from '../testing/memfs.js';

const SKILL = (name: string): string => `---\nname: ${name}\n---\n# ${name}\n`;
const HOOK = (name: string, agent = 'codex'): string =>
  `---\nname: ${name}\nstrategy: delimited-text\ntarget:\n  agent: ${agent}\n  filePattern: AGENTS.md\n---\n`;

describe('resolveSkills - scheme 1 (flat)', () => {
  it('resolves a flat skill with body files and one hook', async () => {
    const fs = createMemFs({
      'repo/mySkill/SKILL.md': SKILL('mySkill'),
      'repo/mySkill/run.sh': '#!/bin/sh\n',
      'repo/mySkill/lib/util.js': 'export {};\n',
      'repo/mySkill/hooks/HOOK.md': HOOK('mySkill-hook'),
      'repo/mySkill/hooks/snippet.txt': 'content\n',
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect(skill.id).toEqual({ name: 'mySkill' });
    expect(skill.rootPath).toBe('mySkill');
    // Body files exclude everything under hooks/.
    expect(skill.files).toEqual(['mySkill/SKILL.md', 'mySkill/lib/util.js', 'mySkill/run.sh']);
    expect(skill.hooks).toHaveLength(1);
    const hook = skill.hooks[0]!;
    expect(hook.manifest.name).toBe('mySkill-hook');
    expect(hook.manifestPath).toBe('mySkill/hooks/HOOK.md');
    expect(hook.files).toEqual(['mySkill/hooks/HOOK.md', 'mySkill/hooks/snippet.txt']);
  });

  it('resolves multiple flat skills', async () => {
    const fs = createMemFs({
      'repo/a/SKILL.md': SKILL('a'),
      'repo/b/SKILL.md': SKILL('b'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills.map((s) => s.id.name).sort()).toEqual(['a', 'b']);
  });
});

describe('resolveSkills - scheme 2 (grouped)', () => {
  it('resolves a grouped skill with the group set', async () => {
    const fs = createMemFs({
      'repo/group/mySkill/SKILL.md': SKILL('mySkill'),
      'repo/group/mySkill/file.txt': 'x\n',
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toEqual({ group: 'group', name: 'mySkill' });
    expect(skills[0]!.rootPath).toBe('group/mySkill');
  });

  it('does not treat a group directory itself as a skill', async () => {
    const fs = createMemFs({
      'repo/group/one/SKILL.md': SKILL('one'),
      'repo/group/two/SKILL.md': SKILL('two'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(2);
    expect(skills.every((s) => s.id.group === 'group')).toBe(true);
  });
});

describe('resolveSkills - scheme 3 (repo config)', () => {
  it('uses explicit skill paths from skillkeeper.repo.yaml, overriding auto-detection', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': [
        'version: 1',
        'skills:',
        '  - path: declared/here',
        '    name: explicit-name',
        '    group: g',
      ].join('\n'),
      'repo/declared/here/SKILL.md': SKILL('ignored-by-override'),
      'repo/declared/here/data.txt': 'x\n',
      // This auto-detectable skill must be ignored when config is present.
      'repo/auto/SKILL.md': SKILL('auto'),
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toEqual({ group: 'g', name: 'explicit-name' });
    expect(skills[0]!.rootPath).toBe('declared/here');
  });

  it('applies the default group and falls back to the manifest name', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': [
        'version: 1',
        'defaults:',
        '  group: shared',
        'skills:',
        '  - path: x/y',
      ].join('\n'),
      'repo/x/y/SKILL.md': SKILL('manifest-name'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills[0]!.id).toEqual({ group: 'shared', name: 'manifest-name' });
  });

  it('yields a group-less id when neither entry nor defaults set a group', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': ['version: 1', 'skills:', '  - path: x/y'].join('\n'),
      'repo/x/y/SKILL.md': SKILL('plain'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills[0]!.id).toEqual({ name: 'plain' });
  });

  it('applies a default group to an auto-detected flat skill in config mode', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': [
        'version: 1',
        'defaults:',
        '  group: shared',
        'include:',
        '  - "solo/**"',
      ].join('\n'),
      'repo/solo/SKILL.md': SKILL('solo'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    // The flat (group-less) skill inherits the default group from config.
    expect(skills[0]!.id).toEqual({ group: 'shared', name: 'solo' });
  });

  it('keeps the detected group for grouped skills in config auto-detect mode', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': ['version: 1', 'include:', '  - "g/**"'].join('\n'),
      'repo/g/inner/SKILL.md': SKILL('inner'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills[0]!.id).toEqual({ group: 'g', name: 'inner' });
  });

  it('warns when a declared path has no SKILL.md', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': ['version: 1', 'skills:', '  - path: missing/dir'].join('\n'),
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/missing\/dir/);
  });

  it('reports a warning when the repo config is invalid', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': 'skills: []',
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(0);
    expect(warnings.some((w) => /skillkeeper\.repo\.yaml/.test(w))).toBe(true);
  });

  it('honors include and exclude globs in config mode', async () => {
    const fs = createMemFs({
      'repo/skillkeeper.repo.yaml': [
        'version: 1',
        'include:',
        '  - "keep/**"',
        'exclude:',
        '  - "keep/no/**"',
      ].join('\n'),
      'repo/keep/yes/SKILL.md': SKILL('yes'),
      'repo/keep/no/SKILL.md': SKILL('no'),
      'repo/drop/me/SKILL.md': SKILL('dropped'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills.map((s) => s.id.name)).toEqual(['yes']);
  });
});

describe('resolveSkills - reserved hooks and depth warnings', () => {
  it('never counts files under hooks/ as skill body files', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL('s'),
      'repo/s/hooks/HOOK.md': HOOK('h'),
      'repo/s/hooks/deep/nested.txt': 'x\n',
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills[0]!.files).toEqual(['s/SKILL.md']);
    expect([...skills[0]!.hooks[0]!.files].sort()).toEqual([
      's/hooks/HOOK.md',
      's/hooks/deep/nested.txt',
    ]);
  });

  it('does not treat a hooks directory as a skill even if it contains SKILL.md by mistake', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL('s'),
      // A stray SKILL.md under hooks/ must be ignored (hooks/ is reserved).
      'repo/s/hooks/SKILL.md': SKILL('should-not-resolve'),
      'repo/s/hooks/HOOK.md': HOOK('h'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.id.name).toBe('s');
  });

  it('emits an unresolved-path warning for a 3-level-deep SKILL.md, not a guessed skill', async () => {
    const fs = createMemFs({
      'repo/group/sub/tooDeep/SKILL.md': SKILL('tooDeep'),
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/group\/sub\/tooDeep/);
  });

  it('resolves shallow skills while warning about a sibling that is too deep', async () => {
    const fs = createMemFs({
      'repo/ok/SKILL.md': SKILL('ok'),
      'repo/a/b/c/SKILL.md': SKILL('deep'),
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills.map((s) => s.id.name)).toEqual(['ok']);
    expect(warnings).toHaveLength(1);
  });

  it('handles an invalid SKILL.md by surfacing a warning, not throwing', async () => {
    const fs = createMemFs({
      'repo/bad/SKILL.md': '---\nversion: 1\n---\n', // missing name
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(0);
    expect(warnings.some((w) => /bad\/SKILL\.md/.test(w))).toBe(true);
  });

  it('skips a malformed HOOK.md with a warning but keeps the skill', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL('s'),
      'repo/s/hooks/HOOK.md': '---\nstrategy: nope\n---\n',
    });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills).toHaveLength(1);
    expect(skills[0]!.hooks).toHaveLength(0);
    expect(warnings.some((w) => /HOOK\.md/.test(w))).toBe(true);
  });

  it('returns nothing for an empty repository', async () => {
    const fs = createMemFs({ 'repo/.keep': '' });
    const { skills, warnings } = await resolveSkills(fs, 'repo');
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('returns nothing when the repo root does not exist (unlistable)', async () => {
    const fs = createMemFs({ 'other/file.txt': 'x' });
    const { skills, warnings } = await resolveSkills(fs, 'does-not-exist');
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('supports multiple named hooks under hooks/<name>/HOOK.md', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL('s'),
      'repo/s/hooks/one/HOOK.md': HOOK('one'),
      'repo/s/hooks/one/a.txt': 'x\n',
      'repo/s/hooks/two/HOOK.md': HOOK('two'),
    });
    const { skills } = await resolveSkills(fs, 'repo');
    const hooks = skills[0]!.hooks;
    expect(hooks.map((h) => h.manifest.name).sort()).toEqual(['one', 'two']);
    const one = hooks.find((h) => h.manifest.name === 'one')!;
    expect([...one.files].sort()).toEqual(['s/hooks/one/HOOK.md', 's/hooks/one/a.txt']);
  });
});
