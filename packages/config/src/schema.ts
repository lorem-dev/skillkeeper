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

/** Minimum/maximum for an interval, in minutes: 1 minute .. 23 hours. */
export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 23 * 60;

export const updatesSchema = z.object({
  /** When to check for skill and repository updates. */
  mode: z.enum(['manual', 'on-startup', 'scheduled']).default('on-startup'),
  /** How often to check (minutes) when mode is "scheduled". 1 min .. 23 h. */
  intervalMinutes: z
    .number()
    .int()
    .min(MIN_INTERVAL_MINUTES)
    .max(MAX_INTERVAL_MINUTES)
    .default(12 * 60),
  /**
   * For "scheduled" mode: also run a check on startup (not just on the interval).
   * Not shown in Settings -- the "on-startup" mode covers the common case.
   */
  checkOnStartup: z.boolean().default(false),
});

export type UpdatesConfig = z.infer<typeof updatesSchema>;

// ---------------------------------------------------------------------------
// Section: projects
// ---------------------------------------------------------------------------

export const projectsSchema = z.object({
  /**
   * How often to re-check that tracked project folders still exist (minutes).
   * The check always runs (on startup and on this interval); only the interval
   * is configurable. 1 min .. 23 h.
   */
  checkIntervalMinutes: z
    .number()
    .int()
    .min(MIN_INTERVAL_MINUTES)
    .max(MAX_INTERVAL_MINUTES)
    .default(1),
});

export type ProjectsConfig = z.infer<typeof projectsSchema>;

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
  projects: ProjectsConfig;
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
  'projects',
] as const;
