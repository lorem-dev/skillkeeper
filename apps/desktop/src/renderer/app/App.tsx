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
import { useAppUpdateSchedule, UpdateAvailableDialog, UpdateReadyDialog } from '@/systems/appUpdate';
import { useProjectCheckSchedule } from '@/systems/projects';
import { ConfigBanner } from '@/features/configBanner';
import { WindowChrome } from './WindowChrome';
import { dismissPreloader } from './preloader';
import { hostPlatform } from './hostPlatform';
import { type View, VIEW_LOADERS, preloadView, isView, groupForView } from './navigation';
import { Sidebar, SidebarItem, Icon, Spinner } from '@/shared/ui';
import { Toasts, StatusBar, LogsPage } from '@/systems/notifications';
import { TerminalPage } from '@/systems/terminal';
import { TasksPage } from '@/systems/tasks';
import { AboutDialog, AboutIdentity, AboutFooter } from '@/features/about';
import { OnboardingDemoTree } from '@/features/onboardingDemo';
import { OnboardingOverlay, useOnboardingActive, useOnboardingStep } from '@/systems/onboarding';
import { SshUnlockBlocker } from '@/systems/sshUnlock';
import { SshKeyField } from '@/features/sshKey';
import { STEP_VIEW } from '@/app/config/onboarding';
import './App.scss';

/**
 * Documentation section explaining how to set an ssh-agent up per platform.
 *
 * The `latest` segment is required: the site is versioned by mike, so only the
 * bare root redirects to a version -- a deep path without it is a 404.
 */
const SSH_AGENT_DOCS = 'https://lorem-dev.github.io/skillkeeper/latest/usage/repositories/#setting-up-an-ssh-agent';

const RepositoriesPage = lazy(() => import('@/pages/Repositories').then((m) => ({ default: m.RepositoriesPage })));
const SkillsComponentsPage = lazy(() => import('@/pages/Skills').then((m) => ({ default: m.SkillsComponentsPage })));
const SkillsManagementPage = lazy(() => import('@/pages/Skills').then((m) => ({ default: m.SkillsManagementPage })));
const ProjectsPage = lazy(() => import('@/pages/Projects').then((m) => ({ default: m.ProjectsPage })));
const ComponentsPage = lazy(() => import('@/pages/Mcp').then((m) => ({ default: m.ComponentsPage })));
const ManagementPage = lazy(() => import('@/pages/Mcp').then((m) => ({ default: m.ManagementPage })));
const SettingsPage = lazy(() => import('@/pages/Settings').then((m) => ({ default: m.SettingsPage })));

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
  useAppUpdateSchedule();
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
  const appUpdateNav = useSkillkeeperStore((s) => s.appUpdateNav);
  const settingsAppUpdatesNav = useSkillkeeperStore((s) => s.settingsAppUpdatesNav);
  const onboardingActive = useOnboardingActive();
  const onboardingStep = useOnboardingStep();
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

  // An update dialog takes over the window: it closes the other overlays (the
  // store's open actions do that) and brings the backdrop to Projects, so the
  // user is not left looking at a page that is about to be replaced.
  useEffect(() => {
    if (appUpdateNav > 0) goTo('projects');
  }, [appUpdateNav, goTo]);

  // The macOS Help menu's "Check for Updates" item requests Settings; the
  // page itself scrolls its "Application updates" section into view (see
  // `settingsAppUpdatesNav` in the store), mirroring `repoFocus`'s
  // nonce-plus-self-scroll shape.
  useEffect(() => {
    if (settingsAppUpdatesNav > 0) goTo('settings');
  }, [settingsAppUpdatesNav, goTo]);

  // A background ssh auth failure requests the terminal (for the passphrase
  // prompt); subscribed once for the app's lifetime.
  //
  // With no ssh-agent to hold the key, that prompt returns on every single
  // operation, which reads as the app being broken rather than as a machine
  // that needs setting up. Say so once per session, with a link to the
  // instructions -- checked here rather than at startup because an agent can be
  // started (or a key added) while the app is running.
  const sshAgentWarned = useRef(false);
  useEffect(() => {
    const off = bridgeClient.onTerminalRequestOpen(() => {
      const store = useSkillkeeperStore.getState();
      store.openTerminal();
      if (sshAgentWarned.current) return;
      // A held (unlocked) or unencrypted key already answers passphrase
      // prompts on the app's behalf, so the agent advice would be wrong --
      // check the key's state alongside the agent before deciding to warn. A
      // PuTTY key already loaded into an agent (`puttyInAgent`) is the same
      // case by another name; the other PuTTY states still need an agent, so
      // they are not included here. A failed key-state read must not
      // suppress the notice: fall back to `null` (treated as "cannot rule it
      // out") rather than letting the whole `Promise.all` reject and
      // silently drop the check.
      void Promise.all([bridgeClient.sshAgentAvailable(), bridgeClient.sshKeyState().catch(() => null)]).then(
        ([available, keyState]) => {
          if (available || sshAgentWarned.current) return;
          if (
            keyState !== null &&
            (keyState.state === 'unlocked' || keyState.state === 'unencrypted' || keyState.state === 'puttyInAgent')
          ) {
            return;
          }
          sshAgentWarned.current = true;
          store.notify({ key: 'ssh.noAgent' }, 'info', undefined, SSH_AGENT_DOCS);
        },
      );
    });
    return off;
  }, []);

  // Application-menu items (macOS) and the Cmd+,/Ctrl+, Settings shortcut arrive
  // as 'menu:navigate' events. Route them through the same goTo the sidebar uses,
  // opening the matching group so a Skills/MCP sub-page is visible in the sidebar.
  useEffect(() => {
    const off = bridgeClient.onMenuNavigate((view) => {
      if (!isView(view)) return;
      goTo(view);
      const group = groupForView(view);
      if (group === 'skills') setSkillsOpen(true);
      else if (group === 'mcp') setMcpOpen(true);
    });
    return off;
  }, [goTo]);

  // The application menu's About item (macOS) arrives as a 'menu:about' event;
  // subscribed once for the app's lifetime, mirroring onTerminalRequestOpen.
  useEffect(() => {
    const off = bridgeClient.onMenuAbout(() => {
      useSkillkeeperStore.getState().openAbout();
    });
    return off;
  }, []);

  // While onboarding is active, keep the backdrop on the step's view (and the
  // Skills group open behind the scrim during its steps, so the sidebar stays
  // consistent). The overlay swallows clicks, so the user cannot navigate away
  // regardless.
  useEffect(() => {
    if (!onboardingActive) return;
    const view = STEP_VIEW[onboardingStep];
    goTo(view);
    if (view === 'skills-management') setSkillsOpen(true);
  }, [onboardingActive, onboardingStep, goTo]);

  // macOS Help menu toggle: start or skip based on current mode.
  useEffect(() => {
    const off = bridgeClient.onMenuOnboardingToggle(() => {
      const s = useSkillkeeperStore.getState();
      if (s.onboarding.active) s.skipOnboarding();
      else s.startOnboarding();
    });
    return off;
  }, []);

  // macOS Help menu's "Check for Updates" item; subscribed once for the app's
  // lifetime, mirroring onMenuOnboardingToggle.
  useEffect(() => {
    const off = bridgeClient.onMenuCheckForUpdates(() => {
      useSkillkeeperStore.getState().focusAppUpdatesSettings();
    });
    return off;
  }, []);

  // Keep the native menu's label + enabled state in sync with onboarding mode.
  useEffect(() => {
    bridgeClient.onboardingMenuSync(onboardingActive);
  }, [onboardingActive]);

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
      <div
        className={cx('sk-app', `sk-app--${platform}`, onboardingActive && 'sk-app--onboarding')}
        data-anim={animationMode}
      >
        <WindowChrome />
        <ConfigBanner />
        <div className="sk-shell">
          {/* The sidebar carries no app title on any platform (matching macOS):
            the app title lives in the top bar (WindowChrome/TitleBar) on
            Windows/Linux, and macOS shows none. On macOS the sidebar top is the
            drag/traffic-light zone, so it renders a draggable panel there. */}
          <Sidebar dragRegion={platform === 'mac'}>
            {NAV_ITEMS.map(({ id, key }) => (
              <SidebarItem key={id} icon={<Icon name={id} />} active={activeView === id} onClick={() => goTo(id)}>
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
        <AboutDialog />
        <UpdateAvailableDialog />
        <UpdateReadyDialog />
        <OnboardingOverlay
          aboutIdentity={<AboutIdentity showTagline={false} />}
          aboutFooter={<AboutFooter />}
          renderDemoTree={(variant) => <OnboardingDemoTree variant={variant} />}
          sshKeyField={<SshKeyField />}
        />
        {/* Last, and portaled to the body from there: while the passphrase prompt
          is up, this window takes no interaction at all -- including the
          onboarding tour above and the portaled menus/tooltips outside. */}
        <SshUnlockBlocker />
      </div>
    </AnimationProvider>
  );
}
