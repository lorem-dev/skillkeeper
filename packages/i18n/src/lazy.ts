/**
 * Lazy i18n surface for bundled consumers (the desktop renderer). Only English
 * -- the default and fallback -- is imported statically; every other catalog is
 * fetched on demand via `loadCatalog`, so each becomes its own chunk. Importing
 * this module must NOT pull the eager `catalogs` barrel from `index.ts`.
 */
import { en } from './catalogs/en.js';
import type { MessageKey, Catalog } from './catalogs/en.js';
import { type Lang, SUPPORTED_LANGS } from './langs.js';

export type { MessageKey, Catalog, Lang };
export type { Vars, Translator } from './translator.js';
export { createTranslatorFrom, interpolate } from './translator.js';
export { SUPPORTED_LANGS };
export { LANGUAGE_NATIVE_NAMES, LANGUAGE_CHINESE_QUALIFIERS } from './nativeNames.js';

/** The English catalog, always available synchronously (default + fallback). */
export { en };

/**
 * Per-language catalog loaders. English resolves synchronously from the static
 * import; every other language is a dynamic `import()` so Rollup splits it into
 * its own chunk. Written as literal `import()` calls (not computed specifiers)
 * so the bundler can statically discover and split each catalog.
 */
const loaders: Record<Lang, () => Promise<Partial<Catalog>>> = {
  en: () => Promise.resolve(en),
  de: () => import('./catalogs/de.js').then((m) => m.de),
  ru: () => import('./catalogs/ru.js').then((m) => m.ru),
  uk: () => import('./catalogs/uk.js').then((m) => m.uk),
  be: () => import('./catalogs/be.js').then((m) => m.be),
  fr: () => import('./catalogs/fr.js').then((m) => m.fr),
  ja: () => import('./catalogs/ja.js').then((m) => m.ja),
  'zh-cn': () => import('./catalogs/zh-cn.js').then((m) => m.zhCn),
  pl: () => import('./catalogs/pl.js').then((m) => m.pl),
  'sr-cyrl': () => import('./catalogs/sr-cyrl.js').then((m) => m.srCyrl),
  'sr-latn': () => import('./catalogs/sr-latn.js').then((m) => m.srLatn),
  'zh-tw': () => import('./catalogs/zh-tw.js').then((m) => m.zhTw),
  es: () => import('./catalogs/es.js').then((m) => m.es),
  pt: () => import('./catalogs/pt.js').then((m) => m.pt),
  ko: () => import('./catalogs/ko.js').then((m) => m.ko),
  it: () => import('./catalogs/it.js').then((m) => m.it),
};

/** Load a language's catalog (English is synchronous; others are code-split). */
export function loadCatalog(lang: Lang): Promise<Partial<Catalog>> {
  return loaders[lang]();
}
