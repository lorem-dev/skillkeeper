import type { MessageKey, Catalog } from './catalogs/en.js';
import type { Lang } from './langs.js';

/**
 * Interpolation variables bag: keys are placeholder names (without braces),
 * values are string representations.
 */
export type Vars = Record<string, string>;

/** Translator function returned by {@link createTranslatorFrom}. */
export interface Translator {
  (key: MessageKey | (string & {}), vars?: Vars): string;
  /**
   * Select a plural form for `count`. Looks up `${baseKey}.${category}`, where
   * `category` comes from `Intl.PluralRules` for the bound language, falling
   * back to `${baseKey}.other`. `{count}` is interpolated automatically.
   */
  plural(baseKey: string, count: number, vars?: Vars): string;
}

/** Replace all `{name}` tokens in `template` with values from `vars`. */
export function interpolate(template: string, vars: Vars): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value !== undefined ? value : `{${name}}`;
  });
}

/**
 * Build a translator from explicit `primary` and `fallback` catalogs.
 *
 * Lookup order for a key: `primary` -> `fallback` -> the raw key string.
 */
export function createTranslatorFrom(
  primary: Partial<Catalog>,
  fallback: Partial<Catalog>,
  lang: Lang,
): Translator {
  const pluralRules = new Intl.PluralRules(lang);

  const has = (key: string): boolean =>
    (primary as Record<string, string>)[key] !== undefined ||
    (fallback as Record<string, string>)[key] !== undefined;

  const t = function t(key: MessageKey | (string & {}), vars?: Vars): string {
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
