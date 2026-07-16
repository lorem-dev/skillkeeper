/**
 * Renderer-side lazy-i18n runtime. Holds a registry of loaded catalogs (English
 * is always present), loads others on demand via `@skillkeeper/i18n/lazy`, and
 * notifies subscribers when a catalog arrives so bound translators re-render.
 *
 * Callers gate the UI on `ensureCatalog` (startup in the store; language switch
 * in settings) so the English fallback is never visibly flashed.
 */
import { en, loadCatalog, SUPPORTED_LANGS } from '@skillkeeper/i18n/lazy';
import type { Lang, Catalog } from '@skillkeeper/i18n/lazy';

const registry: Partial<Record<Lang, Partial<Catalog>>> = { en };
const inflight = new Map<Lang, Promise<void>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/** Narrow an arbitrary config value to a supported `Lang`, defaulting to `en`. */
export function resolveLang(value: string | undefined): Lang {
  return value !== undefined && (SUPPORTED_LANGS as readonly string[]).includes(value)
    ? (value as Lang)
    : 'en';
}

/** The loaded catalog for `lang`, or English when it has not loaded yet. */
export function getCatalog(lang: Lang): Partial<Catalog> {
  return registry[lang] ?? en;
}

/**
 * Ensure `lang`'s catalog is loaded. Resolves immediately if already present;
 * otherwise de-dupes concurrent loads by caching the in-flight promise. On
 * resolution the catalog is registered and subscribers are notified.
 */
export function ensureCatalog(lang: Lang): Promise<void> {
  if (registry[lang] !== undefined) return Promise.resolve();
  const existing = inflight.get(lang);
  if (existing !== undefined) return existing;
  const p = loadCatalog(lang).then((cat) => {
    registry[lang] = cat;
    inflight.delete(lang);
    notify();
  });
  inflight.set(lang, p);
  return p;
}

/** Subscribe to catalog-load events. Returns an unsubscribe function. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
