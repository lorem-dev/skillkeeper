/**
 * Zustand store for the SkillKeeper renderer.
 *
 * Holds all UI state derived from bridge calls to the Rust backend. The renderer
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
  ProjectFolderState,
  InstallManifest,
  AvailableSkill,
  SkillResolveWarning,
  AgentKind,
  ApplyArgs,
  ApplyResult,
  ApplyProgress,
  RepoInfo,
  ProjectInfo,
  McpServerDef,
  McpPresetOrigin,
  McpInstall,
  McpBatch,
  ApplyMcpArgs,
  ApplyMcpResult,
  UpdateMcpArgs,
  UpdateMcpResult,
} from '@/services/bridge';
import { bridgeClient } from '@/services/bridge';
import { applyScope } from '@/domain';
import { installedLeafIds, installedAgentsByProject } from '@/entities/skill';
import type { ProjectSkillUpdate } from '@/entities/skill';
import { ensureCatalog, resolveLang } from '@/systems/i18n';
import { ONBOARDING_ORDER } from '@/app/config/onboarding';
import { nextStepId, prevStepId } from '@/systems/onboarding';
import type { StepId } from '@/systems/onboarding';
// From the feature's UI-free lib barrel, not its main barrel (`@/features/sshKey`):
// that one re-exports `ui/SshKeyField.tsx`, which imports `@/app/store` --
// importing it here would be a cycle (store -> feature UI barrel -> store).
import { sshErrorKey } from '@/features/sshKey/lib';

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

/** Synthesizes a stable id for a repo-discovered preset from its source.
 *  Exported so a story fixture building an `McpPreset[]` by hand (Storybook
 *  runs outside Tauri, so `refreshMcpPresets` cannot run for real) can derive
 *  the same ids `buildMcpProjectTree`/`buildMcpRepoTree` expect instead of
 *  hand-rolling a string that might drift from this format. */
export function repoMcpPresetId(repoId: string, group: string | undefined, name: string): string {
  return `repo:${repoId}:${group ?? ''}:${name}`;
}

// The domain logic runs in the Rust backend (`skillkeeper-core`) and reaches
// the renderer only through the typed Tauri bridge -- only TYPES cross the
// layer boundary (see architecture.md: "In the renderer, import only TYPES ...
// cross the IPC bridge instead"). A few small, pure MCP algorithms are needed
// synchronously in the renderer (for live preset editing/update detection), so
// the three helpers below reimplement them locally, matching the canonical Rust
// implementations in `skillkeeper-core` (which its `cargo test` suite covers).

/** Mirrors the Rust `parse_params` (`skillkeeper-core` `mcp`): scans every string field of
 *  an MCP def for `{param}` placeholders and returns the sorted, deduped set.
 *  Exported so its behavior can be tested directly. */
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

/** Mirrors the Rust `normalize_remote` (`skillkeeper-core`): canonicalizes a git
 *  remote URL to `host/path`, lowercased, without transport/user/port/`.git`,
 *  so ssh/https/scp forms of the same remote compare equal. Exported so its
 *  behavior can be tested directly. */
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
 * Recursively sorts object keys for stable JSON, mirroring the Rust
 * `canonical_mcp_json` (`skillkeeper-core` `mcp`). Reimplemented for the same
 * reason as `scanMcpParams`/`normalizeMcpRemote` above: the canonical hash is
 * computed in the backend, but the renderer needs it synchronously for update
 * detection. `hashMcpDefInRenderer` below reproduces the same canonical-JSON +
 * SHA-256 algorithm using the standard Web Crypto API (`crypto.subtle`),
 * available in every renderer/browser context, so its output matches the
 * backend's `hash_mcp_def` byte-for-byte.
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
 *  {@link sortMcpKeysForHash} for why this reimplements the backend's
 *  `hash_mcp_def`. Exported so its behavior can be tested directly. */
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

/**
 * Severity of a notification entry.
 *
 * `warning` sits between the two: something the user should see and may need to
 * act on, but which did not fail the operation -- a skill-resolution warning, for
 * example, where the rest of the repository still resolved.
 */
export type NotificationLevel = 'error' | 'warning' | 'info';

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
  /**
   * Documentation URL this entry points at, opened in the browser. Set when the
   * message describes something the user has to set up outside the app, where
   * the text alone cannot carry the instructions.
   */
  readonly href?: string;
  /** ISO timestamp. */
  readonly at: string;
}

/** Lifecycle of a queued repository task.
 *
 * `skipped` is not a failure: the operation could not run yet because the chosen
 * SSH key is locked, and a scheduled check never blocks waiting for a
 * passphrase. It raises the prompt and resumes once the key is unlocked, so
 * reporting the first attempt as failed would call the app broken for doing
 * exactly what it was asked to do. */
export type RepoTaskStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped';

/** A repository operation queued for sequential execution (shown in the task list). */
export interface RepoTask {
  readonly id: string;
  readonly repoId: string;
  readonly repoName: string;
  /** 'sync' force-pulls; 'check' fetches to refresh the update indicator;
   *  'update-skill' re-installs one project skill from its repository;
   *  'refresh-projects' re-scans tracked project folders + their skill counts
   *  (not tied to a repository -- `repoName` is empty). */
  readonly kind: 'sync' | 'check' | 'update-skill' | 'refresh-projects';
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
  /**
   * Tree expansion, in-memory only (survives navigation, resets on app
   * reload). `null` means "not yet customized by the user" -- the page then
   * falls back to its own default (the root ids).
   */
  expandedIds: string[] | null;
}

/** MCP-page display mode: browse by repository or by tracked project. */
export type McpMode = 'repositories' | 'projects';

/** MCP components view: tile grid vs. hierarchical tree. */
export type McpComponentsView = 'tiles' | 'tree';

/**
 * MCP-page view state: display mode + tree expansion. Lives in the store (not
 * component state) so it survives navigating away and back, in memory only
 * (resets on app reload). Mirrors the view-state half of `SkillsUiState`.
 */
export interface McpUiState {
  /** Browse-by mode. */
  mode: McpMode;
  /** Tree expansion, in-memory only; `null` = not yet customized. */
  expandedIds: string[] | null;
  /** Components-page display: tile grid or tree. */
  componentsView: McpComponentsView;
  /** Components-page repository filter (empty = all). Lives here (not local
   *  component state) so `goToMcp` can set it from another page. */
  componentsRepoFilter: string[];
  /** Management-page project filter (empty = all). Lives here so `goToMcpProject`
   *  can set it from a project card. */
  managementProjectFilter: string[];
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
  /**
   * Why the embedded terminal is unavailable, or null while it is healthy.
   *
   * The backend runs repository git through the terminal only while a shell
   * session is live, falling back to a silent headless git otherwise. Without
   * this, that fallback is indistinguishable from "nothing happened": the
   * terminal stays blank during a clone and no error is raised anywhere.
   */
  terminalError: string | null;
  /** Whether the full-screen sync task-list page is open. */
  tasksOpen: boolean;
  /** Whether the About dialog is open. */
  aboutOpen: boolean;
  /** Installed skills. */
  skills: InstallManifest[];
  /** Every skill available across all cloned repositories (for the Skills page). */
  availableSkills: AvailableSkill[];
  /** Progress of an in-flight skill apply (install/remove), or null when idle. */
  skillApply: ApplyProgress | null;
  /** Skills-page selection + view state (persists across navigation until reload). */
  skillsUi: SkillsUiState;
  /** MCP-page view state (persists across navigation until reload). */
  mcpUi: McpUiState;
  /** Nonce bumped by `goToSkills` to request navigating to the Skills page (App
   *  watches it and switches the active view). */
  skillsNav: number;
  /** Nonce bumped by `goToMcp`/`goToMcpProject` to request navigating to an MCP
   *  sub-page (App watches it, switches the active view, and opens the MCP nav
   *  group). `mcpNavView` says which sub-page. */
  mcpNav: number;
  mcpNavView: 'mcp-components' | 'mcp-management';
  /**
   * A pending "add repository" request from another page (e.g. an unlinked skill
   * on the Skills page): the remote URL to prefill. Setting it navigates to the
   * Repositories page (App) and opens the add form prefilled (RepoAddButton).
   */
  addRepoRequest: string | null;
  /**
   * True once a background update check was refused because the chosen SSH key
   * is locked. The refusal raises the passphrase window, and this flag is what
   * lets the answer to that window re-run the sweep it interrupted (or explain
   * the skip if the user declines). Cleared by any check that succeeds.
   */
  updatesBlockedByKey: boolean;
  /** Tracked projects. */
  projects: Project[];
  /** Per-project skill counts for the card badges (not persisted). */
  projectInfo: Record<string, ProjectInfo>;
  /**
   * Projects whose folder the app cannot use, and why: `missing` when it was
   * deleted or moved, `denied` when this system refuses to describe it (on macOS
   * the normal state for a folder under Desktop, Documents, Downloads, or a
   * removable or network volume until the user grants access). A project absent
   * from the map is usable. Not persisted.
   */
  projectFolder: Record<string, ProjectFolderState>;
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
  /** Guided-tour progress (persisted via the bridge's onboarding store). */
  onboarding: { active: boolean; step: StepId; completed: boolean };
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
  /** Merge a partial update into the MCP-page view state. */
  setMcpUi(patch: Partial<McpUiState>): void;
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
  /** Navigate to the MCP Components page filtered to one repository: set the
   *  components repo filter and bump `mcpNav` so the shell switches view. */
  goToMcp(repoId: string): void;
  /** Navigate to the MCP Management page filtered to one project: set the
   *  management project filter and bump `mcpNav`. */
  goToMcpProject(projectId: string): void;
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
  /**
   * Deletes a MANUAL preset: uninstalls every one of its currently-installed
   * instances (across every tracked project and the global codex scope) via
   * `applyMcp`, then removes it from `config.mcp.servers`. Uninstall always
   * runs before the config write -- if any `applyMcp` call fails, the error is
   * `notify`-ed and the preset is left in config so the delete can be retried.
   */
  deleteMcpPreset(presetId: string): Promise<void>;
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
  /** Load all data from the Rust backend via the bridge client. */
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
  /** Check every repository for upstream updates. `interactive` is true only
   *  when a user asked for the check (the Repositories "Refresh" button); the
   *  scheduled and startup sweeps pass false so a locked SSH key cannot pop a
   *  passphrase prompt with nobody there to answer it. */
  refreshRepoUpdates(interactive: boolean): Promise<void>;
  /**
   * Report how the passphrase window closed, so a sweep the locked key refused
   * can finish what it started: an unlock re-runs it, a decline says once that
   * the check stayed skipped. A no-op when no sweep was refused.
   */
  noteUnlockResolved(unlocked: boolean): void;
  /** Fetch branch + skill count for every repo into `repoInfo`. */
  refreshRepoInfo(): Promise<void>;
  /** Track a project for a chosen folder (name pre-derived from the folder). */
  addProject(path: string, name: string): Promise<void>;
  updateProject(id: string, path: string, name: string): Promise<void>;
  /** Stop tracking a project (the folder on disk is left untouched). */
  removeProject(id: string): Promise<void>;
  /** Fetch skill counts for every project into `projectInfo`. */
  refreshProjectInfo(): Promise<void>;
  /** Check every project's folder and update `projectFolder`. */
  checkProjects(): Promise<void>;
  /** Run the folder check now and (re)schedule the next run after the interval. */
  sweepProjects(): Promise<void>;
  /** User-triggered project refresh: re-scan folders + skill counts, tracked as
   *  a `refresh-projects` task in the task list. */
  refreshProjects(): Promise<void>;
  /** Re-check one project's folder before an action; notifies + marks it missing
   * when the folder is gone. Resolves to whether the folder still exists. */
  ensureProjectAvailable(id: string): Promise<boolean>;
  /**
   * Record a notification: append to the log + toasts. An `error` notification
   * with a `repoId` also marks that repo's status (the red dot); `warning` and
   * `info` never touch repo status.
   */
  notify(
    message: NotificationMessage,
    level: NotificationLevel,
    repoId?: string,
    /** Documentation URL the entry links to, for something set up outside the app. */
    href?: string,
  ): void;
  /**
   * Record skill-resolution warnings as `warning` entries in the notifications
   * log. Unlike {@link notify} these raise **no toast**: a resolution warning is
   * a standing condition of a repository rather than a reaction to a user
   * action, so it waits to be read instead of interrupting.
   *
   * Warnings are recomputed on every catalog load, so an unchanged repository
   * would re-log on each refresh. Entries whose exact text is already present are
   * skipped, keeping a persistent warning (a permanently misplaced `SKILL.md`) to
   * a single line.
   */
  notifyResolveWarnings(warnings: readonly SkillResolveWarning[]): void;
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
  /**
   * Record (or clear, with null) why the terminal is unavailable. Setting a new
   * reason also logs it once, so the user learns that git is running without
   * visible output instead of only seeing a blank terminal.
   */
  setTerminalError(error: string | null): void;
  /** Open the full-screen sync task-list page. */
  openTasks(): void;
  /** Close the full-screen sync task-list page. */
  closeTasks(): void;
  /** Open the About dialog. */
  openAbout(): void;
  /** Close the About dialog. */
  closeAbout(): void;
  /** Empty the notifications log. Leaves toasts and per-repo errors intact. */
  clearNotifications(): void;
  /** Load the persisted onboarding state via the bridge and seed `onboarding`. */
  loadOnboarding(bridge: BridgeClient): Promise<void>;
  /** Start the guided tour from the first step. */
  startOnboarding(): void;
  /** Advance to the next step, or finish when the current step is the last one. */
  nextOnboardingStep(): void;
  /** Retreat to the previous step. No-op when the current step is the first one. */
  prevOnboardingStep(): void;
  /** Jump to the final "done" step so the thank-you always shows. Does NOT
   *  complete the tour -- only finishOnboarding() does. */
  skipOnboarding(): void;
  /** Mark the guided tour completed and hide it. */
  finishOnboarding(): void;
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

/**
 * Build a notification entry. Raw text is stored verbatim; a keyed message
 * stores key (+ vars) and is translated at display time, so the log follows the
 * current language.
 */
function makeNotificationEntry(
  message: NotificationMessage,
  level: NotificationLevel,
  repoId?: string,
  href?: string,
): NotificationEntry {
  const payload =
    typeof message === 'string' ? { text: message } : { key: message.key, vars: message.vars };
  return {
    id: crypto.randomUUID(),
    level,
    ...payload,
    repoId,
    href,
    at: new Date().toISOString(),
  };
}

/**
 * Repository errors are raw git text today, with one exception: a refusal from
 * the SSH gate (`require_unlocked` in the Rust backend) is one of the stable
 * `ssh.*` codes, not git output. Route through {@link sshErrorKey} so a known
 * code still translates while everything else (real git text) passes through
 * untouched, exactly as it always has.
 */
function repoErrorMessage(error: string): NotificationMessage {
  const key = sshErrorKey(error);
  return key !== null ? { key } : error;
}

/**
 * Whether a background update check has already reported an SSH refusal this
 * session. A locked key refuses every repository in the sweep, so without a
 * latch one skipped sweep would produce one message per repository. A check
 * that succeeds clears it, so a later refusal is reported again.
 */
let sshRefusalReported = false;

/**
 * React to an update check that failed. A refusal from the SSH gate is not a
 * broken repository: the clone is untouched and the only thing missing is the
 * passphrase, so a locked key raises the passphrase window right there instead
 * of leaving the user to discover a silently failed sweep. Any other failure
 * (real git output) stays in the task list, as it always has.
 */
function handleCheckFailure(
  get: () => SkillkeeperStore,
  set: (patch: Partial<SkillkeeperStore>) => void,
  error: unknown,
): void {
  const key = sshErrorKey(String(error));
  if (key === null) return;
  if (key !== 'ssh.keyLocked') {
    // A missing or unusable key file: nothing to unlock, so say it once.
    if (sshRefusalReported) return;
    sshRefusalReported = true;
    get().notify({ key }, 'warning');
    return;
  }
  // Every repository in the sweep hits the same locked key: raise the window
  // once. `updatesBlockedByKey` is what tells the answer to that window which
  // sweep to resume (see noteUnlockResolved).
  if (get().updatesBlockedByKey) return;
  set({ updatesBlockedByKey: true });
  void bridgeClient.promptSshUnlock().catch((raiseError: unknown) => {
    const raiseKey = sshErrorKey(String(raiseError));
    get().notify(raiseKey !== null ? { key: raiseKey } : String(raiseError), 'error');
  });
}

/**
 * Cap the retained log so a long-running session (background update checks,
 * per-op entries) cannot grow it without bound -- the LogsPage renders one DOM
 * node per entry. Keeps the most recent.
 */
const NOTIFICATION_LOG_LIMIT = 500;

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
  projectFolder: {},
  notifications: [],
  toasts: [],
  tasks: [],
  logsOpen: false,
  terminalOpen: false,
  terminalError: null,
  tasksOpen: false,
  aboutOpen: false,
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
    expandedIds: null,
  },
  mcpUi: {
    mode: 'repositories',
    expandedIds: null,
    componentsView: 'tiles',
    componentsRepoFilter: [],
    managementProjectFilter: [],
  },
  skillsNav: 0,
  mcpNav: 0,
  mcpNavView: 'mcp-components',
  addRepoRequest: null,
  projects: [],
  mcpPresets: [],
  mcpInstalls: [],
  repoFocus: null,
  updatesBlockedByKey: false,
  loading: false,
  error: null,
  onboarding: { active: false, step: 'welcome', completed: false },

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

  setMcpUi(patch) {
    set((s) => ({ mcpUi: { ...s.mcpUi, ...patch } }));
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

  notify(message, level, repoId, href) {
    const entry = makeNotificationEntry(message, level, repoId, href);
    set((s) => ({
      notifications: [...s.notifications, entry].slice(-NOTIFICATION_LOG_LIMIT),
      toasts: [...s.toasts, entry],
      // Only an error marks the repo's status (the red dot); warning and info
      // never do -- a resolution warning leaves the repository usable.
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

  notifyResolveWarnings(warnings) {
    if (warnings.length === 0) return;
    set((s) => {
      // Keyed by (repoId, text), not text alone: repository names are not
      // unique -- only the URL is -- and two forks both default to the same
      // derived name, so a text-only key would silently swallow the second
      // repository's identical warning and leave a row attributed to the first.
      // The separator is NUL, written as an escape: neither an id nor a warning
      // can contain it, so no pair of parts can collide by concatenation. Do not
      // write it as a raw byte -- that makes the whole file read as binary to
      // `file(1)` and to grep, which then skips it silently.
      const key = (repoId: string | undefined, text: string) => `${repoId ?? ''}\0${text}`;
      const logged = new Set(
        s.notifications
          .filter((n) => n.level === 'warning' && n.text !== undefined)
          .map((n) => key(n.repoId, n.text as string)),
      );
      const fresh: NotificationEntry[] = [];
      for (const warning of warnings) {
        const text = `[${warning.repoName}] ${warning.message}`;
        // Dedupe against what is already logged (including entries added in this
        // same pass), so a standing warning stays one line however often the
        // catalog is refreshed. A warning evicted by the log cap can reappear;
        // that is intended, since it is no longer in the log the user reads.
        if (logged.has(key(warning.repoId, text))) continue;
        logged.add(key(warning.repoId, text));
        fresh.push(makeNotificationEntry(text, 'warning', warning.repoId));
      }
      if (fresh.length === 0) return {};
      // Log only: no toast. A resolution warning is a standing condition of the
      // repository, not a reaction to something the user just did, so it waits
      // in the notifications window instead of interrupting.
      return { notifications: [...s.notifications, ...fresh].slice(-NOTIFICATION_LOG_LIMIT) };
    });
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
  },

  showRepoError(repoId) {
    const message = get().repoStatus[repoId]?.error;
    if (message === undefined) return;
    // Repo errors are raw git text, with the same ssh.* exception `notify`
    // handles at the call site: re-derive it here too, since `repoStatus`
    // only ever stores the plain string (the key, with `vars` already
    // dropped -- these codes never carry any).
    const key = sshErrorKey(message);
    const entry: NotificationEntry = {
      id: crypto.randomUUID(),
      level: 'error',
      ...(key !== null ? { key } : { text: message }),
      repoId,
      at: new Date().toISOString(),
    };
    set((s) => ({ toasts: [...s.toasts, entry] }));
  },

  // The logs / terminal / tasks / about overlays are mutually exclusive:
  // opening one closes the others, so switching between them never stacks.
  openLogs() {
    set({ logsOpen: true, terminalOpen: false, tasksOpen: false, aboutOpen: false });
  },

  closeLogs() {
    set({ logsOpen: false });
  },

  openTerminal() {
    set({ terminalOpen: true, logsOpen: false, tasksOpen: false, aboutOpen: false });
  },

  closeTerminal() {
    set({ terminalOpen: false });
  },

  setTerminalError(error) {
    // Log only on a change: the terminal re-checks its status on every shell
    // exit, and a standing failure would otherwise re-log on each one.
    if (get().terminalError === error) return;
    set({ terminalError: error });
    if (error === null) return;
    get().notify({ key: 'terminal.unavailable', vars: { error } }, 'warning');
  },

  openTasks() {
    set({ tasksOpen: true, logsOpen: false, terminalOpen: false, aboutOpen: false });
  },

  closeTasks() {
    set({ tasksOpen: false });
  },

  openAbout() {
    set({ aboutOpen: true, logsOpen: false, terminalOpen: false, tasksOpen: false });
  },

  closeAbout() {
    set({ aboutOpen: false });
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
        get().loadOnboarding(client),
      ]);
      setConfig(configResult.config, configResult.validity, configResult.warnings);
      // Load the active locale catalog before the app is revealed, so the first
      // paint is already in the user's language (no English flash). English is
      // synchronous; a non-English start loads exactly one chunk here.
      await ensureCatalog(resolveLang(configResult.config.general.language));
      setRepositories(repos);
      setSkills(skills);
      set({ availableSkills: available.skills, mcpInstalls });
      get().notifyResolveWarnings(available.warnings);
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
        get().notify(repoErrorMessage(cloned.error), 'error', repo.id);
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
      // A fresh clone brings its skills (and MCP presets) with it, so refresh
      // the catalog and reconcile installs exactly as a sync does. Without this
      // the card shows the new skill count while the Skills page still holds
      // the catalog from before the repository existed, which reads as "the
      // repository was added but its skills went missing".
      await get().refreshAvailableSkills();
      await get().reconcileSkills();
      await get().reconcileMcp();
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
        // Same reasoning as `removeProject` below: a persisted filter must never
        // keep naming something that no longer exists, or it narrows the view by
        // an option the user can no longer see, let alone clear.
        return {
          repositories: s.repositories.filter((r) => r.id !== id),
          repoStatus: rest,
          repoInfo: restInfo,
          skillsUi: { ...s.skillsUi, repoFilter: s.skillsUi.repoFilter.filter((r) => r !== id) },
          mcpUi: {
            ...s.mcpUi,
            componentsRepoFilter: s.mcpUi.componentsRepoFilter.filter((r) => r !== id),
          },
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
          get().notify(repoErrorMessage(res.error), 'error', id);
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

  noteUnlockResolved(unlocked) {
    // Only a sweep that was actually refused has something to finish: an
    // unlock the user did from Settings, or one behind a clone, must not kick
    // off an unrelated check.
    if (!get().updatesBlockedByKey) return;
    set({ updatesBlockedByKey: false });
    if (unlocked) {
      void get().refreshRepoUpdates(false);
      return;
    }
    // Declined: the checks stay skipped, so say so once rather than leaving an
    // empty task list as the only trace.
    if (sshRefusalReported) return;
    sshRefusalReported = true;
    get().notify({ key: 'updates.checkSkippedKeyLocked' }, 'warning');
  },

  refreshRepoUpdates(interactive) {
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
          const hasUpdate = await bridgeClient.repoHasUpdate(r.id, interactive);
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
          sshRefusalReported = false;
          set({ updatesBlockedByKey: false });
          setTaskStatus('done');
        } catch (error) {
          // An ssh refusal is a postponement, not a failure of this repository:
          // handleCheckFailure raises the passphrase prompt and the sweep is
          // re-run once the key is unlocked.
          setTaskStatus(sshErrorKey(String(error)) !== null ? 'skipped' : 'error');
          handleCheckFailure(get, set, error);
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
      set({ availableSkills: available.skills });
      get().notifyResolveWarnings(available.warnings);
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

  deleteMcpPreset(presetId) {
    return (async () => {
      const { mcpInstalls, projects, notify, applyMcp, updateConfig, refreshMcpPresets, refreshMcpInstalls } = get();
      const matching = mcpInstalls.filter((i) => i.identity.local === presetId);

      // Group by the scope each instance lives in. `McpInstall.projectId` is a
      // tracked project's id or the reserved global id, and `applyScope` is the
      // one place that turns either into apply arguments -- including the
      // `scope` field, without which a global batch is applied at project scope
      // (codex's removes are then dropped, and the other four agents fail on an
      // empty project path). An id that resolves to neither is left alone:
      // there is no path to resolve, and reconcile cleans it up separately.
      const byScope = new Map<string, McpInstall[]>();
      for (const inst of matching) {
        const list = byScope.get(inst.projectId);
        if (list !== undefined) list.push(inst);
        else byScope.set(inst.projectId, [inst]);
      }

      // One remove batch per (agent, instanceName) -- each installed instance
      // record is already unique on that pair within a scope.
      const removeBatches = (installs: readonly McpInstall[]): McpBatch[] =>
        installs.map((inst) => ({ agent: inst.agent, install: [], remove: [{ instanceName: inst.instanceName }] }));

      for (const [scopeId, installs] of byScope) {
        const scope = applyScope(scopeId, projects);
        if (scope === null) continue;
        const result = await applyMcp({ ...scope, batches: removeBatches(installs) });
        if (!result.ok) {
          notify(result.error, 'error');
          return;
        }
      }

      const servers = get().config?.mcp.servers ?? [];
      await updateConfig({ mcp: { servers: servers.filter((s) => s.id !== presetId) } });
      await refreshMcpPresets();
      await refreshMcpInstalls();
    })();
  },

  focusRepository(repoId) {
    set((s) => ({ repoFocus: { repoId, nonce: (s.repoFocus?.nonce ?? 0) + 1 } }));
  },

  goToMcp(repoId) {
    set((s) => ({
      mcpUi: { ...s.mcpUi, componentsRepoFilter: [repoId] },
      mcpNav: s.mcpNav + 1,
      mcpNavView: 'mcp-components',
    }));
  },

  goToMcpProject(projectId) {
    set((s) => ({
      mcpUi: { ...s.mcpUi, managementProjectFilter: [projectId] },
      mcpNav: s.mcpNav + 1,
      mcpNavView: 'mcp-management',
    }));
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
        // `req.target` carries the scope the row was built for, so an update
        // badge on a user-wide row re-installs user-wide instead of asking Rust
        // to resolve a project that does not exist.
        const result = await get().applySkills({
          ...req.target,
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
        const { [id]: _removedFolder, ...restFolder } = s.projectFolder;
        // Drop the gone project from every persisted filter that names it (see
        // `removeRepository` above for the repository half of the same rule).
        // Both management pages narrow their tree by these, and both can be left
        // naming ONLY this project (the project cards' "show me this project"
        // action sets exactly that) -- which would then filter the whole tree
        // away while the combobox, listing labels of options that still exist,
        // showed its all-projects placeholder.
        return {
          projects: s.projects.filter((p) => p.id !== id),
          projectInfo: restInfo,
          projectFolder: restFolder,
          skillsUi: { ...s.skillsUi, projectFilter: s.skillsUi.projectFilter.filter((p) => p !== id) },
          mcpUi: {
            ...s.mcpUi,
            managementProjectFilter: s.mcpUi.managementProjectFilter.filter((p) => p !== id),
          },
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
          set((s) => {
            const prev = s.projectInfo[p.id];
            // Keep the previously-resolved icon when a refresh does not return
            // one, so the cached icon survives until an actual update replaces
            // it (no flicker/re-decode from a transient miss).
            const next =
              info.iconDataUrl === undefined && prev?.iconDataUrl !== undefined
                ? { ...info, iconDataUrl: prev.iconDataUrl }
                : info;
            return { projectInfo: { ...s.projectInfo, [p.id]: next } };
          });
        }),
      );
    })();
  },

  checkProjects() {
    return (async () => {
      const projects = get().projects;
      await Promise.all(
        projects.map(async (p) => {
          const state = await bridgeClient.projectFolderState(p.id);
          set((s) => ({ projectFolder: { ...s.projectFolder, [p.id]: state } }));
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

  refreshProjects() {
    // Track the user-triggered refresh as a task (visible in the task list and
    // counted by the status-bar badge), running the folder sweep + skill-count
    // refresh through the shared task chain like the repo tasks.
    const taskId = crypto.randomUUID();
    const setTaskStatus = (status: RepoTask['status']): void =>
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) }));
    set((s) => ({
      tasks: [
        ...s.tasks,
        {
          id: taskId,
          repoId: 'projects',
          repoName: '',
          kind: 'refresh-projects' as const,
          status: 'queued' as const,
          at: new Date().toISOString(),
        },
      ],
    }));
    return enqueue(async () => {
      setTaskStatus('running');
      try {
        await Promise.all([get().sweepProjects(), get().refreshProjectInfo()]);
        setTaskStatus('done');
      } catch {
        setTaskStatus('error');
      }
    });
  },

  ensureProjectAvailable(id) {
    return (async () => {
      const state = await bridgeClient.projectFolderState(id);
      set((s) => ({ projectFolder: { ...s.projectFolder, [id]: state } }));
      // Name the actual obstacle: a folder this system withholds is not a folder
      // the user deleted, and only one of the two is theirs to fix here.
      if (state !== 'present') {
        get().notify({ key: state === 'denied' ? 'projects.noAccess' : 'projects.missing' }, 'error');
      }
      return state === 'present';
    })();
  },

  async loadOnboarding(bridge) {
    const state = await bridge.getOnboarding();
    const raw = state.step;
    const step: StepId = (ONBOARDING_ORDER as readonly string[]).includes(raw) ? (raw as StepId) : 'welcome';
    set({ onboarding: { active: !state.completed, step, completed: state.completed } });
  },

  startOnboarding() {
    const next = { active: true, step: 'welcome' as StepId, completed: false };
    set({ onboarding: next });
    void bridgeClient.setOnboarding({ version: 1, completed: false, step: 'welcome' });
  },

  nextOnboardingStep() {
    const { step } = get().onboarding;
    const next = nextStepId(ONBOARDING_ORDER, step);
    if (next === null) {
      get().finishOnboarding();
      return;
    }
    set({ onboarding: { active: true, step: next, completed: false } });
    void bridgeClient.setOnboarding({ version: 1, completed: false, step: next });
  },

  prevOnboardingStep() {
    const { step } = get().onboarding;
    const prev = prevStepId(ONBOARDING_ORDER, step);
    if (prev === null) return;
    set({ onboarding: { active: true, step: prev, completed: false } });
    void bridgeClient.setOnboarding({ version: 1, completed: false, step: prev });
  },

  skipOnboarding() {
    // Skipping does not end the tour outright: jump to the final "done" window
    // so the thank-you (and the "replay from Settings" hint) always shows. Only
    // finishOnboarding() actually ends it.
    set({ onboarding: { active: true, step: 'done', completed: false } });
    void bridgeClient.setOnboarding({ version: 1, completed: false, step: 'done' });
  },

  finishOnboarding() {
    const { step } = get().onboarding;
    set({ onboarding: { active: false, step, completed: true } });
    void bridgeClient.setOnboarding({ version: 1, completed: true, step });
  },
}));
