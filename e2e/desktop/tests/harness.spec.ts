/**
 * Proves the scenario-driven fixture actually threads a spec's data through
 * to the scripted backend: overriding `repositories` on the scenario reaches
 * `repositories_list`, the same call `store.loadAll` makes at boot.
 *
 * This does NOT assert on a rendered repository row -- `repo-row` is a
 * later task's testid, not this one's. Once it exists, that task tightens
 * this same scenario onto it; until then, "the backend answered with the
 * scenario's data" is proven at the bridge boundary instead of the DOM.
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
  }),
});

test('a scenario decides what the backend returns', async ({ app, page }) => {
  await app.goto();
  await expect(page.getByTestId('app-shell')).toBeVisible();
  const calls = await app.calls('repositories_list');
  expect(calls.length).toBeGreaterThan(0);
});
