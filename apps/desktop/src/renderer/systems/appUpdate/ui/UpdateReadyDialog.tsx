/**
 * "Update ready to install" dialog: the downloaded and verified artifact is
 * on disk, waiting for the user to install it. Opened by
 * `useAppUpdateSchedule`'s `onAppUpdateReady` handler.
 *
 * Closing this dialog by ANY route -- the Cancel button, Escape, or a scrim
 * click -- discards the downloaded artifact: all three are wired to the same
 * handler, so there is no path that leaves a downloaded file on disk with no
 * dialog offering to install it. "Install now" closes SkillKeeper and starts
 * the installer (see `appUpdate.readyHint`) on success, so no further store
 * update is needed here for that path.
 *
 * On an install FAILURE the app does not quit, and nothing closes this
 * dialog either (see `installAppUpdate`'s doc comment in client.ts) -- it
 * stays open with the same "Install now"/Cancel choice. That is deliberately
 * where the manual fallback lives too, rather than in a separate dialog:
 * this is the exact moment and place the user is already looking, mid
 * decision on the same artifact, so a second window would only add a click.
 * `appUpdateInstallFailed` (set by `useAppUpdateSchedule` on an
 * `appUpdate:failed` event with `phase: "install"`) gates it. The fallback
 * command is macOS-specific (clearing the quarantine attribute Gatekeeper
 * sets on a downloaded app, which is the known cause of macOS refusing the
 * copy into place), so it is also gated on `platform` (see
 * {@link UpdateReadyDialogProps.platform}).
 *
 * `appUpdateReadyCanInstall` additionally governs which primary button shows.
 * It is only ever false after `notePendingInstallFailure`: a marker-based
 * install failure discovered on a fresh launch, whose preserved artifact
 * could not be re-verified (missing, corrupt, or superseded by a newer
 * offer). "Install now" would just fail again in that case, so a "Download
 * again" button takes its place instead -- the fallback command above (when
 * shown) is unaffected either way, since it names no downloaded file.
 */
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Modal, Button, Icon } from '@/shared/ui';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import './UpdateAvailableDialog.scss';

/** Not translated: a literal shell command is not language-dependent, and a
 *  mistranslated flag or path would be worse than an English-only line. */
const MACOS_QUARANTINE_FALLBACK_COMMAND = 'xattr -dr com.apple.quarantine /Applications/SkillKeeper.app';

export interface UpdateReadyDialogProps {
  /** The host platform, injected so the macOS-only fallback branch is
   *  testable and has a Storybook story: `bridgeClient.platform` is a real
   *  Tauri singleton that reads as `''` at story time (only `init()`, never
   *  called in Storybook, populates it), and mutating that shared singleton
   *  from a story would leak into every other story reading `.platform` in
   *  the same session. Defaults to the singleton for real application use. */
  platform?: string;
}

export function UpdateReadyDialog({ platform = bridgeClient.platform }: UpdateReadyDialogProps = {}) {
  const open = useSkillkeeperStore((s) => s.appUpdateReadyOpen);
  const offer = useSkillkeeperStore((s) => s.appUpdate.offer);
  const path = useSkillkeeperStore((s) => s.appUpdateReadyPath);
  const installFailed = useSkillkeeperStore((s) => s.appUpdateInstallFailed);
  const canInstall = useSkillkeeperStore((s) => s.appUpdateReadyCanInstall);
  const closeAppUpdateReady = useSkillkeeperStore((s) => s.closeAppUpdateReady);
  const startAppUpdateDownload = useSkillkeeperStore((s) => s.startAppUpdateDownload);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  const version = offer?.version ?? '';
  const showMacFallback = installFailed && platform === 'darwin';

  function handleCancel(): void {
    void bridgeClient.discardAppUpdate();
    closeAppUpdateReady();
  }

  function handleInstallNow(): void {
    void bridgeClient.installAppUpdate();
  }

  function handleDownloadAgain(): void {
    startAppUpdateDownload();
    void bridgeClient.downloadAppUpdate();
    closeAppUpdateReady();
  }

  // Awaits the write before claiming success, unlike the fire-and-forget copies
  // elsewhere in the app. This is the one command a user reaches for BECAUSE
  // their install already failed: telling them it is on the clipboard when it
  // is not leaves them pasting nothing with no idea why.
  async function handleCopyCommand(): Promise<void> {
    try {
      await writeText(MACOS_QUARANTINE_FALLBACK_COMMAND);
      notify({ key: 'appUpdate.commandCopied' }, 'info');
    } catch {
      notify({ key: 'appUpdate.commandCopyFailed' }, 'error');
    }
  }

  return (
    <Modal open={open} onClose={handleCancel} title={t('appUpdate.readyTitle')} className="sk-update-ready">
      <p className="sk-update-body">{t('appUpdate.readyBody', { version })}</p>
      {path !== null && <p className="sk-update-path">{t('appUpdate.readyPath', { path })}</p>}
      <p className="sk-update-hint">{t('appUpdate.readyHint')}</p>
      {showMacFallback && (
        <div className="sk-update-fallback">
          <p className="sk-update-hint">{t('appUpdate.installFailedFallbackHint', { action: t('appUpdate.installNow') })}</p>
          <div className="sk-update-fallback-command-row">
            <pre className="sk-update-fallback-command">{MACOS_QUARANTINE_FALLBACK_COMMAND}</pre>
            <Button
              variant="secondary"
              className="sk-update-fallback-copy"
              onClick={() => void handleCopyCommand()}
              aria-label={t('appUpdate.copyCommand')}
              title={t('appUpdate.copyCommand')}
            >
              <Icon name="copy" size={16} />
            </Button>
          </div>
        </div>
      )}
      <div className="sk-update-actions">
        <Button variant="secondary" onClick={handleCancel}>
          {t('appUpdate.cancel')}
        </Button>
        {canInstall ? (
          <Button variant="primary" onClick={handleInstallNow}>
            {t('appUpdate.installNow')}
          </Button>
        ) : (
          <Button variant="primary" onClick={handleDownloadAgain}>
            {t('appUpdate.downloadAgain')}
          </Button>
        )}
      </div>
    </Modal>
  );
}
