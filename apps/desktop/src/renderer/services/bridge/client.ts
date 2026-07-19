import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  LoadConfigResult,
  Repository,
  Project,
  InstallManifest,
  SkillKeeperConfig,
  EditorOption,
  OpenResult,
  RepoResult,
  RemoveResult,
  RepoInfo,
  AvailableSkill,
  ProjectResult,
  ProjectInfo,
  ApplyArgs,
  ApplyProgress,
  ApplyResult,
  AgentKind,
  AvailableMcp,
  ApplyMcpArgs,
  ApplyMcpResult,
  McpInstall,
  UpdateMcpArgs,
  UpdateMcpResult,
  McpUpdatePreflightArgs,
  McpUpdatePreflightResult,
} from './types';

/** The typed transport surface the renderer uses to reach the Rust backend. */
export interface BridgeClient {
  /** Resolve host-derived values that must be read synchronously later (the
   *  platform string). Awaited once at renderer startup before the first paint. */
  init(): Promise<void>;
  getConfig(): Promise<LoadConfigResult>;
  setConfig(config: SkillKeeperConfig): Promise<LoadConfigResult>;
  listRepositories(): Promise<Repository[]>;
  listSkills(): Promise<InstallManifest[]>;
  listAvailableSkills(): Promise<AvailableSkill[]>;
  reconcileSkills(): Promise<InstallManifest[]>;
  listAvailableMcp(): Promise<AvailableMcp[]>;
  applyMcp(args: ApplyMcpArgs): Promise<ApplyMcpResult>;
  listMcpInstalls(): Promise<McpInstall[]>;
  reconcileMcp(): Promise<McpInstall[]>;
  updateMcp(args: UpdateMcpArgs): Promise<UpdateMcpResult>;
  mcpUpdatePreflight(args: McpUpdatePreflightArgs): Promise<McpUpdatePreflightResult>;
  detectProjectAgents(path: string): Promise<AgentKind[]>;
  applySkillChanges(args: ApplyArgs): Promise<ApplyResult>;
  onSkillsProgress(callback: (progress: ApplyProgress) => void): () => void;
  listProjects(): Promise<Project[]>;
  listEditors(): Promise<EditorOption[]>;
  openConfigInEditor(editorId: string): Promise<OpenResult>;
  /** Open a URL in the OS default browser (e.g. the online documentation). */
  openExternal(url: string): Promise<OpenResult>;
  onConfigChanged(callback: (result: LoadConfigResult) => void): () => void;
  /** Subscribe to application-menu / Settings-shortcut navigation. Returns an unsubscribe fn. */
  onMenuNavigate(callback: (view: string) => void): () => void;
  /** Subscribe to the application menu's About item. Returns an unsubscribe fn. */
  onMenuAbout(callback: () => void): () => void;
  /** The app version string. */
  getAppVersion(): Promise<string>;
  addRepository(url: string, name: string): Promise<RepoResult>;
  cloneRepository(id: string): Promise<RepoResult>;
  updateRepository(id: string, name: string, url: string, branch?: string): Promise<RepoResult>;
  removeRepository(id: string): Promise<RemoveResult>;
  syncRepository(id: string): Promise<RepoResult>;
  repoHasUpdate(id: string): Promise<boolean>;
  describeRepository(id: string): Promise<RepoInfo>;
  listBranches(id: string): Promise<string[]>;
  selectFolder(): Promise<string | null>;
  addProject(path: string, name: string): Promise<ProjectResult>;
  updateProject(id: string, path: string, name: string): Promise<ProjectResult>;
  removeProject(id: string): Promise<RemoveResult>;
  describeProject(id: string): Promise<ProjectInfo>;
  projectExists(id: string): Promise<boolean>;
  openProject(path: string, editorId: string): Promise<OpenResult>;
  startTerminal(cols: number, rows: number): Promise<string>;
  writeTerminal(data: string): void;
  resizeTerminal(cols: number, rows: number): void;
  clearTerminalBuffer(): void;
  runSshAdd(): Promise<void>;
  onTerminalData(callback: (chunk: string) => void): () => void;
  onTerminalExit(callback: () => void): () => void;
  onTerminalRequestOpen(callback: () => void): () => void;
  /** The host platform (`process.platform`), for choosing the window-control chrome. */
  readonly platform: string;
  /** Minimize the window (frameless title bar). */
  minimizeWindow(): void;
  /** Toggle the window between maximized and restored. */
  toggleMaximizeWindow(): void;
  /** Close the window. */
  closeWindow(): void;
  /** Whether the window is currently maximized. */
  isWindowMaximized(): Promise<boolean>;
  /** Subscribe to maximize/restore changes. Returns an unsubscribe fn. */
  onMaximizeChange(callback: (maximized: boolean) => void): () => void;
}

// The platform string is exposed synchronously on the client but resolved
// asynchronously from the `platform` Tauri command. `init()` fills this cache
// once, before the first render reads `bridgeClient.platform`. It defaults to
// the browser's user-agent guess so a read before init still yields something
// sensible (init always runs first at startup, so this is only a safety net).
let platformCache = '';

/**
 * Subscribe to a Tauri backend event, adapting the async `listen` API to the
 * synchronous unsubscribe contract the renderer expects. The returned function
 * unlistens once `listen` has resolved (a call before then is queued via the
 * promise, so no event is leaked).
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const unlisten = listen<T>(channel, (event) => callback(event.payload));
  return () => {
    void unlisten.then((off) => off());
  };
}

/** The live client, backed by the Tauri command/event bridge. */
export const bridgeClient: BridgeClient = {
  async init() {
    platformCache = await invoke<string>('platform');
  },
  getConfig: () => invoke<LoadConfigResult>('config_get'),
  setConfig: (config) => invoke<LoadConfigResult>('config_set', { config }),
  listRepositories: () => invoke<Repository[]>('repositories_list'),
  listSkills: () => invoke<InstallManifest[]>('skills_list'),
  listAvailableSkills: () => invoke<AvailableSkill[]>('skills_available'),
  reconcileSkills: () => invoke<InstallManifest[]>('skills_reconcile'),
  listAvailableMcp: () => invoke<AvailableMcp[]>('mcp_list_available'),
  applyMcp: (args) => invoke<ApplyMcpResult>('mcp_apply', { args }),
  listMcpInstalls: () => invoke<McpInstall[]>('mcp_installs'),
  reconcileMcp: () => invoke<McpInstall[]>('mcp_reconcile'),
  updateMcp: (args) => invoke<UpdateMcpResult>('mcp_update', { args }),
  mcpUpdatePreflight: (args) => invoke<McpUpdatePreflightResult>('mcp_update_preflight', { args }),
  detectProjectAgents: (path) => invoke<AgentKind[]>('projects_detect_agents', { path }),
  applySkillChanges: (args) => invoke<ApplyResult>('skills_apply', { args }),
  onSkillsProgress: (callback) => subscribe<ApplyProgress>('skills:progress', callback),
  listProjects: () => invoke<Project[]>('projects_list'),
  listEditors: () => invoke<EditorOption[]>('editors_list'),
  openConfigInEditor: (editorId) => invoke<OpenResult>('open_config_in_editor', { editorId }),
  openExternal: (url) => invoke<OpenResult>('open_external', { url }),
  onConfigChanged: (callback) => subscribe<LoadConfigResult>('config:changed', callback),
  onMenuNavigate: (callback) => subscribe<string>('menu:navigate', callback),
  onMenuAbout: (callback) => subscribe<void>('menu:about', () => callback()),
  getAppVersion: () => invoke<string>('get_app_version'),
  addRepository: (url, name) => invoke<RepoResult>('repositories_add', { url, name }),
  cloneRepository: (id) => invoke<RepoResult>('repositories_clone', { id }),
  updateRepository: (id, name, url, branch) =>
    invoke<RepoResult>('repositories_update', { id, name, url, branch }),
  removeRepository: (id) => invoke<RemoveResult>('repositories_remove', { id }),
  syncRepository: (id) => invoke<RepoResult>('repositories_sync', { id }),
  repoHasUpdate: (id) => invoke<boolean>('repositories_has_update', { id }),
  describeRepository: (id) => invoke<RepoInfo>('repositories_describe', { id }),
  listBranches: (id) => invoke<string[]>('repositories_list_branches', { id }),
  selectFolder: () => invoke<string | null>('dialog_select_folder'),
  addProject: (path, name) => invoke<ProjectResult>('projects_add', { path, name }),
  updateProject: (id, path, name) => invoke<ProjectResult>('projects_update', { id, path, name }),
  removeProject: (id) => invoke<RemoveResult>('projects_remove', { id }),
  describeProject: (id) => invoke<ProjectInfo>('projects_describe', { id }),
  projectExists: (id) => invoke<boolean>('projects_exists', { id }),
  openProject: (path, editorId) => invoke<OpenResult>('open_project', { path, editorId }),
  startTerminal: (cols, rows) => invoke<string>('terminal_start', { cols, rows }),
  writeTerminal: (data) => {
    void invoke('terminal_input', { data });
  },
  resizeTerminal: (cols, rows) => {
    void invoke('terminal_resize', { cols, rows });
  },
  clearTerminalBuffer: () => {
    void invoke('terminal_clear_buffer');
  },
  runSshAdd: () => invoke<void>('terminal_run_ssh_add'),
  onTerminalData: (callback) => subscribe<string>('terminal:data', callback),
  onTerminalExit: (callback) => subscribe<void>('terminal:exit', () => callback()),
  onTerminalRequestOpen: (callback) => subscribe<void>('terminal:requestOpen', () => callback()),
  // Resolved once by `init()` at startup and cached; read synchronously here so
  // the public interface stays sync (the App reads it during the first render).
  get platform() {
    return platformCache;
  },
  minimizeWindow: () => {
    void invoke('window_minimize');
  },
  toggleMaximizeWindow: () => {
    void invoke('window_toggle_maximize');
  },
  closeWindow: () => {
    void invoke('window_close');
  },
  isWindowMaximized: () => invoke<boolean>('window_is_maximized'),
  onMaximizeChange: (callback) => subscribe<boolean>('window:maximizeChanged', callback),
};
