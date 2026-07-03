/**
 * Zustand store for the SkillKeeper renderer.
 *
 * Holds all UI state derived from IPC calls to the main process. The renderer
 * never owns domain logic -- it only stores results returned by the bridge.
 */
import { create } from 'zustand';
import type {
  BridgeClient,
  SectionValidity,
  SkillKeeperConfig,
  GeneralConfig,
  UpdatesConfig,
  AgentsConfig,
  NotificationsConfig,
  RepositoriesConfig,
  Repository,
  Project,
  InstallManifest,
} from '@/services/bridge';
import { bridgeClient } from '@/services/bridge';

// Re-export the bridge-compatible config result shape for consumers.
export type { SectionValidity, SkillKeeperConfig };
export type { GeneralConfig, UpdatesConfig, AgentsConfig, NotificationsConfig, RepositoriesConfig };
export type { Repository, Project, InstallManifest };

/** A partial update to the config, merged into the current config on write. */
export interface ConfigPatch {
  general?: Partial<GeneralConfig>;
  updates?: Partial<UpdatesConfig>;
  agents?: Partial<AgentsConfig>;
  notifications?: Partial<NotificationsConfig>;
  repositories?: Partial<RepositoriesConfig>;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface SkillkeeperState {
  /** The loaded config, or null before the first load. */
  config: SkillKeeperConfig | null;
  /** Per-section validity from the last config load. */
  configValidity: SectionValidity | null;
  /** Config load warnings. */
  configWarnings: string[];
  /** Tracked repositories. */
  repositories: Repository[];
  /** Per-repository UI status (not persisted). */
  repoStatus: Record<string, { phase: 'idle' | 'cloning' | 'syncing'; hasUpdate: boolean }>;
  /** Installed skills. */
  skills: InstallManifest[];
  /** Tracked projects. */
  projects: Project[];
  /** Whether a background load is in progress. */
  loading: boolean;
  /** Last error message, if any. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface SkillkeeperActions {
  setConfig(config: SkillKeeperConfig, validity: SectionValidity, warnings: string[]): void;
  setConfigValidity(validity: SectionValidity): void;
  setRepositories(repositories: Repository[]): void;
  setSkills(skills: InstallManifest[]): void;
  setProjects(projects: Project[]): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  /** Load all data from the main process via the bridge client. */
  loadAll(client: BridgeClient): Promise<void>;
  /** Reload all data using the singleton bridge client. */
  reload(): Promise<void>;
  /** Merge a partial config patch into the current config and persist it. */
  updateConfig(patch: ConfigPatch): Promise<void>;
  addRepository(url: string, name: string): Promise<void>;
  updateRepository(id: string, name: string, url: string): Promise<void>;
  removeRepository(id: string): Promise<void>;
  syncRepository(id: string): Promise<void>;
  refreshRepoUpdates(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type SkillkeeperStore = SkillkeeperState & SkillkeeperActions;

export const useSkillkeeperStore = create<SkillkeeperStore>((set, get) => ({
  // Initial state
  config: null,
  configValidity: null,
  configWarnings: [],
  repositories: [],
  repoStatus: {},
  skills: [],
  projects: [],
  loading: false,
  error: null,

  // Actions
  setConfig(config, validity, warnings) {
    set({ config, configValidity: validity, configWarnings: warnings });
  },

  setConfigValidity(validity) {
    set({ configValidity: validity });
  },

  setRepositories(repositories) {
    set({ repositories });
  },

  setSkills(skills) {
    set({ skills });
  },

  setProjects(projects) {
    set({ projects });
  },

  setLoading(loading) {
    set({ loading });
  },

  setError(error) {
    set({ error });
  },

  async loadAll(client) {
    const { setLoading, setError, setConfig, setRepositories, setSkills, setProjects } = get();
    setLoading(true);
    setError(null);
    try {
      const [configResult, repos, skills, projects] = await Promise.all([
        client.getConfig(),
        client.listRepositories(),
        client.listSkills(),
        client.listProjects(),
      ]);
      setConfig(configResult.config, configResult.validity, configResult.warnings);
      setRepositories(repos);
      setSkills(skills);
      setProjects(projects);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  },

  async reload() {
    await get().loadAll(bridgeClient);
  },

  async updateConfig(patch) {
    const current = get().config;
    if (current === null) return;
    const merged: SkillKeeperConfig = {
      ...current,
      ...(patch.general !== undefined ? { general: { ...current.general, ...patch.general } } : {}),
      ...(patch.updates !== undefined ? { updates: { ...current.updates, ...patch.updates } } : {}),
      ...(patch.agents !== undefined ? { agents: { ...current.agents, ...patch.agents } } : {}),
      ...(patch.notifications !== undefined
        ? { notifications: { ...current.notifications, ...patch.notifications } }
        : {}),
      ...(patch.repositories !== undefined
        ? { repositories: { ...current.repositories, ...patch.repositories } }
        : {}),
    };
    const result = await bridgeClient.setConfig(merged);
    get().setConfig(result.config, result.validity, result.warnings);
  },

  addRepository(url, name) {
    return (async () => {
      const added = await bridgeClient.addRepository(url, name);
      if (!added.ok) {
        get().setError(added.error);
        return;
      }
      const repo = added.repository;
      set((s) => ({
        repositories: [...s.repositories, repo],
        repoStatus: { ...s.repoStatus, [repo.id]: { phase: 'cloning', hasUpdate: false } },
      }));
      const cloned = await bridgeClient.cloneRepository(repo.id);
      set((s) => ({
        repositories: cloned.ok
          ? s.repositories.map((r) => (r.id === repo.id ? cloned.repository : r))
          : s.repositories,
        repoStatus: { ...s.repoStatus, [repo.id]: { phase: 'idle', hasUpdate: false } },
      }));
      if (!cloned.ok) get().setError(cloned.error);
    })();
  },

  updateRepository(id, name, url) {
    return (async () => {
      const res = await bridgeClient.updateRepository(id, name, url);
      if (!res.ok) {
        get().setError(res.error);
        return;
      }
      const updated = res.repository;
      set((s) => ({ repositories: s.repositories.map((r) => (r.id === id ? updated : r)) }));
    })();
  },

  removeRepository(id) {
    return (async () => {
      const res = await bridgeClient.removeRepository(id);
      if (!res.ok) {
        get().setError(res.error);
        return;
      }
      set((s) => {
        const { [id]: _removed, ...rest } = s.repoStatus;
        return { repositories: s.repositories.filter((r) => r.id !== id), repoStatus: rest };
      });
    })();
  },

  syncRepository(id) {
    return (async () => {
      set((s) => ({ repoStatus: { ...s.repoStatus, [id]: { phase: 'syncing', hasUpdate: s.repoStatus[id]?.hasUpdate ?? false } } }));
      const res = await bridgeClient.syncRepository(id);
      set((s) => ({
        repositories: res.ok ? s.repositories.map((r) => (r.id === id ? res.repository : r)) : s.repositories,
        repoStatus: { ...s.repoStatus, [id]: { phase: 'idle', hasUpdate: false } },
      }));
      if (!res.ok) get().setError(res.error);
    })();
  },

  refreshRepoUpdates() {
    return (async () => {
      const repos = get().repositories;
      await Promise.all(
        repos.map(async (r) => {
          const hasUpdate = await bridgeClient.repoHasUpdate(r.id);
          set((s) => ({
            repoStatus: {
              ...s.repoStatus,
              [r.id]: { phase: s.repoStatus[r.id]?.phase ?? 'idle', hasUpdate },
            },
          }));
        }),
      );
    })();
  },
}));
