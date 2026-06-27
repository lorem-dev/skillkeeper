import { describe, it, expect } from 'vitest';
import { createTranslator } from './index.js';

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

  it('falls back to en when a key is missing in de', () => {
    const t = createTranslator('de');
    // 'hooks.requireConsent' is defined in en but NOT in de.
    const result = t('hooks.requireConsent');
    const enValue = createTranslator('en')('hooks.requireConsent');
    expect(result).toBe(enValue);
  });

  it('falls back to en when a key is missing in ru', () => {
    const t = createTranslator('ru');
    const result = t('hooks.requireConsent');
    const enValue = createTranslator('en')('hooks.requireConsent');
    expect(result).toBe(enValue);
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

  it('leaves a placeholder unchanged when its var is not supplied', () => {
    // skills.count uses {n}; pass an empty vars object so {n} is not found.
    const t = createTranslator('en');
    const result = t('skills.count', {});
    // The {n} token must be preserved as-is in the output.
    expect(result).toContain('{n}');
  });
});
