/**
 * Flows 2, 3 and 11 (Skills pages): browsing the catalog, installing a skill
 * through `SkillInstallModal`, and a skill whose dependency must be selected
 * alongside it. See `.superpowers/specs/2026-09-09-desktop-ui-e2e-design.md`'s
 * "The flows" section.
 *
 * Skills and MCP are not flat sidebar items (see `App.tsx`'s `NAV_ITEMS`
 * comment): the Skills group header must be expanded first, then one of its
 * two sub-items reaches a page -- `nav-skills-management` for the tree that
 * merges the catalog with what is installed (flow 2), `nav-skills-components`
 * for the repositories browse tree that feeds `SkillInstallModal` (flows 3, 11).
 */
import { test, expect } from '../harness/fixture';
import type { Page } from '@playwright/test';
import { flatAndGrouped, installable, withDependency } from '../fixtures/skills';

/**
 * A `skill-group` row identified by its `data-group-id`, found via its
 * nearest `[data-testid="skill-group"]` ancestor rather than
 * `.filter({ has: ... })`: groups nest (a nested group's `<li>` sits INSIDE
 * its parent group's `<li>`), so `.filter({ has: ... })` also matches the
 * parent -- it contains a descendant with that attribute too. Walking up from
 * the identity attribute is unambiguous regardless of nesting depth.
 */
function groupRow(page: Page, groupId: string) {
  return page.locator(`[data-group-id="${groupId}"]`).locator('xpath=ancestor::*[@data-testid="skill-group"][1]');
}

test.describe('browsing skills', () => {
  test.use({ scenario: flatAndGrouped() });

  test('the tree lists a flat skill, a group, and a nested group', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-skills').click();
    await page.getByTestId('nav-skills-management').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();

    // The repository root has no dedicated test id (no flow needs to select it
    // by identity); it is the one branch labeled with the repository's own
    // name, and expanding it is what reveals the flat skill and the group.
    await page.getByText('skills-repo', { exact: true }).click();

    const flatSkill = page.getByTestId('skill-row').filter({ has: page.locator('[data-skill-id="flat-skill"]') });
    await expect(flatSkill).toBeVisible();

    const group = groupRow(page, 'platform');
    await expect(group).toBeVisible();

    // Expanding the group reveals the nested group underneath it.
    await group.click();
    const nestedGroup = groupRow(page, 'platform/lint');
    await expect(nestedGroup).toBeVisible();
  });
});

test.describe('installing a skill', () => {
  test.use({ scenario: installable() });

  test('checking a skill and applying it drives progress to completion', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-skills').click();
    await page.getByTestId('nav-skills-components').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();

    // Checking the skill row (a leaf click toggles its checkbox -- see
    // `TreeView`'s `activateRow`) reveals the dock's "Install" button.
    const row = page.getByTestId('skill-row').filter({ has: page.locator('[data-skill-id="installable-skill"]') });
    await row.click();

    await page.getByTestId('skill-install-open').click();
    await expect(page.getByTestId('skill-install-modal')).toBeVisible();

    // Step 1: pick the project. `projects_detect_agents` (mocked by the
    // scenario) auto-fills the agent selection, so there is nothing else to
    // drive before "Next" is enabled.
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: 'Demo' }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2: the picked skill is already checked -- seeded from the page's
    // hand pick (`seedInstallSelection`).
    const checkbox = page
      .getByTestId('skill-install-checkbox')
      .filter({ has: page.locator('[data-skill-id="installable-skill"]') });
    await expect(checkbox).toHaveAttribute('aria-checked', 'true');

    // Save is a double-confirm: the first click only arms it.
    await page.getByTestId('skill-install-submit').click();

    // The confirming click, the `skills:progress` emit, and the read of its
    // effect all happen inside ONE `page.evaluate` rather than as separate
    // `app`-fixture calls. This is not stylistic: `applySkills` (`app/store/
    // store.ts`) awaits the scripted `skills_apply` then `skills_list`, both
    // of which the harness resolves within a couple of microtask ticks (see
    // `harness/installHarness.ts`'s synchronous mock callback) -- an order of
    // magnitude faster than a second, separate Playwright round trip can
    // land. Confirmed empirically: a standalone `app.emit` call issued after
    // an already-awaited confirming click always arrives once the apply has
    // already resolved and the modal has already closed, so there is no
    // listener left to receive it. Sequencing by microtask ticks
    // (`await Promise.resolve()`) inside one script is deterministic JS
    // ordering, not a timing guess -- unlike a real wait, it cannot be
    // "almost long enough". The emitted event is dispatched through the exact
    // same `plugin:event|emit` invoke call `harness/fixture.ts`'s `app.emit`
    // uses, so this exercises the identical wire path.
    const resultValueNow = await page.evaluate(async () => {
      const submit = document.querySelector('[data-testid="skill-install-submit"]') as HTMLButtonElement;
      submit.click();
      // One tick for `applySkills`'s synchronous `set({ skillApply: ... })`
      // (made before its first await) to reach a committed render.
      await Promise.resolve();
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      await internals.invoke('plugin:event|emit', {
        event: 'skills:progress',
        payload: { done: 1, total: 1 },
      });
      // One more tick for the emitted update to commit before the apply's own
      // (already in-flight) resolution clears it again.
      await Promise.resolve();
      return document.querySelector('[data-testid="skill-install-result"]')?.getAttribute('aria-valuenow') ?? null;
    });

    expect(resultValueNow).toBe('100');
  });
});

test.describe('a skill with dependencies', () => {
  test.use({ scenario: withDependency() });

  test('checking a skill also selects its dependency, marked required', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-skills').click();
    await page.getByTestId('nav-skills-components').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();

    const dependent = page
      .getByTestId('skill-row')
      .filter({ has: page.locator('[data-skill-id="needs-dependency"]') });
    await dependent.click();

    await page.getByTestId('skill-install-open').click();
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: 'Demo' }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    const dependencyRow = page
      .getByTestId('skill-install-checkbox')
      .filter({ has: page.locator('[data-skill-id="depended-on-skill"]') });
    await expect(dependencyRow).toHaveAttribute('aria-checked', 'true');
    await expect(dependencyRow.getByTestId('skill-install-required-badge')).toBeVisible();
  });
});
