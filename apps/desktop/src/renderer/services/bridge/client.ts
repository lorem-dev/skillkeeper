import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  LoadConfigResult,
  Repository,
  Project,
  ProjectFolderState,
  InstallManifest,
  SkillKeeperConfig,
  EditorOption,
  OpenResult,
  RepoResult,
  RemoveResult,
  RepoInfo,
  AvailableSkillsResult,
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
  OnboardingState,
  TerminalStatus,
  SshKeyDto,
} from './types';

/** The typed transport surface the renderer uses to reach the Rust backend. */
export interface BridgeClient {
  /** Resolve host-derived values that must be read synchronously later (the
   *  platform string). Awaited once at renderer startup before the first paint. */
  init(): Promise<void>;
  getConfig(): Promise<LoadConfigResult>;
  setConfig(config: SkillKeeperConfig): Promise<LoadConfigResult>;
  /** Read the persisted onboarding progress (desktop-only onboarding.json). */
  getOnboarding(): Promise<OnboardingState>;
  /** Persist the onboarding progress. */
  setOnboarding(state: OnboardingState): Promise<void>;
  listRepositories(): Promise<Repository[]>;
  listSkills(): Promise<InstallManifest[]>;
  listAvailableSkills(): Promise<AvailableSkillsResult>;
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
  /** Subscribe to the macOS Help menu's onboarding toggle. Returns an unsubscribe fn. */
  onMenuOnboardingToggle(callback: () => void): () => void;
  /** Reflect onboarding mode in the native menu (label + enabled state). */
  onboardingMenuSync(active: boolean): void;
  /** The app version string. */
  getAppVersion(): Promise<string>;
  addRepository(url: string, name: string): Promise<RepoResult>;
  cloneRepository(id: string): Promise<RepoResult>;
  updateRepository(id: string, name: string, url: string, branch?: string): Promise<RepoResult>;
  removeRepository(id: string): Promise<RemoveResult>;
  syncRepository(id: string): Promise<RepoResult>;
  /** Fetch a repository and report whether its branch is behind upstream.
   *  `interactive` says a user asked for this check right now, which is what
   *  lets a locked SSH key raise the passphrase prompt; the scheduled and
   *  startup sweeps pass `false` and are refused instead. */
  repoHasUpdate(id: string, interactive: boolean): Promise<boolean>;
  describeRepository(id: string): Promise<RepoInfo>;
  listBranches(id: string): Promise<string[]>;
  selectFolder(): Promise<string | null>;
  addProject(path: string, name: string): Promise<ProjectResult>;
  updateProject(id: string, path: string, name: string): Promise<ProjectResult>;
  removeProject(id: string): Promise<RemoveResult>;
  describeProject(id: string): Promise<ProjectInfo>;
  projectFolderState(id: string): Promise<ProjectFolderState>;
  openProject(path: string, editorId: string): Promise<OpenResult>;
  startTerminal(cols: number, rows: number): Promise<string>;
  /** Whether a shell session is live, and why not when it is not. Repository git
   *  runs through the terminal only while a session exists, so this is what
   *  distinguishes "the clone printed nothing" from "the clone ran headless". */
  terminalStatus(): Promise<TerminalStatus>;
  writeTerminal(data: string): void;
  resizeTerminal(cols: number, rows: number): void;
  clearTerminalBuffer(): void;
  runSshAdd(): Promise<void>;
  /** Whether an ssh-agent exists to hold a key. Without one, every SSH
   *  operation has to ask for the passphrase again. */
  sshAgentAvailable(): Promise<boolean>;
  onTerminalData(callback: (chunk: string) => void): () => void;
  onTerminalExit(callback: () => void): () => void;
  onTerminalRequestOpen(callback: () => void): () => void;
  /** Read the configured SSH key's path and usability. */
  sshKeyState(): Promise<SshKeyDto>;
  /** Choose a new SSH key file (persists the path). */
  selectSshKey(path: string): Promise<SshKeyDto>;
  /** Stop using an SSH key (clears the path and any held passphrase). */
  clearSshKey(): Promise<SshKeyDto>;
  /** Verify the passphrase for the configured key and hold it for the session.
   *  Rejects with a stable `ssh.*` code on failure. */
  unlockSshKey(passphrase: string): Promise<void>;
  /** Forget the held passphrase without unchoosing the key (relocks it). */
  forgetSshKey(): Promise<void>;
  /** Cancel an in-progress unlock prompt, releasing any operation waiting on it. */
  cancelSshKeyUnlock(): Promise<void>;
  /** Native file picker for choosing a private key file. */
  pickSshKeyFile(): Promise<string | null>;
  /** Raise the unlock prompt on demand (or join the one a blocked git
   *  operation is already waiting behind) and return as soon as the window is
   *  up -- it does not wait for the answer. A no-op for a key that needs no
   *  passphrase; rejects with a stable `ssh.*` code when the prompt could not
   *  be raised at all (a missing/invalid key, or a window-builder failure). */
  promptSshUnlock(): Promise<void>;
  /** Subscribe to the backend requesting the unlock prompt for `path`. Returns
   *  an unsubscribe fn. Fires only while a further operation is waiting -- the
   *  first paint of a freshly opened unlock window must call `sshKeyState()`
   *  instead, since the webview is not listening yet when this first fires. */
  onSshUnlockRequired(callback: (path: string) => void): () => void;
  /** Subscribe to the unlock prompt resolving -- `true` after a successful
   *  unlock, `false` on cancel or the window closing. Fired once per
   *  resolution and app-wide, so a view other than the prompt itself (e.g.
   *  this Settings row) learns to re-read `sshKeyState()`. Treat the payload
   *  as a cue to re-read, not as truth in itself: it is not emitted at all
   *  for a cancel with no prompt on record. Returns an unsubscribe fn. */
  onSshUnlockResolved(callback: (unlocked: boolean) => void): () => void;
  /** The host platform (`process.platform`), for choosing the window-control chrome. */
  readonly platform: string;
  /** Minimize the window (frameless title bar). */
  minimizeWindow(): void;
  /** Toggle the window between maximized and restored. */
  toggleMaximizeWindow(): void;
  /** Close the window. */
  closeWindow(): void;
  /** Resize the window to `height` logical pixels of content, keeping its width
   *  and re-centering it. For a fixed-size dialog whose text length is not known
   *  ahead of time (the unlock window names the key path), which no single
   *  height fits. */
  fitWindowHeight(height: number): void;
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
  getOnboarding: () => invoke<OnboardingState>('onboarding_get'),
  setOnboarding: (state) => invoke<void>('onboarding_set', { state }),
  listRepositories: () => invoke<Repository[]>('repositories_list'),
  listSkills: () => invoke<InstallManifest[]>('skills_list'),
  listAvailableSkills: () => invoke<AvailableSkillsResult>('skills_available'),
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
  onMenuOnboardingToggle: (callback) =>
    subscribe<void>('menu:onboarding-toggle', () => callback()),
  onboardingMenuSync: (active) => {
    void invoke('onboarding_menu_sync', { active });
  },
  getAppVersion: () => invoke<string>('get_app_version'),
  addRepository: (url, name) => invoke<RepoResult>('repositories_add', { url, name }),
  cloneRepository: (id) => invoke<RepoResult>('repositories_clone', { id }),
  updateRepository: (id, name, url, branch) =>
    invoke<RepoResult>('repositories_update', { id, name, url, branch }),
  removeRepository: (id) => invoke<RemoveResult>('repositories_remove', { id }),
  syncRepository: (id) => invoke<RepoResult>('repositories_sync', { id }),
  repoHasUpdate: (id, interactive) =>
    invoke<boolean>('repositories_has_update', { id, interactive }),
  describeRepository: (id) => invoke<RepoInfo>('repositories_describe', { id }),
  listBranches: (id) => invoke<string[]>('repositories_list_branches', { id }),
  selectFolder: () => invoke<string | null>('dialog_select_folder'),
  addProject: (path, name) => invoke<ProjectResult>('projects_add', { path, name }),
  updateProject: (id, path, name) => invoke<ProjectResult>('projects_update', { id, path, name }),
  removeProject: (id) => invoke<RemoveResult>('projects_remove', { id }),
  describeProject: (id) => invoke<ProjectInfo>('projects_describe', { id }),
  projectFolderState: (id) => invoke<ProjectFolderState>('projects_folder_state', { id }),
  openProject: (path, editorId) => invoke<OpenResult>('open_project', { path, editorId }),
  startTerminal: (cols, rows) => invoke<string>('terminal_start', { cols, rows }),
  terminalStatus: () => invoke<TerminalStatus>('terminal_status'),
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
  sshAgentAvailable: () => invoke<boolean>('ssh_agent_available'),
  onTerminalData: (callback) => subscribe<string>('terminal:data', callback),
  onTerminalExit: (callback) => subscribe<void>('terminal:exit', () => callback()),
  onTerminalRequestOpen: (callback) => subscribe<void>('terminal:requestOpen', () => callback()),
  sshKeyState: () => invoke<SshKeyDto>('ssh_key_state'),
  selectSshKey: (path) => invoke<SshKeyDto>('ssh_key_select', { path }),
  clearSshKey: () => invoke<SshKeyDto>('ssh_key_clear'),
  unlockSshKey: (passphrase) => invoke<void>('ssh_key_unlock', { passphrase }),
  forgetSshKey: () => invoke<void>('ssh_key_forget'),
  cancelSshKeyUnlock: () => invoke<void>('ssh_key_cancel_unlock'),
  pickSshKeyFile: () => invoke<string | null>('dialog_select_ssh_key'),
  promptSshUnlock: () => invoke<void>('ssh_key_prompt'),
  onSshUnlockRequired: (callback) => {
    // Same shape as onTerminalRequestOpen: start the listen(), keep the
    // promised unlisten, and return a synchronous off() that works even if
    // called before listen() resolves.
    let off: (() => void) | null = null;
    let cancelled = false;
    void listen<{ path: string }>('ssh:unlockRequired', (e) => callback(e.payload.path)).then(
      (un) => {
        if (cancelled) un();
        else off = un;
      },
    );
    return () => {
      cancelled = true;
      off?.();
    };
  },
  onSshUnlockResolved: (callback) => {
    // Same shape as onSshUnlockRequired.
    let off: (() => void) | null = null;
    let cancelled = false;
    void listen<{ unlocked: boolean }>('ssh:unlockResolved', (e) => callback(e.payload.unlocked)).then(
      (un) => {
        if (cancelled) un();
        else off = un;
      },
    );
    return () => {
      cancelled = true;
      off?.();
    };
  },
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
  fitWindowHeight: (height) => {
    void invoke('window_fit_content_height', { height });
  },
  isWindowMaximized: () => invoke<boolean>('window_is_maximized'),
  onMaximizeChange: (callback) => subscribe<boolean>('window:maximizeChanged', callback),
};
