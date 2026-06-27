/**
 * Public API of @skillkeeper/config.
 *
 * Re-exports only. Keep logic in the modules this file re-exports.
 */

export type {
  GeneralConfig,
  UpdatesConfig,
  AgentsConfig,
  ExecutablesConfig,
  SecurityConfig,
  NotificationsConfig,
  SkillKeeperConfig,
  Section,
} from './schema.js';

export { SECTIONS } from './schema.js';

export type { LoadConfigResult, SectionValidity } from './load.js';
export { loadConfig, saveConfig, defaultConfig } from './load.js';
