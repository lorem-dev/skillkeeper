/**
 * Skills Management page: the per-project view of installed skills. One of the
 * two sub-pages the old combined `SkillsPage` split into (this one owns the
 * "projects" mode; the Components page owns the repositories browse mode) --
 * mirrors how the MCP page split into Components + Management.
 *
 * A tree of project -> ("repo / group" ->) skills, pre-checked where installed,
 * with a per-skill install-status badge (present / add / remove), non-clickable
 * update dots plus a hover "update" action where a newer version exists, and a
 * per-project agent picker. "Save" applies the diff via `SkillSaveModal`.
 * Project + repository multi-selects narrow which nodes appear; a search box
 * fuzzy-filters the tree; a footer summarizes the result and clears the
 * search/filters.
 *
 * View + selection state (query, filters, checked set, per-project agents, tree
 * expansion) lives in the store's shared `skillsUi` slice so it survives
 * navigating between the two sub-pages and away/back. On mount this page pins
 * `skillsUi.mode` to 'projects' so the store discriminator,
 * `resetSkillsSelection`, and the deep-link router (App reads `skillsUi.mode`)
 * all agree with what is shown.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import {
  Page,
  Toolbar,
  Button,
  SearchField,
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
  buildProjectModel,
  installedLeafIds,
  installedAgentsByProject,
  filterTree,
  collectBranchIds,
  rootIds,
  countLeaves,
  projectSkillKey,
} from '@/entities/skill';
import { SkillSaveModal } from '@/features/skillSave';
import './SkillsPage.scss';

/** Whether two agent lists hold the same set. */
function sameAgents(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function SkillsManagementPage() {
  const availableSkills = useSkillkeeperStore((s) => s.availableSkills);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const installs = useSkillkeeperStore((s) => s.skills);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const t = useTranslator();

  const skillsUi = useSkillkeeperStore((s) => s.skillsUi);
  const setSkillsUi = useSkillkeeperStore((s) => s.setSkillsUi);
  const resetSkillsSelection = useSkillkeeperStore((s) => s.resetSkillsSelection);
  const updateProjectSkills = useSkillkeeperStore((s) => s.updateProjectSkills);
  const requestAddRepository = useSkillkeeperStore((s) => s.requestAddRepository);
  const tasks = useSkillkeeperStore((s) => s.tasks);
  const {
    query,
    repoFilter,
    projectFilter,
    projectChecked,
    projectAgents,
    expandedIds: persistedExpandedIds,
  } = skillsUi;

  // Modal open flag is ephemeral -- it should not persist across navigation.
  const [saveOpen, setSaveOpen] = useState(false);

  // This sub-page IS the projects mode; keep the store discriminator in sync
  // (see the file header). Clear the shared search only when arriving from the
  // OTHER mode (mirrors the old in-page mode Select), while keeping it when
  // re-entering this mode. Project icons are resolved into projectInfo by the
  // main process; refresh on mount so the project nodes can show them.
  useEffect(() => {
    const switching = useSkillkeeperStore.getState().skillsUi.mode !== 'projects';
    setSkillsUi(switching ? { mode: 'projects', query: '' } : { mode: 'projects' });
    void refreshProjectInfo();
  }, [setSkillsUi, refreshProjectInfo]);

  const setQuery = (value: string): void => setSkillsUi({ query: value });
  const setRepoFilter = (value: string[]): void => setSkillsUi({ repoFilter: value });
  const setProjectFilter = (value: string[]): void => setSkillsUi({ projectFilter: value });
  const setProjectChecked = (ids: string[]): void => setSkillsUi({ projectChecked: ids });

  // The installed skills are the baseline the selection diffs against
  // (pre-checked leaves + each project's installed agents).
  const installedSet = useMemo(() => new Set(installedLeafIds(installs)), [installs]);
  const installedAgents = useMemo(() => installedAgentsByProject(installs), [installs]);

  // Leaf ids whose skill ships a guidance file -> grey "rules" badge, keyed to
  // the project id scheme (one entry per project the skill could appear under).
  const guidanceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of availableSkills) {
      if (!s.hasGuidance) continue;
      for (const p of projects) ids.add(projectSkillKey(p.id, s.repoId, s.group, s.name));
    }
    return ids;
  }, [availableSkills, projects]);

  // The filters narrow which repos/projects appear (empty = all).
  const shownRepos = useMemo(
    () => (repoFilter.length === 0 ? repositories : repositories.filter((r) => repoFilter.includes(r.id))),
    [repositories, repoFilter],
  );
  const shownProjects = useMemo(
    () => (projectFilter.length === 0 ? projects : projects.filter((p) => projectFilter.includes(p.id))),
    [projects, projectFilter],
  );

  // Merge available skills with what is installed, so orphaned installs appear
  // (grey, remove-only) and update dots can be attached.
  const projectModel = useMemo(
    () => buildProjectModel(availableSkills, shownRepos, repositories, shownProjects, installs),
    [availableSkills, shownRepos, repositories, shownProjects, installs],
  );

  const baseTree = projectModel.nodes;
  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // An update-skill task in flight makes every dot pulse and non-clickable.
  const updatesBusy = useMemo(
    () => tasks.some((t) => t.kind === 'update-skill' && (t.status === 'queued' || t.status === 'running')),
    [tasks],
  );

  // Tag each visible skill leaf with its install-status badge, attach update
  // dots (leaf/group/repo) from the model, and give each project root an agent
  // picker (with an "agents changed" marker).
  const decorated = useMemo(() => {
    const rulesBadge = (
      <span className="sk-skills-badgewrap" onClick={(e) => e.stopPropagation()}>
        <Tooltip content={t('skills.rulesHint')}>
          <Badge tone="neutral">{t('skills.rulesBadge')}</Badge>
        </Tooltip>
      </span>
    );

    const checkedSet = new Set(projectChecked);
    const { updatesByNode, orphanLeaves, statusByLeaf } = projectModel;
    // A node's label: name, then a non-interactive update dot when an update is
    // available, then a single action/status badge. The update action badge
    // shows only while the row is hovered; the unlinked/local status badges are
    // always visible. `updateTooltip` names the update scope.
    const buildLabel = (node: TreeNode, updateTooltip: string): ReactNode => {
      const ups = updatesByNode.get(node.id);
      const orphan = orphanLeaves.get(node.id);
      let badge: ReactNode = null;
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
      const hasRules = guidanceIds.has(node.id);
      if (ups === undefined && badge === null && !hasRules) return node.label;
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
            // Badges own their commands; swallow the click so it never reaches
            // the TreeView row (no accidental select/checkbox toggle).
            <span
              className={`sk-skills-badgewrap${hoverOnly ? ' sk-skills-badge--hover' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              {badge}
            </span>
          )}
          {hasRules && rulesBadge}
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
      // Installed-from-a-tracked-repo leaves (present/update) render their glyph
      // in the accent color, matching how installed MCP instances render blue --
      // available/orphan leaves keep the default gray.
      const status = statusByLeaf.get(node.id);
      const icon =
        status === 'present' || status === 'update' ? (
          <Icon name="skills" size={18} className="sk-skills-icon--installed" />
        ) : (
          node.icon
        );
      return { ...node, label: buildLabel(node, t('skills.updateSkill')), detail, icon };
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
    projectModel,
    shownTree,
    guidanceIds,
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
  const baseExpandedIds = persistedExpandedIds ?? rootIds(baseTree);
  const expandedIds = searching
    ? [...new Set([...baseExpandedIds, ...collectBranchIds(decorated)])]
    : baseExpandedIds;

  // Pending change (drives the Save button + its notification).
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

  const projectOptions = projects.map((p) => ({
    value: p.id,
    label: p.name,
    icon: <ProjectIcon iconUrl={projectInfo[p.id]?.iconDataUrl} name={p.name} size={18} />,
  }));
  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));

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
      <Button
        variant="secondary"
        glass
        disabled={!hasProjectChanges}
        onClick={() => resetSkillsSelection('projects')}
      >
        {t('skills.action.reset')}
      </Button>
      <Button variant="primary" glass disabled={!hasProjectChanges} onClick={() => setSaveOpen(true)}>
        {t('skills.action.save')}
      </Button>
    </>
  );

  // Second toolbar row: the project + repository multi-select filters (projects
  // first). The project options carry a leading `ProjectIcon`.
  const filters = (
    <div className="sk-skills-filters">
      <MultiCombobox
        label={t('skills.filterProjects')}
        options={projectOptions}
        value={projectFilter}
        onChange={setProjectFilter}
        placeholder={t('skills.filterProjectsPlaceholder')}
        emptyText={t('skills.filterProjectsEmpty')}
        ariaLabel={t('skills.filterProjects')}
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
    </div>
  );

  return (
    <Page
      toolbar={
        <div className="sk-skills-header">
          <Toolbar
            title={
              <>
                {t('nav.skills')}
                <span className="sk-skills-title-sep">/</span>
                {t('skills.managementTitle')}
              </>
            }
            trailing={actions}
          />
          {filters}
        </div>
      }
    >
      {baseTree.length === 0 ? (
        <p className="sk-empty">{t('skills.emptyProjects')}</p>
      ) : (
        <>
          <TreeView
            className="sk-skills-tree"
            nodes={decorated}
            checkable
            checkboxLevels={[1, 2, 3]}
            checkedIds={projectChecked}
            onCheckedChange={setProjectChecked}
            defaultExpandedIds={expandedIds}
            onExpandedChange={(ids) => setSkillsUi({ expandedIds: ids })}
            ariaLabel={t('skills.managementTitle')}
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
      <SkillSaveModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        checkedIds={projectChecked}
        projectAgents={projectAgents}
      />
    </Page>
  );
}
