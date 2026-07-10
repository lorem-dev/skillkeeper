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
import type { SkillsMode, McpPreset } from '@/app/store';
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
  repoSkillKey,
  projectSkillKey,
} from '@/entities/skill';
import { SkillInstallModal } from '@/features/skillInstall';
import { SkillSaveModal } from '@/features/skillSave';
import { McpInstallModal } from '@/features/mcpInstall';
import type { McpInstall, McpBatch } from '@/services/bridge';
import { attachRepoMcpLeaves, attachProjectMcpLeaves } from './lib/mcpTree';
import './SkillsPage.scss';

type Mode = SkillsMode;

/**
 * Placeholder passed to `McpInstallModal` while it is closed -- its `preset`
 * prop is required, but the modal's own `open` gate keeps the body (which is
 * the only place `preset` is read) out of the DOM, so this is never shown.
 * Mirrors the same placeholder in `McpPage`.
 */
const EMPTY_MCP_PRESET: McpPreset = {
  id: '',
  origin: 'manual',
  name: '',
  def: { name: '', type: 'stdio' },
  hash: '',
  params: [],
  hasRules: false,
};

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
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
  const refreshMcpPresets = useSkillkeeperStore((s) => s.refreshMcpPresets);
  const refreshMcpInstalls = useSkillkeeperStore((s) => s.refreshMcpInstalls);
  const applyMcp = useSkillkeeperStore((s) => s.applyMcp);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  // Project icons are resolved into projectInfo by the main process; refresh it on
  // mount so the project nodes in the tree can show them (the Projects page does
  // the same). Cheap and idempotent.
  useEffect(() => {
    void refreshProjectInfo();
  }, [refreshProjectInfo]);

  // MCP presets/installs back the tree's MCP leaves (both modes); refresh both
  // on mount, mirroring McpPage's own mount-refresh pattern.
  useEffect(() => {
    void refreshMcpPresets();
    void refreshMcpInstalls();
  }, [refreshMcpPresets, refreshMcpInstalls]);

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
  // The MCP install modal's target (preset + optional preselected project);
  // null means closed. Ephemeral for the same reason as the flags above.
  const [mcpInstallTarget, setMcpInstallTarget] = useState<{
    preset: McpPreset;
    projectId?: string;
  } | null>(null);

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

  // Leaf ids whose skill ships a GUIDE.md/RULES.md guidance file -- they get a
  // grey "rules" badge. Keyed to the active mode's id scheme; keys that map to
  // no node are harmless (the membership test only ever hits real leaves).
  const guidanceIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of availableSkills) {
      if (!s.hasGuidance) continue;
      if (mode === 'repositories') ids.add(repoSkillKey(s.repoId, s.group, s.name));
      else for (const p of projects) ids.add(projectSkillKey(p.id, s.repoId, s.group, s.name));
    }
    return ids;
  }, [availableSkills, projects, mode]);

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

  // MCP leaves (design spec "MCP support" section 8, option B): repo presets
  // (repositories mode) or installed instances / not-yet-installed repo
  // presets (projects mode), inline with the skill leaves. Built from -- but
  // kept separate from -- `baseTree`, so the skill-only counts below stay
  // accurate; the badges wired here never touch the checkbox selection or the
  // apply-plan math (they carry no i18n text yet, matching McpPage/
  // McpInstallModal's "hardcode now, retrofit i18n later" approach for the
  // still-unwrapped MCP feature).
  const treeWithMcp = useMemo(() => {
    function openInstall(preset: McpPreset, projectId?: string): void {
      setMcpInstallTarget({ preset, projectId });
    }

    async function removeMcp(toRemove: readonly McpInstall[]): Promise<void> {
      const first = toRemove[0];
      if (first === undefined) return;
      const project = projects.find((p) => p.id === first.projectId);
      if (project === undefined) return;
      const batches: McpBatch[] = toRemove.map((inst) => ({
        agent: inst.agent,
        install: [],
        remove: [{ instanceName: inst.instanceName }],
      }));
      const result = await applyMcp({ projectId: project.id, projectPath: project.path, batches });
      if (!result.ok) notify(result.error, 'error');
    }

    function renderBadge(label: string, tone: 'accent' | 'neutral', onClick: () => void): ReactNode {
      return (
        <span className="sk-skills-badgewrap" onClick={(e) => e.stopPropagation()}>
          <Tooltip content={label}>
            <button type="button" className="sk-skills-badge-btn" onClick={onClick}>
              <Badge tone={tone}>{label}</Badge>
            </button>
          </Tooltip>
        </span>
      );
    }

    if (mode === 'repositories') {
      return attachRepoMcpLeaves(baseTree, mcpPresets, shownRepos, (preset) =>
        renderBadge('Install MCP', 'accent', () => openInstall(preset)),
      );
    }
    return attachProjectMcpLeaves(baseTree, mcpPresets, mcpInstalls, shownProjects, shownRepos, (action) =>
      action.kind === 'install'
        ? renderBadge('Install MCP', 'accent', () => openInstall(action.preset, action.projectId))
        : renderBadge('Remove', 'neutral', () => void removeMcp(action.installs)),
    );
  }, [mode, baseTree, mcpPresets, mcpInstalls, shownRepos, shownProjects, projects, applyMcp, notify]);

  const shownTree = useMemo(() => filterTree(treeWithMcp, query), [treeWithMcp, query]);
  // Skill-only filtered tree, purely for the "N of M skills" search summary --
  // MCP leaves are not skills and must not inflate that count.
  const shownSkillsOnly = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // An update-skill task in flight makes every dot pulse and non-clickable.
  const updatesBusy = useMemo(
    () => tasks.some((t) => t.kind === 'update-skill' && (t.status === 'queued' || t.status === 'running')),
    [tasks],
  );

  // Project mode: tag each visible skill leaf with its install-status badge,
  // attach update dots (leaf/group/repo) from the model, and give each project
  // root an agent picker (with an "agents changed" marker).
  const decorated = useMemo(() => {
    // Grey, always-visible "rules" badge for skills that ship guidance. Wrapped
    // so a click lands on the badge, not the TreeView row (no checkbox toggle).
    const rulesBadge = (
      <span className="sk-skills-badgewrap" onClick={(e) => e.stopPropagation()}>
        <Tooltip content={t('skills.rulesHint')}>
          <Badge tone="neutral">{t('skills.rulesBadge')}</Badge>
        </Tooltip>
      </span>
    );

    if (mode !== 'projects' || projectModel === null) {
      // Repo mode has no status/update decoration -- only the rules badge.
      if (guidanceIds.size === 0) return shownTree;
      const walk = (node: TreeNode): TreeNode => {
        if (node.children !== undefined && node.children.length > 0) {
          return { ...node, children: node.children.map(walk) };
        }
        if (!guidanceIds.has(node.id)) return node;
        return {
          ...node,
          label: (
            <span className="sk-skills-nodelabel">
              <span className="sk-skills-name">{node.label}</span>
              {rulesBadge}
            </span>
          ),
        };
      };
      return shownTree.map(walk);
    }
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
            // Badges own their commands; swallow the click so it never reaches the
            // TreeView row (no accidental select/checkbox toggle).
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
  // Skill-only counts (MCP leaves are not skills and must not inflate "N of M").
  const totalSkills = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownSkills = useMemo(() => countLeaves(shownSkillsOnly), [shownSkillsOnly]);
  // `treeWithMcp` is a superset of `baseTree` (it may add MCP-only repo/project
  // roots), so expanding its top level also opens those by default.
  const expandedIds = searching ? collectBranchIds(decorated) : rootIds(treeWithMcp);

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
      <McpInstallModal
        open={mcpInstallTarget !== null}
        preset={mcpInstallTarget?.preset ?? EMPTY_MCP_PRESET}
        preselectedProjectId={mcpInstallTarget?.projectId}
        onClose={() => setMcpInstallTarget(null)}
      />
    </Page>
  );
}
