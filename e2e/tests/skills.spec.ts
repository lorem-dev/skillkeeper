/**
 * Skill resolution and install, end to end: the resolution schemes, selective
 * executable bits, guidance-file precedence, hook merging and consent, and the
 * two silent-failure modes the resolver has had.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, readJson, Sandbox } from '../src/cli';

/** The eight skills that install for claude. `text-hook-skill` is opencode's. */
const CLAUDE_SKILLS = [
  'minimal-skill',
  'documented-skill',
  'script-skill',
  'json-hooks-skill',
  'tooling/lint-skill',
  'tooling/format-skill',
  'docs-writing/changelog-skill',
  'docs-writing/readme-skill',
];

describe('skill install', () => {
  let sandbox: Sandbox;
  let clone: string;
  let project: string;

  beforeAll(() => {
    sandbox = new Sandbox();
    clone = sandbox.addFixtureRepo();
    project = sandbox.project();
    for (const id of CLAUDE_SKILLS) {
      sandbox.runOk([
        'skill',
        'install',
        id,
        '--agent',
        'claude',
        '--project',
        project,
        '--allow-hooks',
      ]);
    }
  });

  afterAll(() => sandbox.cleanup());

  const skillsRoot = () => join(project, '.claude', 'skills');

  it('installs every resolvable skill for claude', () => {
    for (const id of CLAUDE_SKILLS) {
      // The destination directory is named after the skill alone; the group is
      // part of the id, not the path.
      const dir = join(skillsRoot(), id.split('/').pop() as string);
      expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
      expect(existsSync(join(dir, '.skid.yml'))).toBe(true);
    }
  });

  it('records the group in a grouped skill identity file', () => {
    const skid = read(join(skillsRoot(), 'lint-skill', '.skid.yml'));
    expect(skid).toContain('name: lint-skill');
    expect(skid).toContain('group: tooling');
    // Ungrouped skills omit the field entirely rather than emitting an empty one.
    expect(read(join(skillsRoot(), 'minimal-skill', '.skid.yml'))).not.toContain('group:');
  });

  it('recreates nested body paths instead of flattening them', () => {
    expect(existsSync(join(skillsRoot(), 'documented-skill', 'reference', 'notes.md'))).toBe(true);
    expect(existsSync(join(skillsRoot(), 'format-skill', 'config', 'format.toml'))).toBe(true);
  });

  it('applies +x only to the declared executables', () => {
    const executable = (p: string) => (statSync(p).mode & 0o111) !== 0;
    const bin = join(skillsRoot(), 'script-skill', 'bin');
    expect(executable(join(bin, 'run.sh'))).toBe(true);
    expect(executable(join(bin, 'check.py'))).toBe(true);
    // Deliberately absent from the `executables` list: the control case.
    expect(executable(join(skillsRoot(), 'script-skill', 'lib', 'shared.sh'))).toBe(false);
  });

  describe('guidance', () => {
    // Claude's target is `.claude/CLAUDE.md` when the project has no top-level
    // CLAUDE.md.
    const guidance = () => read(join(project, '.claude', 'CLAUDE.md'));

    it('writes one marked block per skill that ships guidance', () => {
      const blocks = guidance().match(/SKILLKEEPER_START/g) ?? [];
      // documented-skill, script-skill, json-hooks-skill, tooling/lint-skill,
      // docs-writing/changelog-skill. The other three ship neither file.
      expect(blocks).toHaveLength(5);
    });

    it('prefers GUIDE.md over RULES.md when a skill ships both', () => {
      expect(guidance()).toContain('documented-skill (from GUIDE.md)');
      expect(guidance()).not.toContain('documented-skill (from RULES.md)');
    });

    it('falls back to RULES.md when there is no GUIDE.md', () => {
      expect(guidance()).toContain('script-skill (from RULES.md)');
    });

    it('keys a grouped skill block by its full id', () => {
      expect(guidance()).toContain('tooling/lint-skill');
    });
  });

  describe('hooks', () => {
    it('merges one owned node per hook, tagged with the ownership marker', () => {
      const settings = readJson<{
        hooks: Record<string, { matcher?: string; _skillkeeper?: { label?: string } }[]>;
      }>(join(project, '.claude', 'settings.json'));
      const labels = Object.entries(settings.hooks)
        .flatMap(([key, entries]) => entries.map((e) => `${key}:${e._skillkeeper?.label ?? ''}`))
        .sort();
      expect(labels).toEqual([
        'PostToolUse:json-hooks-skill:post-tool-use',
        'PreToolUse:json-hooks-skill:pre-tool-use',
      ]);
    });

    it('installs the body but skips hooks without --allow-hooks', () => {
      const bare = sandbox.project('no-consent');
      const result = sandbox.runOk([
        'skill',
        'install',
        'json-hooks-skill',
        '--agent',
        'claude',
        '--project',
        bare,
      ]);
      expect(result.output).toContain('--allow-hooks');
      expect(existsSync(join(bare, '.claude', 'skills', 'json-hooks-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(bare, '.claude', 'settings.json'))).toBe(false);
    });

    it('wraps a delimited-text hook in a region and neutralizes decoy delimiters', () => {
      const opencode = sandbox.project('opencode');
      sandbox.runOk([
        'skill',
        'install',
        'text-hook-skill',
        '--agent',
        'opencode',
        '--project',
        opencode,
        '--allow-hooks',
      ]);
      const config = read(join(opencode, '.opencode', 'opencode.json'));
      expect(config).toContain('>>> skillkeeper:hook text-hook-skill:opencode-region');
      expect(config).toContain('<<< skillkeeper:hook text-hook-skill:opencode-region');
      // The payload contains lines that imitate a region boundary; install must
      // guard them so region removal cannot later stop at the wrong line.
      expect(config).toContain('SK7HOOKGUARD7');
      expect(config).not.toContain('>>> skillkeeper:hook decoy/decoy:decoy');
    });
  });

  describe('resolution warnings', () => {
    it('does not resolve a skill nested deeper than one group level', () => {
      const result = sandbox.run([
        'skill',
        'install',
        'too-deep-skill',
        '--agent',
        'claude',
        '--project',
        project,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain('Skill not found in any tracked repository');
    });

    it('reports the unresolved path, so a misplaced skill is not silently absent', () => {
      const result = sandbox.runOk([
        'skill',
        'install',
        'minimal-skill',
        '--agent',
        'claude',
        '--project',
        project,
      ]);
      expect(result.stderr).toContain('deep-nesting/level-two/too-deep-skill');
      expect(result.stderr).toContain('[fixture]');
    });

    it('says nothing about skills installed under an agent directory', () => {
      // A repository that itself uses SkillKeeper carries installed skills in its
      // own working tree. Those are consumed, not published: resolution must skip
      // them silently. This exact case used to warn on ordinary projects.
      const planted = join(clone, '.claude', 'skills', 'release-prep');
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, 'SKILL.md'), '---\nname: release-prep\n---\n');
      const vendored = join(clone, 'node_modules', 'pkg');
      mkdirSync(vendored, { recursive: true });
      writeFileSync(join(vendored, 'SKILL.md'), '---\nname: vendored\n---\n');

      const result = sandbox.runOk([
        'skill',
        'install',
        'minimal-skill',
        '--agent',
        'claude',
        '--project',
        project,
      ]);
      expect(result.stderr).not.toContain('release-prep');
      expect(result.stderr).not.toContain('node_modules');
      // The genuine negative fixture still warns.
      expect(result.stderr).toContain('deep-nesting');
    });
  });
});
