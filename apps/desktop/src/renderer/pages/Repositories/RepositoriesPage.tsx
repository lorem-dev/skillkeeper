/**
 * Repositories page. Placeholder screen; detailed flows are a follow-up spec.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Page } from '@/shared/ui';

export function RepositoriesPage() {
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const t = useTranslator();

  return (
    <Page title={t('nav.repositories')}>
      {repositories.length === 0 ? (
        <p className="sk-empty">{t('repositories.empty')}</p>
      ) : (
        <ul>
          {repositories.map((r) => (
            <li key={r.id}>{r.name}</li>
          ))}
        </ul>
      )}
    </Page>
  );
}
