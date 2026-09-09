/**
 * Scenarios for the Repositories page's add flow (flows 1 and 9 -- see
 * `.superpowers/specs/2026-09-09-desktop-ui-e2e-design.md`).
 *
 * Neither `repositories_add`, `repositories_clone`, nor `repositories_describe`
 * has a default answer in `harness/commands.ts`: none of the three is part of
 * `store.loadAll`'s startup round trip (see that file's doc comment), so
 * `defaultScenario()` leaves all three unmocked on purpose. A spec that drives
 * the add flow must supply them itself, through one of the scenarios below --
 * omitting one is exactly what the fixture's "no command went unmocked"
 * assertion (`harness/fixture.ts`) exists to catch.
 */
import { withScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';
import type { Repository } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/index.js';
import type { RepoResult, RepoInfo } from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

/**
 * The repository `repositories_add` and `repositories_clone` both answer with.
 * Matches the URL flow 1's spec fills into the add form; `deriveRepoName`
 * derives the name "demo" from it client-side, so the add form never has to
 * type a name for the row's `data-repo-name="demo"` to hold.
 *
 * `branch` is deliberately absent: the real `add`/`clone` backend commands
 * never set `Repository.branch` (that field is the user's explicit override
 * from the edit modal, written only by `repositories_update`) -- the card's
 * branch badge comes from `repositories_describe`'s `RepoInfo` instead, below.
 */
function demoRepository(): Repository {
  return {
    id: 'demo-repo-id',
    name: 'demo',
    url: 'https://example.invalid/demo.git',
    kind: 'generic',
    transport: 'https',
    lfs: false,
    localPath: '/repos/demo-repo-id',
  };
}

/**
 * The scenario flow 1 ("adding a repository shows it in the list") runs
 * against: `repositories_add` and `repositories_clone` both succeed with the
 * same repository, and `repositories_describe` reports it cloned on `main`
 * with no skills -- the state `RepositoriesPage` is in once `addRepository`'s
 * whole add-then-clone-then-describe chain (`app/store/store.ts`) settles.
 */
export function oneRepository(): Scenario {
  const repository = demoRepository();
  const added: RepoResult = { ok: true, repository };
  const cloned: RepoResult = { ok: true, repository };
  const info: RepoInfo = { branch: 'main', skillCount: 0 };
  return withScenario({
    responses: {
      repositories_add: added,
      repositories_clone: cloned,
      repositories_describe: info,
    },
  });
}

/**
 * The scenario flow 9 ("a repository that will not clone") runs against:
 * `repositories_add` itself fails with `message`, before a repository record
 * ever exists -- `addRepository` (`app/store/store.ts`) returns right there,
 * so `repositories_clone`/`repositories_describe` are never called and stay
 * deliberately unmocked; a spec that reaches them anyway is a real bug, not a
 * fixture gap.
 */
export function cloneFails(message: string): Scenario {
  const failed: RepoResult = { ok: false, error: message };
  return withScenario({
    responses: {
      repositories_add: failed,
    },
  });
}

/**
 * The repository already on the page BEFORE the add flow runs, for
 * `duplicateFails()` below -- same identity (id/url) as `demoRepository()` so
 * a submit of the same URL is genuinely the duplicate the real backend would
 * reject (`add`, `apps/desktop/src-tauri/src/commands/repositories.rs`: "if
 * `state.repositories.iter().any(|r| r.url == url)` -> `RepoResult::err
 * ("duplicate")`").
 */
function existingRepository(): Repository {
  return demoRepository();
}

/**
 * The scenario for "a repository that already exists": one repository is
 * already tracked (seeded via `scenario.repositories`, exactly like a normal
 * page load would show it, including its own `repositories_describe`
 * answer), and `repositories_add` answers the SAME "duplicate" error the real
 * backend returns for a URL already in `AppState.repositories`. This is the
 * regression case for the bug where the add form inferred success by
 * checking whether ANY repository with the submitted URL was present in the
 * store -- which a pre-existing duplicate satisfies just as well as a
 * genuine new row would, so the false-positive check swallowed this error
 * silently instead of surfacing it.
 */
export function duplicateFails(): Scenario {
  const repository = existingRepository();
  const failed: RepoResult = { ok: false, error: 'duplicate' };
  const info: RepoInfo = { branch: 'main', skillCount: 0 };
  return withScenario({
    repositories: [repository],
    responses: {
      repositories_add: failed,
      repositories_describe: info,
    },
  });
}
