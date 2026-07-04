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
  const repoInfo = useSkillkeeperStore((s) => s.repoInfo);
  const syncRepository = useSkillkeeperStore((s) => s.syncRepository);
  const refreshRepoUpdates = useSkillkeeperStore((s) => s.refreshRepoUpdates);
  const refreshRepoInfo = useSkillkeeperStore((s) => s.refreshRepoInfo);
  const reload = useSkillkeeperStore((s) => s.reload);
  const showRepoError = useSkillkeeperStore((s) => s.showRepoError);
  const t = useTranslator();
  const [editing, setEditing] = useState<Repository | null>(null);

  useEffect(() => {
    void refreshRepoUpdates();
    void refreshRepoInfo();
  }, [refreshRepoUpdates, refreshRepoInfo]);

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
              error={repoStatus[r.id]?.error}
              syncLabel={t('repositories.sync')}
              syncingLabel={t('repositories.syncing')}
              editLabel={t('repositories.edit')}
              updateLabel={t('repositories.hasUpdate')}
              errorLabel={t('repositories.viewError')}
              branch={repoInfo[r.id]?.branch}
              skillCountLabel={
                repoInfo[r.id] !== undefined
                  ? t.plural('repositories.skillCount', repoInfo[r.id]!.skillCount)
                  : undefined
              }
              onSync={() => void syncRepository(r.id)}
              onEdit={() => setEditing(r)}
              onErrorClick={() => showRepoError(r.id)}
            />
          ))}
        </div>
      )}
      <RepoEditModal repository={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
