import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import { buildManifest, classifyBundle, listExistingTags, main, scanAssets } from './gen-versions-json.mjs';

const changes = [
  '# SkillKeeper Changelog',
  '',
  '## Development',
  '',
  '- unreleased, must never appear',
  '',
  '## Version 0.6.0',
  '',
  '### Added',
  '- six',
  '',
  '## Version 0.5.0',
  '',
  '### Added',
  '- five',
  '',
  '## Version 0.4.0',
  '',
  '### Added',
  '- four',
  '',
].join('\n');

const base = { changes, existingTags: ['v0.6.0', 'v0.5.0', 'v0.4.0'], currentTag: 'v0.6.0', assets: [], generatedAt: 'T' };

describe('buildManifest', () => {
  it('lists versions newest first', () => {
    const m = buildManifest(base);
    expect(m.versions.map((v) => v.version)).toEqual(['0.6.0', '0.5.0', '0.4.0']);
  });

  it('never includes the Development section', () => {
    expect(JSON.stringify(buildManifest(base))).not.toContain('unreleased');
  });

  it('drops a version whose release was deleted', () => {
    const m = buildManifest({ ...base, existingTags: ['v0.6.0', 'v0.4.0'] });
    expect(m.versions.map((v) => v.version)).toEqual(['0.6.0', '0.4.0']);
  });

  it('keeps the tag being published even though its release does not exist yet', () => {
    const m = buildManifest({ ...base, existingTags: [] });
    expect(m.versions.map((v) => v.version)).toEqual(['0.6.0']);
  });

  it('flags a release candidate', () => {
    const rc = changes.replace('## Version 0.6.0', '## Version 0.6.0-rc.1');
    const m = buildManifest({ ...base, changes: rc, existingTags: ['v0.6.0-rc.1', 'v0.5.0', 'v0.4.0'], currentTag: 'v0.6.0-rc.1' });
    expect(m.versions[0]).toMatchObject({ version: '0.6.0-rc.1', prerelease: true });
    expect(m.versions[1]).toMatchObject({ prerelease: false });
  });

  it('carries assets only on the entry being released', () => {
    const m = buildManifest({
      ...base,
      assets: [{ key: 'linux-x86_64', kind: 'deb', name: 'a.deb', sha256: 'ab' }],
    });
    expect(m.versions[0].assets['linux-x86_64']).toEqual([{ kind: 'deb', name: 'a.deb', sha256: 'ab' }]);
    expect(m.versions[1].assets).toBeUndefined();
  });

  it('throws rather than silently omitting the release when currentTag matches no heading', () => {
    // No "## Version 9.9.9" section exists anywhere in `changes`: a tag was
    // pushed without bump-version promoting Development, or the heading and
    // the tag disagree. The old behaviour hashed nothing new, kept every
    // other version, and exited 0 with no assets anywhere -- exactly the
    // silent blackout this guard exists to prevent.
    expect(() => buildManifest({ ...base, currentTag: 'v9.9.9' })).toThrow(/matches no "## Version" section/);
  });

  it('attaches assets to the published entry, not the newest one, when a newer candidate already exists', () => {
    // decide.rs's `candidates` is filtered to versions above the running one
    // AND to the client's channel before `.first()` is taken. A stable
    // client running 0.5.0 filters 0.6.0-rc.1 out of its own candidate list
    // entirely, so publishing v0.5.1 as an ordinary maintenance patch while
    // v0.6.0-rc.1 already exists is a normal thing to do -- the stable
    // client's candidates are just [0.5.1], and the assets belong there.
    // This is the scenario the review's I2 finding got wrong: it assumed
    // decide() reads assets off the greatest version in the whole manifest,
    // ignoring that both filters above are per-client.
    const withNewerRc = [
      '# SkillKeeper Changelog',
      '',
      '## Version 0.6.0-rc.1',
      '',
      '### Added',
      '- six rc',
      '',
      '## Version 0.5.1',
      '',
      '### Fixed',
      '- five one',
      '',
      '## Version 0.5.0',
      '',
      '### Added',
      '- five',
      '',
    ].join('\n');
    const m = buildManifest({
      changes: withNewerRc,
      existingTags: ['v0.6.0-rc.1', 'v0.5.1', 'v0.5.0'],
      currentTag: 'v0.5.1',
      assets: [{ key: 'linux-x86_64', kind: 'deb', name: 'a.deb', sha256: 'ab' }],
      generatedAt: 'T',
    });
    expect(m.versions.map((v) => v.version)).toEqual(['0.6.0-rc.1', '0.5.1', '0.5.0']);
    const published = m.versions.find((v) => v.version === '0.5.1');
    expect(published.assets['linux-x86_64']).toEqual([{ kind: 'deb', name: 'a.deb', sha256: 'ab' }]);
    // Neither the newer candidate nor the older release carries assets.
    expect(m.versions.find((v) => v.version === '0.6.0-rc.1').assets).toBeUndefined();
    expect(m.versions.find((v) => v.version === '0.5.0').assets).toBeUndefined();
  });

  it('carries notes only for the ten most recent versions', () => {
    const many = ['# SkillKeeper Changelog', ''];
    const tags = [];
    for (let i = 30; i >= 1; i--) {
      many.push(`## Version 0.${i}.0`, '', `- change ${i}`, '');
      tags.push(`v0.${i}.0`);
    }
    const m = buildManifest({ ...base, changes: many.join('\n'), existingTags: tags, currentTag: 'v0.30.0' });
    expect(m.versions.filter((v) => v.notes !== undefined)).toHaveLength(10);
    expect(m.versions[9].notes).toBeDefined();
    expect(m.versions[10].notes).toBeUndefined();
  });

  it('lists at most one hundred versions', () => {
    const many = ['# SkillKeeper Changelog', ''];
    const tags = [];
    for (let i = 150; i >= 1; i--) {
      many.push(`## Version 0.${i}.0`, '', `- change ${i}`, '');
      tags.push(`v0.${i}.0`);
    }
    const m = buildManifest({ ...base, changes: many.join('\n'), existingTags: tags, currentTag: 'v0.150.0' });
    expect(m.versions).toHaveLength(100);
  });

  it('stamps the schema and the generation time', () => {
    const m = buildManifest(base);
    expect(m.schema).toBe(1);
    expect(m.generatedAt).toBe('T');
  });

  it('sorts release candidates by rc number numerically, below their final', () => {
    // rc.9 and rc.10 are adjacent in CHANGES.md today; a naive string compare
    // would put "rc.10" behind "rc.2" and "rc.9". The final release of the
    // same X.Y.Z must still sort above every one of its own candidates.
    const rcChanges = [
      '# SkillKeeper Changelog',
      '',
      '## Version 0.7.0',
      '',
      '- final',
      '',
      '## Version 0.7.0-rc.10',
      '',
      '- rc10',
      '',
      '## Version 0.7.0-rc.9',
      '',
      '- rc9',
      '',
      '## Version 0.7.0-rc.2',
      '',
      '- rc2',
      '',
    ].join('\n');
    const tags = ['v0.7.0', 'v0.7.0-rc.10', 'v0.7.0-rc.9', 'v0.7.0-rc.2'];
    const m = buildManifest({
      changes: rcChanges,
      existingTags: tags,
      currentTag: 'v0.7.0',
      assets: [],
      generatedAt: 'T',
    });
    expect(m.versions.map((v) => v.version)).toEqual([
      '0.7.0',
      '0.7.0-rc.10',
      '0.7.0-rc.9',
      '0.7.0-rc.2',
    ]);
  });

  it('rejects a malformed version heading instead of comparing it as NaN', () => {
    // The malformed heading must be the one being published (or already
    // known-existing), or the tag filter would drop it before it ever
    // reaches the comparator -- so currentTag is set to match it.
    const bad = base.changes.replace('## Version 0.5.0', '## Version 0.x.0');
    expect(() =>
      buildManifest({ ...base, changes: bad, currentTag: 'v0.x.0' }),
    ).toThrow(/malformed version/);
  });
});

describe('classifyBundle', () => {
  it.each([
    ['SkillKeeper_0.6.0_aarch64.dmg', { key: 'macos-aarch64', kind: 'dmg' }],
    ['SkillKeeper_0.6.0_x64.dmg', { key: 'macos-x86_64', kind: 'dmg' }],
    ['SkillKeeper_0.6.0_amd64.deb', { key: 'linux-x86_64', kind: 'deb' }],
    ['SkillKeeper_0.6.0_arm64.deb', { key: 'linux-aarch64', kind: 'deb' }],
    ['SkillKeeper_0.6.0_amd64.AppImage', { key: 'linux-x86_64', kind: 'appimage' }],
    ['SkillKeeper_0.6.0_aarch64.AppImage', { key: 'linux-aarch64', kind: 'appimage' }],
    ['SkillKeeper_0.6.0_x64-setup.exe', { key: 'windows-x86_64', kind: 'nsis' }],
    ['SkillKeeper_0.6.0_arm64-setup.exe', { key: 'windows-aarch64', kind: 'nsis' }],
    ['SkillKeeper_0.6.0_x64_en-US.msi', { key: 'windows-x86_64', kind: 'msi' }],
    ['SkillKeeper_0.6.0_arm64_en-US.msi', { key: 'windows-aarch64', kind: 'msi' }],
  ])('classifies the real bundler name %s', (name, expected) => {
    expect(classifyBundle(name)).toEqual(expected);
  });

  it('does not classify a Windows MSIX (handled by an explicit skip, not here)', () => {
    expect(classifyBundle('SkillKeeper-0.6.0.0-x64.msix')).toBeNull();
  });

  it('returns null for a name it cannot classify', () => {
    expect(classifyBundle('SkillKeeper_0.6.0_x86_64.rpm')).toBeNull();
  });
});

describe('scanAssets', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gen-versions-json-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('classifies staged bundles and hashes them, skipping known non-bundle files', () => {
    const write = (name) => writeFileSync(join(dir, name), name);
    write('SkillKeeper_0.6.0_amd64.deb');
    write('SkillKeeper_0.6.0_aarch64.dmg');
    write('mcp.schema.json');
    write('skillkeeper-cli-x86_64-unknown-linux-gnu.tar.gz');
    write('SkillKeeper-0.6.0.0-x64.msix');

    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = scanAssets(dir);

    expect(assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'linux-x86_64', kind: 'deb', name: 'SkillKeeper_0.6.0_amd64.deb' }),
        expect.objectContaining({ key: 'macos-aarch64', kind: 'dmg', name: 'SkillKeeper_0.6.0_aarch64.dmg' }),
      ]),
    );
    expect(assets).toHaveLength(2);
    expect(assets[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // The msix, the schema, and the CLI archive are all known non-bundle
    // files: none of them should have produced a warning.
    expect(warn).not.toHaveBeenCalled();
    // mockRestore() clears recorded calls, so it must come after every
    // assertion that inspects them, not before.
    warn.mockRestore();
  });

  it('warns, without dropping the file from the scan, exactly once per unclassifiable name', () => {
    writeFileSync(join(dir, 'SkillKeeper_0.6.0_x86_64.rpm'), 'x');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const assets = scanAssets(dir);

    expect(assets).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('::warning::');
    expect(warn.mock.calls[0][0]).toContain('SkillKeeper_0.6.0_x86_64.rpm');
    warn.mockRestore();
  });
});

describe('listExistingTags', () => {
  beforeEach(() => {
    execFileSync.mockReset();
  });

  it('returns the tags gh reports', () => {
    execFileSync.mockReturnValue(JSON.stringify([{ tagName: 'v0.6.0' }, { tagName: 'v0.5.0' }]));
    expect(listExistingTags('unused')).toEqual(['v0.6.0', 'v0.5.0']);
  });

  it('falls back to every tag already in CHANGES.md when gh fails, and warns', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('gh: command not found');
    });
    const changes = ['# Changelog', '', '## Version 0.2.0', '', '- x', ''].join('\n');
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tags = listExistingTags(changes);

    expect(tags).toEqual(['v0.2.0']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('::warning::');
    warn.mockRestore();
  });
});

// main() is the previously-untested seam: the composition of scanAssets, the
// current tag, and buildManifest, driven with the real filesystem against a
// synthetic repository root under /tmp rather than mocked collaborators.
// This is exactly where the silently-empty-manifest defect lived (a tag with
// no matching CHANGES.md section produced a versions.json with no assets
// anywhere and exit 0) -- so these tests drive main() end to end and inspect
// the file it writes, not just buildManifest's return value.
describe('main', () => {
  let root;

  beforeEach(() => {
    execFileSync.mockReset();
    root = mkdtempSync(join(tmpdir(), 'gen-versions-json-main-'));
    writeFileSync(join(root, 'CHANGES.md'), changes);
    mkdirSync(join(root, 'dist'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** `argv` shaped the way the release workflow invokes this script: node, script path, tag, dist-dir. */
  const argv = (tag, distDir = 'dist') => ['node', 'scripts/gen-versions-json.mjs', tag, distDir];

  it('writes versions.json, attaching the staged assets to the newest entry', () => {
    writeFileSync(join(root, 'dist', 'SkillKeeper_0.6.0_amd64.deb'), 'deb-bytes');
    writeFileSync(join(root, 'dist', 'SkillKeeper_0.6.0_aarch64.dmg'), 'dmg-bytes');
    execFileSync.mockReturnValue(
      JSON.stringify([{ tagName: 'v0.6.0' }, { tagName: 'v0.5.0' }, { tagName: 'v0.4.0' }]),
    );

    const manifest = main({ argv: argv('v0.6.0'), env: {}, root, now: () => 'FIXED-TIME' });

    expect(manifest.generatedAt).toBe('FIXED-TIME');
    expect(manifest.versions[0].tag).toBe('v0.6.0');
    expect(manifest.versions[0].assets['linux-x86_64'][0].name).toBe('SkillKeeper_0.6.0_amd64.deb');
    expect(manifest.versions[0].assets['macos-aarch64'][0].name).toBe('SkillKeeper_0.6.0_aarch64.dmg');
    expect(manifest.versions[1].assets).toBeUndefined();

    // The write actually landed on disk, in the shape the desktop client parses.
    const written = JSON.parse(readFileSync(join(root, 'dist', 'versions.json'), 'utf8'));
    expect(written).toEqual(manifest);
  });

  it('throws when no tag is given, by argument or by $GITHUB_REF_NAME, and writes nothing', () => {
    expect(() => main({ argv: ['node', 'scripts/gen-versions-json.mjs'], env: {}, root })).toThrow(
      /no tag given/,
    );
    expect(existsSync(join(root, 'dist', 'versions.json'))).toBe(false);
  });

  it('throws when the dist directory does not exist', () => {
    expect(() => main({ argv: argv('v0.6.0', 'no-such-dir'), env: {}, root })).toThrow(
      /no such directory/,
    );
  });

  it('throws, and writes nothing, when the tag matches no CHANGES.md section', () => {
    // Simulates a tag pushed without bump-version promoting Development, or a
    // heading whose version segment disagrees with the tag: exactly I3's
    // failure scenario. Before the fix this exited 0 with a versions.json
    // that had discarded every staged asset; now it must fail loudly and
    // must not write the file at all.
    writeFileSync(join(root, 'dist', 'SkillKeeper_0.9.9_amd64.deb'), 'deb-bytes');
    execFileSync.mockReturnValue(
      JSON.stringify([{ tagName: 'v0.6.0' }, { tagName: 'v0.5.0' }, { tagName: 'v0.4.0' }]),
    );

    expect(() => main({ argv: argv('v9.9.9'), env: {}, root })).toThrow(
      /matches no "## Version" section/,
    );
    expect(existsSync(join(root, 'dist', 'versions.json'))).toBe(false);
  });

  it('succeeds and attaches assets to the published entry when a newer prerelease already exists', () => {
    // A maintenance patch (v0.5.0) published while a newer prerelease
    // (v0.6.0-rc.1) already exists is ordinary, not an error: a stable
    // client's own candidate filtering in decide.rs excludes the RC, so its
    // candidates are just [v0.5.0], and that is exactly the entry the
    // assets belong on.
    const withNewerRc = changes.replace(
      '## Version 0.6.0',
      ['## Version 0.6.0-rc.1', '', '### Added', '- six rc', '', '## Version 0.6.0'].join('\n'),
    );
    writeFileSync(join(root, 'CHANGES.md'), withNewerRc);
    writeFileSync(join(root, 'dist', 'SkillKeeper_0.5.0_amd64.deb'), 'deb-bytes');
    execFileSync.mockReturnValue(
      JSON.stringify([{ tagName: 'v0.6.0-rc.1' }, { tagName: 'v0.6.0' }, { tagName: 'v0.5.0' }, { tagName: 'v0.4.0' }]),
    );

    const manifest = main({ argv: argv('v0.5.0'), env: {}, root, now: () => 'FIXED-TIME' });

    const published = manifest.versions.find((v) => v.tag === 'v0.5.0');
    expect(published.assets['linux-x86_64'][0].name).toBe('SkillKeeper_0.5.0_amd64.deb');
    expect(manifest.versions.find((v) => v.tag === 'v0.6.0-rc.1').assets).toBeUndefined();
    expect(existsSync(join(root, 'dist', 'versions.json'))).toBe(true);
  });

  it('falls back to $GITHUB_REF_NAME when no tag argument is given', () => {
    execFileSync.mockReturnValue(
      JSON.stringify([{ tagName: 'v0.6.0' }, { tagName: 'v0.5.0' }, { tagName: 'v0.4.0' }]),
    );
    const manifest = main({
      argv: ['node', 'scripts/gen-versions-json.mjs'],
      env: { GITHUB_REF_NAME: 'v0.6.0' },
      root,
      now: () => 'FIXED-TIME',
    });
    expect(manifest.versions[0].tag).toBe('v0.6.0');
  });
});
