/** Supported locale codes and their canonical order. No catalog imports here,
 *  so consumers that only need the code list stay catalog-free. */
export type Lang =
  | 'en'
  | 'de'
  | 'ru'
  | 'uk'
  | 'be'
  | 'fr'
  | 'ja'
  | 'zh-cn'
  | 'pl'
  | 'sr-cyrl'
  | 'sr-latn'
  | 'zh-tw'
  | 'es'
  | 'pt'
  | 'ko'
  | 'it';

/** All selectable locale codes, in the catalog-map order. Kept as a literal
 *  (not `Object.keys(catalogs)`) so importing it does not pull every catalog. */
export const SUPPORTED_LANGS: Lang[] = [
  'en',
  'de',
  'ru',
  'uk',
  'be',
  'fr',
  'ja',
  'zh-cn',
  'pl',
  'sr-cyrl',
  'sr-latn',
  'zh-tw',
  'es',
  'pt',
  'ko',
  'it',
];
