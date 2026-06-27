import { describe, expect, it } from 'vitest';
import {
  decapsulateForeignDelimiters,
  encapsulateForeignDelimiters,
  insertRegion,
  removeRegion,
  wrapRegion,
} from './hookRegion.js';

describe('wrapRegion', () => {
  it('produces the exact open/close markers for a hash comment token', () => {
    const block = wrapRegion({
      commentToken: '#',
      delimiterId: 'abc123',
      label: 'group/name:hookName',
      version: '1.0.0',
      content: 'export FOO=bar',
    });
    const lines = block.split('\n');
    expect(lines[0]).toBe('# >>> skillkeeper:hook group/name:hookName v1.0.0 [abc123] >>>');
    expect(lines[1]).toBe('export FOO=bar');
    expect(lines[2]).toBe('# <<< skillkeeper:hook group/name:hookName [abc123] <<<');
  });

  it('omits the version segment when no version is given', () => {
    const block = wrapRegion({
      commentToken: '//',
      delimiterId: 'id1',
      label: 'a:b',
      content: 'x',
    });
    expect(block.split('\n')[0]).toBe('// >>> skillkeeper:hook a:b [id1] >>>');
  });

  it('supports HTML comment tokens with an explicit close form', () => {
    const block = wrapRegion({
      commentToken: '<!--',
      commentClose: '-->',
      delimiterId: 'h1',
      label: 'a:b',
      content: 'body',
    });
    const lines = block.split('\n');
    expect(lines[0]).toBe('<!-- >>> skillkeeper:hook a:b [h1] >>> -->');
    expect(lines[2]).toBe('<!-- <<< skillkeeper:hook a:b [h1] <<< -->');
  });
});

describe('insertRegion', () => {
  const block = wrapRegion({ commentToken: '#', delimiterId: 'id1', label: 'a:b', content: 'X' });

  it('appends a block to an empty file', () => {
    const result = insertRegion('', block, 'append');
    expect(result).toBe(`${block}\n`);
  });

  it('appends a block after existing content with a separating newline', () => {
    const result = insertRegion('existing line\n', block, 'append');
    expect(result).toBe(`existing line\n${block}\n`);
  });

  it('prepends a block in prepend mode', () => {
    const result = insertRegion('existing\n', block, 'prepend');
    expect(result).toBe(`${block}\nexisting\n`);
  });

  it('is idempotent: inserting the same delimiterId twice replaces, not duplicates', () => {
    const once = insertRegion('base\n', block, 'append');
    const twice = insertRegion(once, block, 'append');
    const count = (twice.match(/\[id1\] >>>/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('appends a trailing newline when the existing file lacks one (prepend)', () => {
    const result = insertRegion('no-newline', block, 'prepend');
    expect(result).toBe(`${block}\nno-newline\n`);
  });

  it('appends to a file that lacks a trailing newline', () => {
    const result = insertRegion('no-newline', block, 'append');
    expect(result).toBe(`no-newline\n${block}\n`);
  });

  it('inserts a block with no id marker without attempting replacement', () => {
    // A raw block lacking the [id] >>> marker takes the append/prepend path.
    const raw = 'plain block without markers';
    const result = insertRegion('base\n', raw, 'append');
    expect(result).toBe(`base\n${raw}\n`);
  });
});

describe('removeRegion', () => {
  it('removes exactly the block with the given id, leaving surrounding text intact', () => {
    const block = wrapRegion({
      commentToken: '#',
      delimiterId: 'target',
      label: 'a:b',
      content: 'gen',
    });
    const file = `before\n${block}\nafter\n`;
    const result = removeRegion(file, 'target');
    expect(result).toBe('before\nafter\n');
  });

  it('removes only the matching id when several managed regions are present', () => {
    const b1 = wrapRegion({ commentToken: '#', delimiterId: 'one', label: 'a:b', content: '1' });
    const b2 = wrapRegion({ commentToken: '#', delimiterId: 'two', label: 'c:d', content: '2' });
    const file = `${b1}\n${b2}\n`;
    const result = removeRegion(file, 'one');
    expect(result).not.toMatch(/\[one\]/);
    expect(result).toMatch(/\[two\]/);
  });

  it('removes a region even after the surrounding content changed', () => {
    const block = wrapRegion({
      commentToken: '#',
      delimiterId: 'keep',
      label: 'a:b',
      content: 'g',
    });
    const file = `head edited later\n\n${block}\n\ntail edited later\n`;
    const result = removeRegion(file, 'keep');
    expect(result).not.toMatch(/skillkeeper:hook/);
    expect(result).toMatch(/head edited later/);
    expect(result).toMatch(/tail edited later/);
  });

  it('returns the input unchanged when the id is not present', () => {
    const file = 'nothing here\n';
    expect(removeRegion(file, 'absent')).toBe(file);
  });
});

describe('encapsulate/decapsulate foreign delimiters', () => {
  it('round-trips arbitrary content', () => {
    const samples = ['plain text', '', 'multi\nline\ncontent', 'has # comments'];
    for (const s of samples) {
      expect(decapsulateForeignDelimiters(encapsulateForeignDelimiters(s))).toBe(s);
    }
  });

  it('neutralizes a SkillKeeper open delimiter embedded in content', () => {
    const evil = 'normal\n# >>> skillkeeper:hook fake:hook [xyz] >>>\ninjected\n';
    const enc = encapsulateForeignDelimiters(evil);
    expect(enc).not.toMatch(/skillkeeper:hook fake:hook \[xyz\] >>>/);
    expect(decapsulateForeignDelimiters(enc)).toBe(evil);
  });

  it('neutralizes a close delimiter too', () => {
    const evil = '# <<< skillkeeper:hook fake:hook [xyz] <<<\n';
    const enc = encapsulateForeignDelimiters(evil);
    expect(enc).not.toMatch(/<<< skillkeeper:hook/);
    expect(decapsulateForeignDelimiters(enc)).toBe(evil);
  });

  it('a wrapped region built from encapsulated content cannot be falsely removed by an injected id', () => {
    const evilContent =
      '# >>> skillkeeper:hook fake:f [evil] >>>\npayload\n# <<< skillkeeper:hook fake:f [evil] <<<';
    const safe = encapsulateForeignDelimiters(evilContent);
    const block = wrapRegion({
      commentToken: '#',
      delimiterId: 'real',
      label: 'r:r',
      content: safe,
    });
    // The injected id must not be removable.
    const afterEvil = removeRegion(block, 'evil');
    expect(afterEvil).toBe(block);
    // The real id removes the whole block.
    expect(removeRegion(block, 'real')).toBe('');
  });
});
