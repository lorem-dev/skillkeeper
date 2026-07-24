// Shared domain/config types, re-exported so every renderer layer pulls them
// from one place (@/services/bridge) rather than from the workspace packages.
export type {
  Repository,
  Project,
  InstallManifest,
  AgentKind,
} from './generated/core';
export type {
  LoadConfigResult,
  SectionValidity,
  SkillKeeperConfig,
  GeneralConfig,
  UpdatesConfig,
  AgentsConfig,
  NotificationsConfig,
  RepositoriesConfig,
  ProjectsConfig,
  OnboardingState,
} from './generated/config';
export type { Lang } from '@skillkeeper/i18n/lazy';
export type {
  EditorOption,
  OpenResult,
  RepoResult,
  RemoveResult,
  RepoInfo,
  AvailableSkill,
  ProjectResult,
  ProjectInfo,
  SkillRef,
  ApplyArgs,
  ApplyProgress,
  ApplyResult,
  AvailableMcp,
  McpInstallReq,
  McpBatch,
  ApplyMcpArgs,
  McpSkipped,
  ApplyMcpResult,
  McpInstall,
  McpUpdateReq,
  UpdateMcpArgs,
  UpdateMcpResult,
  McpUpdatePreflightArgs,
  McpUpdatePreflightResult,
} from './contracts';
export type { McpServerDef, McpTransport, McpIdentity, McpPresetOrigin } from './generated/core';
