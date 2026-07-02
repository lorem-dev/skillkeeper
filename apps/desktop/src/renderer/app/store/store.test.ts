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
      };

      await useSkillkeeperStore.getState().loadAll(bridge);

      const state = useSkillkeeperStore.getState();
      expect(state.loading).toBe(false);
      expect(state.error).toBe('IPC failure');
    });
  });
});
