/**
 * Repositories page. Displays all installed repositories with refresh and
 * add options in the toolbar.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { RepositoryCard } from '@/entities/repository';
import { Page, Toolbar, Button, Tooltip } from '@/shared/ui';
import { formatDate } from '@/domain';
import './RepositoriesPage.scss';

export function RepositoriesPage() {
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const reload = useSkillkeeperStore((s) => s.reload);
  const t = useTranslator();

  const trailing = (
    <>
      <Tooltip content={t('common.comingSoon')}>
        <Button variant="primary" disabled>{t('repositories.add')}</Button>
      </Tooltip>
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
              lfsLabel={t('repositories.lfs')}
              lastFetchedLabel={
                r.lastFetched !== undefined
                  ? t('repositories.lastFetched', { when: formatDate(r.lastFetched) })
                  : t('repositories.neverFetched')
              }
            />
          ))}
        </div>
      )}
    </Page>
  );
}
