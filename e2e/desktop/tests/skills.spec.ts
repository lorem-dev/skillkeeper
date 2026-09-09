/**
 * Flows 2, 3 and 11 (Skills pages): browsing the catalog, installing a skill
 * through `SkillInstallModal`, and a skill whose dependency must be selected
 * alongside it.
 *
 * Skills and MCP are not flat sidebar items (see `App.tsx`'s `NAV_ITEMS`
 * comment): the Skills group header must be expanded first, then one of its
 * two sub-items reaches a page -- `nav-skills-management` for the tree that
 * merges the catalog with what is installed (flow 2), `nav-skills-components`
 * for the repositories browse tree that feeds `SkillInstallModal` (flows 3, 11).
 */
import { test, expect } from '../harness/fixture';
import type { Page } from '@playwright/test';
import {
  flatAndGrouped,
  installable,
  withDependency,
  flatSkillLeafId,
  groupedSkillGroupId,
  nestedSkillGroupId,
  installableSkillRowId,
  installableSkillInstallCheckboxId,
  needsDependencySkillRowId,
  dependedOnSkillInstallCheckboxId,
} from '../fixtures/skills';

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

    const flatSkill = page
      .getByTestId('skill-row')
      .filter({ has: page.locator(`[data-skill-id="${flatSkillLeafId()}"]`) });
    await expect(flatSkill).toBeVisible();

    const group = groupRow(page, groupedSkillGroupId());
    await expect(group).toBeVisible();

    // Expanding the group reveals the nested group underneath it.
    await group.click();
    const nestedGroup = groupRow(page, nestedSkillGroupId());
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
    const row = page
      .getByTestId('skill-row')
      .filter({ has: page.locator(`[data-skill-id="${installableSkillRowId()}"]`) });
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
      .filter({ has: page.locator(`[data-skill-id="${installableSkillInstallCheckboxId()}"]`) });
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
    // uses (see that file's doc comment, which now records this limit), so
    // this exercises the identical wire path. The payload matches the
    // authoritative `ApplyProgress` shape (`contracts.ts`) in full, including
    // `label` -- the modal renders it, so an approximated payload would be a
    // silent product-code path this spec never actually exercises.
    const progressValueNow = await page.evaluate(async () => {
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
        payload: { done: 1, total: 1, label: 'Installing installable-skill' },
      });
      // One more tick for the emitted update to commit before the apply's own
      // (already in-flight) resolution clears it again.
      await Promise.resolve();
      return (
        document
          .querySelector('[data-testid="skill-install-progress"] [role="progressbar"]')
          ?.getAttribute('aria-valuenow') ?? null
      );
    });

    // Proves the emitted event was received: the progress section reflects
    // the {done: 1, total: 1} the spec pushed, not whatever `skills_apply`'s
    // own (much faster) resolution would have shown on its own.
    expect(progressValueNow).toBe('100');

    // The flow's actual result -- a successful apply -- is the modal closing
    // (`SkillInstallModal.save()` calls `onClose()` only once every op's
    // `applySkills` call resolves `ok: true`). Web-first: by now the apply has
    // long since settled (a real round trip past the evaluate above), so this
    // is asserting a stable end state, not racing a transient one.
    await expect(page.getByTestId('skill-install-modal')).toBeHidden();
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
      .filter({ has: page.locator(`[data-skill-id="${needsDependencySkillRowId()}"]`) });
    await dependent.click();

    await page.getByTestId('skill-install-open').click();
    await page.getByRole('combobox', { name: 'Project' }).click();
    await page.getByRole('option', { name: 'Demo' }).click();
    await page.getByRole('button', { name: 'Next' }).click();

    const dependencyRow = page
      .getByTestId('skill-install-checkbox')
      .filter({ has: page.locator(`[data-skill-id="${dependedOnSkillInstallCheckboxId()}"]`) });
    await expect(dependencyRow).toHaveAttribute('aria-checked', 'true');
    await expect(dependencyRow.getByTestId('skill-install-required-badge')).toBeVisible();

    // The design doc's rule for this flow (`installSelection.ts`'s own header
    // comment) is that the apply plan is built from the DERIVED checked set,
    // never the user's hand pick alone -- the mistake that would draw the
    // dependency correctly and then install none of it. `needs-dependency`
    // alone is the only hand pick (`skillKeys`); if the plan were built from
    // that instead of `derived.shown`, `depended-on-skill` would be silently
    // missing from `skills_apply`'s `install` list below. Submitting and
    // reading the actually-recorded call is what catches that regression --
    // asserting the checkbox/badge above only proves the tree DRAWS the
    // dependency, not that applying it INSTALLS the dependency too.
    await page.getByTestId('skill-install-submit').click();
    await page.getByTestId('skill-install-submit').click();

    const calls = await app.calls('skills_apply');
    expect(calls).toHaveLength(1);
    const { install } = (calls[0] as { args: { install: readonly { name: string }[] } }).args;
    expect(install.map((ref) => ref.name).sort()).toEqual(['depended-on-skill', 'needs-dependency']);
  });
});
