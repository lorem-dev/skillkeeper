/**
 * Resolve a notification entry's display text. Raw `text` is shown as-is; a
 * `key` is translated with the CURRENT language (so switching language
 * re-translates existing log entries) using the provided translator.
 */
import type { NotificationEntry } from '@/app/store';
import type { Translator } from '@/systems/i18n';

export function resolveNotification(entry: NotificationEntry, t: Translator): string {
  if (entry.key !== undefined) return t(entry.key, entry.vars);
  return entry.text ?? '';
}
