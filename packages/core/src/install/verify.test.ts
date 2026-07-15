import { describe, expect, it } from 'vitest';
import { installSkill } from './install.js';
import { repairInstall, verifyInstall } from './verify.js';
import { resolveSkills } from './resolver.js';
import { createMemFs } from './testing/memfs.js';
import type { AgentAdapter, HookCapability } from './adapter.js';
import type { FsPort, HostEnv } from './ports.js';
import type { InstallManifest, ResolvedSkill } from './model.js';

const ENV: HostEnv = { homeDir: '/home/u', platform: 'linux', env: {} };

function adapter(root: string, hookSupport?: HookCapability): AgentAdapter {
  return {
    kind: 'claude',
    async isAvailable() {
      return true;
    },
    async destinationRoot() {
      return root;
    },
    async guidanceFile() {
      return `${root}/guidance.md`;
    },
    async discoverInstalled() {
      return [];
    },
    hookSupport,
  };
}

async function onlySkill(fs: FsPort, repoRoot: string): Promise<ResolvedSkill> {
  const { skills } = await resolveSkills(fs, repoRoot);
  return skills[0]!;
}

async function setupBodyInstall(): Promise<{ fs: FsPort; manifest: InstallManifest }> {
  const fs = createMemFs({
    'repo/s/SKILL.md': '---\nname: s\n---\nbody\n',
    'repo/s/data.txt': 'original\n',
    'repo/s/keep.txt': 'keep\n',
  });
  const skill = await onlySkill(fs, 'repo');
  const manifest = await installSkill({
    fs,
    adapter: adapter('/dest'),
    target: { agent: 'claude', scope: 'global' },
    env: ENV,
    sourceRoot: 'repo',
    skill,
  });
  return { fs, manifest };
}

describe('verifyInstall - files', () => {
  it('reports ok when nothing changed', async () => {
    const { fs, manifest } = await setupBodyInstall();
    const report = await verifyInstall(fs, manifest);
    expect(report.ok).toBe(true);
    expect(report.files.every((f) => f.status === 'ok')).toBe(true);
    expect(report.hookEdits).toEqual([]);
  });

  it('flags a hand-edited file as modified', async () => {
    const { fs, manifest } = await setupBodyInstall();
    await fs.writeFile('/dest/s/data.txt', 'tampered\n');
    const report = await verifyInstall(fs, manifest);
    expect(report.ok).toBe(false);
    const entry = report.files.find((f) => f.relPath === 's/data.txt');
    expect(entry?.status).toBe('modified');
  });

  it('flags a deleted file as missing', async () => {
    const { fs, manifest } = await setupBodyInstall();
    await fs.remove('/dest/s/data.txt');
    const report = await verifyInstall(fs, manifest);
    expect(report.ok).toBe(false);
    expect(report.files.find((f) => f.relPath === 's/data.txt')?.status).toBe('missing');
  });

  it('flags an unrecorded file in a managed directory as extraneous', async () => {
    const { fs, manifest } = await setupBodyInstall();
    await fs.writeFile('/dest/s/sneaked.txt', 'extra\n');
    const report = await verifyInstall(fs, manifest);
    expect(report.ok).toBe(false);
    const entry = report.files.find((f) => f.relPath === 's/sneaked.txt');
    expect(entry?.status).toBe('extraneous');
  });

  it('detects extraneous files nested in subdirectories of a managed dir', async () => {
    const { fs, manifest } = await setupBodyInstall();
    await fs.writeFile('/dest/s/nested/deep/sneaked.txt', 'extra\n');
    const report = await verifyInstall(fs, manifest);
    const entry = report.files.find((f) => f.relPath === 's/nested/deep/sneaked.txt');
    expect(entry?.status).toBe('extraneous');
  });

  it('reports missing files without crashing when the whole managed dir is gone', async () => {
    const { fs, manifest } = await setupBodyInstall();
    // Remove every recorded file so the managed directory disappears entirely.
    for (const f of manifest.files) await fs.remove(`/dest/${f.relPath}`);
    const report = await verifyInstall(fs, manifest);
    expect(report.files.every((f) => f.status === 'missing')).toBe(true);
    // No extraneous entries are produced for a vanished directory.
    expect(report.files.some((f) => f.status === 'extraneous')).toBe(false);
  });
});

describe('verifyInstall - hook edits', () => {
  it('reports ok for an untouched delimited region and modified after tampering', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\n',
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/snippet.txt': 'gen\n',
      '/proj/AGENTS.md': 'top\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest', {
        strategy: 'delimited-text',
        commentToken: '#',
        async resolveTargetFile() {
          return '/proj/AGENTS.md';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });

    const okReport = await verifyInstall(fs, manifest);
    expect(okReport.hookEdits[0]?.status).toBe('ok');

    // Tamper inside the managed region.
    const file = await fs.readFile('/proj/AGENTS.md');
    await fs.writeFile('/proj/AGENTS.md', file.replace('gen', 'hacked'));
    const badReport = await verifyInstall(fs, manifest);
    expect(badReport.ok).toBe(false);
    expect(badReport.hookEdits[0]?.status).toBe('modified');
  });

  it('reports missing when the delimited region was removed entirely', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\n',
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/snippet.txt': 'gen\n',
      '/proj/AGENTS.md': 'top\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest', {
        strategy: 'delimited-text',
        commentToken: '#',
        async resolveTargetFile() {
          return '/proj/AGENTS.md';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    await fs.writeFile('/proj/AGENTS.md', 'top\n');
    const report = await verifyInstall(fs, manifest);
    expect(report.hookEdits[0]?.status).toBe('missing');
  });

  it('reports missing for a delimited edit when the whole target file is gone', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\n',
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/snippet.txt': 'gen\n',
      '/proj/AGENTS.md': 'top\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest', {
        strategy: 'delimited-text',
        commentToken: '#',
        async resolveTargetFile() {
          return '/proj/AGENTS.md';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    await fs.remove('/proj/AGENTS.md');
    const report = await verifyInstall(fs, manifest);
    expect(report.hookEdits[0]?.status).toBe('missing');
  });

  it('reports missing for a json edit when the file is gone and when the node is gone', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\n',
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.E\n---\n',
      'repo/s/hooks/node.json': JSON.stringify({ v: 1 }),
      '/proj/settings.json': '{}',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest', {
        strategy: 'json-merge',
        async resolveTargetFile() {
          return '/proj/settings.json';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    // Node removed but file present.
    await fs.writeFile('/proj/settings.json', '{}');
    expect((await verifyInstall(fs, manifest)).hookEdits[0]?.status).toBe('missing');
    // Whole file gone.
    await fs.remove('/proj/settings.json');
    expect((await verifyInstall(fs, manifest)).hookEdits[0]?.status).toBe('missing');
  });

  it('treats a file-strategy hook edit as a managed file in the report', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\n',
      'repo/s/hooks/HOOK.md': '---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/hook.sh': '#!/bin/sh\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest', {
        strategy: 'file',
        async resolveTargetFile() {
          return '/proj/x';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    const report = await verifyInstall(fs, manifest);
    // The file-kind edit is verified as a file, not in hookEdits.
    expect(report.hookEdits).toEqual([]);
    const fileEdit = manifest.hookEdits.find((e) => e.kind === 'file');
    expect(fileEdit?.kind).toBe('file');
    if (fileEdit?.kind === 'file') {
      expect(report.files.some((f) => f.relPath === fileEdit.relPath && f.status === 'ok')).toBe(
        true,
      );
    }
  });

  it('reports modified for a tampered json node', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': '---\nname: s\n---\n',
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.E\n---\n',
      'repo/s/hooks/node.json': JSON.stringify({ v: 1 }),
      '/proj/settings.json': '{}',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapter('/dest', {
        strategy: 'json-merge',
        async resolveTargetFile() {
          return '/proj/settings.json';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    const okReport = await verifyInstall(fs, manifest);
    expect(okReport.hookEdits[0]?.status).toBe('ok');

    const parsed = JSON.parse(await fs.readFile('/proj/settings.json'));
    parsed.hooks.E[0].v = 999;
    await fs.writeFile('/proj/settings.json', JSON.stringify(parsed));
    const badReport = await verifyInstall(fs, manifest);
    expect(badReport.hookEdits[0]?.status).toBe('modified');
  });
});

describe('repairInstall', () => {
  it('restores a missing file to its recorded hash', async () => {
    const { fs, manifest } = await setupBodyInstall();
    await fs.remove('/dest/s/data.txt');
    expect((await verifyInstall(fs, manifest)).ok).toBe(false);

    await repairInstall({
      fs,
      adapter: adapter('/dest'),
      target: manifest.target,
      env: ENV,
      sourceRoot: 'repo',
      skill: await onlySkill(fs, 'repo'),
      manifest,
    });
    expect(await fs.readFile('/dest/s/data.txt')).toBe('original\n');
    expect((await verifyInstall(fs, manifest)).ok).toBe(true);
  });

  it('restores a hand-modified file to the recorded content', async () => {
    const { fs, manifest } = await setupBodyInstall();
    await fs.writeFile('/dest/s/data.txt', 'tampered\n');
    await repairInstall({
      fs,
      adapter: adapter('/dest'),
      target: manifest.target,
      env: ENV,
      sourceRoot: 'repo',
      skill: await onlySkill(fs, 'repo'),
      manifest,
    });
    expect(await fs.readFile('/dest/s/data.txt')).toBe('original\n');
  });
});
