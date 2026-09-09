/**
 * Flows 7, 8 and 12 (MCP pages): installing a preset with a description and
 * an option-constrained parameter into a tracked project, updating an
 * installed instance whose preflight reports a missing parameter, and
 * updating one whose update SKIPS an agent that cannot express its
 * transport -- the regression test for the 0.7.0 fix "Updating an MCP
 * server no longer deletes it when the new definition cannot be installed"
 * (see `.superpowers/sdd/2026-09-09-desktop-ui-e2e/task-8-brief.md`, and
 * `task-8-report.md`'s fix-round notes for why flow 12 is NOT a preflight
 * refusal -- that mechanism cannot occur for this cause).
 *
 * MCP is a two-level sidebar group exactly like Skills (see `App.tsx`'s
 * `NAV_ITEMS` comment): `nav-group-mcp` must be expanded before either of
 * its two sub-items (`nav-mcp-components`, `nav-mcp-management`) is
 * clickable. All three flows below use `nav-mcp-management` -- the page
 * whose Install and Update badges (`useMcpActions`) carry this task's
 * testids.
 */
import { test, expect } from '../harness/fixture';
import type { Page } from '@playwright/test';
import {
  withParameters,
  withParametersInstallRowId,
  updatable,
  transportSkipped,
  installedInstanceRowId,
} from '../fixtures/mcp';

/**
 * A `mcp-server-row` identified by its own (now-unique) `data-mcp-name`
 * tree-node id -- see `pages/Mcp/lib/mcpTree.tsx`'s "ROW IDENTITY" comment
 * and `fixtures/mcp.ts`'s `withParametersInstallRowId`/
 * `installedInstanceRowId` for why this is an id, not a bare preset name.
 */
function mcpRow(page: Page, rowId: string) {
  return page.getByTestId('mcp-server-row').filter({ has: page.locator(`[data-mcp-name="${rowId}"]`) });
}

test.describe('installing an mcp server with a description and an option parameter', () => {
  test.use({ scenario: withParameters() });

  test('the description renders as spans and the option select offers its labels', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-mcp').click();
    await page.getByTestId('nav-mcp-management').click();
    await expect(page.getByTestId('mcp-page')).toBeVisible();

    // The tracked project's own root is already expanded (it is a tree
    // root); the repo node nested under it is not -- mirroring
    // `skills.spec.ts`'s "browsing skills" flow, expanding it reveals the
    // preset's install row. Global's own root ALSO shows a copy of the same
    // repo/preset (every repo preset gets an install row per scope shown),
    // so the click is scoped to the "Demo" project's own branch -- its
    // `[role="treeitem"]` is the only one whose (accumulated, nested) text
    // contains "Demo" at all.
    const demoRoot = page.locator('[role="treeitem"]').filter({ hasText: 'Demo' });
    await demoRoot.getByText('mcp-repo', { exact: true }).click();

    const row = mcpRow(page, withParametersInstallRowId());
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
    await page.getByRole('option', { name: 'Demo' }).click();
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

test.describe('updating an mcp server with a missing parameter', () => {
  test.use({ scenario: updatable() });

  test('a missing parameter is asked for and the update proceeds', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-mcp').click();
    await page.getByTestId('nav-mcp-management').click();
    await expect(page.getByTestId('mcp-page')).toBeVisible();

    const row = mcpRow(page, installedInstanceRowId());
    await expect(row).toBeVisible();

    // The preflight runs eagerly, before any modal opens (see
    // `useMcpActions.tsx`'s `startMcpUpdateAsync`); it reports the source's
    // new `{token}` placeholder missing from this instance's stored params,
    // which is what opens `McpUpdateParamsModal` with exactly that field.
    await row.getByTestId('mcp-update-open').click();

    const modal = page.getByTestId('mcp-update-modal');
    await expect(modal).toBeVisible();

    const tokenField = page.getByTestId('mcp-param-input').filter({ has: page.locator('[data-param-name="token"]') });
    await expect(tokenField).toBeVisible();
    await tokenField.locator('input').fill('secret-token');

    await page.getByTestId('mcp-update-submit').click();
    await expect(modal).toBeHidden();

    const calls = await app.calls('mcp_update');
    expect(calls).toHaveLength(1);
    const { updates } = (calls[0] as { args: { updates: readonly { values: Record<string, string> }[] } }).args;
    expect(updates[0]?.values).toEqual({ token: 'secret-token' });
  });
});

test.describe('an mcp update the agent cannot express', () => {
  test.use({ scenario: transportSkipped() });

  test('leaves the instance alone and reports why', async ({ app, page }) => {
    await app.goto();
    await page.getByTestId('nav-group-mcp').click();
    await page.getByTestId('nav-mcp-management').click();
    await expect(page.getByTestId('mcp-page')).toBeVisible();

    const row = mcpRow(page, installedInstanceRowId());
    await expect(row).toBeVisible();

    // The preflight accepts the update outright (nothing is missing --
    // `preflight_inner` never checks transport support), so no params modal
    // opens at all: the click runs the update straight through.
    await row.getByTestId('mcp-update-open').click();

    // `updateMcp` succeeds overall but skips codex specifically (`reason:
    // 'transport'`); `runMcpUpdate` (`useMcpActions.tsx`) turns that into an
    // info-level `notify`, which surfaces as a toast -- there is no modal in
    // this path at all, so there is nothing to press Confirm on.
    const toast = page.getByTestId('toast');
    await expect(toast).toContainText('Codex');
    await expect(toast).toContainText('http');

    // The point of the 0.7.0 fix: `update_inner` skips codex's write and
    // `continue`s BEFORE `remove_mcp_instance` for it, so the instance is
    // never removed -- the row must still be there afterward.
    await expect(row).toBeVisible();

    expect(await app.calls('mcp_update')).toHaveLength(1);
  });
});
