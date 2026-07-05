import { describe, expect, it } from 'vitest';
import { repoHasUpdate, skillHasUpdate } from './updates.js';
import { resolveSkills } from './resolver.js';
import { installSkill } from './install.js';
import { createFakeGit } from './testing/fakeGit.js';
import { createMemFs } from './testing/memfs.js';
import type { AgentAdapter } from './adapter.js';
import type { HostEnv, FsPort } from './ports.js';
import type { Repository, ResolvedSkill } from './model.js';

const ENV: HostEnv = { homeDir: '/home/u', platform: 'linux', env: {} };

const REPO: Repository = {
  id: 'r1',
  name: 'repo',
  url: 'git@h:o/r.git',
  kind: 'generic',
  transport: 'ssh',
  lfs: false,
  localPath: '/repos/r1',
};

function adapterWithRoot(root: string): AgentAdapter {
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
  return skills[0]!;
}

describe('repoHasUpdate', () => {
  it('is true when the local ref differs from the upstream ref', async () => {
    const git = createFakeGit({
      refs: { '/repos/r1::HEAD': 'aaa', '/repos/r1::@{upstream}': 'bbb' },
    });
    expect(await repoHasUpdate(git, REPO)).toBe(true);
    // It fetches before comparing.
    expect(git.calls[0]!.op).toBe('fetch');
  });

  it('is false when local and upstream refs match', async () => {
    const git = createFakeGit({
      refs: { '/repos/r1::HEAD': 'same', '/repos/r1::@{upstream}': 'same' },
    });
    expect(await repoHasUpdate(git, REPO)).toBe(false);
  });

  it('runs the fetch on the fetchGit port and the comparisons on git', async () => {
    const git = createFakeGit({
      refs: { '/repos/r1::HEAD': 'aaa', '/repos/r1::@{upstream}': 'bbb' },
    });
    const fetchGit = createFakeGit({});
    expect(await repoHasUpdate(git, REPO, fetchGit)).toBe(true);
    // The network fetch goes to the separate (terminal-backed) port...
    expect(fetchGit.calls.map((c) => c.op)).toEqual(['fetch']);
    // ...while `git` only runs the two local rev-parse comparisons.
    expect(git.calls.map((c) => c.op)).toEqual(['revParse', 'revParse']);
  });
});

describe('skillHasUpdate', () => {
  it('is false immediately after install (source matches installed)', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\nbody\n',
      'repo/s/a.txt': 'one\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'),
      target: { agent: 'claude', scope: 'global' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
    });
    expect(await skillHasUpdate(fs, 'repo', skill, manifest)).toBe(false);
  });

  it('is true when a source file changed after install', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\nbody\n',
      'repo/s/a.txt': 'one\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'),
      target: { agent: 'claude', scope: 'global' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
    });
    await fs.writeFile('repo/s/a.txt', 'changed\n');
    const updated = await onlySkill(fs, 'repo');
    expect(await skillHasUpdate(fs, 'repo', updated, manifest)).toBe(true);
  });

  it('is true when a source file was added after install', async () => {
    const fs = createMemFs({ 'repo/s/SKILL.md': '---\nname: s\n---\nbody\n' });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'),
      target: { agent: 'claude', scope: 'global' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
    });
    await fs.writeFile('repo/s/new.txt', 'new\n');
    const updated = await onlySkill(fs, 'repo');
    expect(await skillHasUpdate(fs, 'repo', updated, manifest)).toBe(true);
  });
});
