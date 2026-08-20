/**
 * Pure self-update logic: what the status-bar badge should show, and how the
 * release notes are presented when GitHub truncated the comparison history.
 *
 * Kept as pure functions so the precedence/clamping rules are unit-testable:
 * renderer tests are node-only and never render React, so logic left inside
 * the badge/dialog components would be covered by nothing.
 */
import type { AppUpdateOffer } from '@/services/bridge';

/** What the status-bar update badge should show. */
export type UpdateBadgeState =
  | { kind: 'hidden' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; percent: number };

/**
 * Resolve the badge from the held offer and the current download state.
 *
 * Hidden when there is no offer, or when the release built nothing installable
 * for this host (`installable`) -- a badge the user cannot act on is noise, not
 * information. Downloading outranks the plain "available" state so progress is
 * never hidden behind a stale version number. `percent` is clamped to 0..100
 * and rounded to the nearest whole number, since the backend's progress event
 * is a `u8` but a caller here could pass anything.
 */
export function badgeState(
  offer: AppUpdateOffer | null,
  downloading: boolean,
  percent: number,
): UpdateBadgeState {
  if (offer === null || !offer.installable) return { kind: 'hidden' };
  if (downloading) {
    const clamped = Math.min(100, Math.max(0, percent));
    return { kind: 'downloading', percent: Math.round(clamped) };
  }
  return { kind: 'available', version: offer.version };
}

/**
 * Append `footer` to `notes` when the release history was truncated, so the
 * dialog can point the user at the full comparison on GitHub instead of
 * silently showing a partial changelog. Never appends to empty notes -- there
 * is nothing to point a footer at.
 */
export function notesWithFooter(notes: string, truncated: boolean, footer: string): string {
  if (notes.trim() === '') return '';
  if (!truncated) return notes;
  return `${notes}\n\n${footer}`;
}

/** The store slices `midDecision` reads -- kept minimal (rather than the
 *  full store state) so a test can pass a plain object instead of a real
 *  store snapshot. */
export interface MidDecisionState {
  appUpdateAvailableOpen: boolean;
  appUpdateReadyOpen: boolean;
  appUpdate: { downloading: boolean };
}

/**
 * True while the user is mid-decision on the self-update flow: either dialog
 * open, or a download already in flight. A pure predicate over store state
 * (rather than reading `useSkillkeeperStore.getState()` itself) so it is
 * node-testable without a real store -- renderer tests never render React,
 * so logic that stayed inside the hook would be covered by nothing.
 *
 * The download-in-flight case matters on its own: "Update now" closes the
 * available dialog before the backend's first progress event flips
 * `downloading` true, so a check landing in that exact window would see both
 * dialogs closed and, without this third condition, wrongly conclude nothing
 * was in progress.
 */
export function midDecision(state: MidDecisionState): boolean {
  return state.appUpdateAvailableOpen || state.appUpdateReadyOpen || state.appUpdate.downloading;
}
