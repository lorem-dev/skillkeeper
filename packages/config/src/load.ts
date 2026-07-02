import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { FsPort } from '@skillkeeper/core';
import {
  generalSchema,
  updatesSchema,
  agentsSchema,
  executablesSchema,
  securitySchema,
  notificationsSchema,
  repositoriesSchema,
  SECTIONS,
} from './schema.js';
import type { SkillKeeperConfig, Section } from './schema.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Full configuration with all sections at their default values. */
export const defaultConfig: SkillKeeperConfig = {
  general: generalSchema.parse({}),
  updates: updatesSchema.parse({}),
  agents: agentsSchema.parse({}),
  executables: executablesSchema.parse({}),
  security: securitySchema.parse({}),
  notifications: notificationsSchema.parse({}),
  repositories: repositoriesSchema.parse({}),
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validity status for each config section. */
export type SectionValidity = Record<Section, 'valid' | 'invalid'>;

/** Result of loading a config file. */
export interface LoadConfigResult {
  /** The resolved configuration. Invalid sections are replaced by defaults. */
  config: SkillKeeperConfig;
  /** Per-section validity indicator. */
  validity: SectionValidity;
  /** Human-readable warnings, one per invalid section. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate one section of a raw parsed object against its zod schema.
 * Returns the parsed value on success, or undefined on failure.
 */
function validateSection<T>(
  schema: { safeParse: (data: unknown) => { success: boolean; data?: T } },
  raw: unknown,
): T | undefined {
  const result = schema.safeParse(raw ?? {});
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Load `config.yaml` from `path` using the given `FsPort`.
 *
 * - If the file does not exist, returns full defaults (all sections valid).
 * - Each section is validated independently. An invalid section is replaced
 *   in the returned `config` by its default value; the raw file on disk is
 *   left untouched.
 * - A warning is appended to `warnings` for every invalid section.
 */
export async function loadConfig(fs: FsPort, path: string): Promise<LoadConfigResult> {
  const config: SkillKeeperConfig = { ...defaultConfig };
  const validity = Object.fromEntries(SECTIONS.map((s) => [s, 'valid'])) as SectionValidity;
  const warnings: string[] = [];

  // File missing -> full defaults, all valid.
  const exists = await fs.exists(path);
  if (!exists) {
    return { config, validity, warnings };
  }

  const text = await fs.readFile(path);

  // Parse YAML. If YAML itself is invalid, treat every section as invalid.
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    for (const section of SECTIONS) {
      validity[section] = 'invalid';
      warnings.push(`Config section "${section}" is invalid (YAML parse error); using defaults.`);
    }
    return { config, validity, warnings };
  }

  const rawObj: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  // Validate each section independently.
  const general = validateSection(generalSchema, rawObj['general']);
  if (general !== undefined) {
    config.general = general;
  } else {
    validity['general'] = 'invalid';
    warnings.push(`Config section "general" is invalid; using defaults.`);
  }

  const updates = validateSection(updatesSchema, rawObj['updates']);
  if (updates !== undefined) {
    config.updates = updates;
  } else {
    validity['updates'] = 'invalid';
    warnings.push(`Config section "updates" is invalid; using defaults.`);
  }

  const agents = validateSection(agentsSchema, rawObj['agents']);
  if (agents !== undefined) {
    config.agents = agents;
  } else {
    validity['agents'] = 'invalid';
    warnings.push(`Config section "agents" is invalid; using defaults.`);
  }

  const executables = validateSection(executablesSchema, rawObj['executables']);
  if (executables !== undefined) {
    config.executables = executables;
  } else {
    validity['executables'] = 'invalid';
    warnings.push(`Config section "executables" is invalid; using defaults.`);
  }

  const security = validateSection(securitySchema, rawObj['security']);
  if (security !== undefined) {
    config.security = security;
  } else {
    validity['security'] = 'invalid';
    warnings.push(`Config section "security" is invalid; using defaults.`);
  }

  const notifications = validateSection(notificationsSchema, rawObj['notifications']);
  if (notifications !== undefined) {
    config.notifications = notifications;
  } else {
    validity['notifications'] = 'invalid';
    warnings.push(`Config section "notifications" is invalid; using defaults.`);
  }

  const repositories = validateSection(repositoriesSchema, rawObj['repositories']);
  if (repositories !== undefined) {
    config.repositories = repositories;
  } else {
    validity['repositories'] = 'invalid';
    warnings.push(`Config section "repositories" is invalid; using defaults.`);
  }

  return { config, validity, warnings };
}

// ---------------------------------------------------------------------------
// saveConfig
// ---------------------------------------------------------------------------

/**
 * Atomically write `config` to `path` as YAML.
 *
 * Writes to a `.tmp` sibling first, then renames to the final path so a
 * crash mid-write cannot leave a partial file.
 */
export async function saveConfig(
  fs: FsPort,
  path: string,
  config: SkillKeeperConfig,
): Promise<void> {
  const yaml = stringifyYaml(config);
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, yaml);
  await fs.rename(tmp, path);
}
