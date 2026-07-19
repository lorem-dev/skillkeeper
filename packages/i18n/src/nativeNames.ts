import type { Lang } from './index.js';

/**
 * Native language names -- each locale's own name for itself. i18n data, so
 * (like the catalogs) this is the ONE place outside `catalogs/` allowed to hold
 * non-ASCII text.
 *
 * The language picker uses this as the authoritative primary label instead of
 * `Intl.DisplayNames`: the system WebView runtime ships a reduced ICU data
 * set on some platforms, where e.g. `Intl.DisplayNames(['be']).of('be')`
 * returns the bare code "be" (Belarusian then looks untranslated) and script
 * codes render as regions ("zh-cn" -> "Chinese (China)"). Keep in sync with
 * `Lang` / `SUPPORTED_LANGS`.
 */
export const LANGUAGE_NATIVE_NAMES: Record<Lang, string> = {
  en: 'English',
  de: 'Deutsch',
  ru: 'русский',
  uk: 'українська',
  be: 'беларуская',
  fr: 'français',
  ja: '日本語',
  'zh-cn': '简体中文',
  pl: 'polski',
  'sr-cyrl': 'српски (ћирилица)',
  'sr-latn': 'srpski (latinica)',
  'zh-tw': '繁體中文',
  es: 'español',
  pt: 'português',
  ko: '한국어',
  it: 'italiano',
};

/**
 * Qualifier words for the two Chinese variants, per UI locale, used in the
 * language picker's cross-locale label instead of the region name Intl would
 * append. Keyed by the locale the label is shown in. Non-ASCII, so it lives
 * here alongside the native names.
 */
export const LANGUAGE_CHINESE_QUALIFIERS: Record<Lang, { mainland: string; traditional: string }> = {
  en: { mainland: 'Mainland', traditional: 'Traditional' },
  de: { mainland: 'Festland', traditional: 'Traditionell' },
  ru: { mainland: 'Материк', traditional: 'Традиционный' },
  uk: { mainland: 'Материк', traditional: 'Традиційний' },
  be: { mainland: 'Мацярык', traditional: 'Традыцыйны' },
  fr: { mainland: 'Continental', traditional: 'Traditionnel' },
  ja: { mainland: '本土', traditional: '繁体' },
  'zh-cn': { mainland: '大陆', traditional: '繁体' },
  pl: { mainland: 'Kontynentalny', traditional: 'Tradycyjny' },
  'sr-cyrl': { mainland: 'Копно', traditional: 'Традиционални' },
  'sr-latn': { mainland: 'Kopno', traditional: 'Tradicionalni' },
  'zh-tw': { mainland: '大陸', traditional: '繁體' },
  es: { mainland: 'Continental', traditional: 'Tradicional' },
  pt: { mainland: 'Continental', traditional: 'Tradicional' },
  ko: { mainland: '본토', traditional: '번체' },
  it: { mainland: 'Continentale', traditional: 'Tradizionale' },
};
