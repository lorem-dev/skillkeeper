/**
 * "Update available" dialog: offers the newly detected version for download,
 * with its release notes. Opened by the store when a check's offer says to
 * (`noteAppUpdateOffer` -> `openAppUpdateAvailable`, see store.ts).
 *
 * "Update now" starts the download in the background; the badge takes over
 * showing its progress, so the dialog closes rather than sitting open beside
 * an already-actioned button. "Cancel" -- and Escape/a scrim click, wired to
 * the same handler as `Modal`'s `onClose` -- dismisses this version so it is
 * not offered again on the next check.
 *
 * `handleUpdateNow` marks the download as started (`startAppUpdateDownload`)
 * synchronously, before the dialog even closes -- not waiting for the
 * backend's first progress event. Without that, there is a window after the
 * dialog closes where a download is in flight but nothing reflects it yet, so
 * a scheduled check landing in that window would not see it and could
 * clobber the in-flight state.
 */
import { Modal, Button } from '@/shared/ui';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import { notesWithFooter } from '../model';
import './UpdateAvailableDialog.scss';

export function UpdateAvailableDialog() {
  const open = useSkillkeeperStore((s) => s.appUpdateAvailableOpen);
  const offer = useSkillkeeperStore((s) => s.appUpdate.offer);
  const closeAppUpdateAvailable = useSkillkeeperStore((s) => s.closeAppUpdateAvailable);
  const startAppUpdateDownload = useSkillkeeperStore((s) => s.startAppUpdateDownload);
  const t = useTranslator();

  const version = offer?.version ?? '';
  const notes = notesWithFooter(offer?.notes ?? '', offer?.truncatedHistory ?? false, t('appUpdate.notesFooter'));

  function handleCancel(): void {
    void bridgeClient.dismissAppUpdate(version);
    closeAppUpdateAvailable();
  }

  function handleUpdateNow(): void {
    startAppUpdateDownload();
    void bridgeClient.downloadAppUpdate();
    closeAppUpdateAvailable();
  }

  return (
    <Modal open={open} onClose={handleCancel} title={t('appUpdate.availableTitle')} className="sk-update-available">
      <p className="sk-update-body">{t('appUpdate.availableBody', { version })}</p>
      {notes !== '' && <pre className="sk-update-notes">{notes}</pre>}
      <div className="sk-update-actions">
        <Button variant="secondary" onClick={handleCancel}>
          {t('appUpdate.cancel')}
        </Button>
        <Button variant="primary" onClick={handleUpdateNow}>
          {t('appUpdate.updateNow')}
        </Button>
      </div>
    </Modal>
  );
}
