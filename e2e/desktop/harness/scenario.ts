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
 * Every field type below is imported from the same generated/hand-written
 * sources the renderer itself uses (`apps/desktop/src/renderer/services/
 * bridge/generated/**` for the ts-rs output, `.../bridge/contracts.ts` for the
 * hand-written result wrappers) -- never a hand-rolled approximation. A
 * scenario that drifts from those shapes is a defect here, not a "close
 * enough" fixture; the renderer would reject the same payload from the real
 * backend.
 */
import type { SkillKeeperConfig, OnboardingState } from '../../../apps/desktop/src/renderer/services/bridge/generated/config/index.js';
import type { Repository, Project, InstallManifest } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/index.js';
import type { AvailableSkill, AvailableMcp, McpInstall } from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

export interface Scenario {
  /** `process.platform` as the Rust backend reports it: 'darwin' | 'win32' | 'linux'. */
  readonly platform: string;
  /** The mocked Tauri window label. `main.tsx` mounts an entirely different
   *  app (`SshUnlockApp`) for the 'ssh-unlock' label, so this is load-bearing,
   *  not decoration -- default 'main'. */
  readonly windowLabel: string;
  readonly config: SkillKeeperConfig;
  readonly onboarding: OnboardingState;
  readonly repositories: readonly Repository[];
  readonly projects: readonly Project[];
  readonly installs: readonly InstallManifest[];
  /** The `skills_available` catalog (installable skills across all tracked
   *  repositories), independent of `installs` (what is already installed).
   *  `skills_available`'s `warnings` half stays a fixed empty array in
   *  `commands.ts` -- no flow in this plan needs one yet. */
  readonly skills: readonly AvailableSkill[];
  /** The `mcp_list_available` catalog (installable MCP presets discovered from
   *  tracked repositories), independent of `mcpInstalls` (what is already
   *  installed) -- same split as `skills`/`installs` above. Its `warnings`
   *  half is likewise fixed to an empty array in `commands.ts`. Not part of
   *  startup (`loadAll` never calls it; only `refreshMcpPresets`, run after a
   *  repository add/update/sync or when the MCP page asks), so an empty
   *  default costs `defaultScenario` nothing. */
  readonly mcpAvailable: readonly AvailableMcp[];
  readonly mcpInstalls: readonly McpInstall[];
  /**
   * Per-command overrides, merged over `commands.ts`'s defaults. A value here
   * is plain data for now (see the file-level note on why a function value
   * cannot cross into the page yet).
   */
  readonly responses: Record<string, unknown>;
  /**
   * Reserved for a scenario that wants to declare named event payloads
   * up front (e.g. to seed a subscriber before the spec's first assertion).
   * Unused today: `fixture.ts`'s `app.emit(name, payload)` is the imperative
   * escape hatch a spec uses instead, dispatched on demand through the mocked
   * event plugin rather than replayed from scenario data. Kept as part of the
   * `Scenario` shape so a later task can add that replay without another
   * interface change.
   */
  readonly events: Record<string, unknown>;
}

/** A `SkillKeeperConfig` with every section present and valid, matching what
 *  a fresh install's `config.yaml` defaults resolve to. */
function emptyConfig(): SkillKeeperConfig {
  return {
    general: { language: 'en', theme: 'system', animations: 'normal' },
    updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
    agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
    executables: { globs: [] },
    security: { hookConsentPolicy: 'always-ask' },
    notifications: { enabled: true },
    repositories: { gitPath: 'git' },
    projects: { checkIntervalMinutes: 1 },
    mcp: { servers: [] },
  };
}

/** No skills installed anywhere -- the ledger `skills_reconcile` returns for a
 *  fresh install. */
function emptyManifest(): InstallManifest[] {
  return [];
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
    config: emptyConfig(),
    onboarding: { version: 1, completed: true, step: 'done' },
    repositories: [],
    projects: [],
    installs: emptyManifest(),
    skills: [],
    mcpAvailable: [],
    mcpInstalls: [],
    responses: {},
    events: {},
  };
}

/** `defaultScenario()` with `patch` shallow-merged over it. A field in `patch`
 *  replaces the default wholesale (e.g. `repositories: [...]` replaces the
 *  empty array, it does not append to it). */
export function withScenario(patch: Partial<Scenario>): Scenario {
  return { ...defaultScenario(), ...patch };
}
