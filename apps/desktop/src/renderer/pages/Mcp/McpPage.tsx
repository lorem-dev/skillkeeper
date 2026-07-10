/**
 * MCP page: a responsive grid of MCP server presets (manual + repo-discovered)
 * with an "Add MCP" action, mirroring RepositoriesPage/ProjectsPage's
 * mount-refresh + card-grid structure. See design spec "MCP support" section 7.
 *
 * Text is hardcoded ASCII for now (no i18n keys exist yet for the MCP feature
 * -- task C9 wraps every string below in `t('mcp....')`), matching the
 * "hardcode now, retrofit i18n later" approach already taken by McpCard,
 * McpEditModal, and McpInstallModal (tasks C1-C5).
 */
import { useEffect, useState } from 'react';
import { useSkillkeeperStore } from '@/app/store';
import type { McpPreset } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { McpCard } from '@/entities/mcp';
import { McpEditModal } from '@/features/mcpEdit';
import type { ManualMcpPreset } from '@/features/mcpEdit';
import { McpInstallModal } from '@/features/mcpInstall';
import { Page, Toolbar, Button } from '@/shared/ui';
import { mcpConnectionFromDef, toManualPreset } from './lib/mcpPresetMapping';
import './McpPage.scss';

/**
 * Placeholder passed to `McpInstallModal` while it is closed -- its `preset`
 * prop is required, but the modal's own `open` gate keeps the body (which is
 * the only place `preset` is read) out of the DOM, so this is never shown.
 */
const EMPTY_PRESET: McpPreset = {
  id: '',
  origin: 'manual',
  name: '',
  def: { name: '', type: 'stdio' },
  hash: '',
  params: [],
  hasRules: false,
};

export function McpPage() {
  const mcpPresets = useSkillkeeperStore((s) => s.mcpPresets);
  const repositories = useSkillkeeperStore((s) => s.repositories);
  const refreshMcpPresets = useSkillkeeperStore((s) => s.refreshMcpPresets);
  const refreshMcpInstalls = useSkillkeeperStore((s) => s.refreshMcpInstalls);
  const focusRepository = useSkillkeeperStore((s) => s.focusRepository);
  const notify = useSkillkeeperStore((s) => s.notify);
  const t = useTranslator();

  const [editOpen, setEditOpen] = useState(false);
  const [editingPreset, setEditingPreset] = useState<ManualMcpPreset | undefined>(undefined);
  const [installingPreset, setInstallingPreset] = useState<McpPreset | null>(null);

  // Presets and installed instances are local/cheap -- refresh both on mount,
  // mirroring RepositoriesPage/ProjectsPage's mount-refresh pattern.
  useEffect(() => {
    void refreshMcpPresets();
    void refreshMcpInstalls();
  }, [refreshMcpPresets, refreshMcpInstalls]);

  function copy(text: string): void {
    void navigator.clipboard.writeText(text);
    notify('Copied to clipboard', 'info');
  }

  function openCreate(): void {
    setEditingPreset(undefined);
    setEditOpen(true);
  }

  function openEdit(preset: McpPreset): void {
    setEditingPreset(toManualPreset(preset));
    setEditOpen(true);
  }

  const trailing = (
    <Button variant="primary" glass onClick={openCreate}>
      Add MCP
    </Button>
  );

  return (
    <Page toolbar={<Toolbar title={t('nav.mcp')} trailing={trailing} />}>
      {mcpPresets.length === 0 ? (
        <p className="sk-empty">No MCP servers yet.</p>
      ) : (
        <div className="sk-mcp-grid">
          {mcpPresets.map((preset) => {
            const connection = mcpConnectionFromDef(preset.def);
            const repoName =
              preset.repoId !== undefined ? repositories.find((r) => r.id === preset.repoId)?.name : undefined;
            return (
              <McpCard
                key={preset.id}
                name={preset.name}
                repoName={repoName}
                goToRepoLabel="Go to repository"
                onGoToRepo={preset.repoId !== undefined ? () => focusRepository(preset.repoId!) : undefined}
                protocol={preset.def.type}
                protocolLabel={preset.def.type}
                hasRules={preset.hasRules}
                rulesLabel="rules"
                url={connection.url}
                command={connection.command}
                copyLabel="Copy"
                onCopyUrl={connection.url !== undefined ? () => copy(connection.url!) : undefined}
                onCopyCommand={connection.command !== undefined ? () => copy(connection.command!) : undefined}
                onEdit={preset.origin === 'manual' ? () => openEdit(preset) : undefined}
                editLabel="Edit"
                onInstall={() => setInstallingPreset(preset)}
                installLabel="Install"
              />
            );
          })}
        </div>
      )}
      <McpEditModal open={editOpen} preset={editingPreset} onClose={() => setEditOpen(false)} />
      <McpInstallModal
        open={installingPreset !== null}
        preset={installingPreset ?? EMPTY_PRESET}
        onClose={() => setInstallingPreset(null)}
      />
    </Page>
  );
}
