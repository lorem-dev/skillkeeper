/**
 * English catalog -- source of truth for all message keys.
 *
 * Rules:
 * - All keys and values are ASCII-only.
 * - Use {varName} for interpolated placeholders.
 * - This object's type is the canonical key set; de/ru are Partial of it.
 */
export const en = {
  'app.title': 'SkillKeeper',

  'nav.repositories': 'Repositories',
  'nav.skills': 'Skills',
  'nav.projects': 'Projects',
  'nav.settings': 'Settings',

  /** Generic activity/loading label. */
  'common.loading': 'Loading',
  /**
   * Generic error line shown in the content area.
   * Interpolation: {message} = the error text.
   */
  'common.errorPrefix': 'Error: {message}',

  /** Empty-state copy for each page. */
  'repositories.empty': 'No repositories added yet.',
  'skills.empty': 'No skills installed yet.',
  'projects.empty': 'No projects tracked yet.',
  'settings.comingSoon': 'Settings screen coming soon.',

  /** Shown in the CLI/GUI when config.yaml has at least one invalid section. */
  'config.invalidBanner':
    'Configuration has invalid sections. Defaults are in use. Run "skillkeeper config validate" for details.',

  /** Shown when a hook install is attempted without explicit consent. */
  'hooks.requireConsent':
    'Hook installation requires explicit consent (--allow-hooks). Skill body installed; hooks skipped.',

  /**
   * Number of installed skills.
   * Interpolation: {n} = count.
   */
  'skills.count': '{n} skill(s) installed',
} as const;

/** The union of all valid translation keys. */
export type MessageKey = keyof typeof en;

/**
 * A widened catalog shape where every value is `string`.
 * Used to type `de`/`ru` catalogs, which have different string values
 * from the `en` source of truth.
 */
export type Catalog = { [K in MessageKey]: string };
