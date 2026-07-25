import { describe, it, expect } from 'vitest';
import { resolveBellBadge, BELL_BADGE_MAX } from './bellBadge';

describe('resolveBellBadge', () => {
  it('hides the badge when nothing is logged', () => {
    const badge = resolveBellBadge(0, 0);
    expect(badge.tone).toBeNull();
    expect(badge.count).toBe(0);
    expect(badge.text).toBe('');
    expect(badge.labelKey).toBe('statusbar.notifications');
    expect(badge.labelCount).toBe('0');
  });

  it('shows errors in the error tone', () => {
    const badge = resolveBellBadge(3, 0);
    expect(badge.tone).toBe('error');
    expect(badge.text).toBe('3');
    expect(badge.labelKey).toBe('statusbar.notifications');
    expect(badge.labelCount).toBe('3');
  });

  it('shows warnings in the warning tone when there are no errors', () => {
    const badge = resolveBellBadge(0, 2);
    expect(badge.tone).toBe('warning');
    expect(badge.text).toBe('2');
    expect(badge.labelKey).toBe('statusbar.warnings');
    expect(badge.labelCount).toBe('2');
  });

  // The invariant that matters: a warning must never dilute or mask an error.
  it('shows ONLY the error count when both are present', () => {
    const badge = resolveBellBadge(1, 50);
    expect(badge.tone).toBe('error');
    expect(badge.count).toBe(1);
    expect(badge.text).toBe('1');
    expect(badge.labelKey).toBe('statusbar.notifications');
    expect(badge.labelCount).toBe('1');
  });

  it('a single error outranks any number of warnings', () => {
    for (const warnings of [1, 9, 10, 999]) {
      expect(resolveBellBadge(1, warnings).tone).toBe('error');
      expect(resolveBellBadge(1, warnings).count).toBe(1);
    }
  });

  it('renders the exact boundary as a number and past it as 9+', () => {
    expect(resolveBellBadge(BELL_BADGE_MAX, 0).text).toBe('9');
    expect(resolveBellBadge(BELL_BADGE_MAX + 1, 0).text).toBe('9+');
    expect(resolveBellBadge(0, BELL_BADGE_MAX).text).toBe('9');
    expect(resolveBellBadge(0, BELL_BADGE_MAX + 1).text).toBe('9+');
    expect(resolveBellBadge(0, 1234).text).toBe('9+');
  });

  it('keeps the true count in the label even when the text is clamped', () => {
    const badge = resolveBellBadge(0, 42);
    expect(badge.text).toBe('9+');
    expect(badge.labelCount).toBe('42');
  });
});
