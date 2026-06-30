import type { LoadConfigResult, Repository, Project, InstallManifest } from './types';

/** The typed transport surface the renderer uses to reach the main process. */
export interface BridgeClient {
  getConfig(): Promise<LoadConfigResult>;
  listRepositories(): Promise<Repository[]>;
  listSkills(): Promise<InstallManifest[]>;
  listProjects(): Promise<Project[]>;
}

/** The live client, backed by the preload bridge on window.skillkeeper. */
export const bridgeClient: BridgeClient = {
  getConfig: () => window.skillkeeper.getConfig(),
  listRepositories: () => window.skillkeeper.listRepositories(),
  listSkills: () => window.skillkeeper.listSkills() as Promise<InstallManifest[]>,
  listProjects: () => window.skillkeeper.listProjects(),
};
