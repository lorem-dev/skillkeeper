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

  'common.refresh': 'Aktualisieren',
  'common.comingSoon': 'Demnächst verfügbar',
  'common.close': 'Schließen',
  'common.clear': 'Löschen',
  'common.decrease': 'Verringern',
  'common.increase': 'Erhöhen',

  'repositories.empty': 'Noch keine Repositories hinzugefügt.',
  'repositories.add': 'Repository hinzufügen',
  'repositories.lfs': 'LFS',
  'repositories.lastFetched': 'Zuletzt abgerufen: {when}',
  'repositories.neverFetched': 'Nie abgerufen',
  'repositories.addRemote': 'Remote-URL',
  'repositories.addName': 'Name',
  'repositories.edit': 'Repository bearbeiten',
  'repositories.save': 'Speichern',
  'repositories.sync': 'Sync',
  'repositories.delete': 'Löschen',
  'repositories.deleteConfirm': 'Löschen bestätigen',
  'repositories.hasUpdate': 'Update verfügbar',

  'projects.empty': 'Noch keine Projekte erfasst.',
  'projects.add': 'Projekt hinzufügen',
  'projects.addedAt': 'Hinzugefügt {when}',

  'skills.empty': 'Noch keine Fähigkeiten installiert.',
  'skills.add': 'Skill installieren',
  'skills.searchPlaceholder': 'Skills suchen',
  'skills.filterAgent': 'Agent',
  'skills.allAgents': 'Alle Agenten',
  'skills.noVersion': 'Keine Version',
  'skills.installedFor': 'Installiert für',
  'skills.scope.project': 'Projekt',
  'skills.scope.global': 'Global',
  'skills.source.repo': 'Aus Repository',
  'skills.source.local': 'Aus lokalem Pfad',
  'skills.details.title': 'Skill-Details',
  'skills.details.files': '{n} Dateien',
  'skills.details.hooks': '{n} Hooks',
  'skills.details.installedAt': 'Installiert: {when}',
  'skills.details.destination': 'Ziel',
  'skills.verify': 'Prüfen',
  'skills.update': 'Aktualisieren',

  'settings.comingSoon': 'Einstellungen folgen in Kürze.',
  'settings.section.general': 'Allgemein',
  'settings.section.updates': 'Updates',
  'settings.section.agents': 'Agenten',
  'settings.section.executables': 'Ausführbare Dateien',
  'settings.section.security': 'Sicherheit',
  'settings.section.notifications': 'Benachrichtigungen',
  'settings.valid': 'Gültig',
  'settings.invalid': 'Ungültig',
  'settings.openConfig': 'Konfigurationsdatei öffnen',
  'settings.openConfigInEditor': 'Konfigurationsdatei in einem Editor öffnen',
  'settings.editor.defaultApp': 'In Standard-App öffnen',
  'settings.openConfigFailed': 'Konfigurationsdatei konnte nicht geöffnet werden',
  'settings.theme': 'Design',
  'settings.theme.system': 'System',
  'settings.theme.light': 'Hell',
  'settings.theme.dark': 'Dunkel',
  'settings.language': 'Sprache',
  'settings.section.repositories': 'Repositories',
  'settings.git': 'Git',
  'settings.gitDescription': 'Pfad zur Git-Programmdatei',
  'settings.updates.mode': 'Aktualisierungen',
  'settings.updates.mode.manual': 'Manuell',
  'settings.updates.mode.onStartup': 'Beim Start',
  'settings.updates.mode.scheduled': 'Geplant',
  'settings.updates.interval': 'Prüfintervall (Stunden)',
  'settings.agents.enabled': 'Aktivierte Agenten',
  'settings.agents.placeholder': 'Agenten wählen',
  'settings.agents.selected': 'Ausgewählt: {count}',
  'settings.notifications.enabled': 'Systembenachrichtigungen',

  'config.invalidBanner':
    'Die Konfiguration enthält ungültige Abschnitte. Standardwerte werden verwendet. Führen Sie "skillkeeper config validate" aus.',

  'skills.count': '{n} Fähigkeit(en) installiert',
};
