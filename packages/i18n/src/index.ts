import { en } from './catalogs/en.js';
import { de } from './catalogs/de.js';
import { ru } from './catalogs/ru.js';
import { uk } from './catalogs/uk.js';
import { be } from './catalogs/be.js';
import { fr } from './catalogs/fr.js';
import { ja } from './catalogs/ja.js';
import { zhCn } from './catalogs/zh-cn.js';
import { pl } from './catalogs/pl.js';
import { srCyrl } from './catalogs/sr-cyrl.js';
import { srLatn } from './catalogs/sr-latn.js';
import { zhTw } from './catalogs/zh-tw.js';
import { es } from './catalogs/es.js';
import { pt } from './catalogs/pt.js';
import { ko } from './catalogs/ko.js';
import { it } from './catalogs/it.js';
import type { MessageKey, Catalog } from './catalogs/en.js';
import { type Lang, SUPPORTED_LANGS } from './langs.js';
import { type Vars, type Translator, createTranslatorFrom } from './translator.js';

export type { MessageKey, Catalog, Lang, Vars, Translator };
export { SUPPORTED_LANGS };

/**
 * Map of all available catalogs. Any keys a catalog omits fall back to English
 * at runtime (see the fallback in createTranslator).
 */
const catalogs: Record<Lang, Partial<Catalog>> = {
  en,
  de,
  ru,
  uk,
  be,
  fr,
  ja,
  'zh-cn': zhCn,
  pl,
  'sr-cyrl': srCyrl,
  'sr-latn': srLatn,
  'zh-tw': zhTw,
  es,
  pt,
  ko,
  it,
};

// Native language names (the picker's primary label; non-ASCII i18n data).
export { LANGUAGE_NATIVE_NAMES, LANGUAGE_CHINESE_QUALIFIERS } from './nativeNames.js';

/**
 * Create a translator bound to the given language (eager: all catalogs are
 * already in memory). Kept for the CLI and any sync consumer.
 */
export function createTranslator(lang: Lang): Translator {
  return createTranslatorFrom(catalogs[lang], catalogs['en'], lang);
}
