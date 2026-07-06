// Shared domain/config types, re-exported so every renderer layer pulls them
// from one place (@/services/bridge) rather than from the workspace packages.
export type {
  Repository,
  Project,
  InstallManifest,
  AgentKind,
} from '@skillkeeper/core';
export type {
  LoadConfigResult,
  SectionValidity,
  SkillKeeperConfig,
  GeneralConfig,
  UpdatesConfig,
  AgentsConfig,
  NotificationsConfig,
  RepositoriesConfig,
} from '@skillkeeper/config';
export type { Lang } from '@skillkeeper/i18n';
export type { EditorOption, OpenResult } from '../../../main/editors.js';
export type { RepoResult, RemoveResult, RepoInfo } from '../../../main/repositories.js';
export type { ProjectResult, ProjectInfo } from '../../../main/projects.js';
