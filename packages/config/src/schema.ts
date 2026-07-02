import { z } from 'zod';

// ---------------------------------------------------------------------------
// Section: general
// ---------------------------------------------------------------------------

export const generalSchema = z.object({
  /** Display language. Defaults to English. */
  language: z.enum(['en', 'de', 'ru']).default('en'),
  /** UI theme preference. */
  theme: z.enum(['system', 'light', 'dark']).default('system'),
  /** Shell command used to open files in the user's editor. */
  defaultEditor: z.string().optional(),
});

export type GeneralConfig = z.infer<typeof generalSchema>;

// ---------------------------------------------------------------------------
// Section: updates
// ---------------------------------------------------------------------------

export const updatesSchema = z.object({
  /** When to check for skill and repository updates. */
  mode: z.enum(['manual', 'on-startup', 'scheduled']).default('manual'),
  /** How often to check (hours) when mode is "scheduled". Must be positive. */
  intervalHours: z.number().int().positive().default(24),
  /** Run a check each time SkillKeeper starts (independent of mode). */
  checkOnStartup: z.boolean().default(false),
});

export type UpdatesConfig = z.infer<typeof updatesSchema>;

// ---------------------------------------------------------------------------
// Section: agents
// ---------------------------------------------------------------------------

export const agentsSchema = z.object({
  /** Which agent kinds to activate. Defaults to all supported kinds. */
  enabled: z
    .array(z.enum(['claude', 'codex', 'copilot', 'cursor', 'opencode']))
    .default(['claude', 'codex', 'copilot', 'cursor', 'opencode']),
  /**
   * Per-agent overrides. Keys are agent kind strings; values are free-form
   * records for forward compatibility. Validated as unknown records.
   */
  overrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type AgentsConfig = z.infer<typeof agentsSchema>;

// ---------------------------------------------------------------------------
// Section: executables
// ---------------------------------------------------------------------------

export const executablesSchema = z.object({
  /** Glob patterns; files matching any pattern get +x after install. */
  globs: z.array(z.string()).default([]),
});

export type ExecutablesConfig = z.infer<typeof executablesSchema>;

// ---------------------------------------------------------------------------
// Section: security
// ---------------------------------------------------------------------------

export const securitySchema = z.object({
  /**
   * How SkillKeeper asks for hook-install consent.
   * "always-ask" is the default and recommended policy.
   */
  hookConsentPolicy: z.enum(['always-ask']).default('always-ask'),
});

export type SecurityConfig = z.infer<typeof securitySchema>;

// ---------------------------------------------------------------------------
// Section: notifications
// ---------------------------------------------------------------------------

export const notificationsSchema = z.object({
  /** Whether to display system notifications (desktop only). */
  enabled: z.boolean().default(true),
});

export type NotificationsConfig = z.infer<typeof notificationsSchema>;

// ---------------------------------------------------------------------------
// Section: repositories
// ---------------------------------------------------------------------------

export const repositoriesSchema = z.object({
  /** Path to the git executable used for repository operations. */
  gitPath: z.string().default('git'),
});

export type RepositoriesConfig = z.infer<typeof repositoriesSchema>;

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

/** All config sections combined. */
export interface SkillKeeperConfig {
  general: GeneralConfig;
  updates: UpdatesConfig;
  agents: AgentsConfig;
  executables: ExecutablesConfig;
  security: SecurityConfig;
  notifications: NotificationsConfig;
  repositories: RepositoriesConfig;
}

/** The config section names as a union type. */
export type Section = keyof SkillKeeperConfig;

/** All section names in a stable order. */
export const SECTIONS: readonly Section[] = [
  'general',
  'updates',
  'agents',
  'executables',
  'security',
  'notifications',
  'repositories',
] as const;
