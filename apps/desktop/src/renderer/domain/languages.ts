import type { Lang } from '@/services/bridge';

const LANGS: readonly Lang[] = [
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

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function displayName(target: Lang, inLocale: Lang): string {
  const name = new Intl.DisplayNames([inLocale], { type: 'language' }).of(target) ?? target;
  // Render a region qualifier with a slash instead of parentheses, e.g.
  // "Chinese (China)" -> "Chinese/China".
  const slashed = name.replace(/^(.+) \((.+)\)$/u, '$1/$2');
  return capitalize(slashed);
}

export interface LanguageOption {
  readonly value: Lang;
  readonly label: string;
}

/**
 * Language picker options, sorted by language code. The current language shows
 * only its native name; every other language shows
 * "<native> (<name in the current locale>)".
 */
export function buildLanguageOptions(current: Lang): LanguageOption[] {
  return LANGS.map((lang) => {
    const native = displayName(lang, lang);
    const label = lang === current ? native : `${native} (${displayName(lang, current)})`;
    return { value: lang, label };
  }).sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}
