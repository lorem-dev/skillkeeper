import type { NotificationEntry } from '@/app/store';

/**
 * The newest `level: 'error'` entry logged strictly after `lastIdBefore` --
 * the id of whatever was the newest entry in the notification log immediately
 * before an operation started (`undefined` when the log was empty then).
 *
 * This exists instead of a saved snapshot of the log's LENGTH because
 * `store.ts`'s notification log is capped (`NOTIFICATION_LOG_LIMIT`, 500):
 * `notify`'s `set()` call does `.slice(-NOTIFICATION_LOG_LIMIT)`, so once the
 * log is full, appending one entry drops the oldest instead of growing the
 * array. A caller that snapshotted the pre-operation LENGTH and later sliced
 * the post-operation array from that same numeric index gets `[]` the moment
 * the log is full at the time it snapshots -- the array's length never grows
 * past the cap, so "everything after index `lengthBefore`" is empty even
 * though a new entry really was appended (see this module's test). Anchoring
 * on the last entry's id instead survives the log shifting underneath it: the
 * entry may have moved to a lower index (or fallen out of the log entirely,
 * if enough entries were appended since), but everything genuinely new is
 * still everything after it.
 */
export function newestErrorSince(
  notifications: readonly NotificationEntry[],
  lastIdBefore: string | undefined,
): NotificationEntry | undefined {
  const cutAt = lastIdBefore === undefined ? 0 : Math.max(0, notifications.findIndex((n) => n.id === lastIdBefore) + 1);
  return notifications.slice(cutAt).find((n) => n.level === 'error');
}
