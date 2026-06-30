/**
 * Zustand store for the SkillKeeper renderer.
 *
 * Holds all UI state derived from IPC calls to the main process. The renderer
 * never owns domain logic -- it only stores results returned by the bridge.
 *
 * Imported types are from the preload bridge shape, not from @skillkeeper/*
 * core packages directly, because the renderer must not depend on Node modules.
 */
import { create } from 'zustand';
import type { SkillkeeperBridge } from '../../../preload/index';
import type { SectionValidity, SkillKeeperConfig } from '@skillkeeper/config';
import type { Repository, Project } from '@skillkeeper/core';

// Re-export the bridge-compatible config result shape for consumers.
export type { SectionValidity, SkillKeeperConfig };
export type { Repository, Project };

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
  /** Installed skills (stub type in v1 shell). */
  skills: unknown[];
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
  setSkills(skills: unknown[]): void;
  setProjects(projects: Project[]): void;
  setLoading(loading: boolean): void;
  setError(error: string | null): void;
  /** Load all data from the main process via the window.skillkeeper bridge. */
  loadAll(bridge: SkillkeeperBridge): Promise<void>;
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

  async loadAll(bridge) {
    const { setLoading, setError, setConfig, setRepositories, setSkills, setProjects } = get();
    setLoading(true);
    setError(null);
    try {
      const [configResult, repos, skills, projects] = await Promise.all([
        bridge.getConfig(),
        bridge.listRepositories(),
        bridge.listSkills(),
        bridge.listProjects(),
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
}));
