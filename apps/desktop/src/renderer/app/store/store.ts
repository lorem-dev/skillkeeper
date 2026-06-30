/**
 * Zustand store for the SkillKeeper renderer.
 *
 * Holds all UI state derived from IPC calls to the main process. The renderer
 * never owns domain logic -- it only stores results returned by the bridge.
 */
import { create } from 'zustand';
import type { BridgeClient, SectionValidity, SkillKeeperConfig, Repository, Project, InstallManifest } from '@/services/bridge';
import { bridgeClient } from '@/services/bridge';

// Re-export the bridge-compatible config result shape for consumers.
export type { SectionValidity, SkillKeeperConfig };
export type { Repository, Project, InstallManifest };

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
}));
