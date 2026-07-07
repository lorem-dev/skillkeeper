export { aggregateInstalls } from './lib/aggregateInstalls';
export type { InstalledSkillView } from './lib/aggregateInstalls';
export {
  buildRepoTree,
  buildProjectTree,
  installedLeafIds,
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
export type { ParsedSkillRef } from './lib/skillTree';
export { SkillCard } from './ui/SkillCard';
export type { SkillCardProps } from './ui/SkillCard';
export { SkillDetailsModal } from './ui/SkillDetailsModal';
export type { SkillDetailsModalProps } from './ui/SkillDetailsModal';
