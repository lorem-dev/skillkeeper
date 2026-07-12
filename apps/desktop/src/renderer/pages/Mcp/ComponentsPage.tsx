/**
 * MCP Components page: a browser for MCP server PRESETS (manual + repo-
 * discovered), one of the two pages the old combined `McpPage` is being split
 * into (this one owns presets; a future Management page owns installed
 * instances). Two interchangeable views, chosen by `McpViewToggle` and
 * persisted in the store's `mcpUi.componentsView`:
 *   - Tiles: a responsive grid of `McpCard`s, one per preset -- restores the
 *     original card-grid `McpPage` (see git history) as one of two views.
 *   - Tree: the same repositories-mode tree `McpPage` builds via
 *     `buildMcpRepoTree` -- manual presets as top-level leaves, repo-origin
 *     presets nested under their repository (and optional group). Since that
 *     tree only ever yields 'manual-preset'/'repo-preset' leaves (no
 *     installed/unlinked instances -- those only exist in `McpPage`'s
 *     projects-mode tree), branch nodes here never show an installed-count
 *     detail and leaves never show update/delete badges.
 * Both views share one fuzzy search box and one create/edit/install/details
 * action set via `useMcpActions` -- this page never manages installed
 * instances (no update/delete-instance flows).
 */
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import type { McpPreset } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { Page, Toolbar, Button, ExpandingSearch, FilterButton, CollapsibleFilters, SearchSummary, TreeView, Badge, Tooltip, MultiCombobox } from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { fuzzyFilter, cardStagger, fade, useFilterToggle } from '@/shared/lib';
import { filterTree, collectBranchIds, rootIds, countLeaves } from '@/entities/skill';
import { McpCard } from '@/entities/mcp';
import { McpViewToggle } from '@/features/mcpView';
import { buildMcpRepoTree } from './lib/mcpTree';
import type { McpTreeItem } from './lib/mcpTree';
import { mcpConnectionFromDef } from './lib/mcpPresetMapping';
import { mcpTileSearchText } from './lib/mcpTileSearch';
import { useMcpActions } from './useMcpActions';
import './ComponentsPage.scss';

export function ComponentsPage() {
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const refreshMcpPresets = useSkillkeeperStore((s) => s.refreshMcpPresets);
  const focusRepository = useSkillkeeperStore((s) => s.focusRepository);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  const { openCreate, openEdit, openInstall, openDetails, modals } = useMcpActions();

  // Presets are local/cheap -- refresh on mount, mirroring McpPage.
  useEffect(() => {
    void refreshMcpPresets();
  }, [refreshMcpPresets]);

  // View + tree expansion live in the store's `mcpUi` slice (shared with
  // McpPage) so they survive navigating away and back. `componentsView` is
  // this page's own field; `expandedIds` is the same field McpPage's
  // repositories-mode tree uses -- intentional, since this tree view is built
  // by the exact same `buildMcpRepoTree` call and shares its node ids.
  const mcpUi = useSkillkeeperStore((s) => s.mcpUi);
  const setMcpUi = useSkillkeeperStore((s) => s.setMcpUi);
  const { componentsView, expandedIds: persistedExpandedIds, componentsRepoFilter: repoFilter } = mcpUi;
  const [query, setQuery] = useState('');

  // Repo filter lives in the store (`mcpUi.componentsRepoFilter`) so `goToMcp`
  // can set it from a repository card. Empty filter = show all.
  const setRepoFilter = (value: string[]): void => setMcpUi({ componentsRepoFilter: value });

  // One filter control here (repositories); the filter row + count badge are
  // driven by whether it is non-empty.
  const filterCount = repoFilter.length > 0 ? 1 : 0;
  const filterToggle = useFilterToggle(filterCount);

  // Manual presets belong to no repository, so they always survive the repo
  // filter -- matching how `buildMcpRepoTree` always keeps manual presets as
  // top-level leaves regardless of the `repos` it nests under.
  const shownRepos = useMemo(
    () => (repoFilter.length === 0 ? repositories : repositories.filter((r) => repoFilter.includes(r.id))),
    [repositories, repoFilter],
  );
  const repoFilteredPresets = useMemo(
    () =>
      repoFilter.length === 0
        ? mcpPresets
        : mcpPresets.filter(
            (p) => p.origin === 'manual' || (p.repoId !== undefined && repoFilter.includes(p.repoId)),
          ),
    [mcpPresets, repoFilter],
  );

  function copy(text: string): void {
    void navigator.clipboard.writeText(text);
    notify(t('mcp.copiedToClipboard'), 'info');
  }

  function repoNameFor(preset: McpPreset): string | undefined {
    return preset.repoId !== undefined ? repositories.find((r) => r.id === preset.repoId)?.name : undefined;
  }

  // Tiles view: the repo-filtered presets, fuzzy-filtered by name/type/repo/connection.
  const filteredPresets = useMemo(
    () => fuzzyFilter(repoFilteredPresets, query, (p) => mcpTileSearchText(p, repositories)),
    [repoFilteredPresets, query, repositories],
  );

  // Tree view: the same repositories-mode tree McpPage builds, narrowed to the
  // selected repositories (manual presets always survive as top-level leaves).
  const treeResult = useMemo(() => buildMcpRepoTree(mcpPresets, shownRepos), [mcpPresets, shownRepos]);
  const { nodes: baseTree, items } = treeResult;
  const shownTree = useMemo(() => filterTree(baseTree, query), [baseTree, query]);

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

    function badgesFor(item: McpTreeItem): ReactNode {
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
        // The repositories-mode tree never yields installed/unlinked leaves --
        // those only exist in McpPage's projects-mode tree.
        default:
          return null;
      }
    }

    function decorate(node: TreeNode): TreeNode {
      const item = items.get(node.id);
      if (item !== undefined) return { ...node, trailing: badgesFor(item) };
      if (node.children === undefined || node.children.length === 0) return node;
      const children = node.children.map(decorate);
      return children !== node.children ? { ...node, children } : node;
    }

    return shownTree.map(decorate);
  }, [shownTree, items, t, openEdit, openInstall]);

  function handleSelect(node: TreeNode): void {
    const item = items.get(node.id);
    if (item !== undefined) openDetails(item);
  }

  const searching = query.trim() !== '';
  const totalCount = componentsView === 'tree' ? countLeaves(baseTree) : repoFilteredPresets.length;
  const shownCount = componentsView === 'tree' ? countLeaves(shownTree) : filteredPresets.length;

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
      <McpViewToggle value={componentsView} onChange={(v) => setMcpUi({ componentsView: v })} />
      <FilterButton
        count={filterCount}
        open={filterToggle.open}
        onToggle={filterToggle.toggle}
        onClear={() => setRepoFilter([])}
        filterLabel={t('common.filter')}
        clearLabel={t('common.clearFilters')}
      />
    </>
  );

  // Docked at the page bottom (over the fade), not in the toolbar row.
  const dock = (
    <Button variant="primary" glass onClick={openCreate}>
      {t('mcp.add')}
    </Button>
  );

  // Second toolbar row: the repository multi-select filter that narrows which
  // presets/tree nodes show. Mirrors SkillsPage's/ManagementPage's own filter.
  const repoOptions = repositories.map((r) => ({ value: r.id, label: r.name }));

  return (
    <Page
      toolbar={
        <div className="sk-mcp-components-header">
          <Toolbar
            title={
              <>
                {t('nav.mcp')}
                <span className="sk-mcp-title-sep">/</span>
                {t('mcp.componentsTitle')}
              </>
            }
            trailing={actions}
          />
          <CollapsibleFilters
            open={filterToggle.visible}
            onFocusWithinChange={filterToggle.onFocusWithinChange}
            className="sk-mcp-components-filters"
          >
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
        </div>
      }
      dock={dock}
    >
      {mcpPresets.length === 0 ? (
        <p className="sk-empty">{t('mcp.empty')}</p>
      ) : componentsView === 'tiles' ? (
        <>
          <div className="sk-mcp-grid">
            <AnimatePresence mode="popLayout" initial={false}>
              {filteredPresets.map((preset, i) => {
                const connection = mcpConnectionFromDef(preset.def);
                const repoName = repoNameFor(preset);
                return (
                  <motion.div
                    key={preset.id}
                    layout
                    custom={i}
                    variants={cardStagger}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                  >
                    <McpCard
                      name={preset.name}
                      repoName={repoName}
                      goToRepoLabel={t('mcp.goToRepository')}
                      onGoToRepo={preset.repoId !== undefined ? () => focusRepository(preset.repoId!) : undefined}
                      protocol={preset.def.type}
                      protocolLabel={t(`mcp.protocol.${preset.def.type}`)}
                      hasRules={preset.hasRules}
                      rulesLabel={t('mcp.rulesBadge')}
                      url={connection.url}
                      command={connection.command}
                      copyLabel={t('mcp.copy')}
                      onCopyUrl={connection.url !== undefined ? () => copy(connection.url!) : undefined}
                      onCopyCommand={connection.command !== undefined ? () => copy(connection.command!) : undefined}
                      onEdit={preset.origin === 'manual' ? () => openEdit(preset) : undefined}
                      editLabel={t('mcp.edit')}
                      onInstall={() => openInstall(preset)}
                      installLabel={t('mcp.install')}
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
                  foundLabel={t.plural('mcp.searchFound', shownCount)}
                  totalLabel={t.plural('mcp.searchTotal', totalCount)}
                  showAllLabel={t('mcp.showAll')}
                  onShowAll={() => setQuery('')}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <>
          <TreeView
            className="sk-mcp-components-tree"
            nodes={decorated}
            onSelect={handleSelect}
            defaultExpandedIds={expandedIds}
            onExpandedChange={(ids) => setMcpUi({ expandedIds: ids })}
            ariaLabel={t('mcp.componentsTitle')}
          />
          {searching && (
            <div className="sk-list-footer">
              <SearchSummary
                foundLabel={t.plural('mcp.searchFound', shownCount)}
                totalLabel={t.plural('mcp.searchTotal', totalCount)}
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
