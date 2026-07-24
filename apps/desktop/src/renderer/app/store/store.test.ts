/**
 * Unit tests for the Zustand store actions.
 *
 * These tests run in Node (no React rendering, no Tauri). They exercise the
 * pure state-mutation logic of each action so we can verify the store behaves
 * correctly without spinning up a browser or a Tauri runtime.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServerDef, BridgeClient } from '@/services/bridge';
import {
  useSkillkeeperStore,
  mcpInstallHasUpdate,
  scanMcpParams,
  normalizeMcpRemote,
  hashMcpDefInRenderer,
} from './store';
import type { SectionValidity, SkillKeeperConfig, Repository, Project, InstallManifest, McpPreset } from './store';
import { bridgeClient } from '@/services/bridge';
import type { RepoResult, RemoveResult, ProjectResult, AvailableMcp, McpInstall } from '@/services/bridge';
import { ONBOARDING_ORDER } from '@/app/config/onboarding';

// The store reaches the Rust backend through the `bridgeClient` singleton, whose
// methods call Tauri `invoke` under the hood -- unavailable in the Node/vitest
// env. Mock the module so the MCP-preset actions (which use the singleton rather
// than a passed-in bridge) can be driven directly. Only the methods those
// actions touch need stubbing; the rest stay bare `vi.fn()`s.
vi.mock('@/services/bridge', () => ({
  bridgeClient: {
    listAvailableMcp: vi.fn(),
    applyMcp: vi.fn(),
    listMcpInstalls: vi.fn(),
    setConfig: vi.fn(),
    syncRepository: vi.fn(),
    repoHasUpdate: vi.fn(),
    describeRepository: vi.fn(),
    setOnboarding: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset the store to its initial state before each test. */
function reset(): void {
  useSkillkeeperStore.setState({
    config: null,
    configValidity: null,
    configWarnings: [],
    repositories: [],
    skills: [],
    projects: [],
    loading: false,
    error: null,
    skillsUi: {
      mode: 'projects',
      query: '',
      repoFilter: [],
      projectFilter: [],
      repoChecked: [],
      projectChecked: [],
      projectAgents: {},
      expandedIds: null,
    },
    mcpUi: {
      mode: 'repositories',
      expandedIds: null,
      componentsView: 'tiles',
      componentsRepoFilter: [],
      managementProjectFilter: [],
    },
  });
}

const validValidity: SectionValidity = {
  general: 'valid',
  updates: 'valid',
  agents: 'valid',
  executables: 'valid',
  security: 'valid',
  notifications: 'valid',
  repositories: 'valid',
  projects: 'valid',
  mcp: 'valid',
};

const partiallyInvalidValidity: SectionValidity = {
  general: 'invalid',
  updates: 'valid',
  agents: 'valid',
  executables: 'valid',
  security: 'valid',
  notifications: 'valid',
  repositories: 'valid',
  projects: 'valid',
  mcp: 'valid',
};

const mockConfig: SkillKeeperConfig = {
  general: { language: 'en', theme: 'system', animations: 'normal' },
  updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
  agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
  executables: { globs: [] },
  security: { hookConsentPolicy: 'always-ask' },
  notifications: { enabled: true },
  repositories: { gitPath: 'git' },
  projects: { checkIntervalMinutes: 1 },
  mcp: { servers: [] },
};

const mockRepo: Repository = {
  id: 'repo-1',
  name: 'My Skills',
  url: 'https://github.com/example/skills',
  kind: 'github',
  transport: 'https',
  lfs: false,
  localPath: '/tmp/skills',
};

const mockProject: Project = {
  id: 'proj-1',
  path: '/home/user/project',
  name: 'My Project',
  addedAt: '2026-01-01T00:00:00.000Z',
};

const mockInstall: InstallManifest = {
  skillId: { name: 'test-skill' },
  target: { agent: 'claude', scope: 'global' },
  destinationRoot: '/tmp/dest',
  installedAt: '2026-01-01T00:00:00.000Z',
  files: [],
  hookEdits: [],
};

/** A project-scoped install (so it seeds the project-mode selection baseline). */
const projectInstall: InstallManifest = {
  skillId: { name: 'fmt' },
  target: { agent: 'claude', scope: 'project', projectId: 'proj-1' },
  destinationRoot: '/tmp/dest',
  sourceRepoId: 'repo-1',
  installedAt: '2026-01-01T00:00:00.000Z',
  files: [],
  hookEdits: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSkillkeeperStore', () => {
  beforeEach(reset);

  describe('setConfig', () => {
    it('stores config, validity, and warnings', () => {
      const warnings = ['Section "general" is invalid; using defaults.'];
      useSkillkeeperStore.getState().setConfig(mockConfig, partiallyInvalidValidity, warnings);

      const state = useSkillkeeperStore.getState();
      expect(state.config).toBe(mockConfig);
      expect(state.configValidity).toEqual(partiallyInvalidValidity);
      expect(state.configWarnings).toEqual(warnings);
    });

    it('stores empty warnings array when config is valid', () => {
      useSkillkeeperStore.getState().setConfig(mockConfig, validValidity, []);

      const state = useSkillkeeperStore.getState();
      expect(state.configValidity).toEqual(validValidity);
      expect(state.configWarnings).toHaveLength(0);
    });
  });

  describe('setConfigValidity', () => {
    it('updates only the validity without changing config', () => {
      useSkillkeeperStore.getState().setConfig(mockConfig, validValidity, []);
      useSkillkeeperStore.getState().setConfigValidity(partiallyInvalidValidity);

      const state = useSkillkeeperStore.getState();
      expect(state.config).toBe(mockConfig);
      expect(state.configValidity).toEqual(partiallyInvalidValidity);
    });
  });

  describe('setRepositories', () => {
    it('stores an array of repositories', () => {
      useSkillkeeperStore.getState().setRepositories([mockRepo]);

      const state = useSkillkeeperStore.getState();
      expect(state.repositories).toHaveLength(1);
      expect(state.repositories[0]).toBe(mockRepo);
    });

    it('replaces an existing list', () => {
      useSkillkeeperStore.getState().setRepositories([mockRepo]);
      useSkillkeeperStore.getState().setRepositories([]);

      expect(useSkillkeeperStore.getState().repositories).toHaveLength(0);
    });
  });

  describe('setSkills', () => {
    it('stores skills', () => {
      useSkillkeeperStore.getState().setSkills([mockInstall]);

      expect(useSkillkeeperStore.getState().skills).toHaveLength(1);
    });

    it('reseeds the project selection from the new installed baseline', () => {
      const store = useSkillkeeperStore.getState();
      // Dirty the selection, then set a new baseline.
      store.setSkillsUi({ repoChecked: ['stale'], projectChecked: [], projectAgents: {} });
      store.setSkills([projectInstall]);

      const ui = useSkillkeeperStore.getState().skillsUi;
      expect(ui.repoChecked).toEqual([]);
      expect(ui.projectChecked).toHaveLength(1);
      expect(ui.projectAgents).toEqual({ 'proj-1': ['claude'] });
    });

    it('preserves view state (mode/query/filters) when reseeding', () => {
      const store = useSkillkeeperStore.getState();
      store.setSkillsUi({ mode: 'repositories', query: 'fmt', repoFilter: ['repo-1'] });
      store.setSkills([projectInstall]);

      const ui = useSkillkeeperStore.getState().skillsUi;
      expect(ui.mode).toBe('repositories');
      expect(ui.query).toBe('fmt');
      expect(ui.repoFilter).toEqual(['repo-1']);
    });

    it('does not clear a persisted tree expansion when reseeding', () => {
      const store = useSkillkeeperStore.getState();
      store.setSkillsUi({ expandedIds: ['root-1', 'group-1'] });
      store.setSkills([projectInstall]);

      expect(useSkillkeeperStore.getState().skillsUi.expandedIds).toEqual(['root-1', 'group-1']);
    });
  });

  describe('setSkillsUi', () => {
    it('merges a partial patch into the selection state', () => {
      useSkillkeeperStore.getState().setSkillsUi({ mode: 'repositories', query: 'x' });

      const ui = useSkillkeeperStore.getState().skillsUi;
      expect(ui.mode).toBe('repositories');
      expect(ui.query).toBe('x');
      // Untouched fields keep their prior values.
      expect(ui.repoChecked).toEqual([]);
    });

    it('defaults expandedIds to null and merges a patch without disturbing other fields', () => {
      expect(useSkillkeeperStore.getState().skillsUi.expandedIds).toBeNull();

      useSkillkeeperStore.getState().setSkillsUi({ expandedIds: ['a', 'b'] });

      const ui = useSkillkeeperStore.getState().skillsUi;
      expect(ui.expandedIds).toEqual(['a', 'b']);
      expect(ui.mode).toBe('projects');
    });
  });

  describe('resetSkillsSelection', () => {
    it('repositories mode clears repo checks and leaves project checks', () => {
      const store = useSkillkeeperStore.getState();
      store.setSkills([projectInstall]);
      store.setSkillsUi({ repoChecked: ['a', 'b'], projectChecked: [] });
      store.resetSkillsSelection('repositories');

      const ui = useSkillkeeperStore.getState().skillsUi;
      expect(ui.repoChecked).toEqual([]);
      expect(ui.projectChecked).toEqual([]);
    });

    it('projects mode restores the installed baseline (checks + agents)', () => {
      const store = useSkillkeeperStore.getState();
      store.setSkills([projectInstall]);
      // User unchecks everything and drops the agent.
      store.setSkillsUi({ projectChecked: [], projectAgents: { 'proj-1': [] } });
      store.resetSkillsSelection('projects');

      const ui = useSkillkeeperStore.getState().skillsUi;
      expect(ui.projectChecked).toHaveLength(1);
      expect(ui.projectAgents).toEqual({ 'proj-1': ['claude'] });
    });

    it('does not clear a persisted tree expansion in either mode', () => {
      const store = useSkillkeeperStore.getState();
      store.setSkills([projectInstall]);
      store.setSkillsUi({ expandedIds: ['root-1'] });

      store.resetSkillsSelection('repositories');
      expect(useSkillkeeperStore.getState().skillsUi.expandedIds).toEqual(['root-1']);

      store.resetSkillsSelection('projects');
      expect(useSkillkeeperStore.getState().skillsUi.expandedIds).toEqual(['root-1']);
    });
  });

  describe('setMcpUi', () => {
    it('defaults to repositories mode with no persisted expansion', () => {
      const ui = useSkillkeeperStore.getState().mcpUi;
      expect(ui.mode).toBe('repositories');
      expect(ui.expandedIds).toBeNull();
    });

    it('defaults to the tiles components view', () => {
      const ui = useSkillkeeperStore.getState().mcpUi;
      expect(ui.componentsView).toBe('tiles');
    });

    it('merges a partial patch without disturbing untouched fields', () => {
      useSkillkeeperStore.getState().setMcpUi({ expandedIds: ['preset-1'] });

      let ui = useSkillkeeperStore.getState().mcpUi;
      expect(ui.expandedIds).toEqual(['preset-1']);
      expect(ui.mode).toBe('repositories');

      useSkillkeeperStore.getState().setMcpUi({ mode: 'projects' });

      ui = useSkillkeeperStore.getState().mcpUi;
      expect(ui.mode).toBe('projects');
      // The expansion set from the earlier patch survives an unrelated merge.
      expect(ui.expandedIds).toEqual(['preset-1']);
    });

    it('updates componentsView independently of the rest', () => {
      useSkillkeeperStore.getState().setMcpUi({ componentsView: 'tree' });

      const ui = useSkillkeeperStore.getState().mcpUi;
      expect(ui.componentsView).toBe('tree');
      // Unrelated fields are untouched by the merge.
      expect(ui.mode).toBe('repositories');
      expect(ui.expandedIds).toBeNull();
    });
  });

  describe('setProjects', () => {
    it('stores an array of projects', () => {
      useSkillkeeperStore.getState().setProjects([mockProject]);

      const state = useSkillkeeperStore.getState();
      expect(state.projects).toHaveLength(1);
      expect(state.projects[0]).toBe(mockProject);
    });

    it('replaces an existing list', () => {
      useSkillkeeperStore.getState().setProjects([mockProject]);
      useSkillkeeperStore.getState().setProjects([]);

      expect(useSkillkeeperStore.getState().projects).toHaveLength(0);
    });
  });

  describe('setLoading', () => {
    it('sets loading to true', () => {
      useSkillkeeperStore.getState().setLoading(true);
      expect(useSkillkeeperStore.getState().loading).toBe(true);
    });

    it('sets loading to false', () => {
      useSkillkeeperStore.getState().setLoading(true);
      useSkillkeeperStore.getState().setLoading(false);
      expect(useSkillkeeperStore.getState().loading).toBe(false);
    });
  });

  describe('setError', () => {
    it('stores an error message', () => {
      useSkillkeeperStore.getState().setError('Something went wrong');
      expect(useSkillkeeperStore.getState().error).toBe('Something went wrong');
    });

    it('clears the error with null', () => {
      useSkillkeeperStore.getState().setError('Something went wrong');
      useSkillkeeperStore.getState().setError(null);
      expect(useSkillkeeperStore.getState().error).toBeNull();
    });
  });

  describe('loadAll', () => {
    it('populates all state from the bridge and clears loading', async () => {
      const bridge = {
        init: async () => {},
        getConfig: async () => ({
          config: mockConfig,
          validity: validValidity,
          warnings: [],
        }),
        setConfig: async () => ({
          config: mockConfig,
          validity: validValidity,
          warnings: [],
        }),
        getOnboarding: async () => ({ version: 1, completed: false, step: 'welcome' }),
        setOnboarding: async () => {},
        listRepositories: async () => [mockRepo],
        listSkills: async () => [],
        listAvailableSkills: async () => [],
        reconcileSkills: async () => [],
        listAvailableMcp: async () => [],
        applyMcp: async () => ({ ok: true as const, installed: 0, removed: 0, skipped: [] }),
        listMcpInstalls: async () => [],
        reconcileMcp: async () => [],
        updateMcp: async () => ({ ok: true as const, updated: 0 }),
        mcpUpdatePreflight: async () => ({ ok: true as const, missingParams: [] }),
        detectProjectAgents: async () => [],
        applySkillChanges: async () => ({ ok: true as const, installed: 0, removed: 0 }),
        onSkillsProgress: () => () => {},
        listProjects: async () => [mockProject],
        listEditors: async () => [],
        openConfigInEditor: async () => ({ ok: true }),
        openExternal: async () => ({ ok: true }),
        onConfigChanged: () => () => {},
        onMenuNavigate: () => () => {},
        onMenuAbout: () => () => {},
        onMenuOnboardingToggle: () => () => {},
        onboardingMenuSync: () => {},
        getAppVersion: () => Promise.resolve('0.0.0-test'),
        addRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        cloneRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        updateRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        removeRepository: async () => ({ ok: true } as RemoveResult),
        syncRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        repoHasUpdate: async () => false,
        describeRepository: async () => ({ branch: 'main', skillCount: 0 }),
        listBranches: async () => [],
        selectFolder: async () => null,
        addProject: async () => ({ ok: true, project: mockProject } as ProjectResult),
        updateProject: async () => ({ ok: true, project: mockProject } as ProjectResult),
        removeProject: async () => ({ ok: true } as RemoveResult),
        describeProject: async () => ({ skillCount: 0, fromReposCount: 0, agentCount: 0 }),
        projectExists: async () => true,
        openProject: async () => ({ ok: true }),
        startTerminal: async () => '',
        writeTerminal: () => {},
        resizeTerminal: () => {},
        clearTerminalBuffer: () => {},
        runSshAdd: async () => {},
        onTerminalData: () => () => {},
        onTerminalExit: () => () => {},
        onTerminalRequestOpen: () => () => {},
        platform: 'darwin',
        minimizeWindow: () => {},
        toggleMaximizeWindow: () => {},
        closeWindow: () => {},
        isWindowMaximized: async () => false,
        onMaximizeChange: () => () => {},
      };

      await useSkillkeeperStore.getState().loadAll(bridge);

      const state = useSkillkeeperStore.getState();
      expect(state.config).toEqual(mockConfig);
      expect(state.repositories).toHaveLength(1);
      expect(state.projects).toHaveLength(1);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('stores error message and clears loading when bridge throws', async () => {
      const bridge = {
        init: async () => {},
        getConfig: async (): Promise<never> => {
          throw new Error('IPC failure');
        },
        setConfig: async (): Promise<never> => {
          throw new Error('IPC failure');
        },
        getOnboarding: async () => ({ version: 1, completed: false, step: 'welcome' }),
        setOnboarding: async () => {},
        listRepositories: async () => [],
        listSkills: async () => [],
        listAvailableSkills: async () => [],
        reconcileSkills: async () => [],
        listAvailableMcp: async () => [],
        applyMcp: async () => ({ ok: true as const, installed: 0, removed: 0, skipped: [] }),
        listMcpInstalls: async () => [],
        reconcileMcp: async () => [],
        updateMcp: async () => ({ ok: true as const, updated: 0 }),
        mcpUpdatePreflight: async () => ({ ok: true as const, missingParams: [] }),
        detectProjectAgents: async () => [],
        applySkillChanges: async () => ({ ok: true as const, installed: 0, removed: 0 }),
        onSkillsProgress: () => () => {},
        listProjects: async () => [],
        listEditors: async () => [],
        openConfigInEditor: async () => ({ ok: true }),
        openExternal: async () => ({ ok: true }),
        onConfigChanged: () => () => {},
        onMenuNavigate: () => () => {},
        onMenuAbout: () => () => {},
        onMenuOnboardingToggle: () => () => {},
        onboardingMenuSync: () => {},
        getAppVersion: () => Promise.resolve('0.0.0-test'),
        addRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        cloneRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        updateRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        removeRepository: async () => ({ ok: true } as RemoveResult),
        syncRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        repoHasUpdate: async () => false,
        describeRepository: async () => ({ branch: 'main', skillCount: 0 }),
        listBranches: async () => [],
        selectFolder: async () => null,
        addProject: async () => ({ ok: true, project: mockProject } as ProjectResult),
        updateProject: async () => ({ ok: true, project: mockProject } as ProjectResult),
        removeProject: async () => ({ ok: true } as RemoveResult),
        describeProject: async () => ({ skillCount: 0, fromReposCount: 0, agentCount: 0 }),
        projectExists: async () => true,
        openProject: async () => ({ ok: true }),
        startTerminal: async () => '',
        writeTerminal: () => {},
        resizeTerminal: () => {},
        clearTerminalBuffer: () => {},
        runSshAdd: async () => {},
        onTerminalData: () => () => {},
        onTerminalExit: () => () => {},
        onTerminalRequestOpen: () => () => {},
        platform: 'darwin',
        minimizeWindow: () => {},
        toggleMaximizeWindow: () => {},
        closeWindow: () => {},
        isWindowMaximized: async () => false,
        onMaximizeChange: () => () => {},
      };

      await useSkillkeeperStore.getState().loadAll(bridge);

      const state = useSkillkeeperStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe('IPC failure');
    });
  });

  describe('notifications log + page state', () => {
    beforeEach(() => {
      useSkillkeeperStore.setState({
        notifications: [],
        toasts: [],
        repoStatus: {},
        logsOpen: false,
        terminalOpen: false,
        tasksOpen: false,
      });
    });

    it('openLogs / closeLogs toggle logsOpen', () => {
      const s = useSkillkeeperStore.getState();
      expect(useSkillkeeperStore.getState().logsOpen).toBe(false);
      s.openLogs();
      expect(useSkillkeeperStore.getState().logsOpen).toBe(true);
      s.closeLogs();
      expect(useSkillkeeperStore.getState().logsOpen).toBe(false);
    });

    it('openTerminal / closeTerminal toggle terminalOpen', () => {
      const s = useSkillkeeperStore.getState();
      expect(useSkillkeeperStore.getState().terminalOpen).toBe(false);
      s.openTerminal();
      expect(useSkillkeeperStore.getState().terminalOpen).toBe(true);
      s.closeTerminal();
      expect(useSkillkeeperStore.getState().terminalOpen).toBe(false);
    });

    it('openTasks / closeTasks toggle tasksOpen', () => {
      const s = useSkillkeeperStore.getState();
      expect(useSkillkeeperStore.getState().tasksOpen).toBe(false);
      s.openTasks();
      expect(useSkillkeeperStore.getState().tasksOpen).toBe(true);
      s.closeTasks();
      expect(useSkillkeeperStore.getState().tasksOpen).toBe(false);
    });

    it('an error notification marks the repo status; info does not', () => {
      const s = useSkillkeeperStore.getState();
      s.notify('boom', 'error', 'repo-1');
      s.notify('copied', 'info', 'repo-2');
      const state = useSkillkeeperStore.getState();
      expect(state.notifications).toHaveLength(2);
      expect(state.notifications.map((n) => n.level)).toEqual(['error', 'info']);
      expect(state.repoStatus['repo-1']?.error).toBe('boom');
      expect(state.repoStatus['repo-2']).toBeUndefined();
    });

    it('clearNotifications empties the log but leaves toasts and repo errors intact', () => {
      const s = useSkillkeeperStore.getState();
      s.notify('boom', 'error', 'repo-1');
      expect(useSkillkeeperStore.getState().notifications).toHaveLength(1);
      expect(useSkillkeeperStore.getState().toasts).toHaveLength(1);
      useSkillkeeperStore.getState().clearNotifications();
      expect(useSkillkeeperStore.getState().notifications).toHaveLength(0);
      expect(useSkillkeeperStore.getState().toasts).toHaveLength(1);
      expect(useSkillkeeperStore.getState().repoStatus['repo-1']?.error).toBe('boom');
    });
  });

  describe('sync task queue', () => {
    beforeEach(() => {
      useSkillkeeperStore.setState({ tasks: [], repositories: [mockRepo], repoStatus: {} });
    });

    it('syncRepository enqueues a task for the repo', () => {
      // Do not await: the bridge singleton is unavailable in node, but the task
      // is enqueued synchronously before the async work runs.
      void useSkillkeeperStore.getState().syncRepository('repo-1');
      const tasks = useSkillkeeperStore.getState().tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.repoId).toBe('repo-1');
      expect(tasks[0]!.kind).toBe('sync');
      expect(['queued', 'running']).toContain(tasks[0]!.status);
    });

    it('marks the repo syncing immediately on enqueue (before the task runs)', () => {
      void useSkillkeeperStore.getState().syncRepository('repo-1');
      // The card must enter the busy state the instant the task is queued.
      expect(useSkillkeeperStore.getState().repoStatus['repo-1']?.phase).toBe('syncing');
    });

    it('refreshRepoUpdates enqueues a check task per repo', () => {
      void useSkillkeeperStore.getState().refreshRepoUpdates();
      const tasks = useSkillkeeperStore.getState().tasks;
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.kind).toBe('check');
      expect(tasks[0]!.repoId).toBe('repo-1');
    });

    it('clearFinishedTasks removes done/error tasks but keeps queued/running', () => {
      useSkillkeeperStore.setState({
        tasks: [
          { id: 'a', repoId: 'r', repoName: 'R', kind: 'sync', status: 'done', at: '' },
          { id: 'b', repoId: 'r', repoName: 'R', kind: 'sync', status: 'error', at: '' },
          { id: 'c', repoId: 'r', repoName: 'R', kind: 'sync', status: 'queued', at: '' },
          { id: 'd', repoId: 'r', repoName: 'R', kind: 'sync', status: 'running', at: '' },
        ],
      });
      useSkillkeeperStore.getState().clearFinishedTasks();
      expect(useSkillkeeperStore.getState().tasks.map((t) => t.id)).toEqual(['c', 'd']);
    });
  });

  describe('refreshMcpPresets', () => {
    // Not annotated as `McpServerDef`: that interface's `args` is `readonly
    // string[]`, while the config preset shape (spread into `mockConfig.mcp.servers`
    // below) needs a plain mutable `string[]` -- let the literal infer its own type.
    const manualDef = {
      name: 'github',
      type: 'stdio' as const,
      command: 'github-mcp',
      args: ['--token', '{token}'],
      rules: 'Use {token} carefully.',
    };

    const repoAvailable: AvailableMcp = {
      repoId: 'repo-1',
      remote: 'https://github.com/example/skills',
      group: 'devtools',
      def: { name: 'linear', type: 'http', url: 'https://api.linear.app/{workspace}' },
      hash: 'sha256:repo-hash',
    };

    beforeEach(() => {
      useSkillkeeperStore.getState().setConfig(
        { ...mockConfig, mcp: { servers: [{ id: 'manual-1', ...manualDef }] } },
        validValidity,
        [],
      );
      vi.mocked(bridgeClient.listAvailableMcp).mockReset();
      vi.mocked(bridgeClient.listAvailableMcp).mockResolvedValue([repoAvailable]);
    });

    it('unions manual config presets and repo-discovered presets with correct origin/params/hasRules', async () => {
      await useSkillkeeperStore.getState().refreshMcpPresets();
      const presets = useSkillkeeperStore.getState().mcpPresets;
      expect(presets).toHaveLength(2);

      const manual = presets.find((p) => p.origin === 'manual');
      expect(manual?.id).toBe('manual-1');
      expect(manual?.name).toBe('github');
      expect(manual?.params).toEqual(['token']);
      expect(manual?.hasRules).toBe(true);
      expect(manual?.repoId).toBeUndefined();
      expect(manual?.hash).toBeTruthy();

      const repo = presets.find((p) => p.origin === 'repo');
      expect(repo?.name).toBe('linear');
      expect(repo?.repoId).toBe('repo-1');
      expect(repo?.remote).toBe('https://github.com/example/skills');
      expect(repo?.group).toBe('devtools');
      expect(repo?.hash).toBe('sha256:repo-hash');
      expect(repo?.params).toEqual(['workspace']);
      expect(repo?.hasRules).toBe(false);
    });

    it('computes a deterministic manual preset hash across repeated refreshes', async () => {
      await useSkillkeeperStore.getState().refreshMcpPresets();
      const first = useSkillkeeperStore.getState().mcpPresets.find((p) => p.origin === 'manual')?.hash;
      await useSkillkeeperStore.getState().refreshMcpPresets();
      const second = useSkillkeeperStore.getState().mcpPresets.find((p) => p.origin === 'manual')?.hash;
      expect(first).toBeDefined();
      expect(first).toBe(second);
    });
  });

  describe('deleteMcpPreset', () => {
    const manualDef = { id: 'm1', name: 'github', type: 'stdio' as const, command: 'github-mcp' };
    const otherManualDef = { id: 'm2', name: 'other', type: 'stdio' as const, command: 'other-mcp' };

    const manualProjectInstall: McpInstall = {
      projectId: 'proj-1',
      agent: 'claude',
      instanceName: 'github_1',
      identity: { local: 'm1', source: 'github' },
      hash: 'sha256:x',
      hasParams: false,
    };
    const globalInstall: McpInstall = {
      projectId: 'global',
      agent: 'codex',
      instanceName: 'github_1',
      identity: { local: 'm1', source: 'github' },
      hash: 'sha256:x',
      hasParams: false,
    };
    const unrelatedInstall: McpInstall = {
      projectId: 'proj-1',
      agent: 'claude',
      instanceName: 'other_1',
      identity: { local: 'm2', source: 'other' },
      hash: 'sha256:y',
      hasParams: false,
    };

    /** The args passed to each `bridgeClient.applyMcp` call this test made. */
    const applyMcpArgs = (): unknown[] => vi.mocked(bridgeClient.applyMcp).mock.calls.map((c) => c[0]);
    /** The configs passed to each `bridgeClient.setConfig` call this test made. */
    const setConfigArgs = (): SkillKeeperConfig[] =>
      vi.mocked(bridgeClient.setConfig).mock.calls.map((c) => c[0]);

    beforeEach(() => {
      vi.mocked(bridgeClient.applyMcp).mockReset();
      vi.mocked(bridgeClient.applyMcp).mockResolvedValue({ ok: true, installed: 0, removed: 1, skipped: [] });
      vi.mocked(bridgeClient.listMcpInstalls).mockReset();
      vi.mocked(bridgeClient.listMcpInstalls).mockResolvedValue([unrelatedInstall]);
      vi.mocked(bridgeClient.listAvailableMcp).mockReset();
      vi.mocked(bridgeClient.listAvailableMcp).mockResolvedValue([]);
      vi.mocked(bridgeClient.setConfig).mockReset();
      vi.mocked(bridgeClient.setConfig).mockImplementation(async (config) => ({
        config,
        validity: validValidity,
        warnings: [],
      }));
      useSkillkeeperStore.getState().setConfig(
        { ...mockConfig, mcp: { servers: [manualDef, otherManualDef] } },
        validValidity,
        [],
      );
      useSkillkeeperStore.setState({
        projects: [mockProject],
        mcpInstalls: [manualProjectInstall, globalInstall, unrelatedInstall],
        notifications: [],
        toasts: [],
      });
    });

    it('uninstalls every instance of the manual preset across projects and global, then drops it from config', async () => {
      await useSkillkeeperStore.getState().deleteMcpPreset('m1');

      expect(applyMcpArgs()).toEqual(
        expect.arrayContaining([
          {
            projectId: 'proj-1',
            projectPath: mockProject.path,
            batches: [{ agent: 'claude', install: [], remove: [{ instanceName: 'github_1' }] }],
          },
          {
            projectId: 'global',
            projectPath: '',
            batches: [{ agent: 'codex', install: [], remove: [{ instanceName: 'github_1' }] }],
          },
        ]),
      );
      expect(applyMcpArgs()).toHaveLength(2);

      expect(setConfigArgs()).toHaveLength(1);
      expect(setConfigArgs()[0]!.mcp.servers.map((s) => s.id)).toEqual(['m2']);

      expect(useSkillkeeperStore.getState().mcpInstalls).toEqual([unrelatedInstall]);
    });

    it('notifies and leaves the preset in config when an applyMcp call fails', async () => {
      vi.mocked(bridgeClient.applyMcp).mockResolvedValue({ ok: false, error: 'boom' });

      await useSkillkeeperStore.getState().deleteMcpPreset('m1');

      expect(setConfigArgs()).toHaveLength(0);
      expect(useSkillkeeperStore.getState().config?.mcp.servers.map((s) => s.id)).toEqual(['m1', 'm2']);
      expect(useSkillkeeperStore.getState().notifications.some((n) => n.text === 'boom')).toBe(true);
    });

    it('is a no-op on config/uninstalls when the preset has no installed instances', async () => {
      useSkillkeeperStore.setState({ mcpInstalls: [unrelatedInstall] });

      await useSkillkeeperStore.getState().deleteMcpPreset('m1');

      expect(applyMcpArgs()).toHaveLength(0);
      expect(setConfigArgs()).toHaveLength(1);
      expect(setConfigArgs()[0]!.mcp.servers.map((s) => s.id)).toEqual(['m2']);
    });
  });

  describe('focusRepository', () => {
    it('sets repoFocus and bumps the nonce on repeated calls', () => {
      useSkillkeeperStore.setState({ repoFocus: null });

      useSkillkeeperStore.getState().focusRepository('repo-1');
      expect(useSkillkeeperStore.getState().repoFocus).toEqual({ repoId: 'repo-1', nonce: 1 });

      useSkillkeeperStore.getState().focusRepository('repo-1');
      expect(useSkillkeeperStore.getState().repoFocus).toEqual({ repoId: 'repo-1', nonce: 2 });

      useSkillkeeperStore.getState().focusRepository('repo-2');
      expect(useSkillkeeperStore.getState().repoFocus).toEqual({ repoId: 'repo-2', nonce: 3 });
    });
  });

  describe('mcpInstallHasUpdate', () => {
    const preset: McpPreset = {
      id: 'repo:repo-1:devtools:linear',
      origin: 'repo',
      name: 'linear',
      def: { name: 'linear', type: 'http', url: 'https://api.linear.app/{workspace}' },
      hash: 'sha256:current',
      params: ['workspace'],
      hasRules: false,
      repoId: 'repo-1',
      remote: 'https://github.com/example/skills',
      group: 'devtools',
    };

    const manualPreset: McpPreset = {
      id: 'manual-1',
      origin: 'manual',
      name: 'github',
      def: { name: 'github', type: 'stdio', command: 'github-mcp' },
      hash: 'sha256:manual-current',
      params: [],
      hasRules: false,
    };

    it('is true when the install hash differs from the matched repo preset', () => {
      const install: McpInstall = {
        projectId: 'proj-1',
        agent: 'claude',
        instanceName: 'linear_1',
        identity: { remote: 'https://github.com/example/skills', group: 'devtools', source: 'linear' },
        hash: 'sha256:stale',
        hasParams: true,
      };
      expect(mcpInstallHasUpdate(install, [preset])).toBe(true);
    });

    it('is false when the install hash matches the matched preset', () => {
      const install: McpInstall = {
        projectId: 'proj-1',
        agent: 'claude',
        instanceName: 'linear_1',
        identity: { remote: 'https://github.com/example/skills', group: 'devtools', source: 'linear' },
        hash: 'sha256:current',
        hasParams: true,
      };
      expect(mcpInstallHasUpdate(install, [preset])).toBe(false);
    });

    it('matches manual installs by local preset id', () => {
      const install: McpInstall = {
        projectId: 'proj-1',
        agent: 'claude',
        instanceName: 'github_1',
        identity: { local: 'manual-1', source: 'github' },
        hash: 'sha256:stale',
        hasParams: false,
      };
      expect(mcpInstallHasUpdate(install, [manualPreset])).toBe(true);
    });

    it('is false when no preset matches the install identity', () => {
      const install: McpInstall = {
        projectId: 'proj-1',
        agent: 'claude',
        instanceName: 'gone_1',
        identity: { local: 'missing-preset', source: 'gone' },
        hash: 'sha256:whatever',
        hasParams: false,
      };
      expect(mcpInstallHasUpdate(install, [preset, manualPreset])).toBe(false);
    });
  });

  // `store.ts` reimplements the MCP param/remote/hash helpers locally because
  // the renderer cannot call the domain layer's runtime exports (they pull
  // Node-only modules into the sandboxed bundle); the canonical algorithms now
  // live in the Rust `skillkeeper-core` crate (covered by its `cargo test`
  // suite). These tests pin the renderer copies to their expected outputs so a
  // drift fails here rather than silently breaking manual-preset update
  // detection at runtime.
  describe('renderer MCP helpers', () => {
    it('scanMcpParams collects the sorted, deduped placeholder set', () => {
      const linear: McpServerDef = {
        name: 'linear',
        type: 'http',
        url: 'https://api.linear.app/{workspace}/mcp',
        headers: { Authorization: 'Bearer {token}', 'X-Env': 'prod' },
        rules: 'Use {token} only for the {workspace} workspace.',
      };
      expect(scanMcpParams(linear)).toEqual(['token', 'workspace']);

      const github: McpServerDef = {
        name: 'github',
        type: 'stdio',
        command: 'github-mcp',
        args: ['--token', '{gh_token}', '--repo', '{repo}'],
        env: { GH_HOST: 'github.com', GH_TOKEN: '{gh_token}' },
      };
      expect(scanMcpParams(github)).toEqual(['gh_token', 'repo']);

      const plain: McpServerDef = { name: 'plain', type: 'sse', url: 'https://example.com/sse' };
      expect(scanMcpParams(plain)).toEqual([]);
    });

    it('normalizeMcpRemote canonicalizes scp, https, ssh+port, and userinfo forms', () => {
      expect(normalizeMcpRemote('git@github.com:acme/x.git')).toBe('github.com/acme/x');
      expect(normalizeMcpRemote('https://github.com/Acme/X.git')).toBe('github.com/acme/x');
      expect(normalizeMcpRemote('ssh://git@example.com:2222/org/repo/')).toBe('example.com/org/repo');
      expect(normalizeMcpRemote('https://user:pass@host.example.com/a/b')).toBe('host.example.com/a/b');
    });

    it('hashMcpDefInRenderer emits a sha256 digest that ignores the def name', async () => {
      const a: McpServerDef = { name: 'one', type: 'http', url: 'https://example.com' };
      const b: McpServerDef = { name: 'two', type: 'http', url: 'https://example.com' };
      const hashA = await hashMcpDefInRenderer(a);
      expect(hashA).toMatch(/^sha256:[0-9a-f]{64}$/);
      // `name` is excluded from the hash, so these must collide.
      expect(hashA).toBe(await hashMcpDefInRenderer(b));
      // A change to a hashed field must change the digest.
      expect(hashA).not.toBe(
        await hashMcpDefInRenderer({ name: 'one', type: 'http', url: 'https://other.example.com' }),
      );
    });
  });

  describe('onboarding actions', () => {
    beforeEach(() => {
      useSkillkeeperStore.setState({ onboarding: { active: false, step: 'welcome', completed: false } });
      vi.mocked(bridgeClient.setOnboarding).mockReset();
    });

    it('startOnboarding begins the tour at the first step', () => {
      useSkillkeeperStore.getState().startOnboarding();
      expect(useSkillkeeperStore.getState().onboarding).toEqual({ active: true, step: 'welcome', completed: false });
    });

    it('nextOnboardingStep advances one step in ONBOARDING_ORDER', () => {
      useSkillkeeperStore.setState({ onboarding: { active: true, step: ONBOARDING_ORDER[0]!, completed: false } });
      useSkillkeeperStore.getState().nextOnboardingStep();
      expect(useSkillkeeperStore.getState().onboarding).toEqual({
        active: true,
        step: ONBOARDING_ORDER[1]!,
        completed: false,
      });
    });

    it('nextOnboardingStep from the last step delegates to finishOnboarding', () => {
      const last = ONBOARDING_ORDER[ONBOARDING_ORDER.length - 1]!;
      useSkillkeeperStore.setState({ onboarding: { active: true, step: last, completed: false } });
      useSkillkeeperStore.getState().nextOnboardingStep();
      expect(useSkillkeeperStore.getState().onboarding).toEqual({ active: false, step: last, completed: true });
    });

    it('prevOnboardingStep from welcome is a no-op', () => {
      useSkillkeeperStore.setState({ onboarding: { active: true, step: 'welcome', completed: false } });
      useSkillkeeperStore.getState().prevOnboardingStep();
      expect(useSkillkeeperStore.getState().onboarding).toEqual({ active: true, step: 'welcome', completed: false });
    });

    it('skipOnboarding routes to the done step without completing the tour', () => {
      useSkillkeeperStore.getState().skipOnboarding();
      expect(useSkillkeeperStore.getState().onboarding).toEqual({ active: true, step: 'done', completed: false });
    });

    it('finishOnboarding marks the tour completed and inactive', () => {
      useSkillkeeperStore.setState({ onboarding: { active: true, step: 'agents', completed: false } });
      useSkillkeeperStore.getState().finishOnboarding();
      expect(useSkillkeeperStore.getState().onboarding).toEqual({ active: false, step: 'agents', completed: true });
    });

    describe('loadOnboarding', () => {
      // Only `getOnboarding` is exercised by the action; the rest of BridgeClient
      // is irrelevant to this test, so a minimal stub is cast through `unknown`.
      function stubBridge(step: string): BridgeClient {
        return {
          getOnboarding: vi.fn().mockResolvedValue({ version: 1, completed: false, step }),
          setOnboarding: vi.fn().mockResolvedValue(undefined),
        } as unknown as BridgeClient;
      }

      it('seeds onboarding from a valid persisted step', async () => {
        await useSkillkeeperStore.getState().loadOnboarding(stubBridge('projects'));
        expect(useSkillkeeperStore.getState().onboarding).toEqual({
          active: true,
          step: 'projects',
          completed: false,
        });
      });

      it('falls back to welcome when the persisted step is unknown', async () => {
        await useSkillkeeperStore.getState().loadOnboarding(stubBridge('bogus'));
        expect(useSkillkeeperStore.getState().onboarding).toEqual({
          active: true,
          step: 'welcome',
          completed: false,
        });
      });
    });
  });
});
