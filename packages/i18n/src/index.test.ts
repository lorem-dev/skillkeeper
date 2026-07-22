import { describe, it, expect } from 'vitest';
import { createTranslator } from './index.js';
import { createTranslatorFrom } from './translator.js';
import type { Catalog } from './index.js';

describe('createTranslator', () => {
  it('returns a different value per language for a shared key', () => {
    const en = createTranslator('en');
    const de = createTranslator('de');
    const ru = createTranslator('ru');

    // nav.settings is a plain word that each language translates differently.
    const enVal = en('nav.settings');
    const deVal = de('nav.settings');
    const ruVal = ru('nav.settings');

    expect(enVal).toBeTruthy();
    // German and Russian values must differ from English.
    expect(deVal).not.toBe(enVal);
    expect(ruVal).not.toBe(enVal);
  });

  it('substitutes interpolated vars in a key', () => {
    const t = createTranslator('en');
    const result = t('skills.count', { n: '3' });
    expect(result).toContain('3');
    expect(result).not.toContain('{n}');
  });

  it('interpolation works in de and ru', () => {
    const de = createTranslator('de');
    const ru = createTranslator('ru');
    expect(de('skills.count', { n: '5' })).toContain('5');
    expect(ru('skills.count', { n: '7' })).toContain('7');
  });

  it('falls back to the English catalog when a key is missing in the active locale', () => {
    // Exercised with synthetic catalogs rather than a real untranslated key: as
    // locales reach full coverage there may be no genuinely missing key to rely
    // on, so the fallback mechanism is tested independently of catalog state. A
    // key absent from the primary (locale) catalog resolves from the fallback
    // (English) catalog for every language.
    const value = 'Hook installation requires explicit consent.';
    const fallback = { 'hooks.requireConsent': value } as unknown as Partial<Catalog>;
    const empty = {} as Partial<Catalog>;
    expect(createTranslatorFrom(empty, fallback, 'de')('hooks.requireConsent')).toBe(value);
    expect(createTranslatorFrom(empty, fallback, 'ru')('hooks.requireConsent')).toBe(value);
  });

  it('returns the key string itself when the key is unknown in all catalogs', () => {
    const t = createTranslator('en');
    expect(t('totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('unknown key falls back to the key string in de and ru', () => {
    expect(createTranslator('de')('totally.unknown.key')).toBe('totally.unknown.key');
    expect(createTranslator('ru')('totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('nav keys are all defined and non-empty in every language', () => {
    const en = createTranslator('en');
    const de = createTranslator('de');
    const ru = createTranslator('ru');

    const navKeys = [
      'nav.repositories',
      'nav.skills',
      'nav.projects',
      'nav.settings',
    ] as const;

    for (const key of navKeys) {
      expect(en(key)).toBeTruthy();
      expect(de(key)).toBeTruthy();
      expect(ru(key)).toBeTruthy();
      // None of them should return the raw key string (i.e., all are defined).
      expect(en(key)).not.toBe(key);
      expect(de(key)).not.toBe(key);
      expect(ru(key)).not.toBe(key);
    }
  });

  it('config.invalidBanner key is defined in en', () => {
    const t = createTranslator('en');
    const result = t('config.invalidBanner');
    expect(result).toBeTruthy();
    expect(result).not.toBe('config.invalidBanner');
  });

  it('selects English plural forms (one vs other) and interpolates count', () => {
    const t = createTranslator('en');
    expect(t.plural('repositories.skillCount', 1)).toBe('1 skill');
    expect(t.plural('repositories.skillCount', 0)).toBe('0 skills');
    expect(t.plural('repositories.skillCount', 5)).toBe('5 skills');
  });

  it('selects Russian plural forms (one/few/many)', () => {
    const t = createTranslator('ru');
    expect(t.plural('repositories.skillCount', 1)).toBe('1 навык');
    expect(t.plural('repositories.skillCount', 3)).toBe('3 навыка');
    expect(t.plural('repositories.skillCount', 5)).toBe('5 навыков');
    expect(t.plural('repositories.skillCount', 21)).toBe('21 навык');
  });

  it('falls back to the other form when a category key is missing (de few/many)', () => {
    const t = createTranslator('de');
    // German only defines one/other; select(2) is "other".
    expect(t.plural('repositories.skillCount', 1)).toBe('1 Fähigkeit');
    expect(t.plural('repositories.skillCount', 2)).toBe('2 Fähigkeiten');
  });

  it('plural falls back to .other when the exact category key is absent', () => {
    const primary = { 'x.other': '{count} items' } as unknown as Partial<Catalog>;
    const t = createTranslatorFrom(primary, {} as Partial<Catalog>, 'en');
    // count 1 selects "one"; "x.one" is absent in both catalogs, so it falls
    // back to "x.other".
    expect(t.plural('x', 1)).toBe('1 items');
  });

  it('plural resolves a category key found only in the fallback catalog', () => {
    const fallback = {
      'x.one': '{count} item',
      'x.other': '{count} items',
    } as unknown as Partial<Catalog>;
    const t = createTranslatorFrom({} as Partial<Catalog>, fallback, 'en');
    expect(t.plural('x', 1)).toBe('1 item');
  });

  it('leaves a placeholder unchanged when its var is not supplied', () => {
    // skills.count uses {n}; pass an empty vars object so {n} is not found.
    const t = createTranslator('en');
    const result = t('skills.count', {});
    // The {n} token must be preserved as-is in the output.
    expect(result).toContain('{n}');
  });
});
