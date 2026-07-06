import { describe, it, expect } from 'vitest';
import { buildLanguageOptions } from './languages';

describe('buildLanguageOptions', () => {
  it('current language shows native name only', () => {
    const opts = buildLanguageOptions('en');
    expect(opts.find((o) => o.value === 'en')?.label).toBe('English');
  });

  it('other languages show "native (localized)"', () => {
    const opts = buildLanguageOptions('en');
    // German in English is "German"; native is "Deutsch".
    expect(opts.find((o) => o.value === 'de')?.label).toBe('Deutsch (German)');
  });

  it('returns one option per supported language, first letter capitalized', () => {
    const opts = buildLanguageOptions('ru');
    expect(opts.map((o) => o.value).sort()).toEqual([
      'be',
      'de',
      'en',
      'fr',
      'ja',
      'pl',
      'ru',
      'uk',
      'zh-cn',
    ]);
    for (const o of opts) expect(o.label[0]).toBe(o.label[0]?.toUpperCase());
  });
});
