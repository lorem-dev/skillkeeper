/**
 * Flows 7, 8 and 12 (MCP pages): installing a preset with a description and
 * an option-constrained parameter, updating an installed instance whose
 * preflight accepts it, and updating one whose preflight refuses it -- the
 * regression test for the 0.7.0 fix "Updating an MCP server no longer
 * deletes it when the new definition cannot be installed" (see
 * `.superpowers/sdd/2026-09-09-desktop-ui-e2e/task-8-brief.md`, and
 * `../fixtures/mcp.ts`'s own doc comment for why every scenario here targets
 * the Global scope rather than a tracked project).
 *
 * MCP is a two-level sidebar group exactly like Skills (see `App.tsx`'s
 * `NAV_ITEMS` comment): `nav-group-mcp` must be expanded before either of its
 * two sub-items (`nav-mcp-components`, `nav-mcp-management`) is clickable.
 * All three flows below use `nav-mcp-management` -- the page whose Install
 * and Update badges (`useMcpActions`) carry this task's testids.
 */
import { test, expect } from '../harness/fixture';
import { withParameters, updatable, preflightRefuses } from '../fixtures/mcp';

test.describe('an mcp update the agent cannot express', () => {
  test.use({ scenario: preflightRefuses('codex cannot express the http transport') });

  test('leaves the instance alone', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-mcp').click();
    await page.getByTestId('nav-mcp-management').click();
    await expect(page.getByTestId('mcp-page')).toBeVisible();

    const row = page.getByTestId('mcp-server-row').filter({
      has: page.locator('[data-mcp-name="github"]'),
    });
    await expect(row).toBeVisible();

    await row.getByTestId('mcp-update-open').click();
    await page.getByTestId('mcp-update-submit').click();

    await expect(page.getByTestId('mcp-update-error')).toContainText('cannot express');
    // The point of the 0.7.0 fix: the removal must not have happened.
    await expect(row).toBeVisible();
    expect(await app.calls('mcp_update')).toHaveLength(0);
  });
});

test.describe('installing an mcp server with a description and an option parameter', () => {
  test.use({ scenario: withParameters() });

  test('the description renders as spans and the option select offers its labels', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-mcp').click();
    await page.getByTestId('nav-mcp-management').click();
    await expect(page.getByTestId('mcp-page')).toBeVisible();

    // The Global scope root is already expanded (it is a tree root, per
    // `ManagementPage.tsx`'s `rootIds(baseTree)` seed); the repo node nested
    // under it is not -- mirroring `skills.spec.ts`'s "browsing skills" flow,
    // expanding it reveals the preset's install row.
    await page.getByText('mcp-repo', { exact: true }).click();

    const row = page.getByTestId('mcp-server-row').filter({ has: page.locator('[data-mcp-name="github"]') });
    await row.getByTestId('mcp-install-open').click();

    const modal = page.getByTestId('mcp-install-modal');
    await expect(modal).toBeVisible();

    // The backend has already parsed the description into spans by the time
    // it reaches the renderer (`mcp_description_spans`, mocked by the
    // scenario) -- this asserts it rendered as those spans (a link button
    // reading "GitHub" alongside its surrounding text), never as the raw
    // `[GitHub](https://github.com)` markup string. See
    // `features/mcpInstall/lib/descriptionRenderSites.test.ts` for the
    // source-level rule this is the end-to-end counterpart of.
    const description = page.getByTestId('mcp-install-description');
    await expect(description).toContainText('Connect to');
    await expect(description.getByRole('button', { name: 'GitHub' })).toBeVisible();
    await expect(description).toContainText('for issues.');
    const descriptionText = await description.textContent();
    expect(descriptionText).not.toContain('[');
    expect(descriptionText).not.toContain(']');
    expect(descriptionText).not.toContain('(https://github.com)');

    // `exact: true` and scoped to the modal: the toolbar's own "Projects"
    // filter combobox is also on screen, and a substring match on "Project"
    // would otherwise resolve to both.
    await modal.getByRole('combobox', { name: 'Project', exact: true }).click();
    await page.getByRole('option', { name: 'Global' }).click();
    // The native checkbox input is visually hidden (`Checkbox.scss`'s
    // `.sk-checkbox__input`, zero-size + opacity 0 -- the styled box is a
    // sibling), so it never becomes Playwright-"visible" itself; clicking its
    // label text toggles it exactly as a real click anywhere on the row would.
    await modal.getByText('Claude', { exact: true }).click();

    // The option-constrained parameter renders as a Select, not a text
    // field; opening it must offer both authored option labels.
    const regionField = page
      .getByTestId('mcp-param-select')
      .filter({ has: page.locator('[data-param-name="region"]') });
    await regionField.getByRole('button').click();
    await expect(page.getByRole('option', { name: 'United States' })).toBeVisible();
    await page.getByRole('option', { name: 'Europe' }).click();

    await page.getByTestId('mcp-install-submit').click();
    await expect(modal).toBeHidden();

    expect(await app.calls('mcp_apply')).toHaveLength(1);
  });
});

test.describe('updating an mcp server with a passing preflight', () => {
  test.use({ scenario: updatable() });

  test('a missing parameter is asked for and the update proceeds', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-mcp').click();
    await page.getByTestId('nav-mcp-management').click();
    await expect(page.getByTestId('mcp-page')).toBeVisible();

    const row = page.getByTestId('mcp-server-row').filter({ has: page.locator('[data-mcp-name="github"]') });
    await expect(row).toBeVisible();

    await row.getByTestId('mcp-update-open').click();
    await expect(page.getByTestId('mcp-update-modal')).toBeVisible();

    // The first Confirm press is what runs the preflight (see
    // `McpUpdateParamsModal`'s own doc comment); it reports the source's new
    // `{token}` placeholder missing from this instance's stored params.
    await page.getByTestId('mcp-update-submit').click();

    const tokenField = page.getByTestId('mcp-param-input').filter({ has: page.locator('[data-param-name="token"]') });
    await expect(tokenField).toBeVisible();
    await tokenField.locator('input').fill('secret-token');

    // The second press confirms with the filled-in value.
    await page.getByTestId('mcp-update-submit').click();

    await expect(page.getByTestId('mcp-update-modal')).toBeHidden();
    await expect(page.getByTestId('mcp-update-error')).toHaveCount(0);

    const calls = await app.calls('mcp_update');
    expect(calls).toHaveLength(1);
    const { updates } = (calls[0] as { args: { updates: readonly { values: Record<string, string> }[] } }).args;
    expect(updates[0]?.values).toEqual({ token: 'secret-token' });
  });
});
