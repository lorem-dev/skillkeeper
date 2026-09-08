/**
 * Proves the scenario-driven fixture actually threads a spec's data through
 * to the scripted backend, and that its two imperative escape hatches
 * (`app.emit`, `app.clipboard`) actually work end to end -- not just by
 * construction.
 *
 * The first test asserts on a rendered `repo-row` (Task 4's testid): the
 * repository the scenario seeds shows up in the Repositories page, proving
 * the scenario's data reaches all the way to the DOM, not just the bridge
 * boundary `app.calls('repositories_list')` alone would prove. `repositories_
 * describe` (the card's branch/skill-count badges) is mocked here too --
 * `RepositoriesPage` fetches it for every listed repository on mount
 * (`refreshRepoInfo`), and it carries no default in `harness/commands.ts` (see
 * that file's doc comment): unlike `repositories_list`, it is not part of
 * `store.loadAll`'s startup round trip.
 *
 * The other two are self-tests of the fixture itself, not of the app: five
 * later tasks compose specs against `app.emit`/`app.clipboard` (one
 * specifically needs `app.emit` to drive `skills:progress`), and neither has
 * any application UI to exercise it through yet. Each drives the exact wire
 * shape a real caller would -- `plugin:event|listen`/`|emit` the way
 * `@tauri-apps/api/event`'s `listen`/`emit` build them (see `core.js`'s
 * `invoke` and `event.js`'s `listen`), and `plugin:clipboard-manager|write_text`
 * the way `@tauri-apps/plugin-clipboard-manager`'s `writeText` builds it --
 * from inside the page, entirely independent of `fixture.ts`'s own
 * implementation, so a wrong shape on either side surfaces here.
 */
import { test, expect } from '../harness/fixture';
import { withScenario } from '../harness/scenario';

test.use({
  scenario: withScenario({
    repositories: [
      {
        id: 'demo',
        name: 'demo',
        url: 'https://example.invalid/demo.git',
        kind: 'generic',
        transport: 'https',
        lfs: false,
        localPath: '/repos/demo',
        branch: 'main',
      },
    ],
    responses: {
      repositories_describe: { branch: 'main', skillCount: 0 },
    },
  }),
});

test('a scenario decides what the backend returns', async ({ app, page }) => {
  await app.goto();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  await page.getByTestId('nav-repositories').click();
  const row = page.getByTestId('repo-row').filter({ has: page.locator('[data-repo-name="demo"]') });
  await expect(row).toBeVisible();
  const calls = await app.calls('repositories_list');
  expect(calls.length).toBeGreaterThan(0);
});

/** Shape of `window.__TAURI_INTERNALS__` this file's self-tests reach into
 *  directly, matching `fixture.ts`'s own narrowing. */
interface TauriInternals {
  readonly invoke: (cmd: string, args: unknown) => Promise<unknown>;
  readonly transformCallback: (callback: (data: unknown) => void) => number;
}

test('app.emit dispatches to a page-registered listener', async ({ app, page }) => {
  await app.goto();

  // Register a listener the same way `@tauri-apps/api/event`'s `listen()`
  // registers one under the hood: mint a callback id via `transformCallback`,
  // then invoke `plugin:event|listen` with it. This is the harness's own
  // mocked event plugin (`installHarness.ts`'s `shouldMockEvents`), reached
  // directly rather than through the app -- no application code needs to
  // exist for this to prove `app.emit` actually dispatches.
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
    const received = window as unknown as Record<string, unknown>;
    received.__E2E_SELF_TEST_RECEIVED__ = undefined;
    const handler = internals.transformCallback((data) => {
      received.__E2E_SELF_TEST_RECEIVED__ = data;
    });
    return internals.invoke('plugin:event|listen', {
      event: 'e2e-self-test',
      target: { kind: 'Any' },
      handler,
    });
  });

  await app.emit('e2e-self-test', { hello: 'world' });

  const received = await page.evaluate(
    () => (window as unknown as Record<string, unknown>).__E2E_SELF_TEST_RECEIVED__,
  );
  expect(received).toEqual({ event: 'e2e-self-test', payload: { hello: 'world' } });
});

test('app.clipboard records a write made through the clipboard plugin', async ({ app, page }) => {
  await app.goto();

  // The exact command name and argument shape
  // `@tauri-apps/plugin-clipboard-manager`'s `writeText()` sends (see its
  // `dist-js/index.js`), reached directly rather than through the app --
  // there is no copy button to click yet.
  await page.evaluate(() => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__;
    return internals.invoke('plugin:clipboard-manager|write_text', { text: 'copied-by-self-test' });
  });

  const clipboard = await app.clipboard();
  expect(clipboard).toEqual(['copied-by-self-test']);
});
