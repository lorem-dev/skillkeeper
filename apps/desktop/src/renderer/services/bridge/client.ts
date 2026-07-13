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

/** The typed transport surface the renderer uses to reach the main process. */
export interface BridgeClient {
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
  onConfigChanged(callback: (result: LoadConfigResult) => void): () => void;
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

/** The live client, backed by the preload bridge on window.skillkeeper. */
export const bridgeClient: BridgeClient = {
  getConfig: () => window.skillkeeper.getConfig(),
  setConfig: (config) => window.skillkeeper.setConfig(config),
  listRepositories: () => window.skillkeeper.listRepositories(),
  listSkills: () => window.skillkeeper.listSkills() as Promise<InstallManifest[]>,
  listAvailableSkills: () => window.skillkeeper.listAvailableSkills() as Promise<AvailableSkill[]>,
  reconcileSkills: () => window.skillkeeper.reconcileSkills() as Promise<InstallManifest[]>,
  listAvailableMcp: () => window.skillkeeper.listAvailableMcp() as Promise<AvailableMcp[]>,
  applyMcp: (args) => window.skillkeeper.applyMcp(args),
  listMcpInstalls: () => window.skillkeeper.listMcpInstalls() as Promise<McpInstall[]>,
  reconcileMcp: () => window.skillkeeper.reconcileMcp() as Promise<McpInstall[]>,
  updateMcp: (args) => window.skillkeeper.updateMcp(args),
  mcpUpdatePreflight: (args) => window.skillkeeper.mcpUpdatePreflight(args),
  detectProjectAgents: (path) => window.skillkeeper.detectProjectAgents(path) as Promise<AgentKind[]>,
  applySkillChanges: (args) => window.skillkeeper.applySkillChanges(args),
  onSkillsProgress: (callback) => window.skillkeeper.onSkillsProgress(callback),
  listProjects: () => window.skillkeeper.listProjects(),
  listEditors: () => window.skillkeeper.listEditors(),
  openConfigInEditor: (editorId) => window.skillkeeper.openConfigInEditor(editorId),
  onConfigChanged: (callback) => window.skillkeeper.onConfigChanged(callback),
  addRepository: (url, name) => window.skillkeeper.addRepository(url, name),
  cloneRepository: (id) => window.skillkeeper.cloneRepository(id),
  updateRepository: (id, name, url, branch) => window.skillkeeper.updateRepository(id, name, url, branch),
  removeRepository: (id) => window.skillkeeper.removeRepository(id),
  syncRepository: (id) => window.skillkeeper.syncRepository(id),
  repoHasUpdate: (id) => window.skillkeeper.repoHasUpdate(id),
  describeRepository: (id) => window.skillkeeper.describeRepository(id),
  listBranches: (id) => window.skillkeeper.listBranches(id),
  selectFolder: () => window.skillkeeper.selectFolder(),
  addProject: (path, name) => window.skillkeeper.addProject(path, name),
  updateProject: (id, path, name) => window.skillkeeper.updateProject(id, path, name),
  removeProject: (id) => window.skillkeeper.removeProject(id),
  describeProject: (id) => window.skillkeeper.describeProject(id),
  projectExists: (id) => window.skillkeeper.projectExists(id),
  openProject: (path, editorId) => window.skillkeeper.openProject(path, editorId),
  startTerminal: (cols, rows) => window.skillkeeper.startTerminal(cols, rows),
  writeTerminal: (data) => window.skillkeeper.writeTerminal(data),
  resizeTerminal: (cols, rows) => window.skillkeeper.resizeTerminal(cols, rows),
  clearTerminalBuffer: () => window.skillkeeper.clearTerminalBuffer(),
  runSshAdd: () => window.skillkeeper.runSshAdd(),
  onTerminalData: (callback) => window.skillkeeper.onTerminalData(callback),
  onTerminalExit: (callback) => window.skillkeeper.onTerminalExit(callback),
  onTerminalRequestOpen: (callback) => window.skillkeeper.onTerminalRequestOpen(callback),
  // Lazy getter (not a load-time read) so importing the client never touches
  // window.skillkeeper before the preload bridge exists.
  get platform() {
    return window.skillkeeper.platform;
  },
  minimizeWindow: () => window.skillkeeper.minimizeWindow(),
  toggleMaximizeWindow: () => window.skillkeeper.toggleMaximizeWindow(),
  closeWindow: () => window.skillkeeper.closeWindow(),
  isWindowMaximized: () => window.skillkeeper.isWindowMaximized(),
  onMaximizeChange: (callback) => window.skillkeeper.onMaximizeChange(callback),
};
