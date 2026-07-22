/**
 * Modal scrim shown over the app while the native folder picker (for adding a
 * project) is open. It blocks interaction with the app behind it -- relevant on
 * platforms where the native dialog does not make the app window modal (Windows)
 * -- and clicking the scrim cancels the add. The native dialog itself cannot be
 * closed programmatically, so a scrim click only abandons our side of the pick
 * (its eventual result is dropped); see `pickProjectFolder` in the store.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Modal, Spinner } from '@/shared/ui';

export function FolderPickOverlay() {
  const t = useTranslator();
  const open = useSkillkeeperStore((s) => s.folderPickOpen);
  const cancel = useSkillkeeperStore((s) => s.cancelFolderPick);
  return (
    <Modal open={open} onClose={cancel}>
      <Spinner label={t('projects.selectingFolder')} />
    </Modal>
  );
}
