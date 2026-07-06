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
  RepositoriesConfig,
  ProjectsConfig,
  SkillKeeperConfig,
  Section,
} from './schema.js';

export { SECTIONS, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from './schema.js';

export type { LoadConfigResult, SectionValidity } from './load.js';
export { loadConfig, saveConfig, defaultConfig } from './load.js';
