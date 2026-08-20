/**
 * Drives the self-update check: once the initial load settles, and again on a
 * fixed 24-hour interval. The backend owns whether a real check is actually
 * due, and its own rate-limit protection around that (see the Rust
 * `AppUpdateSession`) -- this hook is deliberately dumb: it asks every time,
 * on this fixed cadence, and never reads or reasons about a timestamp itself.
 * See `checkNow`/`midDecision` below for the one exception: it skips a check
 * outright while the user is mid-decision on a previous one.
 *
 * Also subscribes to the download progress/ready/failed events. Progress
 * feeds the status-bar badge (`setAppUpdateProgress`); ready opens the
 * "update ready" dialog (which also closes the "update available" one --
 * see `openAppUpdateReady`); a failure raises an error notification keyed by
 * which phase failed (`appUpdate.downloadFailed` vs `appUpdate.installFailed`)
 * and resets the badge to idle so it does not get stuck showing a stale
 * percentage forever.
 *
 * An install failure additionally needs the ready dialog to be showing the
 * manual fallback, but which store action gets it there depends on whether
 * the dialog is already open: a same-session failure leaves it open on its
 * own (see `installAppUpdate`'s doc comment in client.ts), so that case just
 * flips `appUpdateInstallFailed`. A failure discovered on a FRESH launch --
 * the install ran, and failed, inside a helper script after the previous
 * process had already exited -- never opened the dialog in this session at
 * all, so the backend attaches `path`/`offer` to the event for exactly that
 * case, and this reopens it via `notePendingInstallFailure` instead of
 * leaving the toast as a dead end.
 */
import { useEffect, useRef } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { bridgeClient } from '@/services/bridge';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Run the scheduled/startup check via the store, which tracks it as an
 * `app-update-check` task and enforces the mid-decision invariant: a
 * scheduled check must never disturb a user who is mid-decision (either
 * update dialog open, or a download in flight) -- see `runAppUpdateCheck`'s
 * doc comment in store.ts. This must never be "resolved" by closing a dialog
 * or by discarding an in-flight/downloaded update on a timer: silently
 * clobbering release notes the user is reading, or deleting a verified
 * installer they were about to run, is worse than deferring the check by up
 * to 24 hours.
 */
function checkNow(): void {
  void useSkillkeeperStore.getState().runAppUpdateCheck();
}

export function useAppUpdateSchedule(): void {
  const loading = useSkillkeeperStore((s) => s.loading);
  const startupDone = useRef(false);

  // One-time check once the initial load has finished.
  useEffect(() => {
    if (loading || startupDone.current) return;
    startupDone.current = true;
    checkNow();
  }, [loading]);

  // Recurring check, unconditionally, every 24 hours.
  useEffect(() => {
    const id = setInterval(checkNow, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(
    () =>
      bridgeClient.onAppUpdateProgress(({ percent }) => {
        useSkillkeeperStore.getState().setAppUpdateProgress(percent);
      }),
    [],
  );

  useEffect(
    () =>
      bridgeClient.onAppUpdateReady(({ path }) => {
        // `openAppUpdateReady` itself closes the "update available" dialog
        // (the two are mutually exclusive; see store.ts), so nothing further
        // is needed here. `version` is not read from the payload: the offer
        // already held by the store is the single source for that (see
        // store.ts's `appUpdate` doc comment); only `path` is new information.
        useSkillkeeperStore.getState().openAppUpdateReady(path);
      }),
    [],
  );

  useEffect(
    () =>
      bridgeClient.onAppUpdateFailed(({ message, phase, path, offer, installReady }) => {
        const store = useSkillkeeperStore.getState();
        const key = phase === 'install' ? 'appUpdate.installFailed' : 'appUpdate.downloadFailed';
        store.notify({ key, vars: { message } }, 'error');
        store.resetAppUpdate();
        if (phase !== 'install') return;
        if (path !== undefined) {
          // A marker-based failure discovered on a fresh launch: the ready
          // dialog never opened this session, so reopen it with the
          // preserved artifact's path rather than leaving the toast above as
          // a dead end. `installReady` says whether that artifact re-verified
          // -- a corrupt or superseded one must not offer a working-looking
          // "Install now".
          store.notePendingInstallFailure(path, offer ?? null, installReady);
        } else {
          // Same-session failure: the ready dialog is already open (nothing
          // closes it on an install failure -- see `installAppUpdate`'s doc
          // comment in client.ts); just flip the flag so it shows the
          // fallback alongside the toast above.
          store.setAppUpdateInstallFailed(true);
        }
      }),
    [],
  );
}
