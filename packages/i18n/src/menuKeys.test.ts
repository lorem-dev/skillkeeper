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
