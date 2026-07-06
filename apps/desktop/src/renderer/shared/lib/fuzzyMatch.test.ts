import { describe, it, expect } from 'vitest';
import { levenshtein, fuzzyFilter } from './fuzzyMatch';

describe('levenshtein', () => {
  it('is zero for equal strings and the length for an empty operand', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('kitten', 'kitten')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts single insert/delete/substitute edits', () => {
    expect(levenshtein('kitten', 'sitten')).toBe(1); // substitute
    expect(levenshtein('kitten', 'kittens')).toBe(1); // insert
    expect(levenshtein('kitten', 'kittn')).toBe(1); // delete
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});

interface Item {
  readonly name: string;
  readonly path: string;
}

const items: Item[] = [
  { name: 'skillkeeper', path: '/work/skillkeeper' },
  { name: 'lorem-cli', path: '/work/lorem/cli' },
  { name: 'notes', path: '/home/notes' },
];

const toText = (i: Item): readonly string[] => [i.name, i.path];

describe('fuzzyFilter', () => {
  it('returns a copy of all items in order for an empty query', () => {
    const result = fuzzyFilter(items, '   ', toText);
    expect(result).toEqual(items);
    expect(result).not.toBe(items);
  });

  it('matches exact substrings case-insensitively across fields', () => {
    expect(fuzzyFilter(items, 'Skill', toText).map((i) => i.name)).toEqual(['skillkeeper']);
    // Substring lives in the path field, not the name.
    expect(fuzzyFilter(items, 'lorem', toText).map((i) => i.name)).toEqual(['lorem-cli']);
  });

  it('tolerates a typo within the budget (~1 edit per 3 chars)', () => {
    // "skillkeper" is one deletion away from "skillkeeper".
    expect(fuzzyFilter(items, 'skillkeper', toText).map((i) => i.name)).toEqual(['skillkeeper']);
  });

  it('excludes items beyond the typo budget', () => {
    expect(fuzzyFilter(items, 'zzzzz', toText)).toEqual([]);
  });

  it('ranks prefix matches ahead of mid-string matches', () => {
    const list: Item[] = [
      { name: 'my-notes-app', path: '/a' },
      { name: 'notes', path: '/b' },
    ];
    // "notes" is a prefix of the second entry but mid-string in the first.
    expect(fuzzyFilter(list, 'notes', toText).map((i) => i.name)).toEqual(['notes', 'my-notes-app']);
  });

  it('does not fuzz very short queries (substring only)', () => {
    // 2-char query: "xy" is not a substring of anything, so no fuzzy fallback.
    expect(fuzzyFilter(items, 'xy', toText)).toEqual([]);
  });
});
