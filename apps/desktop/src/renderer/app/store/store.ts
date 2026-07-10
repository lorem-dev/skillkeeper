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
  ProjectsConfig,
  Repository,
  Project,
  InstallManifest,
  AvailableSkill,
  AgentKind,
  ApplyArgs,
  ApplyResult,
  ApplyProgress,
  RepoInfo,
  ProjectInfo,
  McpServerDef,
  McpPresetOrigin,
  McpInstall,
  ApplyMcpArgs,
  ApplyMcpResult,
  UpdateMcpArgs,
  UpdateMcpResult,
} from '@/services/bridge';
import { bridgeClient } from '@/services/bridge';
import { installedLeafIds, installedAgentsByProject } from '@/entities/skill';
import type { ProjectSkillUpdate } from '@/entities/skill';

// Re-export the bridge-compatible config result shape for consumers.
export type { SectionValidity, SkillKeeperConfig };
export type { GeneralConfig, UpdatesConfig, AgentsConfig, NotificationsConfig, RepositoriesConfig, ProjectsConfig };
export type { Repository, Project, InstallManifest };

/** A partial update to the config, merged into the current config on write. */
export interface ConfigPatch {
  general?: Partial<GeneralConfig>;
  updates?: Partial<UpdatesConfig>;
  agents?: Partial<AgentsConfig>;
  notifications?: Partial<NotificationsConfig>;
  repositories?: Partial<RepositoriesConfig>;
  projects?: Partial<ProjectsConfig>;
  mcp?: Partial<SkillKeeperConfig['mcp']>;
}

/**
 * One MCP server preset available to install: the union of manually-defined
 * presets (`config.mcp.servers`, editable) and presets discovered from cloned
 * repositories (`AvailableMcp`, read-only, refreshed on repo sync).
 */
export interface McpPreset {
  /** Manual: the config entry's stable `id`. Repo: a synthesized, stable id
   *  from `repoId` + `group` + `name` (see {@link repoMcpPresetId}). */
  readonly id: string;
  readonly origin: McpPresetOrigin;
  readonly name: string;
  readonly def: McpServerDef;
  /** Content hash of the raw def (excludes `name`), for update detection. */
  readonly hash: string;
  /** `{param}` placeholders found across the def's fields, sorted + deduped. */
  readonly params: string[];
  readonly hasRules: boolean;
  readonly repoId?: string;
  readonly remote?: string;
  readonly group?: string;
}

/** Synthesizes a stable id for a repo-discovered preset from its source. */
function repoMcpPresetId(repoId: string, group: string | undefined, name: string): string {
  return `repo:${repoId}:${group ?? ''}:${name}`;
}

// The renderer must not call `@skillkeeper/core`'s runtime exports directly --
// only its types cross the layer boundary (see architecture.md: "In the
// renderer, import only TYPES ... cross the IPC bridge instead"). Concretely,
// `@skillkeeper/core` is one barrel module: importing any single runtime
// export from it pulls the whole module graph into the renderer bundle,
// including files that reach for Node's `fs`/`crypto`/`child_process`
// (`nodeFs.ts`, `mcpHashing.ts`, `systemGit.ts`), which the sandboxed renderer
// (`nodeIntegration: false`) cannot run. `parseParams` and `normalizeRemote`
// happen to be pure and dependency-free in isolation, but importing them still
// drags that graph in (verified: doing so adds "externalized for browser
// compatibility" warnings to the renderer build that are otherwise absent).
// The three helpers below duplicate those small, stable algorithms locally
// instead, byte-for-byte, so the store never reaches into core's runtime.

/** Mirrors core's `parseParams` (`mcpParams.ts`): scans every string field of
 *  an MCP def for `{param}` placeholders and returns the sorted, deduped set.
 *  Exported so a guard test can pin it to core's `parseParams`. */
export function scanMcpParams(def: McpServerDef): string[] {
  const names = new Set<string>();
  const scan = (text: string): void => {
    for (const match of text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  };
  if (def.url !== undefined) scan(def.url);
  if (def.headers !== undefined) for (const v of Object.values(def.headers)) scan(v);
  if (def.command !== undefined) scan(def.command);
  if (def.args !== undefined) for (const a of def.args) scan(a);
  if (def.env !== undefined) for (const v of Object.values(def.env)) scan(v);
  if (def.rules !== undefined) scan(def.rules);
  return [...names].sort();
}

/** Mirrors core's `normalizeRemote` (`repoRemote.ts`): canonicalizes a git
 *  remote URL to `host/path`, lowercased, without transport/user/port/`.git`,
 *  so ssh/https/scp forms of the same remote compare equal. Exported so a
 *  guard test can pin it to core's `normalizeRemote`. */
export function normalizeMcpRemote(url: string): string {
  let s = url.trim();
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s);
  if (scp !== null) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.+)$/.exec(s);
    if (withScheme !== null) {
      let rest = withScheme[1]!;
      const at = rest.lastIndexOf('@');
      if (at !== -1) rest = rest.slice(at + 1);
      rest = rest.replace(/^([^/]+):\d+\//, '$1/');
      s = rest;
    }
  }
  return s
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

/**
 * Recursively sorts object keys for stable JSON, mirroring core's
 * `canonicalMcpJson` (in `mcpHashing.ts`). Duplicated for the same reason as
 * `scanMcpParams`/`normalizeMcpRemote` above: `hashMcpDef` itself calls Node's
 * `crypto.createHash`, unreachable from the sandboxed renderer.
 * `hashMcpDefInRenderer` below reproduces the same canonical-JSON + SHA-256
 * algorithm using the standard Web Crypto API (`crypto.subtle`), available in
 * every renderer/browser context, so its output matches the main process's
 * `hashMcpDef` byte-for-byte.
 */
function sortMcpKeysForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortMcpKeysForHash);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortMcpKeysForHash(child);
    }
    return out;
  }
  return value;
}

/** Content hash of an MCP server def, excluding `name` -- see the note on
 *  {@link sortMcpKeysForHash} for why this is not simply `core`'s `hashMcpDef`.
 *  Exported so a guard test can pin it to core's `hashMcpDef`. */
export async function hashMcpDefInRenderer(def: McpServerDef): Promise<string> {
  const { name: _name, ...rest } = def;
  const canonical = JSON.stringify(sortMcpKeysForHash(rest));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/**
 * Finds the preset a ledger install refers to: manual installs match by their
 * local preset id; repo installs match by (normalized remote, group, source
 * name). Returns undefined when no preset in the current catalog matches
 * (e.g. the repo preset or manual entry was removed). Exported so a caller
 * driving the update flow (e.g. the Skills page's per-instance Update badge)
 * can read the matched preset's current `def` to build an `McpUpdateReq`.
 */
export function matchMcpPreset(install: McpInstall, presets: readonly McpPreset[]): McpPreset | undefined {
  const { identity } = install;
  if (identity.local !== undefined) {
    return presets.find((p) => p.origin === 'manual' && p.id === identity.local);
  }
  return presets.find(
    (p) =>
      p.origin === 'repo' &&
      p.remote !== undefined &&
      identity.remote !== undefined &&
      normalizeMcpRemote(p.remote) === normalizeMcpRemote(identity.remote) &&
      p.group === identity.group &&
      p.name === identity.source,
  );
}

/**
 * Whether an installed MCP instance is out of date relative to its current
 * preset -- i.e. a repo sync or a manual-preset edit changed the source def
 * since this instance was installed/last updated. An install whose preset can
 * no longer be found (removed repo/manual entry) is never "updatable" here;
 * that is a removal case, not an update one.
 */
export function mcpInstallHasUpdate(install: McpInstall, presets: readonly McpPreset[]): boolean {
  const preset = matchMcpPreset(install, presets);
  return preset !== undefined && install.hash !== preset.hash;
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
  /** 'sync' force-pulls; 'check' fetches to refresh the update indicator;
   *  'update-skill' re-installs one project skill from its repository. */
  readonly kind: 'sync' | 'check' | 'update-skill';
  readonly status: RepoTaskStatus;
  /** ISO timestamp of when it was queued. */
  readonly at: string;
}

/** Skills-page display mode: browse by repository or by tracked project. */
export type SkillsMode = 'repositories' | 'projects';

/**
 * Skills-page selection + view state. Lives in the store (not component state)
 * so the user's picks survive navigating away and back; it is reset only on app
 * reload (the store is recreated) or when the installed baseline changes (a new
 * load or a successful apply reseeds the selection). See `setSkills`.
 */
export interface SkillsUiState {
  /** Browse-by mode. */
  mode: SkillsMode;
  /** Tree search query. */
  query: string;
  /** Repo ids the tree is narrowed to (empty = all). */
  repoFilter: string[];
  /** Project ids the tree is narrowed to (empty = all). */
  projectFilter: string[];
  /** Repo-mode checked skill leaf ids (baseline: none). */
  repoChecked: string[];
  /** Project-mode checked skill leaf ids (baseline: the installed set). */
  projectChecked: string[];
  /** Chosen agents per project (baseline: the installed agents). */
  projectAgents: Record<string, AgentKind[]>;
}

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
  /** Every skill available across all cloned repositories (for the Skills page). */
  availableSkills: AvailableSkill[];
  /** Progress of an in-flight skill apply (install/remove), or null when idle. */
  skillApply: ApplyProgress | null;
  /** Skills-page selection + view state (persists across navigation until reload). */
  skillsUi: SkillsUiState;
  /** Nonce bumped by `goToSkills` to request navigating to the Skills page (App
   *  watches it and switches the active view). */
  skillsNav: number;
  /**
   * A pending "add repository" request from another page (e.g. an unlinked skill
   * on the Skills page): the remote URL to prefill. Setting it navigates to the
   * Repositories page (App) and opens the add form prefilled (RepoAddButton).
   */
  addRepoRequest: string | null;
  /** Tracked projects. */
  projects: Project[];
  /** Per-project skill counts for the card badges (not persisted). */
  projectInfo: Record<string, ProjectInfo>;
  /** Projects whose folder no longer exists (deleted/moved); not persisted. */
  projectMissing: Record<string, boolean>;
  /** Union of manual (config) + repo-discovered MCP server presets. */
  mcpPresets: McpPreset[];
  /** Installed MCP server instances, read from every agent's ledger. */
  mcpInstalls: McpInstall[];
  /**
   * A pending "focus this repository" request, bumped by `focusRepository` so
   * a consuming page (e.g. an MCP card's "source repository" badge) can react
   * even to repeated requests for the same repo. Mirrors the `skillsNav`/
   * `addRepoRequest` nonce pattern.
   */
  repoFocus: { repoId: string; nonce: number } | null;
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
  /** Merge a partial update into the skills-page selection/view state. */
  setSkillsUi(patch: Partial<SkillsUiState>): void;
  /**
   * Discard the current mode's pending selection changes, restoring it to the
   * installed baseline (repo mode: clear checks; project mode: reseed checks and
   * agents from the installed set). View state (mode/query/filters) is kept.
   */
  resetSkillsSelection(mode: SkillsMode): void;
  /**
   * Navigate to the Skills page: merge `patch` into the skills-page state
   * (mode/filters/query) and bump `skillsNav` so the shell switches view. When
   * `resetSelection` is true (the default) the target mode's checkbox selection
   * is reset to the installed baseline; pass `false` to keep the current
   * selection and only apply the patch (e.g. just narrowing a filter).
   */
  goToSkills(patch: Partial<SkillsUiState>, resetSelection?: boolean): void;
  setProjects(projects: Project[]): void;
  /** Refetch the available-skills catalog from all repos. */
  refreshAvailableSkills(): Promise<void>;
  /** Apply skill installs/removals for a project; tracks progress in `skillApply`. */
  applySkills(args: ApplyArgs): Promise<ApplyResult>;
  /** Scan project folders to adopt/prune installs, refreshing `skills`. */
  reconcileSkills(): Promise<void>;
  /** Prune MCP ledger/params entries whose native server is gone; refreshes `mcpInstalls`. */
  reconcileMcp(): Promise<void>;
  /** Rebuild `mcpPresets`: manual (config `mcp.servers`) union repo-discovered presets. */
  refreshMcpPresets(): Promise<void>;
  /** Refetch installed MCP server instances from every agent's ledger into `mcpInstalls`. */
  refreshMcpInstalls(): Promise<void>;
  /** Install/remove MCP server instances for a project; refreshes `mcpInstalls` afterward. */
  applyMcp(args: ApplyMcpArgs): Promise<ApplyMcpResult>;
  /** Update installed MCP instances to their preset's current def; refreshes `mcpInstalls` afterward. */
  updateMcp(args: UpdateMcpArgs): Promise<UpdateMcpResult>;
  /** Queue one update-skill task per request (re-install from the repository). */
  updateProjectSkills(requests: readonly ProjectSkillUpdate[]): void;
  /** Request navigating to Repositories and opening the add form for `remote`. */
  requestAddRepository(remote: string): void;
  /** Clear a consumed add-repository request. */
  clearAddRepoRequest(): void;
  /** Request focusing one repository (e.g. from an MCP preset's source badge);
   *  bumps `repoFocus.nonce` so a consuming page reacts even to repeat requests. */
  focusRepository(repoId: string): void;
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
  /** Track a project for a chosen folder (name pre-derived from the folder). */
  addProject(path: string, name: string): Promise<void>;
  updateProject(id: string, path: string, name: string): Promise<void>;
  /** Stop tracking a project (the folder on disk is left untouched). */
  removeProject(id: string): Promise<void>;
  /** Fetch skill counts for every project into `projectInfo`. */
  refreshProjectInfo(): Promise<void>;
  /** Check every project's folder exists and update `projectMissing`. */
  checkProjects(): Promise<void>;
  /** Run the folder check now and (re)schedule the next run after the interval. */
  sweepProjects(): Promise<void>;
  /** Re-check one project's folder before an action; notifies + marks it missing
   * when the folder is gone. Resolves to whether the folder still exists. */
  ensureProjectAvailable(id: string): Promise<boolean>;
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

/** Pending timer for the next project-folder sweep (self-rescheduling loop). */
let projectSweepTimer: ReturnType<typeof setTimeout> | undefined;

/** Append `run` to the task chain so it starts only after the previous task settles. */
function enqueue(run: () => Promise<void>): Promise<void> {
  const next = taskChain.then(run, run);
  taskChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/** The project-mode selection (checks + agents) that matches what is installed. */
function installedBaseline(
  installs: readonly InstallManifest[],
): Pick<SkillsUiState, 'projectChecked' | 'projectAgents'> {
  return { projectChecked: installedLeafIds(installs), projectAgents: installedAgentsByProject(installs) };
}

export const useSkillkeeperStore = create<SkillkeeperStore>((set, get) => ({
  // Initial state
  config: null,
  configValidity: null,
  configWarnings: [],
  repositories: [],
  repoStatus: {},
  repoInfo: {},
  projectInfo: {},
  projectMissing: {},
  notifications: [],
  toasts: [],
  tasks: [],
  logsOpen: false,
  terminalOpen: false,
  tasksOpen: false,
  skills: [],
  availableSkills: [],
  skillApply: null,
  skillsUi: {
    mode: 'projects',
    query: '',
    repoFilter: [],
    projectFilter: [],
    repoChecked: [],
    projectChecked: [],
    projectAgents: {},
  },
  skillsNav: 0,
  addRepoRequest: null,
  projects: [],
  mcpPresets: [],
  mcpInstalls: [],
  repoFocus: null,
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
    // A new installed baseline (initial load or a successful apply) reseeds the
    // selection: repo checks clear and project checks/agents match what is now
    // installed, so pending changes never linger against a stale baseline. Plain
    // navigation never calls this, so in-progress picks survive it.
    set((s) => ({ skills, skillsUi: { ...s.skillsUi, repoChecked: [], ...installedBaseline(skills) } }));
  },

  setSkillsUi(patch) {
    set((s) => ({ skillsUi: { ...s.skillsUi, ...patch } }));
  },

  resetSkillsSelection(mode) {
    set((s) => ({
      skillsUi:
        mode === 'repositories'
          ? { ...s.skillsUi, repoChecked: [] }
          : { ...s.skillsUi, ...installedBaseline(get().skills) },
    }));
  },

  goToSkills(patch, resetSelection = true) {
    set((s) => {
      const merged = { ...s.skillsUi, ...patch };
      if (!resetSelection) {
        // Keep the current view/selection untouched and only apply the patch
        // (e.g. narrowing to one repository from its card).
        return { skillsUi: merged, skillsNav: s.skillsNav + 1 };
      }
      // Reset the target mode's selection to the installed baseline (repo mode:
      // no checks; project mode: reseed from installed), so no stale pending
      // changes carry over into the fresh view.
      const selection =
        merged.mode === 'repositories'
          ? { repoChecked: [] }
          : installedBaseline(get().skills);
      return { skillsUi: { ...merged, ...selection }, skillsNav: s.skillsNav + 1 };
    });
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
      // reconcileSkills returns the full install list AND syncs state with disk
      // (adopts skills pulled in via git, prunes gone ones, re-homes by remote).
      const [configResult, repos, skills, available, projects, mcpInstalls] = await Promise.all([
        client.getConfig(),
        client.listRepositories(),
        client.reconcileSkills(),
        client.listAvailableSkills(),
        client.listProjects(),
        // Reconcile MCP ledgers with disk alongside the skill reconcile, and
        // seed `mcpInstalls` from the surviving list (mirrors reconcileSkills).
        client.reconcileMcp(),
      ]);
      setConfig(configResult.config, configResult.validity, configResult.warnings);
      setRepositories(repos);
      setSkills(skills);
      set({ availableSkills: available, mcpInstalls });
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
      ...(patch.projects !== undefined ? { projects: { ...current.projects, ...patch.projects } } : {}),
      ...(patch.mcp !== undefined ? { mcp: { ...current.mcp, ...patch.mcp } } : {}),
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
          // A synced repo may add/remove/change skills: refresh the catalog and
          // reconcile installs so project-mode update dots recompute.
          await get().refreshAvailableSkills();
          await get().reconcileSkills();
          await get().reconcileMcp();
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

  refreshAvailableSkills() {
    return (async () => {
      const available = await bridgeClient.listAvailableSkills();
      set({ availableSkills: available });
    })();
  },

  applySkills(args) {
    return (async () => {
      const perSkill = Math.max(1, args.agents.length);
      const total = (args.install.length + args.remove.length) * perSkill;
      set({ skillApply: { done: 0, total, label: '' } });
      const off = bridgeClient.onSkillsProgress((p) => set({ skillApply: p }));
      try {
        const result = await bridgeClient.applySkillChanges(args);
        if (!result.ok) get().notify(result.error, 'error');
        // Refresh the installed set so the tree/badges reflect the new state.
        const skills = await bridgeClient.listSkills();
        get().setSkills(skills);
        return result;
      } finally {
        off();
        set({ skillApply: null });
      }
    })();
  },

  reconcileSkills() {
    return (async () => {
      const installs = await bridgeClient.reconcileSkills();
      get().setSkills(installs);
    })();
  },

  reconcileMcp() {
    return (async () => {
      // Prune stale MCP ledger/params entries on disk; store the surviving
      // installed-instance list (mirrors reconcileSkills -> setSkills).
      const mcpInstalls = await bridgeClient.reconcileMcp();
      set({ mcpInstalls });
    })();
  },

  refreshMcpPresets() {
    return (async () => {
      const manualDefs = get().config?.mcp.servers ?? [];
      const manual = await Promise.all(
        manualDefs.map(async (preset): Promise<McpPreset> => {
          const { id, ...def } = preset;
          return {
            id,
            origin: 'manual',
            name: def.name,
            def,
            hash: await hashMcpDefInRenderer(def),
            params: scanMcpParams(def),
            hasRules: def.rules !== undefined,
          };
        }),
      );
      const available = await bridgeClient.listAvailableMcp();
      const repo: McpPreset[] = available.map((a) => ({
        id: repoMcpPresetId(a.repoId, a.group, a.def.name),
        origin: 'repo',
        name: a.def.name,
        def: a.def,
        hash: a.hash,
        params: scanMcpParams(a.def),
        hasRules: a.def.rules !== undefined,
        repoId: a.repoId,
        remote: a.remote,
        group: a.group,
      }));
      set({ mcpPresets: [...manual, ...repo] });
    })();
  },

  refreshMcpInstalls() {
    return (async () => {
      const mcpInstalls = await bridgeClient.listMcpInstalls();
      set({ mcpInstalls });
    })();
  },

  applyMcp(args) {
    return (async () => {
      const result = await bridgeClient.applyMcp(args);
      await get().refreshMcpInstalls();
      return result;
    })();
  },

  updateMcp(args) {
    return (async () => {
      const result = await bridgeClient.updateMcp(args);
      await get().refreshMcpInstalls();
      return result;
    })();
  },

  focusRepository(repoId) {
    set((s) => ({ repoFocus: { repoId, nonce: (s.repoFocus?.nonce ?? 0) + 1 } }));
  },

  updateProjectSkills(requests) {
    // One task per skill, run through the shared queue (one at a time). Each task
    // re-installs the skill (remove + install) from its current repository.
    for (const req of requests) {
      const taskId = crypto.randomUUID();
      const setTaskStatus = (status: RepoTask['status']): void =>
        set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) }));
      set((s) => ({
        tasks: [
          ...s.tasks,
          {
            id: taskId,
            repoId: req.repoId,
            repoName: req.repoName,
            kind: 'update-skill' as const,
            status: 'queued' as const,
            at: new Date().toISOString(),
          },
        ],
      }));
      void enqueue(async () => {
        setTaskStatus('running');
        const result = await get().applySkills({
          projectId: req.projectId,
          projectPath: req.projectPath,
          agents: req.agents,
          install: [req.ref],
          remove: [req.ref],
        });
        setTaskStatus(result.ok ? 'done' : 'error');
      });
    }
  },

  requestAddRepository(remote) {
    set({ addRepoRequest: remote });
  },

  clearAddRepoRequest() {
    set({ addRepoRequest: null });
  },

  addProject(path, name) {
    return (async () => {
      const res = await bridgeClient.addProject(path, name);
      if (!res.ok) {
        get().notify(res.error, 'error');
        return;
      }
      const info = await bridgeClient.describeProject(res.project.id);
      set((s) => ({
        projects: [...s.projects, res.project],
        projectInfo: { ...s.projectInfo, [res.project.id]: info },
      }));
      // The added folder may already contain skills (e.g. pulled in via git);
      // reconcile adopts them into the install list.
      await get().reconcileSkills();
      // Likewise reconcile any MCP ledgers the added folder already carries.
      await get().reconcileMcp();
    })();
  },

  updateProject(id, path, name) {
    return (async () => {
      const res = await bridgeClient.updateProject(id, path, name);
      if (!res.ok) {
        get().notify(res.error, 'error');
        return;
      }
      const info = await bridgeClient.describeProject(id);
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? res.project : p)),
        projectInfo: { ...s.projectInfo, [id]: info },
      }));
    })();
  },

  removeProject(id) {
    return (async () => {
      const res = await bridgeClient.removeProject(id);
      if (!res.ok) {
        get().notify(res.error, 'error');
        return;
      }
      set((s) => {
        const { [id]: _removed, ...restInfo } = s.projectInfo;
        const { [id]: _removedMissing, ...restMissing } = s.projectMissing;
        return {
          projects: s.projects.filter((p) => p.id !== id),
          projectInfo: restInfo,
          projectMissing: restMissing,
        };
      });
    })();
  },

  refreshProjectInfo() {
    return (async () => {
      const projects = get().projects;
      await Promise.all(
        projects.map(async (p) => {
          const info = await bridgeClient.describeProject(p.id);
          set((s) => ({ projectInfo: { ...s.projectInfo, [p.id]: info } }));
        }),
      );
    })();
  },

  checkProjects() {
    return (async () => {
      const projects = get().projects;
      await Promise.all(
        projects.map(async (p) => {
          const exists = await bridgeClient.projectExists(p.id);
          set((s) => ({ projectMissing: { ...s.projectMissing, [p.id]: !exists } }));
        }),
      );
    })();
  },

  sweepProjects() {
    return (async () => {
      if (projectSweepTimer !== undefined) {
        clearTimeout(projectSweepTimer);
        projectSweepTimer = undefined;
      }
      await get().checkProjects();
      // Reschedule after the configured interval: run to completion, then again.
      const minutes = get().config?.projects.checkIntervalMinutes ?? 1;
      projectSweepTimer = setTimeout(() => void get().sweepProjects(), minutes * 60 * 1000);
    })();
  },

  ensureProjectAvailable(id) {
    return (async () => {
      const exists = await bridgeClient.projectExists(id);
      set((s) => ({ projectMissing: { ...s.projectMissing, [id]: !exists } }));
      if (!exists) get().notify({ key: 'projects.missing' }, 'error');
      return exists;
    })();
  },
}));
