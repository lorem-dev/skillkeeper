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
} from '@skillkeeper/config';
