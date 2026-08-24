/**
 * What the status-bar bell badge should show, derived from the logged counts.
 *
 * Kept as a pure function so the precedence rule is unit-testable: renderer tests
 * are node-only and never render React, so logic left inside the component would
 * be covered by nothing.
 */
import type { NotificationLevel } from '@/app/store';

/** Largest count shown as a number; above it the badge reads `9+`. */
export const BELL_BADGE_MAX = 9;

export interface BellBadge {
  /** Which count is on display, or `null` when the badge is hidden. */
  readonly tone: 'error' | 'warning' | null;
  /** The number behind the badge text; 0 when hidden. */
  readonly count: number;
  /** Ready-to-render text (`"3"`, `"9+"`), empty when hidden. */
  readonly text: string;
  /** i18n key for the button's accessible label. */
  readonly labelKey: 'statusbar.notifications' | 'statusbar.warnings';
  /** `{count}` interpolation value for `labelKey`. */
  readonly labelCount: string;
}

/**
 * Errors outrank warnings absolutely: while a single error is logged the badge
 * shows the error count and nothing else, so a pile of warnings can never dilute
 * or hide an error. Warnings surface only once the error count is zero.
 */
export function resolveBellBadge(errorCount: number, warningCount: number): BellBadge {
  const level: NotificationLevel | null = errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : null;
  if (level === null) {
    return {
      tone: null,
      count: 0,
      text: '',
      // No badge: the bell still needs a label, and zero errors is the honest one.
      labelKey: 'statusbar.notifications',
      labelCount: '0',
    };
  }
  const count = level === 'error' ? errorCount : warningCount;
  return {
    tone: level,
    count,
    text: count > BELL_BADGE_MAX ? `${BELL_BADGE_MAX}+` : String(count),
    labelKey: level === 'error' ? 'statusbar.notifications' : 'statusbar.warnings',
    labelCount: String(count),
  };
}
