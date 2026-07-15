import { describe, expect, it } from 'vitest';
import { installSkill, uninstallSkill } from './install.js';
import { resolveSkills } from '../skills/resolver.js';
import { createMemFs } from '../testing/memfs.js';
import { sha256 } from '../kernel/hashing.js';
import type { AgentAdapter, HookCapability } from '../adapters/adapter.js';
import type { FsPort, HostEnv } from '../kernel/ports.js';
import type { ResolvedSkill } from '../kernel/model.js';

const ENV: HostEnv = { homeDir: '/home/u', platform: 'linux', env: {} };

function adapterWithRoot(root: string, hookSupport?: HookCapability): AgentAdapter {
  return {
    kind: 'claude',
    async isAvailable() {
      return true;
    },
    async destinationRoot() {
      return root;
    },
    async guidanceFile() {
      return '/path/to/guidance.md';
    },
    async discoverInstalled() {
      return [];
    },
    hookSupport,
  };
}

async function onlySkill(fs: FsPort, repoRoot: string): Promise<ResolvedSkill> {
  const { skills } = await resolveSkills(fs, repoRoot);
  const skill = skills[0];
  if (skill === undefined) throw new Error('no skill resolved');
  return skill;
}

const SKILL_MD = (name: string, extra = ''): string => `---\nname: ${name}\n${extra}---\nbody\n`;

describe('installSkill - body', () => {
  it('copies body files (not hooks/), records hashes, and skips hooks by default', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/run.sh': '#!/bin/sh\necho hi\n',
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
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

    expect(await fs.readFile('/dest/s/SKILL.md')).toBe(SKILL_MD('s'));
    expect(await fs.readFile('/dest/s/run.sh')).toBe('#!/bin/sh\necho hi\n');
    expect(await fs.exists('/dest/s/hooks/HOOK.md')).toBe(false);

    const paths = manifest.files.map((f) => f.relPath).sort();
    // A generated .skid.yml identity file is recorded alongside the body.
    expect(paths).toEqual(['s/.skid.yml', 's/SKILL.md', 's/run.sh']);
    expect(await fs.exists('/dest/s/.skid.yml')).toBe(true);
    const sh = manifest.files.find((f) => f.relPath === 's/run.sh');
    expect(sh?.sha256).toBe(sha256('#!/bin/sh\necho hi\n'));
    expect(manifest.hookEdits).toEqual([]);
  });

  it('applies +x to declared executables and glob-matched files', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s', 'executables:\n  - run.sh\n'),
      'repo/s/run.sh': 'x\n',
      'repo/s/bin/tool': 'y\n',
      'repo/s/notexec.txt': 'z\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'),
      target: { agent: 'claude', scope: 'global' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      executableGlobs: ['bin/**'],
    });

    expect((await fs.stat('/dest/s/run.sh'))?.executable).toBe(true);
    expect((await fs.stat('/dest/s/bin/tool'))?.executable).toBe(true);
    expect((await fs.stat('/dest/s/notexec.txt'))?.executable).toBe(false);
    expect(manifest.files.find((f) => f.relPath === 's/run.sh')?.executable).toBe(true);
    expect(manifest.files.find((f) => f.relPath === 's/bin/tool')?.executable).toBe(true);
  });

  it('records source repo id and version on the manifest', async () => {
    const fs = createMemFs({ 'repo/s/SKILL.md': SKILL_MD('s', 'version: 2.0.0\n') });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'),
      target: { agent: 'claude', scope: 'global' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      sourceRepoId: 'repo-1',
      now: () => 1000,
    });
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.sourceRepoId).toBe('repo-1');
    expect(manifest.installedAt).toBe(new Date(1000).toISOString());
    expect(manifest.destinationRoot).toBe('/dest');
  });
});

describe('installSkill - hooks (delimited-text)', () => {
  const delimitedAdapter = (): AgentAdapter =>
    adapterWithRoot('/dest', {
      strategy: 'delimited-text',
      commentToken: '#',
      async resolveTargetFile() {
        return '/proj/AGENTS.md';
      },
    });

  it('does not write a hook edit when allowHooks is false', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n  filePattern: AGENTS.md\n---\n',
      'repo/s/hooks/snippet.txt': 'export PATH=x\n',
      '/proj/AGENTS.md': 'user content\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: delimitedAdapter(),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: false,
    });
    expect(manifest.hookEdits).toEqual([]);
    expect(await fs.readFile('/proj/AGENTS.md')).toBe('user content\n');
  });

  it('inserts a delimited region and records a delimited ManagedHookEdit when allowed', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n  filePattern: AGENTS.md\n---\n',
      'repo/s/hooks/snippet.txt': 'export PATH=x\n',
      '/proj/AGENTS.md': 'user content\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: delimitedAdapter(),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    expect(manifest.hookEdits).toHaveLength(1);
    const edit = manifest.hookEdits[0]!;
    expect(edit.kind).toBe('delimited');
    if (edit.kind === 'delimited') {
      expect(edit.file).toBe('/proj/AGENTS.md');
      expect(edit.delimiterId.length).toBeGreaterThan(0);
    }
    const written = await fs.readFile('/proj/AGENTS.md');
    expect(written).toMatch(/user content/);
    expect(written).toMatch(/skillkeeper:hook/);
    expect(written).toMatch(/export PATH=x/);
  });
});

describe('installSkill - hooks (json-merge)', () => {
  const jsonAdapter = (): AgentAdapter =>
    adapterWithRoot('/dest', {
      strategy: 'json-merge',
      async resolveTargetFile() {
        return '/proj/.claude/settings.json';
      },
    });

  it('merges a node under hooks with a marker and preserves an existing user entry', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.PreToolUse\n---\n',
      'repo/s/hooks/node.json': JSON.stringify({ matcher: 'Edit', hooks: [{ command: 'sk' }] }),
      '/proj/.claude/settings.json': JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'user' }] }] },
      }),
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: jsonAdapter(),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    expect(manifest.hookEdits).toHaveLength(1);
    const edit = manifest.hookEdits[0]!;
    expect(edit.kind).toBe('json');
    if (edit.kind === 'json') {
      expect(edit.keyPath).toBe('hooks.PreToolUse');
      expect(edit.markerId.length).toBeGreaterThan(0);
    }
    const parsed = JSON.parse(await fs.readFile('/proj/.claude/settings.json'));
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe('user');
    const owned = parsed.hooks.PreToolUse.find((e: { _skillkeeper?: unknown }) => e._skillkeeper);
    expect(owned.matcher).toBe('Edit');
  });
});

describe('uninstallSkill', () => {
  it('removes recorded body files, prunes empty dirs, and leaves unowned entries', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/lib/util.js': 'x\n',
      '/dest/unrelated.txt': 'keep me\n',
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
    expect(await fs.exists('/dest/s/SKILL.md')).toBe(true);
    await uninstallSkill(fs, manifest);
    expect(await fs.exists('/dest/s/SKILL.md')).toBe(false);
    expect(await fs.exists('/dest/s/lib/util.js')).toBe(false);
    expect(await fs.exists('/dest/s')).toBe(false);
    // Unowned sibling content is preserved.
    expect(await fs.readFile('/dest/unrelated.txt')).toBe('keep me\n');
  });

  it('removes a delimited hook region by id, leaving surrounding text', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/snippet.txt': 'gen\n',
      '/proj/AGENTS.md': 'top\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
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
    await uninstallSkill(fs, manifest);
    const after = await fs.readFile('/proj/AGENTS.md');
    expect(after).toMatch(/top/);
    expect(after).not.toMatch(/skillkeeper:hook/);
  });

  it('removes a json hook node by marker, leaving the user entry', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.PreToolUse\n---\n',
      'repo/s/hooks/node.json': JSON.stringify({ matcher: 'Edit' }),
      '/proj/.claude/settings.json': JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash' }] },
      }),
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
        strategy: 'json-merge',
        async resolveTargetFile() {
          return '/proj/.claude/settings.json';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    await uninstallSkill(fs, manifest);
    const parsed = JSON.parse(await fs.readFile('/proj/.claude/settings.json'));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash');
  });

  it('removes hook-owned standalone files for the file strategy', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n  filePattern: hook.sh\n---\n',
      'repo/s/hooks/hook.sh': '#!/bin/sh\n',
      '/proj/.config': '',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
        strategy: 'file',
        async resolveTargetFile() {
          return '/proj/hooks-dir';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    const fileEdit = manifest.hookEdits.find((e) => e.kind === 'file');
    expect(fileEdit).toBeDefined();
    if (fileEdit?.kind === 'file') {
      expect(await fs.exists(`/dest/${fileEdit.relPath}`)).toBe(true);
      await uninstallSkill(fs, manifest);
      expect(await fs.exists(`/dest/${fileEdit.relPath}`)).toBe(false);
    }
  });
});

describe('installSkill - hook edge cases', () => {
  it('delimited hook with no payload file, no comment token, and a fresh target file', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      // HOOK.md is the only file in hooks/: there is no separate payload file.
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      // No commentToken provided -> defaults to '#'. Target file does not exist.
      adapter: adapterWithRoot('/dest', {
        strategy: 'delimited-text',
        async resolveTargetFile() {
          return '/proj/fresh/AGENTS.md';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    expect(manifest.hookEdits[0]?.kind).toBe('delimited');
    const written = await fs.readFile('/proj/fresh/AGENTS.md');
    expect(written).toMatch(/^# >>> skillkeeper:hook/);
  });

  it('json hook with no payload file and default keyPath into a fresh file', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md': '---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n---\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
        strategy: 'json-merge',
        async resolveTargetFile() {
          return '/proj/fresh/settings.json';
        },
      }),
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    const edit = manifest.hookEdits[0]!;
    expect(edit.kind).toBe('json');
    if (edit.kind === 'json') expect(edit.keyPath).toBe('hooks');
    const parsed = JSON.parse(await fs.readFile('/proj/fresh/settings.json'));
    // Default keyPath 'hooks' yields an array holding the owned (empty) node.
    expect(Array.isArray(parsed.hooks)).toBe(true);
  });

  it('file hook with no payload file records no edit', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md': '---\nname: h\nstrategy: file\ntarget:\n  agent: claude\n---\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
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
    expect(manifest.hookEdits).toEqual([]);
  });

  it('uses the real clock when no now() is injected', async () => {
    const fs = createMemFs({ 'repo/s/SKILL.md': SKILL_MD('s') });
    const skill = await onlySkill(fs, 'repo');
    const before = Date.now();
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'),
      target: { agent: 'claude', scope: 'global' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
    });
    const stamp = new Date(manifest.installedAt).getTime();
    expect(stamp).toBeGreaterThanOrEqual(before);
  });

  it('uninstall tolerates a hook target file that was already deleted', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/snippet.txt': 'gen\n',
      '/proj/AGENTS.md': 'top\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
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
    // The user deleted the whole target file before uninstall.
    await fs.remove('/proj/AGENTS.md');
    await expect(uninstallSkill(fs, manifest)).resolves.toBeUndefined();
  });

  it('uses a group-qualified label for hooks of a grouped skill', async () => {
    const fs = createMemFs({
      'repo/grp/s/SKILL.md': SKILL_MD('s'),
      'repo/grp/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/grp/s/hooks/snippet.txt': 'gen\n',
      '/proj/AGENTS.md': 'top\n',
    });
    const skill = await onlySkill(fs, 'repo');
    expect(skill.id).toEqual({ group: 'grp', name: 's' });
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
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
    const written = await fs.readFile('/proj/AGENTS.md');
    // The managed region label is "<group>/<name>:<hookName>".
    expect(written).toMatch(/skillkeeper:hook grp\/s:h/);
    expect(manifest.hookEdits).toHaveLength(1);
  });

  it('records no hook edits when allowHooks is true but the adapter has no hookSupport', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: delimited-text\ntarget:\n  agent: claude\n---\n',
      'repo/s/hooks/snippet.txt': 'gen\n',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest'), // no hookSupport
      target: { agent: 'claude', scope: 'project' },
      env: ENV,
      sourceRoot: 'repo',
      skill,
      allowHooks: true,
    });
    expect(manifest.hookEdits).toEqual([]);
  });

  it('uninstall tolerates a json hook target file that was already deleted', async () => {
    const fs = createMemFs({
      'repo/s/SKILL.md': SKILL_MD('s'),
      'repo/s/hooks/HOOK.md':
        '---\nname: h\nstrategy: json-merge\ntarget:\n  agent: claude\n  keyPath: hooks.E\n---\n',
      'repo/s/hooks/node.json': JSON.stringify({ v: 1 }),
      '/proj/settings.json': '{}',
    });
    const skill = await onlySkill(fs, 'repo');
    const manifest = await installSkill({
      fs,
      adapter: adapterWithRoot('/dest', {
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
    await fs.remove('/proj/settings.json');
    await expect(uninstallSkill(fs, manifest)).resolves.toBeUndefined();
  });
});
