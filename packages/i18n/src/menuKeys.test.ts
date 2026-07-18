import { describe, it, expect } from 'vitest';
import { en } from './catalogs/en.js';
import { be } from './catalogs/be.js';
import { de } from './catalogs/de.js';
import { es } from './catalogs/es.js';
import { fr } from './catalogs/fr.js';
import { it as itCat } from './catalogs/it.js';
import { ja } from './catalogs/ja.js';
import { ko } from './catalogs/ko.js';
import { pl } from './catalogs/pl.js';
import { pt } from './catalogs/pt.js';
import { ru } from './catalogs/ru.js';
import { srCyrl } from './catalogs/sr-cyrl.js';
import { srLatn } from './catalogs/sr-latn.js';
import { uk } from './catalogs/uk.js';
import { zhCn } from './catalogs/zh-cn.js';
import { zhTw } from './catalogs/zh-tw.js';
import type { Catalog } from './catalogs/en.js';

const NEW_KEYS = ['menu.view', 'menu.about', 'menu.openSettings'] as const;

const LOCALES: Record<string, Partial<Catalog>> = {
  be, de, es, fr, it: itCat, ja, ko, pl, pt, ru,
  'sr-cyrl': srCyrl, 'sr-latn': srLatn, uk, 'zh-cn': zhCn, 'zh-tw': zhTw,
};

describe('menu.* keys', () => {
  it('defines the English source values', () => {
    expect(en['menu.view']).toBe('View');
    expect(en['menu.about']).toBe('About SkillKeeper');
    expect(en['menu.openSettings']).toBe('Open Settings');
  });

  for (const [lang, cat] of Object.entries(LOCALES)) {
    for (const key of NEW_KEYS) {
      it(`${lang} translates ${key} (present and not the English fallback)`, () => {
        const value = cat[key];
        expect(value).toBeTruthy();
        expect(value).not.toBe(en[key]);
      });
    }
  }
});

const REFINEMENT_KEYS = [
  'menu.edit', 'menu.window', 'menu.help',
  'menu.undo', 'menu.redo', 'menu.cut', 'menu.copy', 'menu.paste',
  'menu.pasteAndMatchStyle', 'menu.delete', 'menu.selectAll',
  'menu.minimize', 'menu.zoom', 'menu.close',
  'menu.services', 'menu.hide', 'menu.hideOthers', 'menu.showAll', 'menu.quit',
  'about.version', 'about.tagline',
] as const;

describe('menu refinement keys', () => {
  it('defines English source values', () => {
    expect(en['menu.edit']).toBe('Edit');
    expect(en['menu.window']).toBe('Window');
    expect(en['menu.help']).toBe('Help');
    expect(en['menu.selectAll']).toBe('Select All');
    expect(en['menu.pasteAndMatchStyle']).toBe('Paste and Match Style');
    expect(en['menu.hide']).toBe('Hide SkillKeeper');
    expect(en['menu.quit']).toBe('Quit SkillKeeper');
    expect(en['about.version']).toBe('Version {version}');
    expect(en['about.tagline']).toBe('Install and manage skills for AI agents');
    expect(en['about.copyright']).toBe('(c) {years} Lorem Dev');
  });

  // Some canonical Apple localizations legitimately equal the English word
  // (e.g. "Version", "Zoom", "Services" are the shipped Apple terms in these
  // locales). For those `${lang}|${key}` pairs we only require the value to be
  // present, not that it differs from English.
  const SAME_AS_EN_OK = new Set<string>([
    'de|about.version',
    'fr|about.version',
    'es|menu.zoom',
    'fr|menu.zoom',
    'it|menu.zoom',
    'pt|menu.zoom',
    'pl|menu.zoom',
    'fr|menu.services',
  ]);

  for (const [lang, cat] of Object.entries(LOCALES)) {
    for (const key of REFINEMENT_KEYS) {
      it(`${lang} translates ${key}`, () => {
        const value = cat[key];
        expect(value).toBeTruthy();
        if (!SAME_AS_EN_OK.has(`${lang}|${key}`)) {
          expect(value).not.toBe(en[key]);
        }
      });
    }
  }
});
