/**
 * Skills page. Two modes chosen by a Select:
 *   - Repositories: a tree of repo -> (group ->) skills; check skills to add.
 *   - Projects: a tree of project -> ("repo / group" ->) skills, pre-checked
 *     where installed, with a per-skill install-status badge; save applies the
 *     diff.
 * A search box fuzzy-filters the whole tree (matches keep their ancestors as
 * context); a footer summarizes the result and clears the search.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { SkillsMode } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import {
  Page,
  Toolbar,
  Button,
  SearchField,
  Select,
  MultiCombobox,
  SearchSummary,
  TreeView,
  ChangeBadge,
  Badge,
  Tooltip,
  Icon,
} from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { AgentSelect } from '@/entities/agent';
import { ProjectIcon } from '@/entities/project';
import {
  buildRepoTree,
  buildProjectModel,
  installedLeafIds,
  installedAgentsByProject,
  filterTree,
  collectBranchIds,
  rootIds,
  countLeaves,
} from '@/entities/skill';
import { SkillInstallModal } from '@/features/skillInstall';
import { SkillSaveModal } from '@/features/skillSave';
import './SkillsPage.scss';

type Mode = SkillsMode;

/** Whether two agent lists hold the same set. */
function sameAgents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function SkillsPage() {
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const installs = useSkillkeeperStore((s) => s.skills);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const t = useTranslator();

  // Project icons are resolved into projectInfo by the main process; refresh it on
  // mount so the project nodes in the tree can show them (the Projects page does
  // the same). Cheap and idempotent.
  useEffect(() => {
    void refreshProjectInfo();
  }, [refreshProjectInfo]);

  // Selection + view state lives in the store so it survives navigating away and
  // back (until the app reloads). The store reseeds the selection to the
  // installed baseline on load and after a successful apply (see `setSkills`).
  const skillsUi = useSkillkeeperStore((s) => s.skillsUi);
  const setSkillsUi = useSkillkeeperStore((s) => s.setSkillsUi);
  const resetSkillsSelection = useSkillkeeperStore((s) => s.resetSkillsSelection);
  const updateProjectSkills = useSkillkeeperStore((s) => s.updateProjectSkills);
  const requestAddRepository = useSkillkeeperStore((s) => s.requestAddRepository);
  const tasks = useSkillkeeperStore((s) => s.tasks);
  const { mode, query, repoFilter, projectFilter, repoChecked, projectChecked, projectAgents } =
    skillsUi;

  // Modal open flags are ephemeral -- they should not persist across navigation.
  const [installOpen, setInstallOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  // Thin setters that merge one selection field into the store at a time.
  const setQuery = (value: string): void => setSkillsUi({ query: value });
  const setRepoFilter = (value: string[]): void => setSkillsUi({ repoFilter: value });
  const setProjectFilter = (value: string[]): void => setSkillsUi({ projectFilter: value });
  const setRepoChecked = (ids: string[]): void => setSkillsUi({ repoChecked: ids });
  const setProjectChecked = (ids: string[]): void => setSkillsUi({ projectChecked: ids });

  // The installed skills are the baseline the project-mode selection diffs
  // against (pre-checked leaves + each project's installed agents).
  const installedSet = useMemo(() => new Set(installedLeafIds(installs)), [installs]);
  const installedAgents = useMemo(() => installedAgentsByProject(installs), [installs]);

  // The filters narrow which repos/projects appear (empty = all).
  const shownRepos = useMemo(
    () =>
      repoFilter.length === 0
        ? repositories
        : repositories.filter((r) => repoFilter.includes(r.id)),
    [repositories, repoFilter],
  );
  const shownProjects = useMemo(
    () =>
      projectFilter.length === 0 ? projects : projects.filter((p) => projectFilter.includes(p.id)),
    [projects, projectFilter],
  );

  // Project mode: merge available skills with what is installed, so orphaned
  // installs appear (grey, remove-only) and update dots can be attached.
  const projectModel = useMemo(
    () =>
      mode === 'projects'
        ? buildProjectModel(availableSkills, shownRepos, repositories, shownProjects, installs)
        : null,
    [mode, availableSkills, shownRepos, repositories, shownProjects, installs],
  );

  const baseTree = useMemo(
    () =>
      mode === 'repositories'
        ? buildRepoTree(availableSkills, shownRepos)
        : (projectModel?.nodes ?? []),
    [mode, availableSkills, shownRepos, projectModel],
  );

  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // An update-skill task in flight makes every dot pulse and non-clickable.
  const updatesBusy = useMemo(
    () => tasks.some((t) => t.kind === 'update-skill' && (t.status === 'queued' || t.status === 'running')),
    [tasks],
  );

  // Project mode: tag each visible skill leaf with its install-status badge,
  // attach update dots (leaf/group/repo) from the model, and give each project
  // root an agent picker (with an "agents changed" marker).
  const decorated = useMemo(() => {
    if (mode !== 'projects' || projectModel === null) return shownTree;
    const checkedSet = new Set(projectChecked);
    const { updatesByNode, orphanLeaves } = projectModel;
    // A node's label: name, then a non-interactive update dot when an update is
    // available, then a single action/status badge. The update action badge shows
    // only while the row is hovered; the unlinked/local status badges are always
    // visible. `updateTooltip` names the update scope (skill / group / repository).
    const buildLabel = (node: TreeNode, updateTooltip: string): ReactNode => {
      const ups = updatesByNode.get(node.id);
      const orphan = orphanLeaves.get(node.id);
      let badge: ReactNode = null;
      // `hoverOnly`: the action badge (update) shows only on row hover; status
      // badges (unlinked / local) are always visible.
      let hoverOnly = false;
      if (ups !== undefined) {
        hoverOnly = true;
        badge = (
          <Tooltip content={updateTooltip}>
            <button
              type="button"
              className="sk-skills-badge-btn"
              disabled={updatesBusy}
              onClick={() => {
                if (!updatesBusy) updateProjectSkills(ups);
              }}
            >
              <Badge tone="accent">{t('skills.updateBadge')}</Badge>
            </button>
          </Tooltip>
        );
      } else if (orphan?.kind === 'unlinked') {
        badge = (
          <Tooltip content={t('skills.addRepo')}>
            <button
              type="button"
              className="sk-skills-badge-btn"
              onClick={() => requestAddRepository(orphan.remote)}
            >
              <Badge tone="warning">{t('skills.unlinked')}</Badge>
            </button>
          </Tooltip>
        );
      } else if (orphan?.kind === 'local') {
        badge = (
          <Tooltip content={t('skills.localHint')}>
            <Badge tone="neutral">{t('skills.local')}</Badge>
          </Tooltip>
        );
      }
      if (ups === undefined && badge === null) return node.label;
      return (
        <span className="sk-skills-nodelabel">
          <span className="sk-skills-name">{node.label}</span>
          {ups !== undefined && (
            <span
              className={`sk-skills-dot${updatesBusy ? ' sk-skills-dot--pulse' : ''}`}
              aria-hidden="true"
            />
          )}
          {badge !== null && (
            // Badges own their commands; swallow the click so it never reaches the
            // TreeView row (no accidental select/checkbox toggle).
            <span
              className={`sk-skills-badgewrap${hoverOnly ? ' sk-skills-badge--hover' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              {badge}
            </span>
          )}
        </span>
      );
    };
    // Below a repo node: group branches vs skill leaves.
    const decorate = (node: TreeNode): TreeNode => {
      if (node.children !== undefined && node.children.length > 0) {
        return {
          ...node,
          label: buildLabel(node, t('skills.updateGroup')),
          children: node.children.map(decorate),
        };
      }
      const wasInstalled = installedSet.has(node.id);
      const isChecked = checkedSet.has(node.id);
      let detail: ReactNode;
      if (wasInstalled && isChecked)
        detail = <ChangeBadge kind="present" label={t('skills.status.present')} />;
      else if (wasInstalled && !isChecked)
        detail = <ChangeBadge kind="remove" label={t('skills.status.remove')} />;
      else if (!wasInstalled && isChecked)
        detail = <ChangeBadge kind="add" label={t('skills.status.add')} />;
      else detail = undefined;
      return { ...node, label: buildLabel(node, t('skills.updateSkill')), detail };
    };
    return shownTree.map((root) => {
      const pid = root.id.replace(/^proj::/, '');
      const chosen = projectAgents[pid] ?? [];
      const changed = !sameAgents(chosen, installedAgents[pid] ?? []);
      const trailing = (
        <span className="sk-skills-agentctl" onClick={(e) => e.stopPropagation()}>
          {changed && (
            <span className="sk-skills-agentctl__changed" aria-label={t('skills.agentsChanged')}>
              <Icon name="sync" size={14} />
            </span>
          )}
          <AgentSelect
            value={chosen}
            onChange={(next) => setSkillsUi({ projectAgents: { ...projectAgents, [pid]: next } })}
            ariaLabel={t('skills.agentsLabel')}
            tooltip={t('skills.agentsTooltip')}
          />
        </span>
      );
      // Root's direct children are repository nodes (branches) and unmanaged
      // skills (leaves, present in the project but not from a tracked repo).
      const children = (root.children ?? []).map((child) =>
        child.children !== undefined && child.children.length > 0
          ? {
              ...child,
              label: buildLabel(child, t('skills.updateRepo')),
              children: child.children.map(decorate),
            }
          : decorate(child),
      );
      // The project's own icon (resolved + safety-checked in main) when it has
      // one; otherwise a generated placeholder -- via the shared ProjectIcon.
      const projName = projects.find((p) => p.id === pid)?.name ?? pid;
      const icon = <ProjectIcon iconUrl={projectInfo[pid]?.iconDataUrl} name={projName} size={18} />;
      return { ...root, icon, trailing, children };
    });
  }, [
    mode,
    projectModel,
    shownTree,
    projectChecked,
    installedSet,
    projectAgents,
    installedAgents,
    projectInfo,
    projects,
    updatesBusy,
    updateProjectSkills,
    requestAddRepository,
    setSkillsUi,
    t,
  ]);

  const searching = query.trim() !== '';
  const filtering = repoFilter.length > 0 || projectFilter.length > 0;
  const totalSkills = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownSkills = useMemo(() => countLeaves(decorated), [decorated]);
  const expandedIds = searching ? collectBranchIds(decorated) : rootIds(baseTree);

  const checkedIds = mode === 'repositories' ? repoChecked : projectChecked;
  const onCheckedChange = mode === 'repositories' ? setRepoChecked : setProjectChecked;

  // Project-mode pending change (drives the Save button + its notification).
  const pendingAdd = projectChecked.filter((id) => !installedSet.has(id)).length;
  const pendingRemove = useMemo(() => {
    const checkedSet = new Set(projectChecked);
    return [...installedSet].filter((id) => !checkedSet.has(id)).length;
  }, [projectChecked, installedSet]);
  // Agents changing (even with no skill change) is a saveable diff too.
  const agentsChangedAny = useMemo(
    () => projects.some((p) => !sameAgents(projectAgents[p.id] ?? [], installedAgents[p.id] ?? [])),
    [projects, projectAgents, installedAgents],
  );
  const hasProjectChanges = pendingAdd > 0 || pendingRemove > 0 || agentsChangedAny;

  // Whether the current mode has pending changes to discard (enables Reset).
  const canReset = mode === 'repositories' ? repoChecked.length > 0 : hasProjectChanges;

  function changeMode(next: Mode): void {
    setSkillsUi({ mode: next, query: '' });
  }

  function onAdd(): void {
    setInstallOpen(true);
  }

  function onSave(): void {
    setSaveOpen(true);
  }

  const sourceOptions = [
    { value: 'repositories', label: t('skills.source.repositories') },
    { value: 'projects', label: t('skills.source.projects') },
  ];

  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));
  const projectOptions = projects.map((p) => ({ value: p.id, label: p.name }));
  const checkboxLevels = mode === 'repositories' ? [1, 2] : [1, 2, 3];

  const actions = (
    <>
      <SearchField
        className="sk-skills-search"
        placeholder={t('skills.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
        clearLabel={t('common.clear')}
      />
      {mode === 'repositories' ? (
        <Button variant="primary" glass disabled={repoChecked.length === 0} onClick={onAdd}>
          {t('skills.action.add')}
        </Button>
      ) : (
        <Button variant="primary" glass disabled={!hasProjectChanges} onClick={onSave}>
          {t('skills.action.save')}
        </Button>
      )}
      <Button variant="secondary" glass disabled={!canReset} onClick={() => resetSkillsSelection(mode)}>
        {t('skills.action.reset')}
      </Button>
    </>
  );

  // Second toolbar row: display mode and the repo/project multi-select filters
  // that narrow which nodes the tree shows.
  const filters = (
    <div className="sk-skills-filters">
      <Select
        label={t('skills.source')}
        options={sourceOptions}
        value={mode}
        onChange={(v) => changeMode(v as Mode)}
      />
      <MultiCombobox
        label={t('skills.filterRepositories')}
        options={repoOptions}
        value={repoFilter}
        onChange={setRepoFilter}
        placeholder={t('skills.filterRepositoriesPlaceholder')}
        emptyText={t('skills.filterRepositoriesEmpty')}
        ariaLabel={t('skills.filterRepositories')}
      />
      {mode === 'projects' && (
        <MultiCombobox
          label={t('skills.filterProjects')}
          options={projectOptions}
          value={projectFilter}
          onChange={setProjectFilter}
          placeholder={t('skills.filterProjectsPlaceholder')}
          emptyText={t('skills.filterProjectsEmpty')}
          ariaLabel={t('skills.filterProjects')}
        />
      )}
    </div>
  );

  return (
    <Page
      toolbar={
        <div className="sk-skills-header">
          <Toolbar title={t('nav.skills')} trailing={actions} />
          {filters}
        </div>
      }
    >
      {baseTree.length === 0 ? (
        <p className="sk-empty">
          {mode === 'repositories' ? t('skills.emptyRepositories') : t('skills.emptyProjects')}
        </p>
      ) : (
        <>
          <TreeView
            key={mode}
            className="sk-skills-tree"
            nodes={decorated}
            checkable
            checkboxLevels={checkboxLevels}
            checkedIds={checkedIds}
            onCheckedChange={onCheckedChange}
            defaultExpandedIds={expandedIds}
            ariaLabel={t('nav.skills')}
          />
          {(searching || filtering) && (
            <div className="sk-list-footer">
              {searching && (
                <SearchSummary
                  foundLabel={t.plural('skills.searchFound', shownSkills)}
                  totalLabel={t.plural('skills.searchTotal', totalSkills)}
                  showAllLabel={t('skills.showAll')}
                  onShowAll={() => setQuery('')}
                />
              )}
              {filtering && (
                <div className="sk-skills-filter-reset">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setRepoFilter([]);
                      setProjectFilter([]);
                    }}
                  >
                    {t('skills.resetFilters')}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      <SkillInstallModal
        open={installOpen}
        onClose={() => setInstallOpen(false)}
        skillKeys={repoChecked}
      />
      <SkillSaveModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        checkedIds={projectChecked}
        projectAgents={projectAgents}
      />
    </Page>
  );
}
