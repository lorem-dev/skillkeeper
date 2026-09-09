/**
 * Scenarios for the Settings page and the self-update surface (flows 5 and 6
 * -- see `.superpowers/specs/2026-09-09-desktop-ui-e2e-design.md`).
 */
import { withScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';
import type {
  SkillKeeperConfig,
  SectionValidity,
} from '../../../apps/desktop/src/renderer/services/bridge/generated/config/index.js';
import type { AppUpdateOffer } from '../../../apps/desktop/src/renderer/services/bridge/generated/AppUpdateOffer.js';
import type { SshKeyDto } from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

/** The warning `config_get` reports alongside `invalidSection()`'s
 *  `repositories: 'invalid'`. Exported so the spec can assert its exact text
 *  reaches `ConfigBanner` rather than merely asserting the banner exists. */
export const REPOSITORIES_INVALID_WARNING = 'repositories: gitPath must not be empty';

/**
 * `SettingsPage`'s mount round trip: `OpenConfigButton` (the toolbar's editor
 * picker, same lazy-loaded-once pattern as `OpenProjectButton`) reads
 * `editors_list`, and the repositories section's `SshKeyField` reads
 * `ssh_key_state` -- neither has a default in `harness/commands.ts` (not part
 * of `loadAll`'s startup round trip), so any scenario that opens Settings
 * must answer both, exactly like `fixtures/skills.ts`'s
 * `projectsPageStartupResponses`.
 */
function settingsPageStartupResponses(): Record<string, unknown> {
  const sshKeyState: SshKeyDto = { state: 'notConfigured' };
  return {
    editors_list: [],
    ssh_key_state: sshKeyState,
  };
}

/**
 * A config with every section populated by values distinct from
 * `harness/scenario.ts`'s own `emptyConfig()` defaults, so a rendered field
 * can be told apart from an incidental default. `config_get`'s
 * `SectionValidity` (`harness/commands.ts`'s `defaultResponses`) marks every
 * section 'valid' regardless of the values here -- that default IS flow 5's
 * "all-valid" precondition, kept implicit rather than duplicated in a
 * `responses` override.
 */
function config(): SkillKeeperConfig {
  return {
    general: { language: 'en', theme: 'system', animations: 'fast' },
    updates: { mode: 'scheduled', intervalMinutes: 180, checkOnStartup: false },
    agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
    executables: { globs: [] },
    security: { hookConsentPolicy: 'always-ask' },
    notifications: { enabled: true },
    repositories: { gitPath: '/usr/bin/git' },
    projects: { checkIntervalMinutes: 5 },
    mcp: { servers: [] },
  };
}

/** Flow 5: opening Settings renders every section, backed by a config whose
 *  `SectionValidity` is all-valid (see `config()`'s doc comment). */
export function settingsPage(): Scenario {
  return withScenario({ config: config(), responses: settingsPageStartupResponses() });
}

/** The counterpart to `settingsPage()`: same config, but `repositories` is
 *  reported invalid with one warning -- so the invalid-config banner
 *  (`ConfigBanner`) has something to actually show, giving the valid case
 *  above a contrasting negative to be meaningful against. */
export function invalidSection(): Scenario {
  const validity: SectionValidity = {
    general: 'valid',
    updates: 'valid',
    agents: 'valid',
    executables: 'valid',
    security: 'valid',
    notifications: 'valid',
    repositories: 'invalid',
    projects: 'valid',
    mcp: 'valid',
  };
  return withScenario({
    config: config(),
    validity,
    configWarnings: [REPOSITORIES_INVALID_WARNING],
    responses: settingsPageStartupResponses(),
  });
}

/**
 * The offer `app_update_check_now` resolves with once the spec presses
 * "Check now" on the Settings page. `showDialog: false` keeps the "update
 * available" dialog from auto-opening (`noteAppUpdateOffer` in
 * `app/store/store.ts`), so the only overlay this flow drives is the "ready
 * to install" dialog, via a plain `appUpdate:ready` emit afterward.
 */
function offer(): AppUpdateOffer {
  return {
    version: '1.5.0',
    bump: 'minor',
    notes: '',
    truncatedHistory: false,
    installable: true,
    showDialog: false,
  };
}

/** Flow 6: `app_update_check_now` returns an offer; the spec then emits
 *  `appUpdate:ready` to complete it -- see `settings.spec.ts`. */
export function offeredUpdate(): Scenario {
  return withScenario({
    responses: {
      ...settingsPageStartupResponses(),
      app_update_check_now: offer(),
    },
  });
}
