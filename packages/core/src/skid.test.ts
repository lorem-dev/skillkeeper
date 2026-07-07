import { describe, expect, it } from 'vitest';
import { installSkill } from './install.js';
import { resolveSkills } from './resolver.js';
import { skillHasUpdate } from './updates.js';
import { createMemFs } from './testing/memfs.js';
import { contentHash, manifestContentHash, resolvedContentHash } from './hashing.js';
import { parseSkid, serializeSkid } from './skid.js';
import { normalizeRemote } from './repoRemote.js';
import type { AgentAdapter } from './adapter.js';
import type { FsPort, HostEnv, ResolvedSkill } from './index.js';

const ENV: HostEnv = { homeDir: '/home/u', platform: 'linux', env: {} };
const REMOTE = 'git@github.com:acme/skills.git';

function adapter(root: string): AgentAdapter {
  return {
    kind: 'claude',
    async isAvailable() {
      return true;
    },
    async destinationRoot() {
      return root;
    },
    async discoverInstalled() {
      return [];
    },
  };
}

async function onlySkill(fs: FsPort, repoRoot: string): Promise<ResolvedSkill> {
  const { skills } = await resolveSkills(fs, repoRoot);
  const skill = skills[0];
  if (skill === undefined) throw new Error('no skill resolved');
  return skill;
}

describe('serializeSkid / parseSkid', () => {
  it('round-trips, omitting absent optional fields', () => {
    const text = serializeSkid({ schema: 1, remote: REMOTE, name: 's', version: 'abc' });
    expect(text.startsWith('#')).toBe(true);
    expect(text).not.toContain('group:');
    expect(parseSkid(text)).toEqual({ schema: 1, remote: REMOTE, name: 's', group: undefined, version: 'abc' });
  });

  it('carries the group when present', () => {
    const skid = { schema: 1, remote: REMOTE, name: 's', group: 'fmt', version: 'h' };
    expect(parseSkid(serializeSkid(skid))).toEqual(skid);
  });

  it('returns undefined for non-skid or malformed yaml', () => {
    expect(parseSkid('name: only')).toBeUndefined(); // no version
    expect(parseSkid(': : :')).toBeUndefined();
    expect(parseSkid('42')).toBeUndefined();
  });
});

describe('normalizeRemote', () => {
  it('maps ssh/https/.git variants of one repo to the same identity', () => {
    const forms = [
      'git@github.com:Acme/Skills.git',
      'https://github.com/acme/skills',
      'https://user@github.com/acme/skills.git/',
      'ssh://git@github.com:22/acme/skills.git',
    ];
    const norm = forms.map(normalizeRemote);
    expect(new Set(norm).size).toBe(1);
    expect(norm[0]).toBe('github.com/acme/skills');
  });
});

describe('installSkill .skid.yml + contentHash invariant', () => {
  const files = {
    'repo/s/SKILL.md': '---\nname: s\n---\nbody\n',
    'repo/s/run.sh': 'echo hi\n',
  };

  it('writes a .skid.yml with the remote and content hash', async () => {
    const fs = createMemFs(files);
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest'),
      target: { agent: 'claude', scope: 'project', projectId: 'p1' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      sourceRepoId: 'r1',
      sourceRemote: REMOTE,
    });

    const skid = parseSkid(await fs.readFile('/dest/s/.skid.yml'));
    expect(skid).toEqual({ schema: 1, remote: REMOTE, name: 's', group: undefined, version: manifest.contentHash });
    expect(manifest.sourceRemote).toBe(REMOTE);
  });

  it('installed hash equals the resolved (repository) hash for identical content', async () => {
    const fs = createMemFs(files);
    const skill = await onlySkill(fs, 'repo');
    const available = await resolvedContentHash(fs, 'repo', skill);
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest'),
      target: { agent: 'claude', scope: 'project', projectId: 'p1' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      sourceRemote: REMOTE,
    });
    // The three producers agree, and .skid.yml is excluded from the body hash.
    expect(manifest.contentHash).toBe(available);
    expect(manifestContentHash(manifest)).toBe(available);
    expect(await skillHasUpdate(fs, 'repo', skill, manifest)).toBe(false);
  });

  it('detects an update when the repository content changes', async () => {
    const fs = createMemFs(files);
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest'),
      target: { agent: 'claude', scope: 'project', projectId: 'p1' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      sourceRemote: REMOTE,
    });
    await fs.writeFile('repo/s/run.sh', 'echo changed\n');
    const changed = await onlySkill(fs, 'repo');
    expect(await skillHasUpdate(fs, 'repo', changed, manifest)).toBe(true);
  });

  it('contentHash ignores a .skid.yml entry in the input', () => {
    const withSkid = [
      { relPath: 'SKILL.md', sha256: 'a' },
      { relPath: '.skid.yml', sha256: 'zzz' },
    ];
    const withoutSkid = [{ relPath: 'SKILL.md', sha256: 'a' }];
    expect(contentHash(withSkid)).toBe(contentHash(withoutSkid));
  });
});
