/**
 * Projects page. Lists tracked projects as cards with skill-count badges, an
 * add-via-folder-picker action, and a refresh that re-reads the skill counts.
 */
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { ProjectCard } from '@/entities/project';
import { ProjectAddButton } from '@/features/projectAdd';
import { ProjectEditModal } from '@/features/projectEdit';
import { OpenProjectButton } from '@/features/projectOpen';
import type { Project } from '@/services/bridge';
import { Page, Toolbar, Button, ExpandingSearch, SearchSummary, Tooltip, Icon } from '@/shared/ui';
import { fuzzyFilter, fade, useAnimationsEnabled, useMotion } from '@/shared/lib';
import './ProjectsPage.scss';

/** Minimum time the Refresh button stays in its loading state, so a refresh
 *  that finishes quickly still reads as a deliberate action, not a flicker. */
const REFRESH_MIN_MS = 1000;

export function ProjectsPage() {
  const animate = useAnimationsEnabled();
  const { cardStagger } = useMotion();
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const projectMissing = useSkillkeeperStore((s) => s.projectMissing);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const refreshProjects = useSkillkeeperStore((s) => s.refreshProjects);
  const ensureProjectAvailable = useSkillkeeperStore((s) => s.ensureProjectAvailable);
  const removeProject = useSkillkeeperStore((s) => s.removeProject);
  const goToSkills = useSkillkeeperStore((s) => s.goToSkills);
  const goToMcpProject = useSkillkeeperStore((s) => s.goToMcpProject);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
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
  const filtered = useMemo(
    () => fuzzyFilter(projects, query, (p) => [p.name, p.path]),
    [projects, query],
  );

  // Count of MCP servers installed from repositories, per project id. A
  // repo-origin install carries a `remote` on its identity (manual installs
  // carry `local` instead); distinct instances are keyed by (remote,
  // instanceName) so the same instance across several agents counts once.
  const mcpFromReposByProject = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const inst of mcpInstalls) {
      if (inst.identity.remote === undefined) continue;
      const set = map.get(inst.projectId) ?? new Set<string>();
      set.add(`${inst.identity.remote}|${inst.instanceName}`);
      map.set(inst.projectId, set);
    }
    return map;
  }, [mcpInstalls]);

  const trailing = (
    <>
      {projects.length >= 2 && (
        <ExpandingSearch
          glass
          label={t('common.search')}
          placeholder={t('common.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
      )}
      <Tooltip content={t('common.refresh')}>
        <Button
          variant="secondary"
          glass
          aria-label={t('common.refresh')}
          className="sk-refresh-btn"
          loading={refreshing}
          onClick={() => {
            // Run the folder sweep + skill-count refresh as a tracked task,
            // holding the button's loading state for at least REFRESH_MIN_MS so
            // a fast refresh does not just flash.
            setRefreshing(true);
            const minDelay = new Promise((resolve) => setTimeout(resolve, REFRESH_MIN_MS));
            void Promise.all([refreshProjects(), minDelay]).finally(() => setRefreshing(false));
          }}
        >
          <Icon name="sync" size={16} />
        </Button>
      </Tooltip>
    </>
  );

  return (
    <Page
      toolbar={<Toolbar title={t('nav.projects')} trailing={trailing} />}
      dock={<ProjectAddButton />}
    >
      {projects.length === 0 ? (
        <p className="sk-empty">{t('projects.empty')}</p>
      ) : (
        <>
        <div className="sk-project-list">
          <AnimatePresence mode="popLayout" initial={animate}>
            {filtered.map((p, i) => {
              const info = projectInfo[p.id];
              const mcpCount = mcpFromReposByProject.get(p.id)?.size ?? 0;
              return (
                <motion.div
                  key={p.id}
                  layout
                  custom={i}
                  variants={cardStagger}
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
                    skillCountHint={
                      info !== undefined ? t.plural('projects.skillCountHint', info.skillCount) : undefined
                    }
                    fromReposLabel={
                      info !== undefined && info.fromReposCount > 0
                        ? t.plural('projects.skillCount', info.fromReposCount)
                        : undefined
                    }
                    fromReposHint={
                      info !== undefined && info.fromReposCount > 0
                        ? t.plural('projects.fromReposHint', info.fromReposCount)
                        : undefined
                    }
                    mcpCountLabel={
                      mcpCount > 0 ? t('projects.mcpCount', { count: String(mcpCount) }) : undefined
                    }
                    mcpCountHint={mcpCount > 0 ? t.plural('projects.mcpHint', mcpCount) : undefined}
                    agentsLabel={
                      info !== undefined && info.agentCount > 0
                        ? t.plural('projects.agentCount', info.agentCount)
                        : undefined
                    }
                    agentsHint={
                      info !== undefined && info.agentCount > 0
                        ? t.plural('projects.agentsHint', info.agentCount)
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
                    mcpLabel={t('common.goToMcp')}
                    onGoToMcp={() => goToMcpProject(p.id)}
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
