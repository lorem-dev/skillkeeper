import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import { deriveRepoName } from '@/entities/repository';
import { Button } from '@/shared/ui';

/**
 * "Add project": opens the native folder picker, then tracks the chosen folder.
 * The initial name is derived from the folder name the same way as repositories
 * (PascalCase split into Title-Cased words).
 */
export function ProjectAddButton() {
  const t = useTranslator();
  const addProject = useSkillkeeperStore((s) => s.addProject);

  async function pick(): Promise<void> {
    const path = await bridgeClient.selectFolder();
    if (path === null) return;
    await addProject(path, deriveRepoName(path));
  }

  return (
    <Button variant="primary" glass onClick={() => void pick()}>
      {t('projects.add')}
    </Button>
  );
}
