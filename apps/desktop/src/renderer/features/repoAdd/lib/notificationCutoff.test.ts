import { describe, expect, it } from 'vitest';
import type { NotificationEntry } from '@/app/store';
import { newestErrorSince } from './notificationCutoff';

function entry(id: string, level: NotificationEntry['level']): NotificationEntry {
  return { id, level, text: id, at: '2026-01-01T00:00:00.000Z' };
}

describe('newestErrorSince', () => {
  it('finds the newest error logged after the given id', () => {
    const notifications = [entry('a', 'info'), entry('b', 'error'), entry('c', 'info'), entry('d', 'error')];
    expect(newestErrorSince(notifications, 'b')).toEqual(entry('d', 'error'));
  });

  it('returns undefined when nothing after the given id is an error', () => {
    const notifications = [entry('a', 'error'), entry('b', 'info')];
    expect(newestErrorSince(notifications, 'a')).toBeUndefined();
  });

  it('searches the whole log when there was nothing logged before', () => {
    const notifications = [entry('a', 'info'), entry('b', 'error')];
    expect(newestErrorSince(notifications, undefined)).toEqual(entry('b', 'error'));
  });

  // Regression: `store.ts`'s notification log caps at `NOTIFICATION_LOG_LIMIT`
  // (500) -- `notify`'s `set()` does `.slice(-500)`, so once the log is full,
  // appending an entry drops the oldest one instead of growing the array. A
  // caller that snapshotted the pre-submit LENGTH (instead of an id) and later
  // sliced from that same numeric index would find the array's length
  // unchanged (still exactly the cap) and read back an empty slice -- silently
  // losing the very error it was looking for. Anchoring on the id of the last
  // entry present before the submit must keep working even though that entry
  // has since shifted to a lower index.
  it('still finds the error once the log is full and has shifted past the cap', () => {
    const full = Array.from({ length: 500 }, (_, i) => entry(`old-${i}`, 'info'));
    const lastIdBefore = full[full.length - 1]?.id;
    // Simulate `notify` appending one more entry and re-capping to 500: the
    // oldest entry is dropped and everything else shifts one index left.
    const afterSubmit = [...full.slice(1), entry('new-error', 'error')];
    expect(afterSubmit).toHaveLength(500);
    expect(newestErrorSince(afterSubmit, lastIdBefore)).toEqual(entry('new-error', 'error'));
  });
});
