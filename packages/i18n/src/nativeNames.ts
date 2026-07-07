import type { Lang } from './index.js';

/**
 * Native language names -- each locale's own name for itself. i18n data, so
 * (like the catalogs) this is the ONE place outside `catalogs/` allowed to hold
 * non-ASCII text.
 *
 * The language picker uses this as the authoritative primary label instead of
 * `Intl.DisplayNames`: the Electron/Chromium runtime ships a reduced ICU data
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
