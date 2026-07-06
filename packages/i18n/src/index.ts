import { en } from './catalogs/en.js';
import { de } from './catalogs/de.js';
import { ru } from './catalogs/ru.js';
import { uk } from './catalogs/uk.js';
import { be } from './catalogs/be.js';
import { fr } from './catalogs/fr.js';
import { ja } from './catalogs/ja.js';
import { zhCn } from './catalogs/zh-cn.js';
import { pl } from './catalogs/pl.js';
import type { MessageKey, Catalog } from './catalogs/en.js';

/** Supported locale codes. */
export type Lang = 'en' | 'de' | 'ru' | 'uk' | 'be' | 'fr' | 'ja' | 'zh-cn' | 'pl';

export type { MessageKey, Catalog };

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
};

/** All selectable locale codes (the catalog keys), for runtime validation. */
export const SUPPORTED_LANGS = Object.keys(catalogs) as Lang[];

/**
 * Interpolation variables bag: keys are placeholder names (without braces),
 * values are string representations.
 */
export type Vars = Record<string, string>;

/**
 * Translator function returned by {@link createTranslator}.
 *
 * @param key A {@link MessageKey} from the English catalog.
 * @param vars Optional interpolation variables. Each `{name}` token in the
 *             resolved string is replaced with `vars[name]`.
 * @returns The localized string, or the key itself when no translation exists.
 */
export interface Translator {
  (key: MessageKey | (string & {}), vars?: Vars): string;
  /**
   * Select a plural form for `count`. Looks up `${baseKey}.${category}`, where
   * `category` is chosen by `Intl.PluralRules` for the bound language (`one`,
   * `few`, `many`, `other`, ...), falling back to `${baseKey}.other`. `{count}`
   * is interpolated automatically (extra `vars` are merged in).
   */
  plural(baseKey: string, count: number, vars?: Vars): string;
}

/**
 * Replace all `{name}` tokens in `template` with values from `vars`.
 */
function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : `{${name}}`;
  });
}

/**
 * Create a translator bound to the given language.
 *
 * Lookup order for a key:
 * 1. `lang` catalog (if `lang !== 'en'`)
 * 2. `en` catalog (fallback for missing keys)
 * 3. The raw key string (last resort)
 *
 * @param lang The desired language.
 * @returns A `t(key, vars?)` function.
 */
export function createTranslator(lang: Lang): Translator {
  const primary = catalogs[lang];
  const fallback: Partial<Catalog> = catalogs['en'];
  const pluralRules = new Intl.PluralRules(lang);

  const has = (key: string): boolean =>
    (primary as Record<string, string>)[key] !== undefined ||
    (fallback as Record<string, string>)[key] !== undefined;

  const t = function t(key: MessageKey | (string & {}), vars?: Vars): string {
    // Cast needed because primary/fallback are Partial -- the key may not exist.
    const raw =
      (primary as Record<string, string>)[key] ??
      (fallback as Record<string, string>)[key] ??
      key;

    return vars !== undefined ? interpolate(raw, vars) : raw;
  } as Translator;

  t.plural = (baseKey: string, count: number, vars?: Vars): string => {
    const category = pluralRules.select(count);
    const categoryKey = `${baseKey}.${category}`;
    const key = has(categoryKey) ? categoryKey : `${baseKey}.other`;
    return t(key, { count: String(count), ...vars });
  };

  return t;
}
