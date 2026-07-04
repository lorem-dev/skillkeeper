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
import type { Repository, Project, InstallManifest } from '@skillkeeper/core';
import type { EditorOption, OpenResult } from '../main/editors.js';
import type { RepoResult, RemoveResult, RepoInfo } from '../main/repositories.js';

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
  /** List all tracked projects. */
  listProjects(): Promise<Project[]>;
  /** List text editors available on this machine, plus the default-app entry. */
  listEditors(): Promise<EditorOption[]>;
  /** Open the config file in the given allowlisted editor id. */
  openConfigInEditor(editorId: string): Promise<OpenResult>;
  /** Subscribe to config-file changes detected by the main process. Returns an unsubscribe fn. */
  onConfigChanged(callback: (result: LoadConfigResult) => void): () => void;
  addRepository(url: string, name: string): Promise<RepoResult>;
  cloneRepository(id: string): Promise<RepoResult>;
  updateRepository(id: string, name: string, url: string): Promise<RepoResult>;
  removeRepository(id: string): Promise<RemoveResult>;
  syncRepository(id: string): Promise<RepoResult>;
  repoHasUpdate(id: string): Promise<boolean>;
  describeRepository(id: string): Promise<RepoInfo>;
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
  addRepository(url, name) {
    return ipcRenderer.invoke('repositories:add', { url, name }) as Promise<RepoResult>;
  },
  cloneRepository(id) {
    return ipcRenderer.invoke('repositories:clone', { id }) as Promise<RepoResult>;
  },
  updateRepository(id, name, url) {
    return ipcRenderer.invoke('repositories:update', { id, name, url }) as Promise<RepoResult>;
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
};

contextBridge.exposeInMainWorld('skillkeeper', bridge);

export type { EditorOption, OpenResult } from '../main/editors.js';
export type { RepoResult, RemoveResult } from '../main/repositories.js';
