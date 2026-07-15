// Hooks: delimited-region and json-merge edit strategies, guidance blocks.
export {
  wrapRegion,
  insertRegion,
  removeRegion,
  extractRegion,
  encapsulateForeignDelimiters,
  decapsulateForeignDelimiters,
} from './hookRegion.js';
export type { WrapRegionOptions, InsertMode } from './hookRegion.js';
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
export {
  guidanceKey,
  skillGuidanceId,
  upsertGuidanceBlock,
  removeGuidanceBlock,
  hasGuidanceBlock,
  stripGuidanceMarkers,
} from './guidance.js';
export {
  skillGuidanceBlockKey,
  readSkillGuide,
  writeSkillGuidance,
  clearSkillGuidance,
} from './guidanceApply.js';
