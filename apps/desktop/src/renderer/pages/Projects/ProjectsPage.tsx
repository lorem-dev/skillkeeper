/**
 * Projects page. Displays all projects with refresh and add options in
 * the toolbar.
 */
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { ProjectRow } from '@/entities/project';
import { Page, Toolbar, Button, Tooltip, List } from '@/shared/ui';
import { formatDate } from '@/domain';

export function ProjectsPage() {
  const projects = useSkillkeeperStore((s) => s.projects);
  const reload = useSkillkeeperStore((s) => s.reload);
  const t = useTranslator();

  const trailing = (
    <>
      <Tooltip content={t('common.comingSoon')}>
        <Button variant="primary" disabled>{t('projects.add')}</Button>
      </Tooltip>
      <Button variant="secondary" onClick={() => void reload()}>{t('common.refresh')}</Button>
    </>
  );

  return (
    <Page title={t('nav.projects')}>
      <Toolbar trailing={trailing} />
      {projects.length === 0 ? (
        <p className="sk-empty">{t('projects.empty')}</p>
      ) : (
        <List>
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              addedLabel={t('projects.addedAt', { when: formatDate(p.addedAt) })}
            />
          ))}
        </List>
      )}
    </Page>
  );
}
