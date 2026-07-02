import type { Lang } from '@/services/bridge';

const LANGS: readonly Lang[] = ['en', 'de', 'ru'];

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

function displayName(target: Lang, inLocale: Lang): string {
  const name = new Intl.DisplayNames([inLocale], { type: 'language' }).of(target);
  return capitalize(name ?? target);
}

export interface LanguageOption {
  readonly value: Lang;
  readonly label: string;
}

/**
 * Language picker options. The current language shows only its native name;
 * every other language shows "<native> (<name in the current locale>)".
 */
export function buildLanguageOptions(current: Lang): LanguageOption[] {
  return LANGS.map((lang) => {
    const native = displayName(lang, lang);
    if (lang === current) return { value: lang, label: native };
    return { value: lang, label: `${native} (${displayName(lang, current)})` };
  });
}
