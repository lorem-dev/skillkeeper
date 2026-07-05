/**
 * Unit tests for the Zustand store actions.
 *
 * These tests run in Node (no React rendering, no Electron). They exercise the
 * pure state-mutation logic of each action so we can verify the store behaves
 * correctly without spinning up a browser or Electron environment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSkillkeeperStore } from './store';
import type { SectionValidity, SkillKeeperConfig, Repository, Project, InstallManifest } from './store';
import type { RepoResult, RemoveResult } from '@/services/bridge';

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
};

const partiallyInvalidValidity: SectionValidity = {
  general: 'invalid',
  updates: 'valid',
  agents: 'valid',
  executables: 'valid',
  security: 'valid',
  notifications: 'valid',
  repositories: 'valid',
};

const mockConfig: SkillKeeperConfig = {
  general: { language: 'en', theme: 'system' },
  updates: { mode: 'manual', intervalHours: 24, checkOnStartup: false },
  agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
  executables: { globs: [] },
  security: { hookConsentPolicy: 'always-ask' },
  notifications: { enabled: true },
  repositories: { gitPath: 'git' },
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
        listRepositories: async () => [mockRepo],
        listSkills: async () => [],
        listProjects: async () => [mockProject],
        listEditors: async () => [],
        openConfigInEditor: async () => ({ ok: true }),
        onConfigChanged: () => () => {},
        addRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        cloneRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        updateRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        removeRepository: async () => ({ ok: true } as RemoveResult),
        syncRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        repoHasUpdate: async () => false,
        describeRepository: async () => ({ branch: 'main', skillCount: 0 }),
        startTerminal: async () => '',
        writeTerminal: () => {},
        resizeTerminal: () => {},
        runSshAdd: async () => {},
        onTerminalData: () => () => {},
        onTerminalExit: () => () => {},
        onTerminalRequestOpen: () => () => {},
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
        getConfig: async (): Promise<never> => {
          throw new Error('IPC failure');
        },
        setConfig: async (): Promise<never> => {
          throw new Error('IPC failure');
        },
        listRepositories: async () => [],
        listSkills: async () => [],
        listProjects: async () => [],
        listEditors: async () => [],
        openConfigInEditor: async () => ({ ok: true }),
        onConfigChanged: () => () => {},
        addRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        cloneRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        updateRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        removeRepository: async () => ({ ok: true } as RemoveResult),
        syncRepository: async () => ({ ok: true, repository: mockRepo } as RepoResult),
        repoHasUpdate: async () => false,
        describeRepository: async () => ({ branch: 'main', skillCount: 0 }),
        startTerminal: async () => '',
        writeTerminal: () => {},
        resizeTerminal: () => {},
        runSshAdd: async () => {},
        onTerminalData: () => () => {},
        onTerminalExit: () => () => {},
        onTerminalRequestOpen: () => () => {},
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
});
