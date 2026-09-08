/**
 * The scripted backend's fixture data for one Playwright run.
 *
 * A `Scenario` is plain, JSON-serializable data: `installHarness` carries it
 * across into the page via `page.addInitScript`'s argument, which uses
 * Playwright's structured-clone-style serialization -- functions and other
 * non-serializable values do not survive that trip. `responses` is the one
 * deliberate escape hatch: `commands.ts`'s `defaultResponses` merges it over
 * the default command table, so a scenario built entirely from plain data (as
 * `defaultScenario` is) never runs into the restriction; a later task that
 * needs a per-call computed answer resolves it a different way (see
 * `installHarness.ts`'s notes on that boundary).
 *
 * Field shapes loosely mirror the real backend's without importing from
 * `apps/desktop` -- this suite stays a self-contained package, the same way
 * `e2e/cli` does not depend on the CLI crate's Rust types either:
 *   config       -> LoadConfigResult['config'] (SkillKeeperConfig)
 *   onboarding   -> OnboardingState { version, completed, step }
 *   repositories -> Repository[]
 *   projects     -> Project[]
 *   installs     -> InstallManifest[]
 *   mcpInstalls  -> McpInstall[]
 *
 * This is the minimal shape Task 2's command table needs (see
 * `commands.ts`'s `defaultResponses`). A later task extends this file to add
 * whatever a flow test needs; it will not recreate it.
 */
export interface Scenario {
  /** `process.platform` as the Rust backend reports it: 'darwin' | 'win32' | 'linux'. */
  readonly platform: string;
  /** The mocked Tauri window label. `main.tsx` mounts an entirely different
   *  app (`SshUnlockApp`) for the 'ssh-unlock' label, so this is load-bearing,
   *  not decoration -- default 'main'. */
  readonly windowLabel: string;
  readonly config: Record<string, unknown>;
  readonly onboarding: Record<string, unknown>;
  readonly repositories: readonly unknown[];
  readonly projects: readonly unknown[];
  readonly installs: readonly unknown[];
  readonly mcpInstalls: readonly unknown[];
  /**
   * Per-command overrides, merged over `commands.ts`'s defaults. A value here
   * is plain data for now (see the file-level note on why a function value
   * cannot cross into the page yet).
   */
  readonly responses: Record<string, unknown>;
  /** Named canned event payloads a later task's harness can emit on demand
   *  (e.g. to drive `onConfigChanged`/`onTerminalData` subscribers). Unused
   *  until that task wires an emit path through the mocked event plugin. */
  readonly events: Record<string, unknown>;
}

/**
 * A scenario with a clean, empty-but-valid backend: no repositories, no
 * projects, no installs, onboarding already completed (so the guided tour
 * never opens unprompted), update checks on 'manual' (so nothing schedules a
 * startup sweep), and `platform: 'darwin'` -- which resolves to the 'mac'
 * chrome variant (see `hostPlatform.ts`), so `WindowChrome` renders nothing
 * and the `window_is_maximized`/`window:maximizeChanged` round trip it would
 * otherwise drive never comes into play.
 */
export function defaultScenario(): Scenario {
  return {
    platform: 'darwin',
    windowLabel: 'main',
    config: {
      general: { language: 'en', theme: 'system', animations: 'normal' },
      updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
      agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
      executables: { globs: [] },
      security: { hookConsentPolicy: 'always-ask' },
      notifications: { enabled: true },
      repositories: { gitPath: 'git' },
      projects: { checkIntervalMinutes: 1 },
      mcp: { servers: [] },
    },
    onboarding: { version: 1, completed: true, step: 'done' },
    repositories: [],
    projects: [],
    installs: [],
    mcpInstalls: [],
    responses: {},
    events: {},
  };
}
