/**
 * Repositories page. Displays all installed repositories with refresh and
 * add options in the toolbar.
 */
import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { RepositoryCard } from '@/entities/repository';
import { RepoAddButton } from '@/features/repoAdd';
import { RepoEditModal } from '@/features/repoEdit';
import type { Repository } from '@/services/bridge';
import { Page, Toolbar, Button } from '@/shared/ui';
import './RepositoriesPage.scss';

export function RepositoriesPage() {
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const repoStatus = useSkillkeeperStore((s) => s.repoStatus);
  const syncRepository = useSkillkeeperStore((s) => s.syncRepository);
  const refreshRepoUpdates = useSkillkeeperStore((s) => s.refreshRepoUpdates);
  const reload = useSkillkeeperStore((s) => s.reload);
  const t = useTranslator();
  const [editing, setEditing] = useState<Repository | null>(null);

  useEffect(() => {
    void refreshRepoUpdates();
  }, [refreshRepoUpdates]);

  const trailing = (
    <>
      <RepoAddButton />
      <Button variant="secondary" onClick={() => void reload()}>{t('common.refresh')}</Button>
    </>
  );

  return (
    <Page toolbar={<Toolbar title={t('nav.repositories')} trailing={trailing} />}>
      {repositories.length === 0 ? (
        <p className="sk-empty">{t('repositories.empty')}</p>
      ) : (
        <div className="sk-repo-list">
          {repositories.map((r) => (
            <RepositoryCard
              key={r.id}
              repository={r}
              phase={repoStatus[r.id]?.phase ?? 'idle'}
              hasUpdate={repoStatus[r.id]?.hasUpdate ?? false}
              syncLabel={t('repositories.sync')}
              editLabel={t('repositories.edit')}
              updateLabel={t('repositories.hasUpdate')}
              onSync={() => void syncRepository(r.id)}
              onEdit={() => setEditing(r)}
            />
          ))}
        </div>
      )}
      <RepoEditModal repository={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
