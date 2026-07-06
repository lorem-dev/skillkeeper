/**
 * React hook that provides a translator bound to the current language from
 * the store's config.
 *
 * Falls back to 'en' when no config is loaded yet. The translator is memoized
 * so component re-renders only when the language actually changes.
 */
import { useMemo } from 'react';
import { createTranslator, SUPPORTED_LANGS } from '@skillkeeper/i18n';
import type { Translator, Lang } from '@skillkeeper/i18n';
import { useSkillkeeperStore } from '@/app/store';

export type { Translator };

export function useTranslator(): Translator {
  const config = useSkillkeeperStore((s) => s.config);
  const current = config?.general?.language;
  // Accept any supported locale (the config is schema-validated); fall back to
  // English when unset or unrecognized.
  const lang: Lang =
    current !== undefined && (SUPPORTED_LANGS as readonly string[]).includes(current)
      ? (current as Lang)
      : 'en';

  return useMemo(() => createTranslator(lang), [lang]);
}
