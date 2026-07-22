import { useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { deriveRepoName } from '@/entities/repository';
import { Button } from '@/shared/ui';

/**
 * "Add project": opens the native folder picker, then tracks the chosen folder.
 * The initial name is derived from the folder name the same way as repositories
 * (PascalCase split into Title-Cased words).
 *
 * The button shows its pending shimmer (and is non-interactive) while the folder
 * dialog is open and the chosen folder is being added, so a slow pick cannot be
 * double-triggered.
 */
export function ProjectAddButton() {
  const t = useTranslator();
  const addProject = useSkillkeeperStore((s) => s.addProject);
  const pickProjectFolder = useSkillkeeperStore((s) => s.pickProjectFolder);
  const [busy, setBusy] = useState(false);

  async function pick(): Promise<void> {
    setBusy(true);
    try {
      // Shows the modal scrim over the app while the picker is open; a scrim
      // click cancels and resolves to null (see the store).
      const path = await pickProjectFolder();
      if (path === null) return;
      await addProject(path, deriveRepoName(path));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button variant="primary" glass loading={busy} onClick={() => void pick()}>
      {t('projects.add')}
    </Button>
  );
}
