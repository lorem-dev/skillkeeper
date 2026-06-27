import { describe, expect, it } from 'vitest';
import { createMemFs } from './memfs.js';

describe('createMemFs', () => {
  it('reads seeded files', async () => {
    const fs = createMemFs({ 'a/b.txt': 'hi' });
    expect(await fs.readFile('a/b.txt')).toBe('hi');
  });

  it('lists immediate children of a directory', async () => {
    const fs = createMemFs({ 'a/b.txt': 'hi', 'a/c.txt': 'yo', 'a/d/e.txt': 'deep' });
    expect((await fs.list('a')).sort()).toEqual(['b.txt', 'c.txt', 'd']);
  });

  it('flips the executable flag via chmod, readable via stat', async () => {
    const fs = createMemFs({ 'a/run.sh': '#!/bin/sh' });
    const before = await fs.stat('a/run.sh');
    expect(before?.executable).toBe(false);
    await fs.chmod('a/run.sh', true);
    const after = await fs.stat('a/run.sh');
    expect(after?.executable).toBe(true);
    expect(after?.isFile).toBe(true);
    expect(after?.isDirectory).toBe(false);
  });

  it('writes new files and creates parent directories implicitly', async () => {
    const fs = createMemFs();
    await fs.writeFile('x/y/z.txt', 'content');
    expect(await fs.readFile('x/y/z.txt')).toBe('content');
    expect(await fs.exists('x/y')).toBe(true);
    const dirStat = await fs.stat('x/y');
    expect(dirStat?.isDirectory).toBe(true);
    expect(dirStat?.isFile).toBe(false);
  });

  it('reports size as the byte length of UTF-8 content', async () => {
    const fs = createMemFs({ 'f.txt': 'abc' });
    expect((await fs.stat('f.txt'))?.size).toBe(3);
  });

  it('exists is false for missing paths and stat returns undefined', async () => {
    const fs = createMemFs();
    expect(await fs.exists('nope')).toBe(false);
    expect(await fs.stat('nope')).toBeUndefined();
  });

  it('rejects reading a missing file', async () => {
    const fs = createMemFs();
    await expect(fs.readFile('missing.txt')).rejects.toThrow(/ENOENT/);
  });

  it('rejects listing a missing directory', async () => {
    const fs = createMemFs();
    await expect(fs.list('missing')).rejects.toThrow(/ENOENT/);
  });

  it('rejects listing a file as a directory', async () => {
    const fs = createMemFs({ 'a.txt': 'x' });
    await expect(fs.list('a.txt')).rejects.toThrow(/ENOTDIR/);
  });

  it('rejects reading a directory as a file', async () => {
    const fs = createMemFs({ 'd/a.txt': 'x' });
    await expect(fs.readFile('d')).rejects.toThrow(/EISDIR/);
  });

  it('removes files; remove on a missing file is a no-op', async () => {
    const fs = createMemFs({ 'a.txt': 'x' });
    await fs.remove('a.txt');
    expect(await fs.exists('a.txt')).toBe(false);
    await expect(fs.remove('a.txt')).resolves.toBeUndefined();
  });

  it('removeDirIfEmpty removes only empty dirs and is a no-op when missing', async () => {
    const fs = createMemFs({ 'full/a.txt': 'x' });
    await fs.mkdir('empty');
    await fs.removeDirIfEmpty('empty');
    expect(await fs.exists('empty')).toBe(false);
    // Non-empty directory is left intact.
    await fs.removeDirIfEmpty('full');
    expect(await fs.exists('full')).toBe(true);
    // Missing directory is a no-op.
    await expect(fs.removeDirIfEmpty('gone')).resolves.toBeUndefined();
  });

  it('chmod on a missing path rejects', async () => {
    const fs = createMemFs();
    await expect(fs.chmod('nope', true)).rejects.toThrow(/ENOENT/);
  });

  it('renames files and directories', async () => {
    const fs = createMemFs({ 'tmp.txt': 'data' });
    await fs.rename('tmp.txt', 'final.txt');
    expect(await fs.exists('tmp.txt')).toBe(false);
    expect(await fs.readFile('final.txt')).toBe('data');
  });

  it('rename of a missing source rejects', async () => {
    const fs = createMemFs();
    await expect(fs.rename('nope', 'dest')).rejects.toThrow(/ENOENT/);
  });

  it('mkdir is idempotent and normalizes paths', async () => {
    const fs = createMemFs();
    await fs.mkdir('a/b');
    await fs.mkdir('a/b/');
    expect(await fs.exists('a/b')).toBe(true);
  });

  it('preserves the executable bit set on write through chmod and survives rename', async () => {
    const fs = createMemFs({ 'bin/tool': 'x' });
    await fs.chmod('bin/tool', true);
    await fs.rename('bin/tool', 'bin/tool2');
    expect((await fs.stat('bin/tool2'))?.executable).toBe(true);
  });
});
