export { aggregateInstalls } from './lib/aggregateInstalls';
export type { InstalledSkillView } from './lib/aggregateInstalls';
export {
  buildRepoTree,
  buildProjectTree,
  buildProjectModel,
  installedLeafIds,
  installedAgentsByProject,
  filterTree,
  collectBranchIds,
  branchesContaining,
  rootIds,
  countLeaves,
  repoSkillKey,
  projectSkillKey,
  parseRepoSkillKey,
  parseProjectSkillKey,
  repoNodeId,
  repoGroupNodeId,
  projectNodeId,
  projectRepoNodeId,
  projectGroupNodeId,
} from './lib/skillTree';
export type {
  ParsedSkillRef,
  ProjectModel,
  ProjectLeafStatus,
  ProjectSkillUpdate,
  OrphanLeafInfo,
} from './lib/skillTree';
export {
  buildGraph,
  closure,
  dependents,
  contains,
  requiresOf,
  skillPath,
  brokenLeaves,
} from './lib/requires';
export type { RequiresGraph, BrokenArgs } from './lib/requires';
export { deriveSelection, toggle, applyCheckChange, restore } from './lib/selection';
export type { Selection, DerivedSelection } from './lib/selection';
export { buildProjectPlan, scopesNeedingAgents } from './lib/applyPlan';
export type { ProjectPlan, AgentOps, SkillChangeRow } from './lib/applyPlan';
export { SkillCard } from './ui/SkillCard';
export type { SkillCardProps } from './ui/SkillCard';
export { SkillDetailsModal } from './ui/SkillDetailsModal';
export type { SkillDetailsModalProps } from './ui/SkillDetailsModal';
