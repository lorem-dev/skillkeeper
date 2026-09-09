/**
 * Flows 4 and 10 (Projects page): tracking a project, and a project whose
 * folder has gone missing. See `.superpowers/specs/2026-09-09-desktop-ui-e2e-
 * design.md`'s "The flows" section.
 *
 * Projects is the default view (`App.tsx`'s `activeView` starts at
 * 'projects'), so unlike the Repositories and Skills specs, neither test
 * navigates before asserting.
 */
import { test, expect } from '../harness/fixture';
import { trackable, folderMissing } from '../fixtures/projects';

test.describe('tracking a project', () => {
  test.use({ scenario: trackable() });

  test('adding a project shows its card with agent badges', async ({ app, page }) => {
    await app.goto();
    await expect(page.getByTestId('projects-page')).toBeVisible();
    await page.getByTestId('project-add-button').click();
    const card = page
      .getByTestId('project-card')
      .filter({ has: page.locator('[data-project-id="tracked-project-id"]') });
    await expect(card).toBeVisible();
    // Asserts the label text, not just visibility: `agentCount: 2`
    // (`fixtures/projects.ts`) is set specifically to make this badge
    // render at all, so its actual count should be read back too.
    await expect(card.getByTestId('project-card-agents')).toHaveText('2 agents');
  });
});

test.describe('a project whose folder is missing', () => {
  test.use({ scenario: folderMissing() });

  test('a missing folder shows the folder-missing affordance, not a generic error', async ({ app, page }) => {
    await app.goto();
    const card = page
      .getByTestId('project-card')
      .filter({ has: page.locator('[data-project-id="missing-project-id"]') });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('project-card-folder-missing')).toBeVisible();
  });
});
