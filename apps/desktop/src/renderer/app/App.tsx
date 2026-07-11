/**
 * Root application component.
 *
 * Renders: a sidebar for navigation, the config-validity banner, and a
 * placeholder content area that shows the selected view. No router library is
 * used for the v1 shell -- a simple useState drives view selection.
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { cx } from '@/shared/lib';
import { bridgeClient } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { useTheme } from '@/systems/theme';
import { useConfigWatch } from '@/systems/config';
import { useUpdateSchedule } from '@/systems/updates';
import { useProjectCheckSchedule } from '@/systems/projects';
import { ConfigBanner } from '@/features/configBanner';
import { RepositoriesPage } from '@/pages/Repositories';
import { SkillsPage } from '@/pages/Skills';
import { ProjectsPage } from '@/pages/Projects';
import { ComponentsPage, ManagementPage } from '@/pages/Mcp';
import { SettingsPage } from '@/pages/Settings';
import { Sidebar, SidebarItem, Icon, Spinner } from '@/shared/ui';
import { Toasts, StatusBar, LogsPage } from '@/systems/notifications';
import { TerminalPage } from '@/systems/terminal';
import { TasksPage } from '@/systems/tasks';
import './App.scss';

type View = 'repositories' | 'skills' | 'projects' | 'mcp-components' | 'mcp-management' | 'settings';

// The MCP nav item is rendered separately (as a two-level group) since it
// does not map 1:1 to a single `View` -- see the MCP group block in the
// Sidebar JSX below.
const NAV_ITEMS: {
  id: 'projects' | 'repositories' | 'skills';
  key: 'nav.projects' | 'nav.repositories' | 'nav.skills';
}[] = [
  { id: 'projects', key: 'nav.projects' },
  { id: 'repositories', key: 'nav.repositories' },
  { id: 'skills', key: 'nav.skills' },
];

export function App() {
  useTheme();
  useConfigWatch();
  useUpdateSchedule();
  useProjectCheckSchedule();
  const [activeView, setActiveView] = useState<View>('repositories');
  const loadAll = useSkillkeeperStore((s) => s.loadAll);
  const loading = useSkillkeeperStore((s) => s.loading);
  const error = useSkillkeeperStore((s) => s.error);
  const addRepoRequest = useSkillkeeperStore((s) => s.addRepoRequest);
  const skillsNav = useSkillkeeperStore((s) => s.skillsNav);
  const repoFocus = useSkillkeeperStore((s) => s.repoFocus);
  const t = useTranslator();
  // The MCP nav group is a pure expand/collapse toggle (local, ephemeral):
  // clicking the header opens/closes its sub-items; navigation happens only
  // through the sub-items. No "remember last sub-page" -- clicking the header
  // never navigates.
  const [mcpOpen, setMcpOpen] = useState(false);

  useEffect(() => {
    void loadAll(bridgeClient);
  }, [loadAll]);

  // An add-repository request (e.g. from an unlinked skill) switches to the
  // Repositories view; RepoAddButton then opens the prefilled form and clears it.
  useEffect(() => {
    if (addRepoRequest !== null) setActiveView('repositories');
  }, [addRepoRequest]);

  // A "go to skills" request (from a project/repository card) switches to the
  // Skills view; the store already set the mode/filters. Nonce-driven so a repeat
  // request re-fires even when already on the page.
  useEffect(() => {
    if (skillsNav > 0) setActiveView('skills');
  }, [skillsNav]);

  // A "focus this repository" request (e.g. from an MCP preset's source-repo
  // badge) switches to the Repositories view; RepositoriesPage scrolls the
  // matching card into view and applies a transient highlight. Bumped by a
  // nonce so a repeat request for the same repo re-fires, mirroring skillsNav.
  useEffect(() => {
    if (repoFocus !== null) setActiveView('repositories');
  }, [repoFocus]);

  // A background ssh auth failure requests the terminal (for the passphrase
  // prompt); subscribed once for the app's lifetime.
  useEffect(() => {
    const off = bridgeClient.onTerminalRequestOpen(() => {
      useSkillkeeperStore.getState().openTerminal();
    });
    return off;
  }, []);

  function renderView() {
    switch (activeView) {
      case 'repositories':
        return <RepositoriesPage />;
      case 'skills':
        return <SkillsPage />;
      case 'projects':
        return <ProjectsPage />;
      case 'mcp-components':
        return <ComponentsPage />;
      case 'mcp-management':
        return <ManagementPage />;
      case 'settings':
        return <SettingsPage />;
    }
  }

  return (
    <div className="sk-app">
      <ConfigBanner />
      <div className="sk-shell">
        <Sidebar title={t('app.title')}>
          {NAV_ITEMS.map(({ id, key }) => (
            <SidebarItem
              key={id}
              icon={<Icon name={id} />}
              active={activeView === id}
              onClick={() => setActiveView(id)}
            >
              {t(key)}
            </SidebarItem>
          ))}

          {/* MCP: a group header + two sub-pages, composed here (the shared
              Sidebar/SidebarItem stay generic). The header is a pure
              expand/collapse TOGGLE -- clicking it opens/closes the sub-items
              (never navigates and never carries the selected background); the
              trailing chevron rotates and the sub-group animates its height.
              Navigation lives on the sub-items. */}
          <SidebarItem
            icon={<Icon name="mcp" />}
            className={cx('sk-sidebar-item--group', mcpOpen && 'sk-sidebar-item--group--open')}
            onClick={() => setMcpOpen((open) => !open)}
          >
            {t('nav.mcp')}
            <Icon name="chevron-right" size={14} className="sk-nav-group__chevron" />
          </SidebarItem>
          <AnimatePresence initial={false}>
            {mcpOpen && (
              <motion.div
                key="mcp-subgroup"
                className="sk-nav-subgroup"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              >
                <SidebarItem
                  className="sk-sidebar-item--sub"
                  active={activeView === 'mcp-components'}
                  onClick={() => setActiveView('mcp-components')}
                >
                  {t('mcp.componentsTitle')}
                </SidebarItem>
                <SidebarItem
                  className="sk-sidebar-item--sub"
                  active={activeView === 'mcp-management'}
                  onClick={() => setActiveView('mcp-management')}
                >
                  {t('mcp.managementTitle')}
                </SidebarItem>
              </motion.div>
            )}
          </AnimatePresence>

          <SidebarItem
            icon={<Icon name="settings" />}
            active={activeView === 'settings'}
            onClick={() => setActiveView('settings')}
          >
            {t('nav.settings')}
          </SidebarItem>
        </Sidebar>

        <div className="sk-content">
          {loading && (
            <div className="sk-state">
              <Spinner label={t('common.loading')} />
            </div>
          )}
          {error !== null && (
            <div role="alert" className="sk-state sk-state--error">
              {t('common.errorPrefix', { message: error })}
            </div>
          )}
          {!loading && renderView()}
        </div>
      </div>
      <StatusBar />
      <Toasts />
      <LogsPage />
      <TerminalPage />
      <TasksPage />
    </div>
  );
}
