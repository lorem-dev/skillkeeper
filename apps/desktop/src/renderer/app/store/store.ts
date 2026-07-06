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

/** Lifecycle of a queued repository task. */
export type RepoTaskStatus = 'queued' | 'running' | 'done' | 'error';

/** A repository operation queued for sequential execution (shown in the task list). */
export interface RepoTask {
  readonly id: string;
  readonly repoId: string;
  readonly repoName: string;
  /** 'sync' force-pulls; 'check' fetches to refresh the update indicator. */
  readonly kind: 'sync' | 'check';
  readonly status: RepoTaskStatus;
  /** ISO timestamp of when it was queued. */
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
  /** Sync task queue (newest last); executed one at a time. */
  tasks: RepoTask[];
  /** Whether the full-screen error-log page is open. */
  logsOpen: boolean;
  /** Whether the full-screen terminal page is open. */
  terminalOpen: boolean;
  /** Whether the full-screen sync task-list page is open. */
  tasksOpen: boolean;
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
  updateRepository(id: string, name: string, url: string, branch?: string): Promise<void>;
  removeRepository(id: string): Promise<void>;
  syncRepository(id: string): Promise<void>;
  /** Remove finished (done/error) tasks from the task list. */
  clearFinishedTasks(): void;
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
  /** Open the full-screen terminal page. */
  openTerminal(): void;
  /** Close the full-screen terminal page. */
  closeTerminal(): void;
  /** Open the full-screen sync task-list page. */
  openTasks(): void;
  /** Close the full-screen sync task-list page. */
  closeTasks(): void;
  /** Empty the notifications log. Leaves toasts and per-repo errors intact. */
  clearNotifications(): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type SkillkeeperStore = SkillkeeperState & SkillkeeperActions;

/** Serializes queued repository tasks so they run one at a time, in order. */
let taskChain: Promise<unknown> = Promise.resolve();

/** Append `run` to the task chain so it starts only after the previous task settles. */
function enqueue(run: () => Promise<void>): Promise<void> {
  const next = taskChain.then(run, run);
  taskChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

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
  tasks: [],
  logsOpen: false,
  terminalOpen: false,
  tasksOpen: false,
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

  openTerminal() {
    set({ terminalOpen: true });
  },

  closeTerminal() {
    set({ terminalOpen: false });
  },

  openTasks() {
    set({ tasksOpen: true });
  },

  closeTasks() {
    set({ tasksOpen: false });
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
      if (!cloned.ok) {
        set((s) => ({
          repoStatus: { ...s.repoStatus, [repo.id]: { phase: 'idle', hasUpdate: false } },
        }));
        get().notify(cloned.error, 'error', repo.id);
        return;
      }
      // Populate the branch + skill-count info so the card's badges appear right
      // after the clone, without waiting for a manual refresh.
      const info = await bridgeClient.describeRepository(repo.id);
      set((s) => ({
        repositories: s.repositories.map((r) => (r.id === repo.id ? cloned.repository : r)),
        repoInfo: { ...s.repoInfo, [repo.id]: info },
        repoStatus: { ...s.repoStatus, [repo.id]: { phase: 'idle', hasUpdate: false } },
      }));
    })();
  },

  updateRepository(id, name, url, branch) {
    return (async () => {
      const res = await bridgeClient.updateRepository(id, name, url, branch);
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
      // A branch checkout changes the current branch; refresh the card badge.
      const info = await bridgeClient.describeRepository(id);
      set((s) => ({ repoInfo: { ...s.repoInfo, [id]: info } }));
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
    // Enqueue a task and process the queue one at a time (in order). The card
    // enters the 'syncing' state the instant the task is queued -- not only when
    // it starts running -- and stays there until the task is FULLY done (sync +
    // describe). The task list shows queued/running/done/error.
    const repo = get().repositories.find((r) => r.id === id);
    const taskId = crypto.randomUUID();
    const setTaskStatus = (status: RepoTask['status']): void =>
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) }));
    set((s) => ({
      tasks: [
        ...s.tasks,
        {
          id: taskId,
          repoId: id,
          repoName: repo?.name ?? id,
          kind: 'sync' as const,
          status: 'queued' as const,
          at: new Date().toISOString(),
        },
      ],
      // Mark the card busy immediately, while the task is still queued.
      repoStatus: {
        ...s.repoStatus,
        [id]: {
          phase: 'syncing',
          hasUpdate: s.repoStatus[id]?.hasUpdate ?? false,
          error: s.repoStatus[id]?.error,
        },
      },
    }));

    const idle = (s: SkillkeeperState, patch: Partial<{ hasUpdate: boolean; error?: string }>) => ({
      repoStatus: {
        ...s.repoStatus,
        [id]: {
          phase: 'idle' as const,
          hasUpdate: s.repoStatus[id]?.hasUpdate ?? false,
          error: s.repoStatus[id]?.error,
          ...patch,
        },
      },
    });

    const runTask = async (): Promise<void> => {
      setTaskStatus('running');
      try {
        const res = await bridgeClient.syncRepository(id);
        if (res.ok) {
          // Stay 'syncing' until describe finishes, then leave the busy state in
          // a single update so the card only settles once the task is complete.
          const info = await bridgeClient.describeRepository(id);
          set((s) => ({
            repositories: s.repositories.map((r) => (r.id === id ? res.repository : r)),
            repoInfo: { ...s.repoInfo, [id]: info },
            ...idle(s, { hasUpdate: false, error: undefined }),
          }));
          setTaskStatus('done');
        } else {
          get().notify(res.error, 'error', id);
          set((s) => idle(s, {}));
          setTaskStatus('error');
        }
      } catch {
        // Never wedge the queue: mark idle+error and continue with the next task.
        set((s) => idle(s, {}));
        setTaskStatus('error');
      }
    };
    return enqueue(runTask);
  },

  clearFinishedTasks() {
    set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'queued' || t.status === 'running') }));
  },

  refreshRepoUpdates() {
    // Each repo's update-check fetch runs as its own queued task (sequentially,
    // via the shared task chain), so checks are visible in the task list and
    // never race a sync on the same repo -- rather than a parallel burst.
    const repos = get().repositories;
    const runs = repos.map((r) => {
      const taskId = crypto.randomUUID();
      const setTaskStatus = (status: RepoTask['status']): void =>
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) }));
      set((s) => ({
        tasks: [
          ...s.tasks,
          {
            id: taskId,
            repoId: r.id,
            repoName: r.name,
            kind: 'check' as const,
            status: 'queued' as const,
            at: new Date().toISOString(),
          },
        ],
      }));
      return enqueue(async () => {
        setTaskStatus('running');
        try {
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
          setTaskStatus('done');
        } catch {
          setTaskStatus('error');
        }
      });
    });
    return Promise.all(runs).then(() => undefined);
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
