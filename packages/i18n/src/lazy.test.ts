import { describe, it, expect } from 'vitest';
import { en, loadCatalog, SUPPORTED_LANGS } from './lazy.js';
import { createTranslator } from './index.js';

describe('lazy i18n surface', () => {
  it('exposes English synchronously as a non-empty catalog', () => {
    expect(en['app.title']).toBeTypeOf('string');
  });

  it('loadCatalog resolves a catalog for every supported language', async () => {
    for (const lang of SUPPORTED_LANGS) {
      const cat = await loadCatalog(lang);
      expect(cat, `catalog for ${lang}`).toBeTypeOf('object');
      expect(Object.keys(cat).length, `keys for ${lang}`).toBeGreaterThan(0);
    }
  });

  it('a lazily loaded catalog matches the eager one (ru sample key)', async () => {
    const ru = await loadCatalog('ru');
    // Same value the eager translator produces, proving loader/barrel parity.
    const eager = createTranslator('ru');
    const key = 'nav.settings';
    expect((ru as Record<string, string>)[key]).toBe(eager(key));
  });
});
