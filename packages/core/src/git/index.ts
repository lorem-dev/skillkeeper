// Git: system git runner + argument builders, remote URL parsing.
export {
  createSystemGit,
  buildCloneArgs,
  buildFetchArgs,
  buildPullArgs,
  buildResetHardArgs,
  buildCleanArgs,
  buildRevParseArgs,
  buildCurrentBranchArgs,
  buildLfsPullArgs,
  buildSetRemoteUrlArgs,
  buildBranchListArgs,
  parseBranchList,
  buildForceCheckoutArgs,
} from './systemGit.js';
export type { GitRunner, RunResult } from './systemGit.js';
export { normalizeRemote, parseRemote } from './repoRemote.js';
export type { ParsedRemote } from './repoRemote.js';
