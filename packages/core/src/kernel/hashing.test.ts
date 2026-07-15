import { describe, expect, it } from 'vitest';
import { hashTree, sha256 } from './hashing.js';
import { createMemFs } from './testing/memfs.js';

// Known SHA-256 of the ASCII string "abc".
const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
// Known SHA-256 of the empty input.
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('sha256', () => {
  it('hashes a known string to the canonical hex digest', () => {
    expect(sha256('abc')).toBe(ABC_SHA256);
  });

  it('hashes the empty string', () => {
    expect(sha256('')).toBe(EMPTY_SHA256);
  });

  it('hashes a Uint8Array identically to the equivalent string', () => {
    expect(sha256(new TextEncoder().encode('abc'))).toBe(ABC_SHA256);
  });
});

describe('hashTree', () => {
  it('returns managed files sorted by relPath with correct hashes', async () => {
    const fs = createMemFs({
      'root/b.txt': 'abc',
      'root/a.txt': '',
      'root/sub/c.txt': 'abc',
    });
    const result = await hashTree(fs, 'root', ['b.txt', 'a.txt', 'sub/c.txt']);
    expect(result).toEqual([
      { relPath: 'a.txt', sha256: EMPTY_SHA256, executable: false },
      { relPath: 'b.txt', sha256: ABC_SHA256, executable: false },
      { relPath: 'sub/c.txt', sha256: ABC_SHA256, executable: false },
    ]);
  });

  it('reflects the executable bit from the filesystem', async () => {
    const fs = createMemFs({ 'root/run.sh': 'abc' });
    await fs.chmod('root/run.sh', true);
    const result = await hashTree(fs, 'root', ['run.sh']);
    expect(result[0]?.executable).toBe(true);
  });

  it('returns an empty array for no paths', async () => {
    const fs = createMemFs();
    expect(await hashTree(fs, 'root', [])).toEqual([]);
  });
});
