/**
 * The fixture submodule itself: is it checked out, and is its content still the
 * shape the rest of the suite (and the docs) assume?
 *
 * These assertions distinguish a *fixture* problem from a *product* problem. If
 * this file fails, the fixture drifted; if it passes and a later spec fails, the
 * CLI changed behaviour.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FIXTURE_DIR, REPO_ROOT, readJson } from '../src/cli';

/** Every tracked file in the fixture, as repository-relative paths. */
function fixtureFiles(): string[] {
  const out = execFileSync('git', ['-C', FIXTURE_DIR, 'ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter((line) => line !== '');
}

/** Recursively collect files under `dir`, skipping `.git`. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

describe('fixture submodule', () => {
  it('is checked out', () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('mcp.yml');
    expect(files).toContain('tooling/mcp.yml');
  });

  it('is recorded in the superproject as a gitlink', () => {
    const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-s', 'examples/test-repo'], {
      encoding: 'utf8',
    });
    // Mode 160000 is a submodule pointer. Anything else means the fixture was
    // committed as ordinary files, which would break clones.
    expect(out.startsWith('160000 ')).toBe(true);
  });

  it('has a clean worktree', () => {
    const out = execFileSync('git', ['-C', FIXTURE_DIR, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe('');
  });

  it('is ASCII-only', () => {
    const offenders: string[] = [];
    for (const file of walk(FIXTURE_DIR)) {
      const text = readFileSync(file, 'utf8');
      // eslint-disable-next-line no-control-regex -- deliberately matching non-ASCII
      if (/[^\x00-\x7F]/u.test(text)) offenders.push(relative(FIXTURE_DIR, file));
    }
    expect(offenders).toEqual([]);
  });

  it('ships the manifests the suite expects', () => {
    const files = fixtureFiles();
    const skills = files.filter((f) => f.endsWith('SKILL.md'));
    const hooks = files.filter((f) => f.endsWith('HOOK.md'));
    // 24 resolvable skills plus two deliberately unresolvable ones:
    // `deep-nesting/...`, which sits four group levels down -- one past the
    // limit of three -- and `requires/invalid-strict`, whose strict
    // `skillkeeper.requires` is malformed and so fails the whole manifest.
    expect(skills).toHaveLength(26);
    expect(hooks).toHaveLength(3);
    expect(skills).toContain('deep-nesting/l2/l3/l4/too-deep-skill/SKILL.md');
    expect(skills).toContain('requires/invalid-strict/SKILL.md');
    // The dependency group: one skill per behaviour the `requires` field and
    // the lint pass have. Counted so a dropped fixture shows up here rather
    // than as a mysteriously passing lint spec.
    expect(skills.filter((f) => f.startsWith('requires/'))).toHaveLength(13);
    // One group tree carrying skills at one, two, and three levels at once.
    expect(skills).toContain('platform/release-skill/SKILL.md');
    expect(skills).toContain('platform/lint/style-skill/SKILL.md');
    expect(skills).toContain('platform/lint/rust/clippy-skill/SKILL.md');
    // The scheme-3 sample must stay inert: the resolver reads
    // `skillkeeper.repo.yaml`, so the `.example` suffix is what keeps
    // auto-detection live in this fixture.
    expect(files).toContain('skillkeeper.repo.yaml.example');
    expect(files).not.toContain('skillkeeper.repo.yaml');
  });

  it('every manifest opens with a YAML frontmatter block naming the skill', () => {
    for (const file of fixtureFiles().filter(
      (f) => f.endsWith('SKILL.md') || f.endsWith('HOOK.md'),
    )) {
      const text = readFileSync(join(FIXTURE_DIR, file), 'utf8');
      expect(text.startsWith('---\n')).toBe(true);
      const frontmatter = text.split('---\n')[1] ?? '';
      expect(frontmatter).toMatch(/^name:\s*\S+/m);
    }
  });

  it('hook payloads are valid JSON', () => {
    for (const file of fixtureFiles().filter((f) => f.endsWith('.json'))) {
      expect(() => readJson(join(FIXTURE_DIR, file))).not.toThrow();
    }
  });

  it('script-skill ships its scripts non-executable, so install must apply +x', () => {
    // The point of the fixture: if the source were already 755, the install test
    // could not tell "applied from the executables list" from "inherited".
    const out = execFileSync(
      'git',
      ['-C', FIXTURE_DIR, 'ls-files', '-s', 'script-skill/bin', 'script-skill/lib'],
      { encoding: 'utf8' },
    );
    for (const line of out.split('\n').filter((l) => l !== '')) {
      expect(line.startsWith('100644 ')).toBe(true);
    }
  });
});
