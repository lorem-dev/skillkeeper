/**
 * React hook that provides a translator bound to the current language from
 * the store's config.
 *
 * Falls back to 'en' when no config is loaded yet. The translator is memoized
 * so component re-renders only when the language actually changes.
 */
import { useMemo } from 'react';
import { createTranslator } from '@skillkeeper/i18n';
import type { Translator, Lang } from '@skillkeeper/i18n';
import { useSkillkeeperStore } from '@/app/store';

export type { Translator };

export function useTranslator(): Translator {
  const config = useSkillkeeperStore((s) => s.config);
  const lang: Lang =
    config?.general?.language !== undefined &&
    (config.general.language === 'en' ||
      config.general.language === 'de' ||
      config.general.language === 'ru')
      ? (config.general.language as Lang)
      : 'en';

  return useMemo(() => createTranslator(lang), [lang]);
}
