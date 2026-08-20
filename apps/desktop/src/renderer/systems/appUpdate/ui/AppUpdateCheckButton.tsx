/**
 * "Check for updates" button: the manual trigger for the self-update check
 * (see `checkAppUpdateNow` in `app/store/store.ts`), reused by both the About
 * dialog and the Settings page's "Application updates" section.
 *
 * Bypasses the automatic 24-hour schedule and gives feedback for every
 * outcome, so a manual check can never be a silent dead end: an offer opens
 * the existing "update available" flow (`noteAppUpdateOffer`, which also
 * closes the About dialog, since the two overlays are mutually exclusive);
 * nothing newer says so via `appUpdate.upToDate`; a failure reports
 * `appUpdate.checkFailed` with the backend's message. The check is also
 * tracked as an `app-update-check` task, so the task list shows how it ended
 * even if this toast is missed.
 *
 * Disabled while the request is outstanding so a second click cannot queue a
 * redundant check before the first has reported anything.
 */
import { useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Button } from '@/shared/ui';
import { badgeState } from '../model';

export interface AppUpdateCheckButtonProps {
  /**
   * When true, also render an "Update now" button next to Check whenever an
   * installable offer is already held (e.g. from an earlier check this
   * session) -- gated exactly like the status-bar badge (`badgeState`), and
   * driving the same "update available" dialog via `openAppUpdateAvailable`
   * rather than reimplementing any part of the download/install flow.
   *
   * Off by default, so the About dialog's usage is unchanged: that surface
   * already loses the offer to the auto-opened dialog in the common case
   * (`noteAppUpdateOffer`), and the status-bar badge is its "Update now" when
   * it does not.
   */
  readonly offerUpdateNow?: boolean;
}

export function AppUpdateCheckButton({ offerUpdateNow = false }: AppUpdateCheckButtonProps = {}) {
  const checkAppUpdateNow = useSkillkeeperStore((s) => s.checkAppUpdateNow);
  const offer = useSkillkeeperStore((s) => s.appUpdate.offer);
  const downloading = useSkillkeeperStore((s) => s.appUpdate.downloading);
  const percent = useSkillkeeperStore((s) => s.appUpdate.percent);
  const openAppUpdateAvailable = useSkillkeeperStore((s) => s.openAppUpdateAvailable);
  const [checking, setChecking] = useState(false);
  const t = useTranslator();

  async function handleClick(): Promise<void> {
    setChecking(true);
    try {
      await checkAppUpdateNow();
    } finally {
      setChecking(false);
    }
  }

  const showUpdateNow = offerUpdateNow && badgeState(offer, downloading, percent).kind === 'available';

  return (
    <>
      <Button variant="secondary" onClick={() => void handleClick()} disabled={checking}>
        {t('appUpdate.checkNow')}
      </Button>
      {showUpdateNow && (
        <Button variant="primary" onClick={openAppUpdateAvailable}>
          {t('appUpdate.updateNow')}
        </Button>
      )}
    </>
  );
}
