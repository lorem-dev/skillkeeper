/**
 * Electron preload script.
 *
 * Exposes a narrow, typed bridge (`window.skillkeeper`) to the renderer via
 * contextBridge. The renderer may only call methods on this bridge; it has no
 * access to Node APIs, Electron internals, or the main process beyond what is
 * explicitly listed here.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { LoadConfigResult } from '@skillkeeper/config';
import type { Repository, Project } from '@skillkeeper/core';

// ---------------------------------------------------------------------------
// Bridge type (exported so the renderer window.d.ts can import it)
// ---------------------------------------------------------------------------

/** The typed API surface exposed on window.skillkeeper. */
export interface SkillkeeperBridge {
  /** Load config, validity, and warnings from the main process. */
  getConfig(): Promise<LoadConfigResult>;
  /** List all tracked repositories. */
  listRepositories(): Promise<Repository[]>;
  /** List all installed skills (stub in v1 shell). */
  listSkills(): Promise<unknown[]>;
  /** List all tracked projects. */
  listProjects(): Promise<Project[]>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const bridge: SkillkeeperBridge = {
  getConfig(): Promise<LoadConfigResult> {
    return ipcRenderer.invoke('config:get') as Promise<LoadConfigResult>;
  },
  listRepositories(): Promise<Repository[]> {
    return ipcRenderer.invoke('repositories:list') as Promise<Repository[]>;
  },
  listSkills(): Promise<unknown[]> {
    return ipcRenderer.invoke('skills:list') as Promise<unknown[]>;
  },
  listProjects(): Promise<Project[]> {
    return ipcRenderer.invoke('projects:list') as Promise<Project[]>;
  },
};

contextBridge.exposeInMainWorld('skillkeeper', bridge);
