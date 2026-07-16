/**
 * Root application component.
 *
 * Renders: a sidebar for navigation, the config-validity banner, and a
 * placeholder content area that shows the selected view. No router library is
 * used for the v1 shell -- a simple useState drives view selection.
 */
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useSkillkeeperStore } from '@/app/store';
import { cx, AnimationProvider } from '@/shared/lib';
import { bridgeClient } from '@/services/bridge';
import { useTranslator } from '@/systems/i18n';
import { useTheme } from '@/systems/theme';
import { useConfigWatch } from '@/systems/config';
import { useUpdateSchedule } from '@/systems/updates';
import { useProjectCheckSchedule } from '@/systems/projects';
import { ConfigBanner } from '@/features/configBanner';
import { WindowChrome } from './WindowChrome';
import { dismissPreloader } from './preloader';
import { hostPlatform } from './hostPlatform';
import { type View, VIEW_LOADERS, preloadView } from './navigation';
import { Sidebar, SidebarItem, Icon, Spinner } from '@/shared/ui';
import { Toasts, StatusBar, LogsPage } from '@/systems/notifications';
import { TerminalPage } from '@/systems/terminal';
import { TasksPage } from '@/systems/tasks';
import './App.scss';

const RepositoriesPage = lazy(() =>
  import('@/pages/Repositories').then((m) => ({ default: m.RepositoriesPage })),
);
const SkillsComponentsPage = lazy(() =>
  import('@/pages/Skills').then((m) => ({ default: m.SkillsComponentsPage })),
);
const SkillsManagementPage = lazy(() =>
  import('@/pages/Skills').then((m) => ({ default: m.SkillsManagementPage })),
);
const ProjectsPage = lazy(() =>
  import('@/pages/Projects').then((m) => ({ default: m.ProjectsPage })),
);
const ComponentsPage = lazy(() =>
  import('@/pages/Mcp').then((m) => ({ default: m.ComponentsPage })),
);
const ManagementPage = lazy(() =>
  import('@/pages/Mcp').then((m) => ({ default: m.ManagementPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })),
);

// Skills and MCP are rendered separately (each as a two-level group) since
// they do not map 1:1 to a single `View` -- see their group blocks in the
// Sidebar JSX below.
const NAV_ITEMS: {
  id: 'projects' | 'repositories';
  key: 'nav.projects' | 'nav.repositories';
}[] = [
  { id: 'projects', key: 'nav.projects' },
  { id: 'repositories', key: 'nav.repositories' },
];

export function App() {
  useTheme();
  useConfigWatch();
  useUpdateSchedule();
  useProjectCheckSchedule();
  const [activeView, setActiveView] = useState<View>('projects');
  const animationMode = useSkillkeeperStore((s) => s.config?.general.animations ?? 'normal');
  const loadAll = useSkillkeeperStore((s) => s.loadAll);
  const loading = useSkillkeeperStore((s) => s.loading);
  const error = useSkillkeeperStore((s) => s.error);
  const addRepoRequest = useSkillkeeperStore((s) => s.addRepoRequest);
  const skillsNav = useSkillkeeperStore((s) => s.skillsNav);
  const mcpNav = useSkillkeeperStore((s) => s.mcpNav);
  const repoFocus = useSkillkeeperStore((s) => s.repoFocus);
  const t = useTranslator();
  // The Skills and MCP nav groups are pure expand/collapse toggles (local,
  // ephemeral): clicking a header opens/closes its sub-items; navigation
  // happens only through the sub-items. No "remember last sub-page" -- clicking
  // a header never navigates.
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const initialLoadStarted = useRef(false);

  // Load-then-swap navigation: fetch the target page's chunk, THEN switch. The
  // current page stays on screen until the next module resolves (no spinner);
  // local chunk loads are fast. Every activeView change routes through this.
  const goTo = useCallback((view: View) => {
    void preloadView(view).then(() => setActiveView(view));
  }, []);

  useEffect(() => {
    void VIEW_LOADERS.projects();
    void loadAll(bridgeClient);
  }, [loadAll]);

  // Reveal the app by dismissing the hardcoded startup preloader once the
  // initial load settles (loading goes true then false). This effect runs after
  // the loaded content is committed, so the reveal never flashes an unloaded
  // frame. Fades over 300ms unless animations are off; dismissPreloader is
  // idempotent, so a later reload's loading cycle is a harmless no-op.
  useEffect(() => {
    if (loading) {
      initialLoadStarted.current = true;
      return;
    }
    if (initialLoadStarted.current) {
      dismissPreloader(animationMode !== 'off');
    }
  }, [loading, animationMode]);

  // An add-repository request (e.g. from an unlinked skill) switches to the
  // Repositories view; RepoAddButton then opens the prefilled form and clears it.
  useEffect(() => {
    if (addRepoRequest !== null) goTo('repositories');
  }, [addRepoRequest, goTo]);

  // A "go to skills" request (from a project/repository card) switches to the
  // matching Skills sub-page -- Management for the projects mode, Components for
  // the repositories mode -- reading the mode the store already set alongside
  // the filters, and opens the Skills group so the active sub-item is visible.
  // Nonce-driven so a repeat request re-fires even when already on the page.
  useEffect(() => {
    if (skillsNav > 0) {
      const mode = useSkillkeeperStore.getState().skillsUi.mode;
      goTo(mode === 'projects' ? 'skills-management' : 'skills-components');
      setSkillsOpen(true);
    }
  }, [skillsNav, goTo]);

  // A "go to MCP" request (from a repository card -> Components filtered by the
  // repo, or a project card -> Management filtered by the project) switches to
  // the sub-page named by `mcpNavView` (the store already set the matching
  // filter) and opens the MCP group. Nonce-driven, mirroring skillsNav.
  useEffect(() => {
    if (mcpNav > 0) {
      goTo(useSkillkeeperStore.getState().mcpNavView);
      setMcpOpen(true);
    }
  }, [mcpNav, goTo]);

  // A "focus this repository" request (e.g. from an MCP preset's source-repo
  // badge) switches to the Repositories view; RepositoriesPage scrolls the
  // matching card into view and applies a transient highlight. Bumped by a
  // nonce so a repeat request for the same repo re-fires, mirroring skillsNav.
  useEffect(() => {
    if (repoFocus !== null) goTo('repositories');
  }, [repoFocus, goTo]);

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
      case 'skills-components':
        return <SkillsComponentsPage />;
      case 'skills-management':
        return <SkillsManagementPage />;
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

  const platform = hostPlatform(bridgeClient.platform);

  return (
    <AnimationProvider mode={animationMode}>
    <div className={cx('sk-app', `sk-app--${platform}`)} data-anim={animationMode}>
      <WindowChrome />
      <ConfigBanner />
      <div className="sk-shell">
        {/* On macOS the sidebar top is the drag/traffic-light zone: drop the
            app-title header there and render a draggable panel instead; other
            platforms keep the title and no drag region. */}
        <Sidebar
          title={platform === 'mac' ? undefined : t('app.title')}
          dragRegion={platform === 'mac'}
        >
          {NAV_ITEMS.map(({ id, key }) => (
            <SidebarItem
              key={id}
              icon={<Icon name={id} />}
              active={activeView === id}
              onClick={() => goTo(id)}
            >
              {t(key)}
            </SidebarItem>
          ))}

          {/* Skills: a group header + two sub-pages (Components / Management),
              composed here exactly like the MCP group below. The header is a
              pure expand/collapse TOGGLE; navigation lives on the sub-items. */}
          <SidebarItem
            icon={<Icon name="skills" />}
            className={cx('sk-sidebar-item--group', skillsOpen && 'sk-sidebar-item--group--open')}
            onClick={() => setSkillsOpen((open) => !open)}
          >
            {t('nav.skills')}
            <Icon name="chevron-right" size={14} className="sk-nav-group__chevron" />
          </SidebarItem>
          <AnimatePresence initial={false}>
            {skillsOpen && (
              <motion.div
                key="skills-subgroup"
                className="sk-nav-subgroup"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
              >
                <SidebarItem
                  className="sk-sidebar-item--sub"
                  active={activeView === 'skills-components'}
                  onClick={() => goTo('skills-components')}
                >
                  {t('skills.componentsTitle')}
                </SidebarItem>
                <SidebarItem
                  className="sk-sidebar-item--sub"
                  active={activeView === 'skills-management'}
                  onClick={() => goTo('skills-management')}
                >
                  {t('skills.managementTitle')}
                </SidebarItem>
              </motion.div>
            )}
          </AnimatePresence>

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
                  onClick={() => goTo('mcp-components')}
                >
                  {t('mcp.componentsTitle')}
                </SidebarItem>
                <SidebarItem
                  className="sk-sidebar-item--sub"
                  active={activeView === 'mcp-management'}
                  onClick={() => goTo('mcp-management')}
                >
                  {t('mcp.managementTitle')}
                </SidebarItem>
              </motion.div>
            )}
          </AnimatePresence>

          <SidebarItem
            icon={<Icon name="settings" />}
            active={activeView === 'settings'}
            onClick={() => goTo('settings')}
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
          {!loading && <Suspense fallback={null}>{renderView()}</Suspense>}
        </div>
      </div>
      <StatusBar />
      <Toasts />
      <LogsPage />
      <TerminalPage />
      <TasksPage />
    </div>
    </AnimationProvider>
  );
}
