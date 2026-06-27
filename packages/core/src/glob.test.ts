import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny } from './glob.js';

describe('globToRegExp', () => {
  it('matches a literal path', () => {
    expect(globToRegExp('a/b.txt').test('a/b.txt')).toBe(true);
    expect(globToRegExp('a/b.txt').test('a/b_txt')).toBe(false);
  });

  it('* matches within a single segment only', () => {
    const re = globToRegExp('src/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/sub/index.ts')).toBe(false);
  });

  it('leading ** matches across separators', () => {
    const re = globToRegExp('**/x.ts');
    expect(re.test('a/b/x.ts')).toBe(true);
    expect(re.test('x.ts')).toBe(true);
  });

  it('a/** matches the directory itself and any descendant', () => {
    const re = globToRegExp('a/**');
    expect(re.test('a')).toBe(true);
    expect(re.test('a/b')).toBe(true);
    expect(re.test('a/b/c')).toBe(true);
    expect(re.test('ab')).toBe(false);
  });

  it('? matches exactly one non-separator character', () => {
    const re = globToRegExp('a?c');
    expect(re.test('abc')).toBe(true);
    expect(re.test('a/c')).toBe(false);
    expect(re.test('ac')).toBe(false);
  });

  it('escapes regex metacharacters in literals', () => {
    const re = globToRegExp('a.(b)+[c]{d}^e$f|g\\h');
    expect(re.test('a.(b)+[c]{d}^e$f|g\\h')).toBe(true);
    expect(re.test('aXbXcdefgh')).toBe(false);
  });

  it('handles a bare ** as match-all', () => {
    expect(globToRegExp('**').test('anything/at/all')).toBe(true);
  });

  it('handles a trailing /** followed by more segments', () => {
    const re = globToRegExp('a/**/z');
    expect(re.test('a/z')).toBe(true);
    expect(re.test('a/b/z')).toBe(true);
  });
});

describe('matchesAny', () => {
  it('is true when any glob matches', () => {
    expect(matchesAny('src/a.ts', ['docs/**', 'src/**'])).toBe(true);
  });

  it('is false when none match', () => {
    expect(matchesAny('lib/a.ts', ['docs/**', 'src/**'])).toBe(false);
  });

  it('is false for an empty glob list', () => {
    expect(matchesAny('anything', [])).toBe(false);
  });
});
