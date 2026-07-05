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
  'common.decrease': 'Decrease',
  'common.increase': 'Increase',

  'notifications.error': 'Error',
  'notifications.info': 'Notification',

  'statusbar.notifications': 'Errors: {count}',
  'statusbar.terminal': 'Terminal',
  'statusbar.tasks': 'Tasks',

  'logs.title': 'Notifications',
  'terminal.title': 'Terminal',
  'logs.empty': 'Nothing to show.',
  'logs.copy': 'Copy',
  'logs.copyAll': 'Copy all',
  'logs.clear': 'Clear',
  'logs.filter': 'Show',
  'logs.level.error': 'Errors',
  'logs.level.info': 'Messages',

  'tasks.title': 'Tasks',
  'tasks.empty': 'No tasks.',
  'tasks.clear': 'Clear finished',
  'tasks.kind.sync': 'Sync',
  'tasks.kind.check': 'Check for updates',
  'tasks.status.queued': 'Queued',
  'tasks.status.running': 'Running',
  'tasks.status.done': 'Done',
  'tasks.status.error': 'Failed',

  /** Empty-state copy for each page. */
  'repositories.empty': 'No repositories added yet.',
  'repositories.add': 'Add repository',
  'repositories.lfs': 'LFS',
  'repositories.lastFetched': 'Last fetched: {when}',
  'repositories.neverFetched': 'Never fetched',
  'repositories.addRemote': 'Remote URL',
  'repositories.invalidRemote': 'Enter a valid remote URL (https://... or git@host:path).',
  'repositories.addName': 'Name',
  'repositories.edit': 'Edit repository',
  'repositories.save': 'Save',
  'repositories.sync': 'Sync',
  'repositories.syncing': 'Syncing',
  'repositories.delete': 'Delete',
  'repositories.deleteConfirm': 'Confirm delete',
  'repositories.hasUpdate': 'Update available',
  'repositories.viewError': 'Click to view the error',
  'repositories.copyBranch': 'Copy branch name',
  'repositories.branchCopied': 'Branch name copied to the clipboard',
  'repositories.copyRemote': 'Copy link',
  'repositories.remoteCopied': 'Remote URL copied to the clipboard',
  /** Skill-count badge. Plural forms selected via Intl.PluralRules. */
  'repositories.skillCount.one': '{count} skill',
  'repositories.skillCount.few': '{count} skills',
  'repositories.skillCount.many': '{count} skills',
  'repositories.skillCount.other': '{count} skills',

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
  'settings.openConfigInEditor': 'Open the config file in an editor',
  'settings.editor.defaultApp': 'Open in default app',
  'settings.openConfigFailed': 'Could not open the config file',
  'settings.theme': 'Theme',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Light',
  'settings.theme.dark': 'Dark',
  'settings.language': 'Language',
  'settings.section.repositories': 'Repositories',
  'settings.git': 'Git',
  'settings.gitDescription': 'Path to the git executable',
  'settings.updates.mode': 'Update checks',
  'settings.updates.mode.manual': 'Manual',
  'settings.updates.mode.onStartup': 'On startup',
  'settings.updates.mode.scheduled': 'Scheduled',
  'settings.updates.interval': 'Check interval (hours)',
  'settings.agents.enabled': 'Enabled agents',
  'settings.agents.placeholder': 'Choose agents',
  'settings.agents.selected': 'Selected {count}',
  'settings.notifications.enabled': 'System notifications',

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
