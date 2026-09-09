/**
 * Flows 5 and 6 (Settings and self-update): opening Settings renders every
 * section against an all-valid config, and an offered update completes into
 * the "ready to install" status once `appUpdate:ready` arrives.
 *
 * Settings is a FLAT sidebar item (`nav-settings`), not a group -- unlike
 * Skills/MCP it has no sub-items to expand first.
 */
import { test, expect } from '../harness/fixture';
import { settingsPage, invalidSection, offeredUpdate, REPOSITORIES_INVALID_WARNING } from '../fixtures/settings';

test.describe('the settings page', () => {
  test.use({ scenario: settingsPage() });

  test('every section renders and reports valid', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();

    // Each section's identity sits on its title (a CHILD of the
    // `settings-section` container), never on the container itself -- see
    // `FormSection`'s `sectionId` doc comment.
    const sectionIds = ['general', 'repositories', 'projects', 'onboarding', 'app-updates'];
    for (const id of sectionIds) {
      const section = page.getByTestId('settings-section').filter({ has: page.locator(`[data-section-id="${id}"]`) });
      await expect(section).toBeVisible();
    }

    // The scenario's `config_get` reports every section 'valid' (see
    // `fixtures/settings.ts`'s `settingsPage`); the user-visible sign of that
    // is that the invalid-config banner (`ConfigBanner`, `role="alert"`)
    // never appears. This assertion only has power to fail paired with the
    // "an invalid section" test below, which drives the same banner from the
    // opposite scenario -- on its own it would pass even if `config_get`'s
    // validity never reached the UI at all.
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('an invalid section', () => {
  test.use({ scenario: invalidSection() });

  test('the config banner reports the invalid section and its warning', async ({ app, page }) => {
    await app.goto();

    // `ConfigBanner` is mounted app-wide (`App.tsx`, alongside `WindowChrome`),
    // not scoped to the Settings page, so it is already visible on the
    // default Projects view -- no navigation needed for this assertion.
    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(REPOSITORIES_INVALID_WARNING);
  });
});

test.describe('an offered update', () => {
  test.use({ scenario: offeredUpdate() });

  test('checking now then receiving a ready event surfaces the ready status', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();

    // No status is showing yet -- the "ready to install" dialog only mounts
    // its content once `appUpdateReadyOpen` is true (`Modal` renders nothing
    // while closed).
    await expect(page.getByTestId('app-update-status')).toBeHidden();

    await page.getByTestId('app-update-check-button').click();
    const calls = await app.calls('app_update_check_now');
    expect(calls).toHaveLength(1);

    // `useAppUpdateSchedule`'s `onAppUpdateReady` subscription is set up once
    // for the App's lifetime (an empty-deps effect), not inside the check's
    // own resolving chain, so this plain `app.emit` lands normally -- unlike
    // `skills.spec.ts`'s "installing a skill" test, there is no transient
    // listener window to race here.
    await app.emit('appUpdate:ready', { version: '1.5.0', path: '/tmp/SkillKeeper-1.5.0.pkg' });

    // The offer noted from `app_update_check_now` (not the emitted event's
    // own `version`, which the store deliberately ignores -- see
    // `useAppUpdateSchedule.ts`) is what the ready dialog renders.
    await expect(page.getByTestId('app-update-status')).toBeVisible();
    await expect(page.getByTestId('app-update-status')).toContainText('1.5.0');
  });
});
