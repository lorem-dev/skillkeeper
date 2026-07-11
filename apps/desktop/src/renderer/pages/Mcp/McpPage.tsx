/**
 * MCP page: a Skills-like TREE of MCP server presets (manual + repo-
 * discovered) and, in projects mode, their installed/unlinked instances --
 * mirrors SkillsPage's Page/Toolbar/mode-Select/SearchField/TreeView/
 * SearchSummary structure (see `pages/Skills/SkillsPage.tsx`). Two modes:
 *   - Repositories: manual presets + one node per repository, nesting that
 *     repo's presets under an optional group.
 *   - Projects: manual presets + one node per project, nesting install rows,
 *     installed instances, and unlinked (orphaned) instances.
 * Each leaf's trailing badges and click-to-details behavior are resolved via
 * the tree builder's `items` lookup (`McpTreeItem`) -- see design spec "MCP
 * support" sections 5, 7, and 8.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import type { Project } from '@/services/bridge';
import { Page, Toolbar, Button, SearchField, Select, SearchSummary, TreeView, Badge, Tooltip } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { filterTree, collectBranchIds, rootIds, countLeaves } from '@/entities/skill';
import { ProjectIcon } from '@/entities/project';
import { buildMcpRepoTree, buildMcpProjectTree, mcpProjectRootId } from './lib/mcpTree';
import type { McpTreeItem } from './lib/mcpTree';
import { countInstalledLeaves } from './lib/mcpCounts';
import { useMcpActions } from './useMcpActions';
import './McpPage.scss';

type Mode = 'repositories' | 'projects';

export function McpPage() {
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const refreshMcpPresets = useSkillkeeperStore((s) => s.refreshMcpPresets);
  const refreshMcpInstalls = useSkillkeeperStore((s) => s.refreshMcpInstalls);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const t = useTranslator();

  const { openCreate, openEdit, openInstall, startMcpUpdate, requestDeleteInstalls, openDetails, modals } =
    useMcpActions();

  // Presets, installed instances, and project icons are local/cheap --
  // refresh all three on mount, mirroring SkillsPage's own mount effects.
  useEffect(() => {
    void refreshMcpPresets();
    void refreshMcpInstalls();
    void refreshProjectInfo();
  }, [refreshMcpPresets, refreshMcpInstalls, refreshProjectInfo]);

  // Display mode + tree expansion live in the store's `mcpUi` slice so they
  // survive navigating away and back (in memory only -- reset on app
  // reload), mirroring the Skills page's `skillsUi`. The search query stays
  // local/ephemeral -- it is not requested to persist.
  const mcpUi = useSkillkeeperStore((s) => s.mcpUi);
  const setMcpUi = useSkillkeeperStore((s) => s.setMcpUi);
  const { mode, expandedIds: persistedExpandedIds } = mcpUi;
  const [query, setQuery] = useState('');

  const treeResult = useMemo(
    () =>
      mode === 'repositories'
        ? buildMcpRepoTree(mcpPresets, repositories)
        : buildMcpProjectTree(mcpPresets, mcpInstalls, projects, repositories),
    [mode, mcpPresets, mcpInstalls, projects, repositories],
  );
  const { nodes: baseTree, items } = treeResult;

  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

  // Project-mode root node id -> its project, so the tree can swap the
  // generic projects glyph for the project's own icon (mirrors SkillsPage).
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
        case 'manual-preset':
          return (
            <span className="sk-mcp-badge-group">
              {renderBadge(t('mcp.edit'), 'neutral', () => openEdit(item.preset))}
              {renderBadge(t('mcp.installMcp'), 'accent', () => openInstall(item.preset))}
            </span>
          );
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
      // The installed-count number is shown in the accent color, mirroring the
      // Skills page's accent-colored branch counts for installed skills.
      const detail =
        node.trailing === undefined && installedCount > 0 ? (
          <span className="sk-mcp-count">{installedCount}</span>
        ) : (
          node.detail
        );
      // A project-root node: show the project's own icon (resolved + safety-
      // checked in main) when it has one, otherwise a generated placeholder --
      // via the shared ProjectIcon, mirroring SkillsPage's project nodes.
      const project = projectByRootId.get(node.id);
      if (project !== undefined) {
        const icon = <ProjectIcon iconUrl={projectInfo[project.id]?.iconDataUrl} name={project.name} size={18} />;
        return { ...node, icon, children, detail };
      }
      if (children !== node.children || detail !== node.detail) return { ...node, children, detail };
      return node;
    }

    return shownTree.map(decorate);
  }, [
    shownTree,
    items,
    projectByRootId,
    projectInfo,
    t,
    openEdit,
    openInstall,
    startMcpUpdate,
    requestDeleteInstalls,
  ]);

  function handleSelect(node: TreeNode): void {
    const item = items.get(node.id);
    if (item !== undefined) openDetails(item);
  }

  const searching = query.trim() !== '';
  const totalMcp = useMemo(() => countLeaves(baseTree), [baseTree]);
  const shownMcp = useMemo(() => countLeaves(shownTree), [shownTree]);
  // Seed from the persisted expansion (falling back to the roots the first
  // time), mirroring SkillsPage: union in the search-match branches while
  // searching, without collapsing anything the user had open.
  const baseExpandedIds = persistedExpandedIds ?? rootIds(baseTree);
  const expandedIds = searching
    ? [...new Set([...baseExpandedIds, ...collectBranchIds(decorated)])]
    : baseExpandedIds;

  const sourceOptions = [
    { value: 'repositories', label: t('skills.source.repositories') },
    { value: 'projects', label: t('skills.source.projects') },
  ];

  const actions = (
    <>
      <SearchField
        className="sk-list-search"
        placeholder={t('common.search')}
        aria-label={t('common.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onClear={() => setQuery('')}
      />
      <Button variant="primary" glass onClick={openCreate}>
        {t('mcp.add')}
      </Button>
    </>
  );

  return (
    <Page
      toolbar={
        <div className="sk-mcp-header">
          <Toolbar title={t('nav.mcp')} trailing={actions} />
          <div className="sk-mcp-filters">
            <Select
              label={t('skills.source')}
              options={sourceOptions}
              value={mode}
              onChange={(v) => {
                setMcpUi({ mode: v as Mode });
                setQuery('');
              }}
            />
          </div>
        </div>
      }
    >
      {baseTree.length === 0 ? (
        <p className="sk-empty">{t('mcp.empty')}</p>
      ) : (
        <>
          <TreeView
            key={mode}
            className="sk-mcp-tree"
            nodes={decorated}
            onSelect={handleSelect}
            defaultExpandedIds={expandedIds}
            onExpandedChange={(ids) => setMcpUi({ expandedIds: ids })}
            ariaLabel={t('nav.mcp')}
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
