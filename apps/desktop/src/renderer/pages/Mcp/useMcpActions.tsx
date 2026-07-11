/**
 * Shared MCP action logic + modals, extracted from `McpPage` so upcoming
 * pages (Components, Management) can reuse the same create/edit/install/
 * update/delete flows and their five modals without duplicating them. This
 * hook owns exactly what `McpPage` used to own directly: the store hooks the
 * actions need, the action callbacks themselves, the modal STATE, and the
 * modal JSX -- tree building/decoration stays in each consuming page.
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { useSkillkeeperStore, matchMcpPreset } from '@/app/store';
import type { McpPreset } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { bridgeClient } from '@/services/bridge';
import type { McpInstall, McpUpdateReq, Project } from '@/services/bridge';
import { Button, Modal } from '@/shared/ui';
import { McpCard } from '@/entities/mcp';
import { McpEditModal } from '@/features/mcpEdit';
import type { ManualMcpPreset } from '@/features/mcpEdit';
import { McpInstallModal, McpUpdateParamsModal, buildRemoveBatches } from '@/features/mcpInstall';
import type { McpTreeItem } from './lib/mcpTree';
import { resolveDetailsPreset } from './lib/mcpItemPreset';
import { mcpConnectionFromDef, toManualPreset } from './lib/mcpPresetMapping';

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

export interface McpActions {
  openCreate(): void;
  openEdit(preset: McpPreset): void;
  openInstall(preset: McpPreset, projectId?: string): void;
  startMcpUpdate(installs: readonly McpInstall[]): void;
  requestDeleteInstalls(name: string, installs: readonly McpInstall[]): void;
  openDetails(item: McpTreeItem): void;
  /** Renders all five modals (edit, install, update-params, details, delete-confirm). */
  modals: ReactNode;
}

/**
 * Owns the MCP action callbacks and their five modals: `McpEditModal`,
 * `McpInstallModal`, `McpUpdateParamsModal`, a details `Modal` (reuses
 * `McpCard`), and a delete-confirm `Modal`. Any tree/list page that needs to
 * create, edit, install, update, or delete MCP presets/instances can call
 * this hook and wire its openers into that page's own leaf badges, then
 * render `modals` once alongside its own JSX.
 */
export function useMcpActions(): McpActions {
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const projects = useSkillkeeperStore((s) => s.projects);
  const applyMcp = useSkillkeeperStore((s) => s.applyMcp);
  const updateMcp = useSkillkeeperStore((s) => s.updateMcp);
  const deleteMcpPreset = useSkillkeeperStore((s) => s.deleteMcpPreset);
  const focusRepository = useSkillkeeperStore((s) => s.focusRepository);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

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
  const startMcpUpdateAsync = useCallback(
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

  const startMcpUpdate = useCallback(
    (toUpdate: readonly McpInstall[]): void => {
      void startMcpUpdateAsync(toUpdate);
    },
    [startMcpUpdateAsync],
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

  const modals: ReactNode = (
    <>
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
    </>
  );

  return {
    openCreate,
    openEdit,
    openInstall,
    startMcpUpdate,
    requestDeleteInstalls,
    openDetails,
    modals,
  };
}
