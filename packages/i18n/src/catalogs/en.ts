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

  'common.refresh': 'Refresh',
  'common.comingSoon': 'Coming soon',
  'common.close': 'Close',
  'common.clear': 'Clear',

  /** Empty-state copy for each page. */
  'repositories.empty': 'No repositories added yet.',
  'repositories.add': 'Add repository',
  'repositories.lfs': 'LFS',
  'repositories.lastFetched': 'Last fetched: {when}',
  'repositories.neverFetched': 'Never fetched',

  'projects.empty': 'No projects tracked yet.',
  'projects.add': 'Add project',
  'projects.addedAt': 'Added {when}',

  'skills.empty': 'No skills installed yet.',
  'skills.add': 'Install skill',
  'skills.searchPlaceholder': 'Search skills',
  'skills.filterAgent': 'Agent',
  'skills.allAgents': 'All agents',
  'skills.noVersion': 'No version',
  'skills.installedFor': 'Installed for',
  'skills.scope.project': 'Project',
  'skills.scope.global': 'Global',
  'skills.source.repo': 'From repository',
  'skills.source.local': 'From local path',
  'skills.details.title': 'Skill details',
  'skills.details.files': '{n} files',
  'skills.details.hooks': '{n} hooks',
  'skills.details.installedAt': 'Installed: {when}',
  'skills.details.destination': 'Destination',
  'skills.verify': 'Verify',
  'skills.update': 'Update',

  'settings.comingSoon': 'Settings screen coming soon.',
  'settings.section.general': 'General',
  'settings.section.updates': 'Updates',
  'settings.section.agents': 'Agents',
  'settings.section.executables': 'Executables',
  'settings.section.security': 'Security',
  'settings.section.notifications': 'Notifications',
  'settings.valid': 'Valid',
  'settings.invalid': 'Invalid',
  'settings.openConfig': 'Open config file',
  'settings.theme': 'Theme',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.language': 'Language',

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
