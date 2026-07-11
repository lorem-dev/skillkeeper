/**
 * Root application component.
 *
 * Renders: a sidebar for navigation, the config-validity banner, and a
 * placeholder content area that shows the selected view. No router library is
 * used for the v1 shell -- a simple useState drives view selection.
 */
import { useState, useEffect } from 'react';
import { useSkillkeeperStore } from '@/app/store';
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
  const mcpUi = useSkillkeeperStore((s) => s.mcpUi);
  const setMcpUi = useSkillkeeperStore((s) => s.setMcpUi);
  const t = useTranslator();

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

  const mcpActive = activeView === 'mcp-components' || activeView === 'mcp-management';

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

          {/* MCP: a group header + two sub-pages, built here (not inside the
              shared Sidebar/SidebarItem, which stay generic). The header
              navigates to whichever sub-page was last visited (default:
              Components) and is "active" while either sub-view is showing;
              its sub-items only appear while the group is active, mirroring
              a typical collapsed/expanded nav group. */}
          <SidebarItem
            icon={<Icon name="mcp" />}
            active={mcpActive}
            onClick={() => setActiveView(mcpUi.lastSubPage === 'management' ? 'mcp-management' : 'mcp-components')}
          >
            {t('nav.mcp')}
          </SidebarItem>
          {mcpActive && (
            <>
              <SidebarItem
                className="sk-sidebar-item--sub"
                active={activeView === 'mcp-components'}
                onClick={() => {
                  setActiveView('mcp-components');
                  setMcpUi({ lastSubPage: 'components' });
                }}
              >
                {t('mcp.componentsTitle')}
              </SidebarItem>
              <SidebarItem
                className="sk-sidebar-item--sub"
                active={activeView === 'mcp-management'}
                onClick={() => {
                  setActiveView('mcp-management');
                  setMcpUi({ lastSubPage: 'management' });
                }}
              >
                {t('mcp.managementTitle')}
              </SidebarItem>
            </>
          )}

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
