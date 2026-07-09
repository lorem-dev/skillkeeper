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
  ProjectsConfig,
} from '@skillkeeper/config';
export type { Lang } from '@skillkeeper/i18n';
export type { EditorOption, OpenResult } from '../../../main/editors.js';
export type { RepoResult, RemoveResult, RepoInfo, AvailableSkill } from '../../../main/repositories.js';
export type { ProjectResult, ProjectInfo } from '../../../main/projects.js';
export type { SkillRef, ApplyArgs, ApplyProgress, ApplyResult } from '../../../main/skills.js';
export type { AvailableMcp } from '../../../main/mcp.js';
export type {
  McpInstallReq,
  McpBatch,
  ApplyMcpArgs,
  McpSkipped,
  ApplyMcpResult,
  McpInstall,
} from '../../../main/mcp.js';
export type { McpServerDef, McpTransport, McpIdentity } from '@skillkeeper/core';
