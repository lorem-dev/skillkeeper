import { test, expect } from '@playwright/test';
import { installHarness } from '../harness/installHarness.js';
import { defaultScenario } from '../harness/scenario.js';

test('the application mounts against the scripted backend', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await installHarness(page, defaultScenario());
  await page.goto('/');
  // The preloader in index.html stays up until bridgeClient.init() settles, so
  // seeing the shell means the harness answered the startup round-trip.
  await expect(page.getByTestId('app-shell')).toBeVisible();
  expect(failures, failures.join('\n')).toEqual([]);
});
