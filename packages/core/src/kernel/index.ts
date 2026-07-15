// Kernel: domain model, ports, hashing, filesystem port, frontmatter.
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
export type {
  FileStat,
  FsPort,
  GitRef,
  CloneOptions,
  GitPort,
  HostEnv,
  Clock,
} from './ports.js';
export { createNodeFs } from './nodeFs.js';
export {
  sha256,
  hashTree,
  contentHash,
  resolvedContentHash,
  manifestContentHash,
  SKID_FILE,
} from './hashing.js';
export { splitFrontmatter, FrontmatterError } from './frontmatter.js';
export type { Frontmatter } from './frontmatter.js';
