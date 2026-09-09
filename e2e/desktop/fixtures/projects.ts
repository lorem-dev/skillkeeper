/**
 * Scenarios for the Projects page (flows 4 and 10).
 *
 * `App`'s `activeView` starts at `'projects'` (see `App.tsx`), so `ProjectsPage`
 * mounts on every `app.goto()` with no navigation click needed, unlike the
 * Repositories and Skills pages.
 */
import { withScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';
import type { Project } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/index.js';
import type { ProjectResult, ProjectInfo } from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

/**
 * Flow 4: tracking a project. Neither `projects_add`, `projects_describe`, nor
 * `editors_list` has a default answer in `harness/commands.ts` (none is part
 * of `store.loadAll`'s startup round trip), so this scenario supplies all
 * three, plus `dialog_select_folder` -- the native folder picker
 * `ProjectAddButton` awaits before it ever calls `addProject`
 * (`bridgeClient.selectFolder`). `editors_list` is needed because the added
 * project's card is not `missing`, so `OpenProjectButton` mounts and calls it
 * (`ProjectCard.tsx`'s actions column renders `openControl` only when the
 * folder is not missing). `agentCount: 2` is set so the added card's agent
 * badge (`project-card-agents`) actually renders -- `ProjectCard` only shows
 * it when `agentCount > 0`.
 */
export function trackable(): Scenario {
  const project: Project = {
    id: 'tracked-project-id',
    path: '/projects/demo-project',
    name: 'Demo Project',
    addedAt: '2024-01-01T00:00:00Z',
  };
  const added: ProjectResult = { ok: true, project };
  const info: ProjectInfo = { skillCount: 0, fromReposCount: 0, agentCount: 2 };
  return withScenario({
    responses: {
      dialog_select_folder: project.path,
      projects_add: added,
      projects_describe: info,
      editors_list: [],
    },
  });
}

/**
 * Flow 10: a tracked project whose folder no longer exists. The project is
 * seeded up front (`scenario.projects`), exactly as a normal page load would
 * show it; `projects_folder_state` answers `missing` for it, matching what
 * `useProjectCheckSchedule`'s startup sweep (`store.checkProjects`) polls for
 * every tracked project. `projects_describe` still needs an answer --
 * `ProjectsPage`'s mount effect (`refreshProjectInfo`) describes every project
 * regardless of folder state -- but `editors_list` is deliberately NOT
 * mocked: `ProjectCard` never renders `OpenProjectButton` while a project is
 * `missing` (see `ProjectCard.tsx`'s actions column, which shows only the
 * remove button in that case), so the app never calls it for this scenario,
 * and mocking it anyway would hide that fact.
 */
export function folderMissing(): Scenario {
  const project: Project = {
    id: 'missing-project-id',
    path: '/projects/gone',
    name: 'Gone Project',
    addedAt: '2024-01-01T00:00:00Z',
  };
  const info: ProjectInfo = { skillCount: 0, fromReposCount: 0, agentCount: 0 };
  return withScenario({
    projects: [project],
    responses: {
      projects_describe: info,
      projects_folder_state: 'missing',
    },
  });
}
