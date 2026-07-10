/**
 * MCP page: a responsive grid of MCP server presets (manual + repo-discovered)
 * with an "Add MCP" action and a search box, mirroring RepositoriesPage/
 * ProjectsPage's mount-refresh + card-grid + toolbar-search structure. See
 * design spec "MCP support" section 7.
 */
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import type { McpPreset } from '@/app/store';
import { useTranslator } from '@/systems/i18n';
import { McpCard } from '@/entities/mcp';
import { McpEditModal } from '@/features/mcpEdit';
import type { ManualMcpPreset } from '@/features/mcpEdit';
import { McpInstallModal } from '@/features/mcpInstall';
import { Page, Toolbar, Button, SearchField, SearchSummary } from '@/shared/ui';
import { fuzzyFilter, fade } from '@/shared/lib';
import { mcpConnectionFromDef, mcpSearchFields, toManualPreset } from './lib/mcpPresetMapping';
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
  const [query, setQuery] = useState('');

  // Presets and installed instances are local/cheap -- refresh both on mount,
  // mirroring RepositoriesPage/ProjectsPage's mount-refresh pattern.
  useEffect(() => {
    void refreshMcpPresets();
    void refreshMcpInstalls();
  }, [refreshMcpPresets, refreshMcpInstalls]);

  function copy(text: string): void {
    void navigator.clipboard.writeText(text);
    notify(t('mcp.copiedToClipboard'), 'info');
  }

  function openCreate(): void {
    setEditingPreset(undefined);
    setEditOpen(true);
  }

  function openEdit(preset: McpPreset): void {
    setEditingPreset(toManualPreset(preset));
    setEditOpen(true);
  }

  function repoNameFor(preset: McpPreset): string | undefined {
    return preset.repoId !== undefined ? repositories.find((r) => r.id === preset.repoId)?.name : undefined;
  }

  // Fuzzy search by name, transport, source repository, and connection
  // endpoint (URL or command). The field only appears once there are at
  // least two cards to sift through, mirroring ProjectsPage/RepositoriesPage.
  const searching = query.trim() !== '';
  const filtered = fuzzyFilter(mcpPresets, query, (p) => mcpSearchFields(p, repoNameFor(p)));

  const trailing = (
    <>
      {mcpPresets.length >= 2 && (
        <SearchField
          className="sk-list-search"
          placeholder={t('common.search')}
          aria-label={t('common.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery('')}
        />
      )}
      <Button variant="primary" glass onClick={openCreate}>
        {t('mcp.add')}
      </Button>
    </>
  );

  return (
    <Page toolbar={<Toolbar title={t('nav.mcp')} trailing={trailing} />}>
      {mcpPresets.length === 0 ? (
        <p className="sk-empty">{t('mcp.empty')}</p>
      ) : (
        <>
        <div className="sk-mcp-grid">
          {filtered.map((preset) => {
            const connection = mcpConnectionFromDef(preset.def);
            const repoName = repoNameFor(preset);
            return (
              <McpCard
                key={preset.id}
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
                onInstall={() => setInstallingPreset(preset)}
                installLabel={t('mcp.install')}
              />
            );
          })}
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
                foundLabel={t.plural('mcp.searchFound', filtered.length)}
                totalLabel={t.plural('mcp.searchTotal', mcpPresets.length)}
                showAllLabel={t('mcp.showAll')}
                onShowAll={() => setQuery('')}
              />
            </motion.div>
          )}
        </AnimatePresence>
        </>
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
