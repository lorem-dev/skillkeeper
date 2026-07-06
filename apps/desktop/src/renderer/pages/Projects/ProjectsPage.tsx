/**
 * Projects page. Lists tracked projects as cards with skill-count badges, an
 * add-via-folder-picker action, and a refresh that re-reads the skill counts.
 */
import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { ProjectCard } from '@/entities/project';
import { ProjectAddButton } from '@/features/projectAdd';
import { ProjectEditModal } from '@/features/projectEdit';
import { OpenProjectButton } from '@/features/projectOpen';
import type { Project } from '@/services/bridge';
import { Page, Toolbar, Button } from '@/shared/ui';
import './ProjectsPage.scss';

export function ProjectsPage() {
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const projectMissing = useSkillkeeperStore((s) => s.projectMissing);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const sweepProjects = useSkillkeeperStore((s) => s.sweepProjects);
  const ensureProjectAvailable = useSkillkeeperStore((s) => s.ensureProjectAvailable);
  const removeProject = useSkillkeeperStore((s) => s.removeProject);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();
  const [editing, setEditing] = useState<Project | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Skill counts are local and cheap -- refresh them on mount.
  useEffect(() => {
    void refreshProjectInfo();
  }, [refreshProjectInfo]);

  // Edit only when the folder still exists; otherwise notify + mark it missing.
  function edit(project: Project): void {
    void ensureProjectAvailable(project.id).then((ok) => {
      if (ok) setEditing(project);
    });
  }

  function copyPath(path: string): void {
    void navigator.clipboard.writeText(path);
    // Store the key (not the resolved text) so the log follows the language.
    notify({ key: 'projects.pathCopied' }, 'info');
  }

  const trailing = (
    <>
      <ProjectAddButton />
      <Button
        variant="secondary"
        loading={refreshing}
        onClick={() => {
          // Run the folder check now (reschedules the loop) plus the info refresh.
          setRefreshing(true);
          void Promise.all([sweepProjects(), refreshProjectInfo()]).finally(() => setRefreshing(false));
        }}
      >
        {t('common.refresh')}
      </Button>
    </>
  );

  return (
    <Page toolbar={<Toolbar title={t('nav.projects')} trailing={trailing} />}>
      {projects.length === 0 ? (
        <p className="sk-empty">{t('projects.empty')}</p>
      ) : (
        <div className="sk-project-list">
          {projects.map((p) => {
            const info = projectInfo[p.id];
            return (
              <ProjectCard
                key={p.id}
                project={p}
                infoPending={info === undefined}
                skillCountLabel={info !== undefined ? t.plural('projects.skillCount', info.skillCount) : undefined}
                fromReposLabel={
                  info !== undefined ? t('projects.fromRepos', { count: String(info.fromReposCount) }) : undefined
                }
                missing={projectMissing[p.id] === true}
                missingLabel={t('projects.missing')}
                pathCopyLabel={t('projects.copyPath')}
                onPathClick={() => copyPath(p.path)}
                editLabel={t('projects.edit')}
                removeLabel={t('projects.remove')}
                openControl={
                  <OpenProjectButton path={p.path} beforeOpen={() => ensureProjectAvailable(p.id)} />
                }
                onEdit={() => edit(p)}
                onRemove={() => void removeProject(p.id)}
              />
            );
          })}
        </div>
      )}
      <ProjectEditModal project={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
