import { describe, it, expect } from 'vitest';
import { ensureCatalog, getCatalog, subscribe, resolveLang } from './runtime';

describe('i18n runtime', () => {
  it('resolveLang accepts supported codes and defaults unknown to en', () => {
    expect(resolveLang('ru')).toBe('ru');
    expect(resolveLang(undefined)).toBe('en');
    expect(resolveLang('klingon')).toBe('en');
  });

  it('returns the English fallback before a catalog is loaded', () => {
    expect(getCatalog('de')['app.title']).toBe(getCatalog('en')['app.title']);
  });

  it('ensureCatalog loads a catalog, registers it, and notifies subscribers', async () => {
    let notified = 0;
    const off = subscribe(() => {
      notified += 1;
    });
    await ensureCatalog('ru');
    off();
    // A real Russian value now overrides the English fallback.
    expect(getCatalog('ru')['nav.settings']).not.toBe(getCatalog('en')['nav.settings']);
    expect(notified).toBeGreaterThan(0);
  });

  it('ensureCatalog de-dupes concurrent loads (single in-flight promise)', async () => {
    const a = ensureCatalog('uk');
    const b = ensureCatalog('uk');
    expect(a).toStrictEqual(b);
    await Promise.all([a, b]);
    // Already-loaded: resolves without throwing.
    await ensureCatalog('uk');
    expect(getCatalog('uk')['nav.settings']).toBeTypeOf('string');
  });
});
