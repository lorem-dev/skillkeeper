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
  RepoInfo,
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

/** Severity of a notification entry. */
export type NotificationLevel = 'error' | 'info';

/**
 * A notification's message: either raw text (e.g. a git error, which cannot be
 * translated) or an i18n key with optional interpolation vars (resolved at
 * DISPLAY time, so switching language re-translates existing entries).
 */
export type NotificationMessage = string | { readonly key: string; readonly vars?: Record<string, string> };

/**
 * A recorded notification (an error or an informational message). Feeds the
 * bottom toasts and the notifications log. Stores either raw `text` or a
 * translation `key` (+ `vars`) -- never the pre-translated string -- so the log
 * follows the current language.
 */
export interface NotificationEntry {
  readonly id: string;
  readonly level: NotificationLevel;
  /** Raw text shown as-is (untranslatable, e.g. a git error). */
  readonly text?: string;
  /** i18n key resolved at display time. */
  readonly key?: string;
  readonly vars?: Record<string, string>;
  readonly repoId?: string;
  /** ISO timestamp. */
  readonly at: string;
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
  repoStatus: Record<string, { phase: 'idle' | 'cloning' | 'syncing'; hasUpdate: boolean; error?: string }>;
  /**
   * Per-repository branch + skill count for the card badges (not persisted).
   * Kept separate from `repoStatus` so phase/hasUpdate/error updates never need
   * to carry these forward.
   */
  repoInfo: Record<string, RepoInfo>;
  /** Every recorded notification (newest last); consumed by the logs page. */
  notifications: NotificationEntry[];
  /** Currently-visible toasts. */
  toasts: NotificationEntry[];
  /** Whether the full-screen error-log page is open. */
  logsOpen: boolean;
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
  /** Fetch branch + skill count for every repo into `repoInfo`. */
  refreshRepoInfo(): Promise<void>;
  /**
   * Record a notification: append to the log + toasts. An `error` notification
   * with a `repoId` also marks that repo's status (the red dot); `info` never
   * touches repo status.
   */
  notify(message: NotificationMessage, level: NotificationLevel, repoId?: string): void;
  /** Remove one toast (keeps the log and the repo dot). */
  dismissToast(id: string): void;
  /** Re-show the toast for a repo's current error (does not re-log). */
  showRepoError(repoId: string): void;
  /** Open the full-screen notifications log page. */
  openLogs(): void;
  /** Close the full-screen notifications log page. */
  closeLogs(): void;
  /** Empty the notifications log. Leaves toasts and per-repo errors intact. */
  clearNotifications(): void;
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
  repoInfo: {},
  notifications: [],
  toasts: [],
  logsOpen: false,
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

  notify(message, level, repoId) {
    // Raw text is stored verbatim; a keyed message stores key (+ vars) and is
    // translated at display time so the log follows the current language.
    const payload =
      typeof message === 'string' ? { text: message } : { key: message.key, vars: message.vars };
    const entry: NotificationEntry = {
      id: crypto.randomUUID(),
      level,
      ...payload,
      repoId,
      at: new Date().toISOString(),
    };
    set((s) => ({
      notifications: [...s.notifications, entry],
      toasts: [...s.toasts, entry],
      // Only an error marks the repo's status (the red dot); info never does.
      // Repo errors are always raw text (a git error), so store that text.
      repoStatus:
        level !== 'error' || repoId === undefined
          ? s.repoStatus
          : {
              ...s.repoStatus,
              [repoId]: {
                phase: s.repoStatus[repoId]?.phase ?? 'idle',
                hasUpdate: s.repoStatus[repoId]?.hasUpdate ?? false,
                error: typeof message === 'string' ? message : message.key,
              },
            },
    }));
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
  },

  showRepoError(repoId) {
    const message = get().repoStatus[repoId]?.error;
    if (message === undefined) return;
    // Repo errors are raw git text (untranslatable), stored as `text`.
    const entry: NotificationEntry = {
      id: crypto.randomUUID(),
      level: 'error',
      text: message,
      repoId,
      at: new Date().toISOString(),
    };
    set((s) => ({ toasts: [...s.toasts, entry] }));
  },

  openLogs() {
    set({ logsOpen: true });
  },

  closeLogs() {
    set({ logsOpen: false });
  },

  clearNotifications() {
    set({ notifications: [] });
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
        get().notify(added.error, 'error');
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
        // Success clears any error; a failure's error is set by notify() below.
        repoStatus: { ...s.repoStatus, [repo.id]: { phase: 'idle', hasUpdate: false } },
      }));
      if (!cloned.ok) get().notify(cloned.error, 'error', repo.id);
    })();
  },

  updateRepository(id, name, url) {
    return (async () => {
      const res = await bridgeClient.updateRepository(id, name, url);
      if (!res.ok) {
        get().notify(res.error, 'error', id);
        return;
      }
      const updated = res.repository;
      set((s) => ({
        repositories: s.repositories.map((r) => (r.id === id ? updated : r)),
        repoStatus: {
          ...s.repoStatus,
          [id]: {
            phase: s.repoStatus[id]?.phase ?? 'idle',
            hasUpdate: s.repoStatus[id]?.hasUpdate ?? false,
            error: undefined,
          },
        },
      }));
    })();
  },

  removeRepository(id) {
    return (async () => {
      const res = await bridgeClient.removeRepository(id);
      if (!res.ok) {
        get().notify(res.error, 'error', id);
        return;
      }
      set((s) => {
        const { [id]: _removed, ...rest } = s.repoStatus;
        const { [id]: _removedInfo, ...restInfo } = s.repoInfo;
        return {
          repositories: s.repositories.filter((r) => r.id !== id),
          repoStatus: rest,
          repoInfo: restInfo,
        };
      });
    })();
  },

  syncRepository(id) {
    return (async () => {
      set((s) => ({
        repoStatus: {
          ...s.repoStatus,
          [id]: {
            phase: 'syncing',
            hasUpdate: s.repoStatus[id]?.hasUpdate ?? false,
            error: s.repoStatus[id]?.error,
          },
        },
      }));
      const res = await bridgeClient.syncRepository(id);
      set((s) => ({
        repositories: res.ok ? s.repositories.map((r) => (r.id === id ? res.repository : r)) : s.repositories,
        repoStatus: {
          ...s.repoStatus,
          [id]: {
            phase: 'idle',
            hasUpdate: res.ok ? false : (s.repoStatus[id]?.hasUpdate ?? false),
            // Success clears the error; a failure's error is set by notify() below.
            error: res.ok ? undefined : s.repoStatus[id]?.error,
          },
        },
      }));
      if (res.ok) {
        // Branch / skill count may have changed with the pulled content.
        const info = await bridgeClient.describeRepository(id);
        set((s) => ({ repoInfo: { ...s.repoInfo, [id]: info } }));
      } else {
        get().notify(res.error, 'error', id);
      }
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
              [r.id]: {
                phase: s.repoStatus[r.id]?.phase ?? 'idle',
                hasUpdate,
                error: s.repoStatus[r.id]?.error,
              },
            },
          }));
        }),
      );
    })();
  },

  refreshRepoInfo() {
    return (async () => {
      const repos = get().repositories;
      await Promise.all(
        repos.map(async (r) => {
          const info = await bridgeClient.describeRepository(r.id);
          set((s) => ({ repoInfo: { ...s.repoInfo, [r.id]: info } }));
        }),
      );
    })();
  },
}));
