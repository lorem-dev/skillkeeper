/**
 * Flows 1 and 9 (Repositories page): adding a repository, and a repository
 * that fails to add at all. See `.superpowers/specs/2026-09-09-desktop-ui-e2e-
 * design.md`'s "The flows" section.
 *
 * Each flow needs its own scenario (`repositories_add` answers success in one,
 * failure in the other), so each gets its own `describe` block: `test.use`
 * applies to every test declared after it within the same block, not to the
 * whole file.
 */
import { test, expect } from '../harness/fixture';
import { oneRepository, cloneFails } from '../fixtures/repositories';

test.describe('adding a repository', () => {
  test.use({ scenario: oneRepository() });

  test('adding a repository shows it in the list', async ({ app, page }) => {
    await app.goto();
    // Repositories is not the default view (Projects is) -- see App.tsx's
    // `activeView` initial state.
    await page.getByTestId('nav-repositories').click();
    await expect(page.getByTestId('repositories-page')).toBeVisible();
    await page.getByTestId('repo-add-button').click();
    await page.getByTestId('repo-add-url').fill('https://example.invalid/demo.git');
    await page.getByTestId('repo-add-submit').click();
    const row = page.getByTestId('repo-row').filter({ has: page.locator('[data-repo-name="demo"]') });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('repo-row-branch')).toHaveText('main');
  });
});

test.describe('a repository that will not clone', () => {
  test.use({ scenario: cloneFails('authentication failed') });

  test('a repository that will not clone reports the error and adds no row', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-repositories').click();
    await page.getByTestId('repo-add-button').click();
    await page.getByTestId('repo-add-url').fill('https://example.invalid/nope.git');
    await page.getByTestId('repo-add-submit').click();
    await expect(page.getByTestId('repo-add-error')).toContainText('authentication failed');
    await expect(page.getByTestId('repo-row')).toHaveCount(0);
  });
});
