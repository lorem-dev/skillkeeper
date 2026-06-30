import type { Catalog } from './en.js';

/**
 * German catalog.
 *
 * Rules:
 * - Keys are ASCII-only (copied from en.ts).
 * - Values MAY use German umlauts and special characters -- this is the ONE
 *   place in the codebase where non-ASCII characters are permitted.
 * - Only keys that differ meaningfully from English need to be present;
 *   missing keys fall back to `en` at runtime.
 */
export const de: Partial<Catalog> = {
  'app.title': 'SkillKeeper',

  'nav.repositories': 'Repositories',
  'nav.skills': 'Fahigkeiten',
  'nav.projects': 'Projekte',
  'nav.settings': 'Einstellungen',

  'common.loading': 'Wird geladen',
  'common.errorPrefix': 'Fehler: {message}',

  'repositories.empty': 'Noch keine Repositories hinzugefugt.',
  'skills.empty': 'Noch keine Fahigkeiten installiert.',
  'projects.empty': 'Noch keine Projekte erfasst.',
  'settings.comingSoon': 'Einstellungen folgen in Kurze.',

  'config.invalidBanner':
    'Die Konfiguration enthalt ungultige Abschnitte. Standardwerte werden verwendet. Fuhren Sie "skillkeeper config validate" aus.',

  'skills.count': '{n} Fahigkeit(en) installiert',
};
