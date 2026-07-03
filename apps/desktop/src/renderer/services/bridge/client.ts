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
} from './types';

/** The typed transport surface the renderer uses to reach the main process. */
export interface BridgeClient {
  getConfig(): Promise<LoadConfigResult>;
  setConfig(config: SkillKeeperConfig): Promise<LoadConfigResult>;
  listRepositories(): Promise<Repository[]>;
  listSkills(): Promise<InstallManifest[]>;
  listProjects(): Promise<Project[]>;
  listEditors(): Promise<EditorOption[]>;
  openConfigInEditor(editorId: string): Promise<OpenResult>;
  onConfigChanged(callback: (result: LoadConfigResult) => void): () => void;
  addRepository(url: string, name: string): Promise<RepoResult>;
  cloneRepository(id: string): Promise<RepoResult>;
  updateRepository(id: string, name: string, url: string): Promise<RepoResult>;
  removeRepository(id: string): Promise<RemoveResult>;
  syncRepository(id: string): Promise<RepoResult>;
  repoHasUpdate(id: string): Promise<boolean>;
}

/** The live client, backed by the preload bridge on window.skillkeeper. */
export const bridgeClient: BridgeClient = {
  getConfig: () => window.skillkeeper.getConfig(),
  setConfig: (config) => window.skillkeeper.setConfig(config),
  listRepositories: () => window.skillkeeper.listRepositories(),
  listSkills: () => window.skillkeeper.listSkills() as Promise<InstallManifest[]>,
  listProjects: () => window.skillkeeper.listProjects(),
  listEditors: () => window.skillkeeper.listEditors(),
  openConfigInEditor: (editorId) => window.skillkeeper.openConfigInEditor(editorId),
  onConfigChanged: (callback) => window.skillkeeper.onConfigChanged(callback),
  addRepository: (url, name) => window.skillkeeper.addRepository(url, name),
  cloneRepository: (id) => window.skillkeeper.cloneRepository(id),
  updateRepository: (id, name, url) => window.skillkeeper.updateRepository(id, name, url),
  removeRepository: (id) => window.skillkeeper.removeRepository(id),
  syncRepository: (id) => window.skillkeeper.syncRepository(id),
  repoHasUpdate: (id) => window.skillkeeper.repoHasUpdate(id),
};
