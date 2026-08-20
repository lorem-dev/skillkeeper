import { describe, expect, it } from 'vitest';
import { badgeState, notesWithFooter, midDecision } from './model';
import type { MidDecisionState } from './model';

const offer = {
  version: '0.6.0',
  bump: 'Minor',
  notes: 'x',
  truncatedHistory: false,
  installable: true,
  showDialog: true,
};

describe('badgeState', () => {
  it('hides itself when there is no offer', () => {
    expect(badgeState(null, false, 0)).toEqual({ kind: 'hidden' });
  });

  it('offers the version when idle', () => {
    expect(badgeState(offer, false, 0)).toEqual({ kind: 'available', version: '0.6.0' });
  });

  it('shows progress while downloading, outranking the version', () => {
    expect(badgeState(offer, true, 42)).toEqual({ kind: 'downloading', percent: 42 });
  });

  it('clamps a percentage outside 0..100', () => {
    expect(badgeState(offer, true, -5)).toEqual({ kind: 'downloading', percent: 0 });
    expect(badgeState(offer, true, 250)).toEqual({ kind: 'downloading', percent: 100 });
  });

  it('rounds a fractional percentage', () => {
    expect(badgeState(offer, true, 41.6)).toEqual({ kind: 'downloading', percent: 42 });
  });

  it('stays hidden where the host has no installable artifact', () => {
    expect(badgeState({ ...offer, installable: false }, false, 0)).toEqual({ kind: 'hidden' });
  });
});

describe('notesWithFooter', () => {
  it('leaves complete notes alone', () => {
    expect(notesWithFooter('a', false, 'See all')).toBe('a');
  });

  it('appends the footer when history is incomplete', () => {
    const out = notesWithFooter('a', true, 'See all releases');
    expect(out.startsWith('a')).toBe(true);
    expect(out).toContain('See all releases');
  });

  it('does not append a footer to empty notes', () => {
    expect(notesWithFooter('   ', true, 'See all')).toBe('');
  });
});

describe('midDecision', () => {
  const idle: MidDecisionState = {
    appUpdateAvailableOpen: false,
    appUpdateReadyOpen: false,
    appUpdate: { downloading: false },
  };

  it('is false when nothing is happening', () => {
    expect(midDecision(idle)).toBe(false);
  });

  it('is true while the available dialog is open', () => {
    expect(midDecision({ ...idle, appUpdateAvailableOpen: true })).toBe(true);
  });

  it('is true while the ready dialog is open', () => {
    expect(midDecision({ ...idle, appUpdateReadyOpen: true })).toBe(true);
  });

  // The case B5 fixes: "Update now" closes the available dialog before the
  // first progress event would otherwise flip `downloading`, so a check in
  // that exact window must still see the in-flight download -- through this
  // condition alone, with both dialogs already closed.
  it('is true while a download is in flight, even with both dialogs closed', () => {
    expect(midDecision({ ...idle, appUpdate: { downloading: true } })).toBe(true);
  });
});
