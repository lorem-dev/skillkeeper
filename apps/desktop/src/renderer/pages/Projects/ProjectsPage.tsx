/**
 * Projects page. Lists tracked projects as cards with skill-count badges, an
 * add-via-folder-picker action, and a refresh that re-reads the skill counts.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { ProjectCard } from '@/entities/project';
import { ProjectAddButton } from '@/features/projectAdd';
import { ProjectEditModal } from '@/features/projectEdit';
import { OpenProjectButton } from '@/features/projectOpen';
import type { Project } from '@/services/bridge';
import { Page, Toolbar, Button, SearchField, SearchSummary } from '@/shared/ui';
import { fuzzyFilter, fadeRise, fade } from '@/shared/lib';
import './ProjectsPage.scss';

export function ProjectsPage() {
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const projectMissing = useSkillkeeperStore((s) => s.projectMissing);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const sweepProjects = useSkillkeeperStore((s) => s.sweepProjects);
  const ensureProjectAvailable = useSkillkeeperStore((s) => s.ensureProjectAvailable);
  const removeProject = useSkillkeeperStore((s) => s.removeProject);
  const goToSkills = useSkillkeeperStore((s) => s.goToSkills);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();
  const [editing, setEditing] = useState<Project | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');

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

  // Fuzzy search by name and path. The field only appears once there are at
  // least two cards to sift through.
  const searching = query.trim() !== '';
  const filtered = fuzzyFilter(projects, query, (p) => [p.name, p.path]);

  const trailing = (
    <>
      {projects.length >= 2 && (
        <SearchField
          className="sk-list-search"
          placeholder={t('common.search')}
          aria-label={t('common.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
      )}
      <ProjectAddButton />
      <Button
        variant="secondary"
        glass
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
        <>
        <div className="sk-project-list">
          <AnimatePresence mode="popLayout" initial={false}>
            {filtered.map((p) => {
              const info = projectInfo[p.id];
              return (
                <motion.div
                  key={p.id}
                  layout
                  variants={fadeRise}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                >
                  <ProjectCard
                    project={p}
                    iconUrl={info?.iconDataUrl}
                    infoPending={info === undefined}
                    skillCountLabel={
                      info !== undefined ? t.plural('projects.skillCount', info.skillCount) : undefined
                    }
                    fromReposLabel={
                      info !== undefined
                        ? t('projects.fromRepos', { count: String(info.fromReposCount) })
                        : undefined
                    }
                    agentsLabel={
                      info !== undefined && info.agentCount > 0
                        ? t.plural('projects.agentCount', info.agentCount)
                        : undefined
                    }
                    missing={projectMissing[p.id] === true}
                    missingLabel={t('projects.missing')}
                    pathCopyLabel={t('projects.copyPath')}
                    onPathClick={() => copyPath(p.path)}
                    editLabel={t('projects.edit')}
                    skillsLabel={t('common.goToSkills')}
                    onGoToSkills={() =>
                      goToSkills({ mode: 'projects', projectFilter: [p.id], repoFilter: [], query: '' })
                    }
                    removeLabel={t('projects.remove')}
                    openControl={
                      <OpenProjectButton path={p.path} beforeOpen={() => ensureProjectAvailable(p.id)} />
                    }
                    onEdit={() => edit(p)}
                    onRemove={() => void removeProject(p.id)}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
        <AnimatePresence>
          {searching && (
            <motion.div
              key="footer"
              className="sk-list-footer"
              variants={fade}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              <SearchSummary
                foundLabel={t.plural('projects.searchFound', filtered.length)}
                totalLabel={t.plural('projects.searchTotal', projects.length)}
                showAllLabel={t('projects.showAll')}
                onShowAll={() => setQuery('')}
              />
            </motion.div>
          )}
        </AnimatePresence>
        </>
      )}
      <ProjectEditModal project={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
