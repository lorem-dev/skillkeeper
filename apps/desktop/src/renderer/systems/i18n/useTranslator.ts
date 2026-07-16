/**
 * React hook providing a translator bound to the current language from the
 * store's config. The active catalog is loaded lazily; until it arrives the
 * translator falls back to English. `useSyncExternalStore` re-renders the hook
 * when the catalog finishes loading (see the i18n runtime).
 */
import { useMemo, useSyncExternalStore } from 'react';
import { createTranslatorFrom, en } from '@skillkeeper/i18n/lazy';
import type { Translator } from '@skillkeeper/i18n/lazy';
import { useSkillkeeperStore } from '@/app/store';
import { getCatalog, subscribe, resolveLang } from './runtime';

export type { Translator };

export function useTranslator(): Translator {
  const config = useSkillkeeperStore((s) => s.config);
  const lang = resolveLang(config?.general?.language);
  // Re-render whenever any catalog loads; the snapshot is the catalog object for
  // `lang`, so React sees a new reference once `lang` transitions from the
  // English fallback to its real catalog.
  const catalog = useSyncExternalStore(
    subscribe,
    () => getCatalog(lang),
    () => getCatalog(lang),
  );
  return useMemo(() => createTranslatorFrom(catalog, en, lang), [catalog, lang]);
}
