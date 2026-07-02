import type {
  LoadConfigResult,
  Repository,
  Project,
  InstallManifest,
  SkillKeeperConfig,
  EditorOption,
  OpenResult,
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
};
