import { describe, expect, it } from 'vitest';
import { ManifestError, parseHookManifest, parseSkillManifest } from './manifest.js';

describe('parseSkillManifest', () => {
  it('parses name, version, and description from frontmatter', () => {
    const md = [
      '---',
      'name: my-skill',
      'version: 1.2.3',
      'description: Does a thing',
      '---',
      '',
      '# Body text is ignored',
    ].join('\n');
    const m = parseSkillManifest(md);
    expect(m.name).toBe('my-skill');
    expect(m.version).toBe('1.2.3');
    expect(m.description).toBe('Does a thing');
  });

  it('coerces a numeric YAML version to a string', () => {
    const md = ['---', 'name: s', 'version: 1.0', '---'].join('\n');
    expect(parseSkillManifest(md).version).toBe('1');
  });

  it('parses optional executables and hooks lists', () => {
    const md = [
      '---',
      'name: s',
      'executables:',
      '  - run.sh',
      '  - bin/tool',
      'hooks:',
      '  - setup',
      '---',
    ].join('\n');
    const m = parseSkillManifest(md);
    expect(m.executables).toEqual(['run.sh', 'bin/tool']);
    expect(m.hooks).toEqual(['setup']);
  });

  it('throws ManifestError with the field path when name is missing', () => {
    const md = ['---', 'version: 1.0.0', '---'].join('\n');
    expect(() => parseSkillManifest(md)).toThrow(ManifestError);
    try {
      parseSkillManifest(md);
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestError);
      expect((err as ManifestError).fieldPath).toBe('name');
    }
  });

  it('throws ManifestError when there is no frontmatter at all', () => {
    expect(() => parseSkillManifest('# Just a heading')).toThrow(ManifestError);
    try {
      parseSkillManifest('# Just a heading');
    } catch (err) {
      expect((err as ManifestError).fieldPath).toBe('name');
    }
  });

  it('throws ManifestError when frontmatter is not a mapping', () => {
    const md = ['---', '- just', '- a', '- list', '---'].join('\n');
    expect(() => parseSkillManifest(md)).toThrow(ManifestError);
  });

  it('throws ManifestError when the YAML is malformed', () => {
    const md = ['---', 'name: "unterminated', '---'].join('\n');
    expect(() => parseSkillManifest(md)).toThrow(ManifestError);
  });
});

describe('parseHookManifest', () => {
  it('parses name, target, and delimited-text strategy', () => {
    const md = [
      '---',
      'name: my-hook',
      'strategy: delimited-text',
      'target:',
      '  agent: codex',
      '  filePattern: AGENTS.md',
      '---',
    ].join('\n');
    const h = parseHookManifest(md);
    expect(h.name).toBe('my-hook');
    expect(h.strategy).toBe('delimited-text');
    expect(h.target.agent).toBe('codex');
    expect(h.target.filePattern).toBe('AGENTS.md');
  });

  it('parses a json-merge hook with a keyPath target', () => {
    const md = [
      '---',
      'name: claude-hook',
      'strategy: json-merge',
      'target:',
      '  agent: claude',
      '  keyPath: hooks.PreToolUse',
      '---',
    ].join('\n');
    const h = parseHookManifest(md);
    expect(h.strategy).toBe('json-merge');
    expect(h.target.keyPath).toBe('hooks.PreToolUse');
  });

  it('throws ManifestError on an invalid strategy', () => {
    const md = ['---', 'name: h', 'strategy: nonsense', 'target:', '  agent: claude', '---'].join(
      '\n',
    );
    expect(() => parseHookManifest(md)).toThrow(ManifestError);
    try {
      parseHookManifest(md);
    } catch (err) {
      expect((err as ManifestError).fieldPath).toBe('strategy');
    }
  });

  it('throws ManifestError on an unknown agent', () => {
    const md = ['---', 'name: h', 'strategy: file', 'target:', '  agent: notanagent', '---'].join(
      '\n',
    );
    expect(() => parseHookManifest(md)).toThrow(ManifestError);
    try {
      parseHookManifest(md);
    } catch (err) {
      expect((err as ManifestError).fieldPath).toBe('target.agent');
    }
  });
});
