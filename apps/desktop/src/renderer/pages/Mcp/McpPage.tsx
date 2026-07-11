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
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore, matchMcpPreset } from '@/app/store';
import type { McpPreset } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import type { McpInstall, McpUpdateReq, Project } from '@/services/bridge';
import {
  Page,
  Toolbar,
  Button,
  SearchField,
  Select,
  SearchSummary,
  TreeView,
  Badge,
  Tooltip,
  Modal,
} from '@/shared/ui';
import type { TreeNode } from '@/shared/ui';
import { filterTree, collectBranchIds, rootIds, countLeaves } from '@/entities/skill';
import { McpCard } from '@/entities/mcp';
import { ProjectIcon } from '@/entities/project';
import { McpEditModal } from '@/features/mcpEdit';
import type { ManualMcpPreset } from '@/features/mcpEdit';
import { McpInstallModal, McpUpdateParamsModal, buildRemoveBatches } from '@/features/mcpInstall';
import { buildMcpRepoTree, buildMcpProjectTree, mcpProjectRootId } from './lib/mcpTree';
import type { McpTreeItem } from './lib/mcpTree';
import { resolveDetailsPreset } from './lib/mcpItemPreset';
import { countInstalledLeaves } from './lib/mcpCounts';
import { mcpConnectionFromDef, toManualPreset } from './lib/mcpPresetMapping';
import './McpPage.scss';

type Mode = 'repositories' | 'projects';

/**
 * Placeholder passed to `McpInstallModal` while it is closed -- its `preset`
 * prop is required, but the modal's own `open` gate keeps the body (which is
 * the only place `preset` is read) out of the DOM, so this is never shown.
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

/** A pending destructive confirmation: what to show, and what to run on confirm. */
interface DeleteTarget {
  readonly name: string;
  readonly onConfirm: () => void;
}

export function McpPage() {
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const mcpInstalls = useSkillkeeperStore((s) => s.mcpInstalls);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const projectInfo = useSkillkeeperStore((s) => s.projectInfo);
  const applyMcp = useSkillkeeperStore((s) => s.applyMcp);
  const updateMcp = useSkillkeeperStore((s) => s.updateMcp);
  const deleteMcpPreset = useSkillkeeperStore((s) => s.deleteMcpPreset);
  const focusRepository = useSkillkeeperStore((s) => s.focusRepository);
  const refreshMcpPresets = useSkillkeeperStore((s) => s.refreshMcpPresets);
  const refreshMcpInstalls = useSkillkeeperStore((s) => s.refreshMcpInstalls);
  const refreshProjectInfo = useSkillkeeperStore((s) => s.refreshProjectInfo);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

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

  const [editOpen, setEditOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<ManualMcpPreset | undefined>(undefined);
  const [installTarget, setInstallTarget] = useState<{ preset: McpPreset; projectId?: string } | null>(null);
  // The pending update's target, once the preflight has determined which
  // params are missing (prompt open); null means closed. Closing WITHOUT
  // confirming aborts the update -- no `McpUpdateParamsModal` `onConfirm` call
  // means `runMcpUpdate` never runs.
  const [updateTarget, setUpdateTarget] = useState<{
    project: Project;
    installs: readonly McpInstall[];
    missingParams: string[];
  } | null>(null);
  const [detailsPreset, setDetailsPreset] = useState<McpPreset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  function copy(text: string): void {
    void navigator.clipboard.writeText(text);
    notify(t('mcp.copiedToClipboard'), 'info');
  }

  function repoNameFor(preset: McpPreset): string | undefined {
    return preset.repoId !== undefined ? repositories.find((r) => r.id === preset.repoId)?.name : undefined;
  }

  const openCreate = useCallback((): void => {
    setEditingPreset(undefined);
    setEditOpen(true);
  }, []);

  const openEdit = useCallback((preset: McpPreset): void => {
    setEditingPreset(toManualPreset(preset));
    setEditOpen(true);
  }, []);

  const openInstall = useCallback((preset: McpPreset, projectId?: string): void => {
    setInstallTarget({ preset, projectId });
  }, []);

  // Runs an already-preflighted update: `values` carries only the params the
  // preflight (or the follow-up modal) determined were missing -- `updateMcp`
  // merges them with each instance's OWN stored values server-side, so a
  // partial `values` here is always safe.
  const runMcpUpdate = useCallback(
    async (toUpdate: readonly McpInstall[], values: Record<string, string>): Promise<void> => {
      const first = toUpdate[0];
      if (first === undefined) return;
      const project = projects.find((p) => p.id === first.projectId);
      if (project === undefined) return;
      const preset = matchMcpPreset(first, mcpPresets);
      if (preset === undefined) return;
      const updates: McpUpdateReq[] = toUpdate.map((inst) => ({
        projectId: project.id,
        projectPath: project.path,
        agent: inst.agent,
        instanceName: inst.instanceName,
        identity: inst.identity,
        def: preset.def,
        values,
      }));
      const result = await updateMcp({ updates });
      if (!result.ok) notify(result.error, 'error');
    },
    [projects, mcpPresets, updateMcp, notify],
  );

  // Update entry point: preflight every affected agent's instance (one per
  // `toUpdate` entry) against the preset's current def, then either update
  // directly (nothing missing) or open the params modal for the UNION of
  // missing names across all of them. Closing that modal without confirming
  // aborts -- `updateTarget` is simply cleared, `runMcpUpdate` never runs.
  const startMcpUpdate = useCallback(
    async (toUpdate: readonly McpInstall[]): Promise<void> => {
      const first = toUpdate[0];
      if (first === undefined) return;
      const project = projects.find((p) => p.id === first.projectId);
      if (project === undefined) return;
      const preset = matchMcpPreset(first, mcpPresets);
      if (preset === undefined) return;
      const results = await Promise.all(
        toUpdate.map((inst) =>
          bridgeClient.mcpUpdatePreflight({
            projectId: project.id,
            projectPath: project.path,
            agent: inst.agent,
            instanceName: inst.instanceName,
            def: preset.def,
          }),
        ),
      );
      const missing = new Set<string>();
      for (const r of results) {
        if (!r.ok) {
          notify(r.error, 'error');
          return;
        }
        for (const p of r.missingParams) missing.add(p);
      }
      if (missing.size === 0) {
        await runMcpUpdate(toUpdate, {});
        return;
      }
      setUpdateTarget({ project, installs: toUpdate, missingParams: [...missing].sort() });
    },
    [projects, mcpPresets, notify, runMcpUpdate],
  );

  // Removes one leaf's installed instances (installed or unlinked): all share
  // the same project (the tree groups installs by project node), so the first
  // instance's `projectId` resolves the batch's target.
  const removeInstalls = useCallback(
    async (toRemove: readonly McpInstall[]): Promise<void> => {
      const first = toRemove[0];
      if (first === undefined) return;
      const project = projects.find((p) => p.id === first.projectId);
      if (project === undefined) return;
      const result = await applyMcp({
        projectId: project.id,
        projectPath: project.path,
        batches: buildRemoveBatches(toRemove),
      });
      if (!result.ok) notify(result.error, 'error');
    },
    [projects, applyMcp, notify],
  );

  const requestDeleteInstalls = useCallback(
    (name: string, installs: readonly McpInstall[]): void => {
      setDeleteTarget({ name, onConfirm: () => void removeInstalls(installs) });
    },
    [removeInstalls],
  );

  // Routed from `McpEditModal`'s Delete button: the confirm modal is shared
  // with the tree leaves' own Delete badges, so the cascade uninstall + the
  // config-entry removal both go through the store's `deleteMcpPreset`.
  const requestDeletePreset = useCallback(
    (preset: ManualMcpPreset): void => {
      setDeleteTarget({ name: preset.name, onConfirm: () => void deleteMcpPreset(preset.id) });
    },
    [deleteMcpPreset],
  );

  const openDetails = useCallback(
    (item: McpTreeItem): void => {
      const preset = resolveDetailsPreset(item, mcpPresets);
      if (preset !== undefined) setDetailsPreset(preset);
    },
    [mcpPresets],
  );

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
              {item.updatable && renderBadge(t('mcp.update'), 'accent', () => void startMcpUpdate(item.installs))}
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

  // The details modal's body: reuses `McpCard` as-is (same props the old
  // card-grid page passed) -- Edit (manual only) and Install stay available
  // here too, both closing the details modal first since they open their own
  // modal on top of it.
  function renderDetailsCard(preset: McpPreset): ReactNode {
    const connection = mcpConnectionFromDef(preset.def);
    const repoName = repoNameFor(preset);
    return (
      <McpCard
        name={preset.name}
        repoName={repoName}
        goToRepoLabel={t('mcp.goToRepository')}
        onGoToRepo={
          preset.repoId !== undefined
            ? () => {
                focusRepository(preset.repoId!);
                setDetailsPreset(null);
              }
            : undefined
        }
        protocol={preset.def.type}
        protocolLabel={t(`mcp.protocol.${preset.def.type}`)}
        hasRules={preset.hasRules}
        rulesLabel={t('mcp.rulesBadge')}
        url={connection.url}
        command={connection.command}
        copyLabel={t('mcp.copy')}
        onCopyUrl={connection.url !== undefined ? () => copy(connection.url!) : undefined}
        onCopyCommand={connection.command !== undefined ? () => copy(connection.command!) : undefined}
        onEdit={
          preset.origin === 'manual'
            ? () => {
                openEdit(preset);
                setDetailsPreset(null);
              }
            : undefined
        }
        editLabel={t('mcp.edit')}
        onInstall={() => {
          setDetailsPreset(null);
          openInstall(preset);
        }}
        installLabel={t('mcp.install')}
      />
    );
  }

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

      <McpEditModal
        open={editOpen}
        preset={editingPreset}
        onDelete={requestDeletePreset}
        onClose={() => setEditOpen(false)}
      />
      <McpInstallModal
        open={installTarget !== null}
        preset={installTarget?.preset ?? EMPTY_MCP_PRESET}
        preselectedProjectId={installTarget?.projectId}
        onClose={() => setInstallTarget(null)}
      />
      <McpUpdateParamsModal
        open={updateTarget !== null}
        missingParams={updateTarget?.missingParams ?? []}
        onConfirm={(values) => {
          const target = updateTarget;
          setUpdateTarget(null);
          if (target !== null) void runMcpUpdate(target.installs, values);
        }}
        onClose={() => setUpdateTarget(null)}
      />
      <Modal
        open={detailsPreset !== null}
        onClose={() => setDetailsPreset(null)}
        title={t('mcp.detailsTitle')}
        className="sk-mcp-details"
      >
        {detailsPreset !== null && renderDetailsCard(detailsPreset)}
      </Modal>
      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={deleteTarget !== null ? t('mcp.deleteConfirmTitle', { name: deleteTarget.name }) : ''}
        className="sk-mcp-confirm"
      >
        {deleteTarget !== null && (
          <div className="sk-mcp-confirm__body">
            <p>{t('mcp.deleteConfirmBody')}</p>
            <div className="sk-mcp-confirm__actions">
              <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
                {t('mcp.cancel')}
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  deleteTarget.onConfirm();
                  setDeleteTarget(null);
                }}
              >
                {t('mcp.delete')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Page>
  );
}
