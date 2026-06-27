/**
 * Public API of @skillkeeper/core. Re-exports only - keep logic in the modules
 * this file re-exports. The production build excludes `testing/`, so test fakes
 * are NOT exported here (import them from `@skillkeeper/core/testing`).
 */

// Domain model.
export type {
  AgentKind,
  SkillId,
  HookStrategy,
  SkillManifest,
  HookTarget,
  HookManifest,
  ResolvedHook,
  ResolvedSkill,
  Repository,
  AgentTarget,
  ManagedFile,
  ManagedHookEdit,
  InstallManifest,
  Project,
} from './model.js';

// Ports.
export type { FileStat, FsPort, GitRef, CloneOptions, GitPort, HostEnv, Clock } from './ports.js';

// Real filesystem port (production counterpart to the in-memory test fake).
export { createNodeFs } from './node/nodeFs.js';

// Hashing.
export { sha256, hashTree } from './hashing.js';

// Frontmatter and manifests.
export { splitFrontmatter, FrontmatterError } from './frontmatter.js';
export type { Frontmatter } from './frontmatter.js';
export { parseSkillManifest, parseHookManifest, ManifestError } from './manifest.js';

// Repo config.
export { repoConfigSchema, parseRepoConfig, RepoConfigError } from './repoConfig.js';
export type { RepoConfig } from './repoConfig.js';

// Resolver.
export { resolveSkills } from './resolver.js';
export type { ResolveResult } from './resolver.js';

// Hook edit strategies: delimited-text.
export {
  wrapRegion,
  insertRegion,
  removeRegion,
  extractRegion,
  encapsulateForeignDelimiters,
  decapsulateForeignDelimiters,
} from './hookRegion.js';
export type { WrapRegionOptions, InsertMode } from './hookRegion.js';

// Hook edit strategies: json-merge.
export {
  MARKER_FIELD,
  mergeHookNode,
  removeHookNode,
  canonicalJson,
  findOwnedNode,
  encapsulateForeignMarkers,
  decapsulateForeignMarkers,
} from './hookJson.js';
export type { OwnershipMarker, MergeOptions } from './hookJson.js';

// Install / uninstall.
export { installSkill, uninstallSkill } from './install.js';
export type { InstallOptions } from './install.js';

// Verify / repair.
export { verifyInstall, repairInstall } from './verify.js';
export type {
  VerifyReport,
  VerifyStatus,
  FileVerification,
  HookEditVerification,
  RepairOptions,
} from './verify.js';

// Agent adapter framework.
export { AdapterRegistry } from './registry.js';
export type { AgentAdapter, HookCapability, DiscoveredSkill } from './adapter.js';

// Git.
export {
  createSystemGit,
  buildCloneArgs,
  buildFetchArgs,
  buildPullArgs,
  buildRevParseArgs,
  buildLfsPullArgs,
} from './git/systemGit.js';
export type { GitRunner, RunResult } from './git/systemGit.js';

// Application state store.
export { loadState, saveState, emptyState, StateError, STATE_VERSION } from './state.js';
export type { AppState } from './state.js';

// Update detection and scheduler.
export { repoHasUpdate, skillHasUpdate } from './updates.js';
export { Scheduler } from './scheduler.js';
export type { SchedulerMode, SchedulerConfig } from './scheduler.js';
