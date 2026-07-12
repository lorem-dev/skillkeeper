/**
 * MCP Management page: a browser for installed/unlinked MCP instances across
 * projects, the second of the two pages the old combined `McpPage` is being
 * split into (Components owns presets; this page owns installed instances).
 * Always renders the same projects-mode tree `McpPage` builds via
 * `buildMcpProjectTree` -- manual presets as top-level leaves, one node per
 * project nesting install rows (repo presets not yet installed under that
 * project), installed instances (Update if updatable + Delete badges), and
 * unlinked instances (Delete only) -- mirrors `McpPage`'s projects-mode
 * `decorate` walk verbatim (see design spec "MCP support" sections 5, 7, and
 * 8) for the installed/unlinked/repo-preset cases.
 *
 * No "Add MCP" action and no mode toggle here -- this page is always the
 * projects tree; presets are created/edited from the Components page. That
 * also means no Edit badge on the top-level manual-preset leaves this tree
 * still includes (they cover "install this preset into some project", not
 * "edit its definition") -- only Install, using the same action McpPage's
 * repo-preset install rows use.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import type { Project } from '@/services/bridge';
import { Page, Toolbar, ExpandingSearch, FilterButton, CollapsibleFilters, SearchSummary, TreeView, Badge, Tooltip, MultiCombobox } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { useFilterToggle } from '@/shared/lib';
import { filterTree, collectBranchIds, rootIds, countLeaves } from '@/entities/skill';
import { ProjectIcon } from '@/entities/project';
import { buildMcpProjectTree, mcpProjectRootId } from './lib/mcpTree';
import type { McpTreeItem } from './lib/mcpTree';
import { countInstalledLeaves } from './lib/mcpCounts';
import { useMcpActions } from './useMcpActions';
import './ManagementPage.scss';

export function ManagementPage() {
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const refreshMcpPresets = useSkillkeeperStore((s) => s.refreshMcpPresets);
  const refreshMcpInstalls = useSkillkeeperStore((s) => s.refreshMcpInstalls);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const t = useTranslator();

  const { openInstall, startMcpUpdate, requestDeleteInstalls, openDetails, modals } = useMcpActions();

  // Presets, installed instances, and project icons are local/cheap --
  // refresh all three on mount, mirroring McpPage.
  useEffect(() => {
    void refreshMcpPresets();
    void refreshMcpInstalls();
    void refreshProjectInfo();
  }, [refreshMcpPresets, refreshMcpInstalls, refreshProjectInfo]);

  // Tree expansion lives in the store's `mcpUi` slice, shared with McpPage's
  // own projects-mode tree (same builder, same node ids) so it survives
  // navigating away and back. The search query stays local/ephemeral -- it
  // is not requested to persist.
  const mcpUi = useSkillkeeperStore((s) => s.mcpUi);
  const setMcpUi = useSkillkeeperStore((s) => s.setMcpUi);
  const { expandedIds: persistedExpandedIds } = mcpUi;
  const [query, setQuery] = useState('');

  // The repo/project filters are ephemeral (not persisted in the store),
  // mirroring the toolbar search above -- only the tree expansion survives
  // navigating away and back. Empty filter = show all (mirrors SkillsPage).
  const [repoFilter, setRepoFilter] = useState<string[]>([]);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);

  // Two filter controls (projects, repositories); the count badge shows how
  // many are non-empty and drives the collapsible filter row.
  const filterCount = (projectFilter.length > 0 ? 1 : 0) + (repoFilter.length > 0 ? 1 : 0);
  const filterToggle = useFilterToggle(filterCount);
  const clearFilters = (): void => {
    setProjectFilter([]);
    setRepoFilter([]);
  };

  const shownRepos = useMemo(
    () =>
      repoFilter.length === 0 ? repositories : repositories.filter((r) => repoFilter.includes(r.id)),
    [repositories, repoFilter],
  );
  const shownProjects = useMemo(
    () =>
      projectFilter.length === 0 ? projects : projects.filter((p) => projectFilter.includes(p.id)),
    [projects, projectFilter],
  );

  const treeResult = useMemo(
    () => buildMcpProjectTree(mcpPresets, mcpInstalls, shownProjects, shownRepos),
    [mcpPresets, mcpInstalls, shownProjects, shownRepos],
  );
  const { nodes: baseTree, items } = treeResult;

  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // Project-root node id -> its project, so the tree can swap the generic
  // projects glyph for the project's own icon (mirrors McpPage).
  const projectByRootId = useMemo(() => {
    const map = new Map<string, Project>();
    for (const p of projects) map.set(mcpProjectRootId(p.id), p);
    return map;
  }, [projects]);

  const decorated = useMemo(() => {
    function renderBadge(label: string, tone: 'accent' | 'neutral', onClick: () => void): ReactNode {
      return (
        <span className="sk-mcp-badgewrap" onClick={(e) => e.stopPropagation()}>
          <Tooltip content={label}>
            <button type="button" className="sk-mcp-badge-btn" onClick={onClick}>
              <Badge tone={tone}>{label}</Badge>
            </button>
          </Tooltip>
        </span>
      );
    }

    function badgesFor(item: McpTreeItem, name: string): ReactNode {
      switch (item.kind) {
        // Preset leaves (top-level manual presets and per-project repo-preset
        // install rows) only get an Install badge here -- editing a preset's
        // definition stays on the Components page (no `openEdit` on this
        // page's action set).
        case 'manual-preset':
        case 'repo-preset':
          return (
            <span className="sk-mcp-badge-group">
              {renderBadge(t('mcp.installMcp'), 'accent', () => openInstall(item.preset))}
            </span>
          );
        case 'installed':
          return (
            <span className="sk-mcp-badge-group">
              {item.updatable && renderBadge(t('mcp.update'), 'accent', () => startMcpUpdate(item.installs))}
              {renderBadge(t('mcp.delete'), 'neutral', () => requestDeleteInstalls(name, item.installs))}
            </span>
          );
        case 'unlinked':
          return (
            <span className="sk-mcp-badge-group">
              {renderBadge(t('mcp.delete'), 'neutral', () => requestDeleteInstalls(name, item.installs))}
            </span>
          );
      }
    }

    function decorate(node: TreeNode): TreeNode {
      const item = items.get(node.id);
      if (item !== undefined) {
        const name = typeof node.label === 'string' ? node.label : '';
        return { ...node, trailing: badgesFor(item, name) };
      }
      const children =
        node.children !== undefined && node.children.length > 0 ? node.children.map(decorate) : node.children;
      // Every branch (project root, repo node, group node) shows a count of
      // installed MCP instances in its subtree -- computed off the ORIGINAL
      // node (same ids/structure as the decorated one), only when > 0, and
      // only when nothing else already claimed the trailing slot.
      const installedCount = countInstalledLeaves(node, items);
      // The installed-count number is shown in the accent color, mirroring
      // McpPage's/the Skills page's accent-colored branch counts.
      const detail =
        node.trailing === undefined && installedCount > 0 ? (
          <span className="sk-mcp-count">{installedCount}</span>
        ) : (
          node.detail
        );
      // A project-root node: show the project's own icon (resolved +
      // safety-checked in main) when it has one, otherwise a generated
      // placeholder -- via the shared ProjectIcon, mirroring McpPage.
      const project = projectByRootId.get(node.id);
      if (project !== undefined) {
        const icon = <ProjectIcon iconUrl={projectInfo[project.id]?.iconDataUrl} name={project.name} size={18} />;
        return { ...node, icon, children, detail };
      }
      if (children !== node.children || detail !== node.detail) return { ...node, children, detail };
      return node;
    }

    return shownTree.map(decorate);
  }, [shownTree, items, projectByRootId, projectInfo, t, openInstall, startMcpUpdate, requestDeleteInstalls]);

  function handleSelect(node: TreeNode): void {
    const item = items.get(node.id);
    if (item !== undefined) openDetails(item);
  }

  const searching = query.trim() !== '';
  const totalMcp = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownMcp = useMemo(() => countLeaves(shownTree), [shownTree]);
  // Seed from the persisted expansion (falling back to the roots the first
  // time), mirroring McpPage: union in the search-match branches while
  // searching, without collapsing anything the user had open.
  const baseExpandedIds = persistedExpandedIds ?? rootIds(baseTree);
  const expandedIds = searching
    ? [...new Set([...baseExpandedIds, ...collectBranchIds(decorated)])]
    : baseExpandedIds;

  const actions = (
    <>
      <ExpandingSearch
        glass
        label={t('common.search')}
        placeholder={t('common.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
      />
      <FilterButton
        count={filterCount}
        open={filterToggle.open}
        onToggle={filterToggle.toggle}
        onClear={clearFilters}
        filterLabel={t('common.filter')}
        clearLabel={t('common.clearFilters')}
      />
    </>
  );

  // Second toolbar row: the repo/project multi-select filters that narrow
  // which nodes the tree shows. Mirrors SkillsPage's `filters` block; the
  // project options carry a leading `ProjectIcon` (the repo options do not).
  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));
  const projectOptions = projects.map((p) => ({
    value: p.id,
    label: p.name,
    icon: <ProjectIcon iconUrl={projectInfo[p.id]?.iconDataUrl} name={p.name} size={18} />,
  }));

  const filters = (
    <CollapsibleFilters
      open={filterToggle.visible}
      onFocusWithinChange={filterToggle.onFocusWithinChange}
      className="sk-mcp-management-filters"
    >
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
    </CollapsibleFilters>
  );

  return (
    <Page
      toolbar={
        <div className="sk-mcp-management-header">
          <Toolbar
            title={
              <>
                {t('nav.mcp')}
                <span className="sk-mcp-title-sep">/</span>
                {t('mcp.managementTitle')}
              </>
            }
            trailing={actions}
          />
          {filters}
        </div>
      }
    >
      {baseTree.length === 0 ? (
        <p className="sk-empty">{t('mcp.empty')}</p>
      ) : (
        <>
          <TreeView
            className="sk-mcp-management-tree"
            nodes={decorated}
            onSelect={handleSelect}
            defaultExpandedIds={expandedIds}
            onExpandedChange={(ids) => setMcpUi({ expandedIds: ids })}
            ariaLabel={t('mcp.managementTitle')}
          />
          {searching && (
            <div className="sk-list-footer">
              <SearchSummary
                foundLabel={t.plural('mcp.searchFound', shownMcp)}
                totalLabel={t.plural('mcp.searchTotal', totalMcp)}
                showAllLabel={t('mcp.showAll')}
                onShowAll={() => setQuery('')}
              />
            </div>
          )}
        </>
      )}

      {modals}
    </Page>
  );
}
