/**
 * Projects page. Placeholder screen; detailed flows are a follow-up spec.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Page } from '@/shared/ui';

export function ProjectsPage() {
  const projects = useSkillkeeperStore((s) => s.projects);
  const t = useTranslator();

  return (
    <Page title={t('nav.projects')}>
      {projects.length === 0 ? (
        <p className="sk-empty">{t('projects.empty')}</p>
      ) : (
        <ul>
          {projects.map((p) => (
            <li key={p.id}>{p.name}</li>
          ))}
        </ul>
      )}
    </Page>
  );
}
