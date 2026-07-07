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
} from './lib/skillTree';
export type {
  ParsedSkillRef,
  ProjectModel,
  ProjectLeafStatus,
  ProjectSkillUpdate,
  OrphanLeafInfo,
} from './lib/skillTree';
export { buildProjectPlan } from './lib/applyPlan';
export type { ProjectPlan, AgentOps, SkillChangeRow } from './lib/applyPlan';
export { SkillCard } from './ui/SkillCard';
export type { SkillCardProps } from './ui/SkillCard';
export { SkillDetailsModal } from './ui/SkillDetailsModal';
export type { SkillDetailsModalProps } from './ui/SkillDetailsModal';
