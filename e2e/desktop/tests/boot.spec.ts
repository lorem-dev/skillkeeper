import { test, expect } from '@playwright/test';
import { installHarness } from '../harness/installHarness.js';
import { defaultScenario } from '../harness/scenario.js';

test('the application mounts against the scripted backend', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await installHarness(page, defaultScenario());
  await page.goto('/');
  // `<App/>` mounts inside main.tsx's `bridgeClient.init().finally(...)`,
  // which runs its callback on rejection too -- so `app-shell` appearing does
  // NOT by itself prove the harness answered anything. `toBeVisible()` also
  // checks bounding box and CSS visibility, not occlusion, so it would still
  // pass with `#sk-preloader` (a `position: fixed; inset: 0; z-index:
  // 2147483647` overlay) sitting on top of everything. `#sk-preloader` is
  // only removed by App.tsx's own effect, once `loading` has cycled true then
  // false -- proof the mount-to-first-effects lifecycle ran to completion, not
  // proof any one command was answered correctly. What actually catches a
  // broken command (like an unmocked `platform`, which several call sites
  // never await/catch) is the `failures` array below, from `pageerror`. All
  // three assertions together are what the "scripted backend answers"
  // round-trip needs; any one alone would pass on a harness with real gaps.
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await expect(page.locator('#sk-preloader')).toHaveCount(0);
  expect(failures, failures.join('\n')).toEqual([]);
});
