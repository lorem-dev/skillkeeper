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
  'common.search': 'Search',
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
  'repositories.branch': 'Branch',
  'repositories.branchSearch': 'Search branches',
  'repositories.branchNone': 'No matching branch',
  /** Skill-count badge. Plural forms selected via Intl.PluralRules. */
  'repositories.skillCount.one': '{count} skill',
  'repositories.skillCount.few': '{count} skills',
  'repositories.skillCount.many': '{count} skills',
  'repositories.skillCount.other': '{count} skills',
  'repositories.searchFound.one': 'Found {count} repository',
  'repositories.searchFound.few': 'Found {count} repositories',
  'repositories.searchFound.many': 'Found {count} repositories',
  'repositories.searchFound.other': 'Found {count} repositories',
  'repositories.searchTotal.one': '{count} repository total',
  'repositories.searchTotal.few': '{count} repositories total',
  'repositories.searchTotal.many': '{count} repositories total',
  'repositories.searchTotal.other': '{count} repositories total',
  'repositories.showAll': 'Show all repositories',

  'projects.empty': 'No projects tracked yet.',
  'projects.add': 'Add project',
  'projects.addedAt': 'Added {when}',
  'projects.edit': 'Edit project',
  'projects.name': 'Name',
  'projects.remove': 'Remove project',
  'projects.removeConfirm': 'Confirm remove',
  'projects.removeKeepsFolder': 'Removes the project from the list. The folder stays on disk.',
  'projects.changeFolder': 'Change folder',
  'projects.open': 'Open project',
  'projects.openInFileManager': 'Open in file manager',
  'projects.openFailed': 'Could not open the project',
  'projects.missing': 'The folder was deleted or moved',
  'projects.copyPath': 'Copy full path',
  'projects.pathCopied': 'Path copied to the clipboard',
  /** Total skills in the project. Plural forms selected via Intl.PluralRules. */
  'projects.skillCount.one': '{count} skill',
  'projects.skillCount.few': '{count} skills',
  'projects.skillCount.many': '{count} skills',
  'projects.skillCount.other': '{count} skills',
  /** Installed-from-repositories count badge. */
  'projects.fromRepos': '{count} from repos',
  'projects.searchFound.one': 'Found {count} project',
  'projects.searchFound.few': 'Found {count} projects',
  'projects.searchFound.many': 'Found {count} projects',
  'projects.searchFound.other': 'Found {count} projects',
  'projects.searchTotal.one': '{count} project total',
  'projects.searchTotal.few': '{count} projects total',
  'projects.searchTotal.many': '{count} projects total',
  'projects.searchTotal.other': '{count} projects total',
  'projects.showAll': 'Show all projects',

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
  'skills.source': 'Source',
  'skills.source.repositories': 'Repositories',
  'skills.source.projects': 'Projects',
  'skills.action.add': 'Add',
  'skills.action.save': 'Save',
  'skills.showAll': 'Show all skills',
  'skills.emptyRepositories': 'No skills found in your repositories.',
  'skills.emptyProjects': 'No projects tracked yet.',
  'skills.status.add': 'Skill will be added',
  'skills.status.remove': 'Skill will be removed',
  'skills.status.present': 'Skill already installed',
  'skills.installPending': 'Installing skills is coming soon ({count} selected)',
  'skills.savePending': 'Saving changes is coming soon (+{add} / -{remove})',
  'skills.searchFound.one': 'Found {count} skill',
  'skills.searchFound.few': 'Found {count} skills',
  'skills.searchFound.many': 'Found {count} skills',
  'skills.searchFound.other': 'Found {count} skills',
  'skills.searchTotal.one': '{count} skill total',
  'skills.searchTotal.few': '{count} skills total',
  'skills.searchTotal.many': '{count} skills total',
  'skills.searchTotal.other': '{count} skills total',

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
  'settings.section.projects': 'Projects',
  'settings.git': 'Git',
  'settings.gitDescription': 'Path to the git executable',
  'settings.updates.mode': 'Update checks',
  'settings.updates.mode.manual': 'Manual',
  'settings.updates.mode.onStartup': 'On startup',
  'settings.updates.mode.scheduled': 'Scheduled',
  'settings.updates.interval': 'Update interval',
  'settings.projects.checkInterval': 'Folder check interval',
  'settings.interval.minutesUnit': 'm',
  'settings.interval.hoursUnit': 'h',
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
