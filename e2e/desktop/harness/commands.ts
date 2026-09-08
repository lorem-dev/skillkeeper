import type { Scenario } from './scenario.js';

/**
 * Prefix on the error thrown by the harness's mocked `invoke` handler for a
 * command with no entry in the table below. Task 9 asserts a rejection
 * message starts with this string, so it stays a distinct, greppable
 * constant rather than an inline literal.
 *
 * Throwing (rather than resolving `undefined`, or logging and moving on) is
 * the point: a renamed or newly added backend command must surface here, as
 * a named failure, not three steps later as a confusing assertion mismatch.
 */
export const UNKNOWN_COMMAND_PREFIX = 'e2e-harness: unmocked command ';

/**
 * Default answers keyed by the backend command name as written in
 * `apps/desktop/src/renderer/services/bridge/client.ts`. A scenario's
 * `responses` are merged over this table (see `Scenario` in `scenario.ts`);
 * a later task may make one of those override values a function of the
 * invoke arguments instead of plain data.
 *
 * STARTUP COMMAND LIST (Task 2, Step 6): discovered by running
 * `boot.spec.ts` against an empty table and `defaultScenario()` (macOS,
 * onboarding already completed, empty repositories/projects/installs,
 * update mode 'manual'), reading each `e2e-harness: unmocked command <name>`
 * page error, adding a minimal valid answer, and repeating.
 *
 * Only three commands turned out to be load-bearing for the assertions in
 * `boot.spec.ts` (`[data-testid="app-shell"]` visible, zero page errors) --
 * everything else `loadAll` awaits is wrapped in try/catch, so an unmocked
 * response there is a caught rejection (`store.error` gets set, a background
 * task's status flips to 'error'), never an uncaught page error:
 *
 *   1. platform             -- main.tsx's `bridgeClient.init()`, awaited
 *                               before the app mounts at all; index.html's
 *                               preloader stays up until this settles. Left
 *                               unmocked, `bridgeClient.platform` stays ''
 *                               (its default), `hostPlatform('')` resolves to
 *                               'linux' rather than 'mac', and WindowChrome
 *                               then calls `window_is_maximized` too --
 *                               chasing that command is a trap; fix `platform`
 *                               and it disappears on its own.
 *   2. onboarding_menu_sync -- App's "keep the native menu in sync" effect
 *                               (`bridgeClient.onboardingMenuSync`) calls
 *                               `invoke` with a bare `void`, no .catch -- an
 *                               unmocked rejection is a genuine unhandled
 *                               promise rejection, unconditionally, on every
 *                               boot.
 *   3. terminal_resize      -- likewise a bare `void invoke(...)` with no
 *                               .catch, fired by the always-mounted terminal
 *                               view's initial fit/resize, independent of
 *                               whether the terminal panel is open.
 *
 * `boot.spec.ts` would pass with only those three mocked -- `loadAll`'s
 * Promise.all would simply reject and `store.error` would be set. This table
 * mocks the rest of `loadAll`'s round trip anyway, because a boot test that
 * tolerates the ENTIRE startup data fetch failing is not meaningfully
 * proving "a scripted backend answers" (this suite's stated purpose), and
 * every later task built on `defaultScenario()` wants a working store, not
 * one parked in its error state:
 *
 *   - config_get          -- store.loadAll.
 *   - onboarding_get      -- store.loadAll -> loadOnboarding.
 *   - repositories_list   -- store.loadAll.
 *   - skills_reconcile    -- store.loadAll (reconciles the install ledger
 *                             against disk; NOT `skills_list`, which no
 *                             startup path calls).
 *   - skills_available    -- store.loadAll.
 *   - projects_list       -- store.loadAll.
 *   - mcp_reconcile       -- store.loadAll (NOT `mcp_installs`, same
 *                             reason as `skills_reconcile` above).
 *   - get_app_version     -- StatusBar's `useAppVersion`, mounted
 *                             unconditionally alongside the shell (its own
 *                             `.then(ok, () => undefined)` already tolerates
 *                             a rejection, so this one was never required
 *                             either -- included for the same reason as the
 *                             `loadAll` set above).
 *
 * Commands that need no entry at all, and why:
 *   - `window_is_maximized` / `window:maximizeChanged` (WindowChrome): only
 *     called when `hostPlatform(bridgeClient.platform) !== 'mac'`;
 *     `defaultScenario` reports `platform: 'darwin'`, so WindowChrome renders
 *     nothing and never calls either.
 *   - `app_update_check` (useAppUpdateSchedule's one-time startup check):
 *     DOES fire once loading settles, but `store.runAppUpdateCheck` wraps the
 *     call in try/catch, same as the `loadAll` set above.
 *   - Every repository/project/MCP mutation and every `plugin:event|*`
 *     listener registration: `mockIPC` is called with
 *     `{ shouldMockEvents: true }` (see `installHarness.ts`), so `listen()`
 *     calls (onConfigChanged, onSshUnlockResolved, the app-update
 *     subscriptions, ...) are answered by `@tauri-apps/api/mocks`'s own
 *     internal event registry and never reach this table at all.
 */
export function defaultResponses(scenario: Scenario): Record<string, unknown> {
  return {
    platform: scenario.platform,
    onboarding_menu_sync: null,
    terminal_resize: null,
    config_get: {
      config: scenario.config,
      validity: {
        general: 'valid',
        updates: 'valid',
        agents: 'valid',
        executables: 'valid',
        security: 'valid',
        notifications: 'valid',
        repositories: 'valid',
        projects: 'valid',
        mcp: 'valid',
      },
      warnings: [],
    },
    onboarding_get: scenario.onboarding,
    repositories_list: scenario.repositories,
    skills_reconcile: scenario.installs,
    skills_available: { skills: [], warnings: [] },
    projects_list: scenario.projects,
    mcp_reconcile: scenario.mcpInstalls,
    get_app_version: '0.0.0-e2e',
    ...scenario.responses,
  };
}
