/**
 * verify -> repair -> verify, plus the bounds on repair's deletion.
 *
 * Repair is the one operation that deletes files a user may have put there by
 * hand, so the bounds matter as much as the restoration: it must not reach
 * outside the repaired skill's own directory, and must not touch files another
 * install records in the same directory.
 *
 * Note `verify`, `repair`, and `uninstall` take no `--project`: they act on the
 * current directory, unlike `install`.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { read, readJson, Sandbox } from '../src/cli';

describe('verify and repair', () => {
  let sandbox: Sandbox;
  let project: string;

  beforeEach(() => {
    sandbox = new Sandbox();
    sandbox.addFixtureRepo();
    project = sandbox.project();
    for (const id of ['documented-skill', 'minimal-skill', 'json-hooks-skill']) {
      sandbox.runOk(['skill', 'install', id, '--agent', 'claude', '--project', project, '--allow-hooks']);
    }
  });

  afterEach(() => sandbox.cleanup());

  const skillDir = (name: string) => join(project, '.claude', 'skills', name);

  it('reports each drift state, then repairs to a clean verify', () => {
    const dir = skillDir('documented-skill');
    writeFileSync(join(dir, 'reference', 'notes.md'), 'drifted\n'); // modified
    rmSync(join(dir, 'RULES.md')); // missing
    writeFileSync(join(dir, 'unrecorded.txt'), 'junk\n'); // extraneous
    mkdirSync(join(dir, 'stray'), { recursive: true });
    writeFileSync(join(dir, 'stray', 'deep.txt'), 'junk\n'); // nested extraneous

    const before = sandbox.run(['skill', 'verify', 'documented-skill'], { cwd: project });
    expect(before.status).not.toBe(0);
    expect(before.output).toContain('modified');
    expect(before.output).toContain('missing');
    expect(before.output).toContain('extraneous');

    const repaired = sandbox.runOk(['skill', 'repair', 'documented-skill'], { cwd: project });
    // Deleting a user's file silently would be indefensible; each path is named.
    expect(repaired.output).toContain('unrecorded.txt');
    expect(repaired.output).toContain(join('stray', 'deep.txt'));

    const after = sandbox.runOk(['skill', 'verify', 'documented-skill'], { cwd: project });
    expect(after.output).toContain('OK');
  });

  it('restores modified and missing files from source', () => {
    const dir = skillDir('documented-skill');
    writeFileSync(join(dir, 'reference', 'notes.md'), 'drifted\n');
    rmSync(join(dir, 'RULES.md'));

    sandbox.runOk(['skill', 'repair', 'documented-skill'], { cwd: project });
    expect(existsSync(join(dir, 'RULES.md'))).toBe(true);
    expect(read(join(dir, 'reference', 'notes.md'))).not.toContain('drifted');
  });

  it('prunes the directories an extraneous file created', () => {
    const dir = skillDir('documented-skill');
    mkdirSync(join(dir, 'stray', 'deeper'), { recursive: true });
    writeFileSync(join(dir, 'stray', 'deeper', 'x.txt'), 'junk\n');

    sandbox.runOk(['skill', 'repair', 'documented-skill'], { cwd: project });
    expect(existsSync(join(dir, 'stray'))).toBe(false);
    // The skill's own directory survives, of course.
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true);
  });

  it('never reaches outside the repaired skill directory', () => {
    const before = readdirSync(join(project, '.claude', 'skills')).sort();
    writeFileSync(join(skillDir('documented-skill'), 'unrecorded.txt'), 'junk\n');
    // A file at the skills root, alongside the MCP ledgers: outside any skill.
    writeFileSync(join(project, '.claude', 'skills', 'bystander.txt'), 'keep me\n');

    sandbox.runOk(['skill', 'repair', 'documented-skill'], { cwd: project });

    expect(existsSync(join(project, '.claude', 'skills', 'bystander.txt'))).toBe(true);
    // Every sibling skill is intact, files and all.
    expect(readdirSync(join(project, '.claude', 'skills')).sort()).toEqual(expect.arrayContaining(before));
    expect(existsSync(join(skillDir('minimal-skill'), 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir('json-hooks-skill'), 'SKILL.md'))).toBe(true);
  });

  it('uninstall reverses the hook edits and the guidance block', () => {
    const guidanceBefore = read(join(project, '.claude', 'CLAUDE.md'));
    expect(guidanceBefore).toContain('json-hooks-skill (from GUIDE.md)');

    sandbox.runOk(['skill', 'uninstall', 'json-hooks-skill'], { cwd: project });

    // Both owned nodes are gone, and the arrays they lived in were pruned.
    const settings = readJson<{ hooks?: Record<string, unknown> }>(join(project, '.claude', 'settings.json'));
    expect(settings.hooks ?? {}).toEqual({});
    expect(existsSync(skillDir('json-hooks-skill'))).toBe(false);

    const guidanceAfter = read(join(project, '.claude', 'CLAUDE.md'));
    expect(guidanceAfter).not.toContain('json-hooks-skill (from GUIDE.md)');
    // Other skills' blocks are untouched.
    expect(guidanceAfter).toContain('documented-skill (from GUIDE.md)');
  });
});
