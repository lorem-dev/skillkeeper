/**
 * Electron preload script.
 *
 * Exposes a narrow, typed bridge (`window.skillkeeper`) to the renderer via
 * contextBridge. The renderer may only call methods on this bridge; it has no
 * access to Node APIs, Electron internals, or the main process beyond what is
 * explicitly listed here.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { LoadConfigResult, SkillKeeperConfig } from '@skillkeeper/config';
import type { Repository, Project, InstallManifest, AgentKind } from '@skillkeeper/core';
import type { EditorOption, OpenResult } from '../main/editors.js';
import type { RepoResult, RemoveResult, RepoInfo, AvailableSkill } from '../main/repositories.js';
import type { ProjectResult, ProjectInfo } from '../main/projects.js';
import type { ApplyArgs, ApplyProgress, ApplyResult } from '../main/skills.js';
import type {
  AvailableMcp,
  ApplyMcpArgs,
  ApplyMcpResult,
  McpInstall,
  UpdateMcpArgs,
  UpdateMcpResult,
  McpUpdatePreflightArgs,
  McpUpdatePreflightResult,
} from '../main/mcp.js';

// ---------------------------------------------------------------------------
// Bridge type (exported so the renderer window.d.ts can import it)
// ---------------------------------------------------------------------------

/** The typed API surface exposed on window.skillkeeper. */
export interface SkillkeeperBridge {
  /** Load config, validity, and warnings from the main process. */
  getConfig(): Promise<LoadConfigResult>;
  /** Persist the config and return the reloaded result. */
  setConfig(config: SkillKeeperConfig): Promise<LoadConfigResult>;
  /** List all tracked repositories. */
  listRepositories(): Promise<Repository[]>;
  /** List all installed skills (install manifests from the state file). */
  listSkills(): Promise<InstallManifest[]>;
  /** List every skill available across all cloned repositories. */
  listAvailableSkills(): Promise<AvailableSkill[]>;
  /** Scan project folders to adopt/prune installs; returns reconciled manifests. */
  reconcileSkills(): Promise<InstallManifest[]>;
  /** List every MCP server preset available across all cloned repositories. */
  listAvailableMcp(): Promise<AvailableMcp[]>;
  /** Install/remove MCP server instances for a project across agents. */
  applyMcp(args: ApplyMcpArgs): Promise<ApplyMcpResult>;
  /** List installed MCP instances read from every agent ledger. */
  listMcpInstalls(): Promise<McpInstall[]>;
  /** Prune ledger/params entries whose native server is gone; returns survivors. */
  reconcileMcp(): Promise<McpInstall[]>;
  /** Update MCP instances in place (remove + reinstall under the same name). */
  updateMcp(args: UpdateMcpArgs): Promise<UpdateMcpResult>;
  /** Params the new def needs that an instance's own stored params are missing, ahead of an update. */
  mcpUpdatePreflight(args: McpUpdatePreflightArgs): Promise<McpUpdatePreflightResult>;
  /** Detect which agents were used in a project folder (by markers). */
  detectProjectAgents(path: string): Promise<AgentKind[]>;
  /** Install/remove skills for a project across agents; streams progress. */
  applySkillChanges(args: ApplyArgs): Promise<ApplyResult>;
  /** Subscribe to skill-apply progress. Returns an unsubscribe fn. */
  onSkillsProgress(callback: (progress: ApplyProgress) => void): () => void;
  /** List all tracked projects. */
  listProjects(): Promise<Project[]>;
  /** List text editors available on this machine, plus the default-app entry. */
  listEditors(): Promise<EditorOption[]>;
  /** Open the config file in the given allowlisted editor id. */
  openConfigInEditor(editorId: string): Promise<OpenResult>;
  /** Subscribe to config-file changes detected by the main process. Returns an unsubscribe fn. */
  onConfigChanged(callback: (result: LoadConfigResult) => void): () => void;
  /** Subscribe to navigation requests from the application menu (macOS) and the
   *  Settings keyboard shortcut. Returns an unsubscribe fn. */
  onMenuNavigate(callback: (view: string) => void): () => void;
  addRepository(url: string, name: string): Promise<RepoResult>;
  cloneRepository(id: string): Promise<RepoResult>;
  updateRepository(id: string, name: string, url: string, branch?: string): Promise<RepoResult>;
  removeRepository(id: string): Promise<RemoveResult>;
  syncRepository(id: string): Promise<RepoResult>;
  repoHasUpdate(id: string): Promise<boolean>;
  describeRepository(id: string): Promise<RepoInfo>;
  /** Local + origin branch names for a clone (empty if missing). */
  listBranches(id: string): Promise<string[]>;
  /** Open a native folder picker; resolves to the chosen path or null. */
  selectFolder(): Promise<string | null>;
  addProject(path: string, name: string): Promise<ProjectResult>;
  updateProject(id: string, path: string, name: string): Promise<ProjectResult>;
  removeProject(id: string): Promise<RemoveResult>;
  describeProject(id: string): Promise<ProjectInfo>;
  /** Whether the project's folder still exists on disk. */
  projectExists(id: string): Promise<boolean>;
  /** Open the project folder in an editor id, or the OS file manager. */
  openProject(path: string, editorId: string): Promise<OpenResult>;
  /** Start (or attach to) the persistent PTY and return its retained buffer. */
  startTerminal(cols: number, rows: number): Promise<string>;
  /** Write input into the PTY. */
  writeTerminal(data: string): void;
  /** Resize the PTY. */
  resizeTerminal(cols: number, rows: number): void;
  /** Drop the retained scrollback (e.g. on a window resize). */
  clearTerminalBuffer(): void;
  /** Run ssh-add on the PTY so the passphrase prompt appears there. */
  runSshAdd(): Promise<void>;
  /** Subscribe to PTY output chunks. Returns an unsubscribe fn. */
  onTerminalData(callback: (chunk: string) => void): () => void;
  /** Subscribe to the PTY exiting. Returns an unsubscribe fn. */
  onTerminalExit(callback: () => void): () => void;
  /** Subscribe to the main process requesting the terminal overlay be opened. Returns an unsubscribe fn. */
  onTerminalRequestOpen(callback: () => void): () => void;
  /** The host platform (`process.platform`); chooses the window-control chrome. */
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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const bridge: SkillkeeperBridge = {
  getConfig(): Promise<LoadConfigResult> {
    return ipcRenderer.invoke('config:get') as Promise<LoadConfigResult>;
  },
  setConfig(config: SkillKeeperConfig): Promise<LoadConfigResult> {
    return ipcRenderer.invoke('config:set', config) as Promise<LoadConfigResult>;
  },
  listRepositories(): Promise<Repository[]> {
    return ipcRenderer.invoke('repositories:list') as Promise<Repository[]>;
  },
  listSkills(): Promise<InstallManifest[]> {
    return ipcRenderer.invoke('skills:list') as Promise<InstallManifest[]>;
  },
  listAvailableSkills(): Promise<AvailableSkill[]> {
    return ipcRenderer.invoke('skills:available') as Promise<AvailableSkill[]>;
  },
  reconcileSkills(): Promise<InstallManifest[]> {
    return ipcRenderer.invoke('skills:reconcile') as Promise<InstallManifest[]>;
  },
  listAvailableMcp(): Promise<AvailableMcp[]> {
    return ipcRenderer.invoke('mcp:list-available') as Promise<AvailableMcp[]>;
  },
  applyMcp(args: ApplyMcpArgs): Promise<ApplyMcpResult> {
    return ipcRenderer.invoke('mcp:apply', args) as Promise<ApplyMcpResult>;
  },
  listMcpInstalls(): Promise<McpInstall[]> {
    return ipcRenderer.invoke('mcp:installs') as Promise<McpInstall[]>;
  },
  reconcileMcp(): Promise<McpInstall[]> {
    return ipcRenderer.invoke('mcp:reconcile') as Promise<McpInstall[]>;
  },
  updateMcp(args: UpdateMcpArgs): Promise<UpdateMcpResult> {
    return ipcRenderer.invoke('mcp:update', args) as Promise<UpdateMcpResult>;
  },
  mcpUpdatePreflight(args: McpUpdatePreflightArgs): Promise<McpUpdatePreflightResult> {
    return ipcRenderer.invoke('mcp:update-preflight', args) as Promise<McpUpdatePreflightResult>;
  },
  detectProjectAgents(path: string): Promise<AgentKind[]> {
    return ipcRenderer.invoke('projects:detectAgents', { path }) as Promise<AgentKind[]>;
  },
  applySkillChanges(args: ApplyArgs): Promise<ApplyResult> {
    return ipcRenderer.invoke('skills:apply', args) as Promise<ApplyResult>;
  },
  onSkillsProgress(callback: (progress: ApplyProgress) => void): () => void {
    const listener = (_event: IpcRendererEvent, progress: ApplyProgress): void => callback(progress);
    ipcRenderer.on('skills:progress', listener);
    return () => {
      ipcRenderer.removeListener('skills:progress', listener);
    };
  },
  listProjects(): Promise<Project[]> {
    return ipcRenderer.invoke('projects:list') as Promise<Project[]>;
  },
  listEditors(): Promise<EditorOption[]> {
    return ipcRenderer.invoke('editors:list') as Promise<EditorOption[]>;
  },
  openConfigInEditor(editorId: string): Promise<OpenResult> {
    return ipcRenderer.invoke('config:openInEditor', editorId) as Promise<OpenResult>;
  },
  onConfigChanged(callback: (result: LoadConfigResult) => void): () => void {
    const listener = (_event: IpcRendererEvent, result: LoadConfigResult): void => callback(result);
    ipcRenderer.on('config:changed', listener);
    return () => {
      ipcRenderer.removeListener('config:changed', listener);
    };
  },
  onMenuNavigate(callback: (view: string) => void): () => void {
    const listener = (_event: IpcRendererEvent, view: string): void => callback(view);
    ipcRenderer.on('menu:navigate', listener);
    return () => {
      ipcRenderer.removeListener('menu:navigate', listener);
    };
  },
  addRepository(url, name) {
    return ipcRenderer.invoke('repositories:add', { url, name }) as Promise<RepoResult>;
  },
  cloneRepository(id) {
    return ipcRenderer.invoke('repositories:clone', { id }) as Promise<RepoResult>;
  },
  updateRepository(id, name, url, branch) {
    return ipcRenderer.invoke('repositories:update', { id, name, url, branch }) as Promise<RepoResult>;
  },
  removeRepository(id) {
    return ipcRenderer.invoke('repositories:remove', { id }) as Promise<RemoveResult>;
  },
  syncRepository(id) {
    return ipcRenderer.invoke('repositories:sync', { id }) as Promise<RepoResult>;
  },
  repoHasUpdate(id) {
    return ipcRenderer.invoke('repositories:hasUpdate', { id }) as Promise<boolean>;
  },
  describeRepository(id) {
    return ipcRenderer.invoke('repositories:describe', { id }) as Promise<RepoInfo>;
  },
  listBranches(id) {
    return ipcRenderer.invoke('repositories:listBranches', { id }) as Promise<string[]>;
  },
  selectFolder() {
    return ipcRenderer.invoke('dialog:selectFolder') as Promise<string | null>;
  },
  addProject(path, name) {
    return ipcRenderer.invoke('projects:add', { path, name }) as Promise<ProjectResult>;
  },
  updateProject(id, path, name) {
    return ipcRenderer.invoke('projects:update', { id, path, name }) as Promise<ProjectResult>;
  },
  removeProject(id) {
    return ipcRenderer.invoke('projects:remove', { id }) as Promise<RemoveResult>;
  },
  describeProject(id) {
    return ipcRenderer.invoke('projects:describe', { id }) as Promise<ProjectInfo>;
  },
  projectExists(id) {
    return ipcRenderer.invoke('projects:exists', { id }) as Promise<boolean>;
  },
  openProject(path, editorId) {
    return ipcRenderer.invoke('projects:open', { path, editorId }) as Promise<OpenResult>;
  },
  startTerminal(cols: number, rows: number): Promise<string> {
    return ipcRenderer.invoke('terminal:start', { cols, rows }) as Promise<string>;
  },
  writeTerminal(data: string): void {
    ipcRenderer.send('terminal:input', data);
  },
  clearTerminalBuffer(): void {
    ipcRenderer.send('terminal:clearBuffer');
  },
  resizeTerminal(cols: number, rows: number): void {
    ipcRenderer.send('terminal:resize', { cols, rows });
  },
  runSshAdd(): Promise<void> {
    return ipcRenderer.invoke('terminal:runSshAdd') as Promise<void>;
  },
  onTerminalData(callback: (chunk: string) => void): () => void {
    const listener = (_event: IpcRendererEvent, chunk: string): void => callback(chunk);
    ipcRenderer.on('terminal:data', listener);
    return () => {
      ipcRenderer.removeListener('terminal:data', listener);
    };
  },
  onTerminalExit(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on('terminal:exit', listener);
    return () => {
      ipcRenderer.removeListener('terminal:exit', listener);
    };
  },
  onTerminalRequestOpen(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on('terminal:requestOpen', listener);
    return () => {
      ipcRenderer.removeListener('terminal:requestOpen', listener);
    };
  },
  platform: process.platform,
  minimizeWindow(): void {
    ipcRenderer.send('window:minimize');
  },
  toggleMaximizeWindow(): void {
    ipcRenderer.send('window:toggleMaximize');
  },
  closeWindow(): void {
    ipcRenderer.send('window:close');
  },
  isWindowMaximized(): Promise<boolean> {
    return ipcRenderer.invoke('window:isMaximized') as Promise<boolean>;
  },
  onMaximizeChange(callback: (maximized: boolean) => void): () => void {
    const listener = (_event: IpcRendererEvent, maximized: boolean): void => callback(maximized);
    ipcRenderer.on('window:maximizeChanged', listener);
    return () => {
      ipcRenderer.removeListener('window:maximizeChanged', listener);
    };
  },
};

contextBridge.exposeInMainWorld('skillkeeper', bridge);

export type { EditorOption, OpenResult } from '../main/editors.js';
export type { RepoResult, RemoveResult } from '../main/repositories.js';
