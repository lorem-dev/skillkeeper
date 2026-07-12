import type { Lang } from '@/services/bridge';
// Pinned native names live in the i18n package (the sanctioned home for
// non-ASCII text); see the note there and in AGENTS.md.
import {
  LANGUAGE_NATIVE_NAMES as NATIVE_NAMES,
  LANGUAGE_CHINESE_QUALIFIERS as CHINESE_QUALIFIERS,
} from '@skillkeeper/i18n';

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

/** Name of `target` as written in `inLocale`, via Intl; falls back to the pinned
 *  native name when the runtime's ICU cannot resolve it (returns the bare code). */
function localizedName(target: Lang, inLocale: Lang): string {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: 'language' }).of(target);
    if (name !== undefined && name.toLowerCase() !== target.toLowerCase()) return name;
  } catch {
    // fall through to the native name
  }
  return NATIVE_NAMES[target];
}

function displayName(target: Lang, inLocale: Lang): string {
  // The native label comes from the pinned table; the cross-locale qualifier
  // uses Intl (with a native-name fallback).
  const name = target === inLocale ? NATIVE_NAMES[target] : localizedName(target, inLocale);
  // The Chinese variants use a pinned neutral qualifier for the cross-locale
  // label rather than the region name Intl appends. The base language name is
  // whatever precedes the parenthesised qualifier (or the whole string when
  // the runtime returns no qualifier).
  if (target !== inLocale && (target === 'zh-cn' || target === 'zh-tw')) {
    const base = name.replace(/ \(.+\)$/u, '');
    const q = CHINESE_QUALIFIERS[inLocale][target === 'zh-cn' ? 'mainland' : 'traditional'];
    return capitalize(`${base}/${q}`);
  }
  // Render a region/script qualifier with a slash instead of parentheses, e.g.
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
