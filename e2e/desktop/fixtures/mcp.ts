/**
 * Scenarios for the MCP pages (flows 7, 8 and 12 -- see
 * `.superpowers/sdd/2026-09-09-desktop-ui-e2e/task-8-brief.md`, and the
 * fix-round notes appended to `task-8-report.md` for how flow 12's mechanism
 * and the row-identity scheme below changed after review). All three run on
 * `nav-mcp-management` (`App.tsx`'s two-level MCP sidebar group, and the
 * only MCP page `useMcpActions`'s Install/Update badges are wired into with
 * the testids this task adds).
 *
 * Row identity: `pages/Mcp/lib/mcpTree.tsx`'s `mcp-server-row`/
 * `data-mcp-name` now carries each leaf's OWN unique tree-node id, never a
 * bare preset/instance name (see that file's "ROW IDENTITY" doc comment for
 * why a bare name is not unique). The functions below compute that same id
 * by mirroring the same builders the tree itself uses
 * (`repoMcpPresetId`, `mcpProjectPresetLeafId`, `mcpInstalledLeafId`,
 * `instanceKey`, `identityKey`) rather than guessing the format -- NOT by
 * importing them: those live in `app/store/store.ts` and
 * `pages/Mcp/lib/mcpTree.tsx`, both `@/`-aliased and (the latter) JSX
 * source, neither of which this directory's own, deliberately narrower
 * `tsconfig.json` can resolve (see that file's own doc comment on why it
 * has no path aliases and no `"jsx"` option -- it only ever reaches into the
 * ts-rs-generated `services/bridge` tree, which needs neither). A drift
 * between the mirror below and the real builders would only surface as a
 * spec failure (the computed id would stop matching any row), not a type
 * error -- kept intentionally close to the source's exact string
 * concatenation for that reason.
 *
 * `mcp_installs` carries no default answer in `harness/commands.ts` (like
 * `skills_list`, it is not part of `store.loadAll`'s startup round trip --
 * see that file's doc comment): `ManagementPage`'s own mount effect calls it
 * unconditionally, so every scenario here answers it explicitly.
 */
import { withScenario, defaultScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';
import type { Repository, Project } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/index.js';
import type { DescriptionSpan } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/DescriptionSpan.js';
import type { McpPreset as ConfigMcpPreset } from '../../../apps/desktop/src/renderer/services/bridge/generated/config/McpPreset.js';
import type {
  AvailableMcp,
  RawMcpServerDef,
  McpInstall,
  ApplyMcpResult,
  UpdateMcpResult,
} from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

// -- row-identity mirrors (see this file's own doc comment for why these are
// -- copies of `app/store/store.ts`'s/`pages/Mcp/lib/mcpTree.tsx`'s builders
// -- rather than imports of them) ---------------------------------------

/** Mirrors `app/store/store.ts`'s `repoMcpPresetId`. */
function repoMcpPresetId(repoId: string, group: string | undefined, name: string): string {
  return `repo:${repoId}:${group ?? ''}:${name}`;
}

/** Mirrors `pages/Mcp/lib/mcpTree.tsx`'s `mcpProjectPresetLeafId`. */
function mcpProjectPresetLeafId(projectId: string, presetId: string): string {
  return ['mcp-repo', 'leaf', projectId, presetId].join('::');
}

/** Mirrors `pages/Mcp/lib/mcpTree.tsx`'s `mcpInstalledLeafId`. */
function mcpInstalledLeafId(projectId: string, key: string): string {
  return ['mcp-inst', projectId, key].join('::');
}

/** Mirrors `pages/Mcp/lib/mcpTree.tsx`'s `identityKey`, narrowed to the one
 *  identity shape this file's fixtures ever build (a manual preset's
 *  `local` id) -- the remote-based branch is not needed here. */
function localIdentityKey(presetId: string): string {
  return `local:${presetId}`;
}

/** Mirrors `pages/Mcp/lib/mcpTree.tsx`'s `instanceKey`. */
function instanceKey(identityKey: string, instanceName: string): string {
  return `${identityKey}|${instanceName}`;
}

// -- flow 7: installing a repo-discovered preset into a tracked project -----

/** The one repository flow 7's repo-discovered preset resolves from. */
function repo(): Repository {
  return {
    id: 'mcp-repo-id',
    name: 'mcp-repo',
    url: 'https://example.invalid/mcp-repo.git',
    kind: 'generic',
    transport: 'https',
    lfs: false,
    localPath: '/repos/mcp-repo-id',
  };
}

/** The one tracked project flow 7 installs into -- a tracked-project scope
 *  is the common case the original (Global-only) version of this fixture
 *  did not cover at all; see `mcpTree.tsx`'s "ROW IDENTITY" comment for why
 *  moving here no longer risks row-identity ambiguity against Global's own
 *  copy of the same preset. */
function project(): Project {
  return { id: 'mcp-project-id', path: '/projects/demo', name: 'Demo', addedAt: '2024-01-01T00:00:00Z' };
}

/**
 * `App`'s `activeView` starts at `'projects'` (see `App.tsx`), so
 * `ProjectsPage` mounts first on every `app.goto()` regardless of which page
 * the spec navigates to afterward -- and with a non-empty `projects` array,
 * its own mount effect (`refreshProjectInfo` -> `projects_describe`) and its
 * cards' `OpenProjectButton` (`editors_list`) fire immediately, alongside the
 * app-wide `useProjectCheckSchedule` sweep (`projects_folder_state`). None of
 * the three has a default in `harness/commands.ts` (not part of `loadAll`'s
 * startup round trip), so any scenario carrying a tracked project must answer
 * them -- mirrors `fixtures/skills.ts`'s identical helper.
 */
function projectsPageStartupResponses(): Record<string, unknown> {
  return {
    editors_list: [],
    projects_describe: { skillCount: 0, fromReposCount: 0, agentCount: 0 },
    projects_folder_state: 'present',
  };
}

const SERVER_DESCRIPTION_SPANS: DescriptionSpan[] = [
  { kind: 'text', text: 'Connect to ' },
  { kind: 'link', text: 'GitHub', url: 'https://github.com' },
  { kind: 'text', text: ' for issues.' },
];
const REGION_DESCRIPTION_SPANS: DescriptionSpan[] = [{ kind: 'text', text: 'Pick a region.' }];

/** The synthesized preset id `refreshMcpPresets` gives flow 7's
 *  repo-discovered preset -- same builder the store itself uses. */
function githubPresetId(): string {
  return repoMcpPresetId(repo().id, undefined, 'github');
}

/**
 * The exact row identity flow 7's spec must filter by: the preset's install
 * row nested under the TRACKED PROJECT's own branch. Global's copy of the
 * same preset renders alongside it (every repo preset gets an install row
 * per scope root shown) with a DIFFERENT id, so this must be the project-
 * scoped one specifically, not the bare preset name.
 */
export function withParametersInstallRowId(): string {
  return mcpProjectPresetLeafId(project().id, githubPresetId());
}

/**
 * Flow 7: a repo-discovered preset with a server description (parsed into
 * spans, never raw `[text](url)` markup -- see
 * `features/mcpInstall/lib/descriptionRenderSites.test.ts` for the rule this
 * exercises end to end) and one option-constrained parameter, installed into
 * a tracked project.
 */
export function withParameters(): Scenario {
  const def: RawMcpServerDef = {
    name: 'github',
    type: 'http',
    url: 'https://api.example.invalid/{region}',
    description: 'Connect to [GitHub](https://github.com) for issues.',
    parameters: {
      region: {
        description: 'Pick a region.',
        options: [
          { value: 'us', label: 'United States' },
          { value: 'eu', label: 'Europe' },
        ],
      },
    },
  };
  const mcpAvailable: AvailableMcp[] = [{ repoId: repo().id, remote: repo().url, def, hash: 'hash-github' }];
  const applied: ApplyMcpResult = {
    ok: true,
    installed: [{ agent: 'claude', instanceName: 'github', notes: [] }],
    removed: 0,
    skipped: [],
  };
  return withScenario({
    repositories: [repo()],
    projects: [project()],
    mcpAvailable,
    responses: {
      ...projectsPageStartupResponses(),
      mcp_installs: [],
      mcp_description_spans: [SERVER_DESCRIPTION_SPANS, REGION_DESCRIPTION_SPANS],
      mcp_apply: applied,
    },
  });
}

// -- flows 8, 12: updating an already-installed manual preset's instance ----

const MANUAL_PRESET_ID = 'preset-github';

/**
 * The one manual preset flows 8 and 12 update an installed instance of. Its
 * `url` carries a `{token}` placeholder; a manually-authored preset carries
 * no per-parameter metadata at all (see the generated config `McpPreset`'s
 * own doc comment: "the desktop editor does not author `parameters` or
 * `options`"), so `token` always renders as a plain text field, never a
 * `Select` -- `withParameters` above is what covers the option-select case.
 */
function manualPreset(): ConfigMcpPreset {
  return { id: MANUAL_PRESET_ID, name: 'github', type: 'http', url: 'https://api.example.invalid/{token}' };
}

/** `defaultScenario()`'s config with `manualPreset()` as its one manual MCP
 *  server, everything else left at its default. */
function configWithManualPreset(): Scenario['config'] {
  return { ...defaultScenario().config, mcp: { servers: [manualPreset()] } };
}

/**
 * The one already-installed instance flows 8 and 12 target, at the GLOBAL
 * scope (unlike flow 7, no tracked project is needed here: `applyScope`
 * resolves the global scope with zero tracked projects, and a manual
 * preset's installed-instance row has no per-project "install row"
 * duplicate to disambiguate against -- see `mcpTree.tsx`'s doc comment).
 * `hash` deliberately never matches the live
 * `hashMcpDefInRenderer(manualPreset().def)` output (an unfakeable SHA-256
 * digest computed client-side from the CURRENT def) -- that mismatch is
 * exactly what `mcpInstallHasUpdate` reads as "an update is available",
 * which is what makes the Update badge (`mcp-update-open`) render at all.
 */
function installedInstance(): McpInstall {
  return {
    projectId: 'global',
    agent: 'codex',
    instanceName: 'github',
    identity: { local: MANUAL_PRESET_ID, source: 'github' },
    hash: 'sha256:does-not-match-the-live-def',
    hasParams: true,
  };
}

/** The exact row identity flows 8 and 12 must filter by -- computed the same
 *  way `mcpTree.tsx`'s `manualInstanceLeaves` builds it. */
export function installedInstanceRowId(): string {
  const install = installedInstance();
  return mcpInstalledLeafId('global', instanceKey(localIdentityKey(MANUAL_PRESET_ID), install.instanceName));
}

/**
 * Flow 8: the preflight accepts the update but reports `token` (the source's
 * placeholder) missing from this instance's stored params, opening
 * `McpUpdateParamsModal` for exactly that field. Untouched by the fix round:
 * this path was already correct (the params modal only ever opens when
 * something is missing, so Confirm is pressed once to run it and once more
 * to finalize).
 */
export function updatable(): Scenario {
  const updated: UpdateMcpResult = {
    ok: true,
    updated: [{ agent: 'codex', instanceName: 'github', notes: [] }],
    skipped: [],
  };
  return withScenario({
    config: configWithManualPreset(),
    mcpInstalls: [installedInstance()],
    responses: {
      mcp_installs: [installedInstance()],
      // `McpUpdateParamsModal` fetches description spans unconditionally on
      // open (mirroring `McpInstallModal`); `manualPreset()` authors no
      // description at all, so nothing ever reads this response back --
      // it only needs to exist so the call is answered.
      mcp_description_spans: [],
      mcp_update_preflight: { ok: true, missingParams: ['token'] },
      mcp_update: updated,
    },
  });
}

/**
 * Flow 12: the 0.7.0 regression case -- codex cannot express an http
 * transport. This is NOT a preflight refusal: `mcp_update_preflight`
 * (`preflight_inner`, `src-tauri/src/commands/mcp/update.rs`) only ever
 * checks for MISSING PARAMS, never transport/oauth support, so it reports
 * `ok: true` with nothing missing and `startMcpUpdateAsync` proceeds
 * straight to `updateMcp` -- no params modal opens at all. The actual
 * transport check happens inside `mcp_update` itself (`update_inner`):
 * codex's write for this instance is SKIPPED (`reason: 'transport'`), and
 * `update_inner` `continue`s BEFORE `remove_mcp_instance` for that agent --
 * which is the literal mechanism the 0.7.0 fix guarantees (the instance is
 * never removed for an agent whose write it already knows will fail).
 * `updateMcp`'s own top-level result is still `ok: true` (the call as a
 * whole succeeded; only codex's entry is reported skipped) -- see
 * `task-8-report.md`'s fix-round notes for why the original version of this
 * fixture (an `ok: false` preflight) was unreachable for this cause.
 */
export function transportSkipped(): Scenario {
  const updated: UpdateMcpResult = {
    ok: true,
    updated: [],
    skipped: [{ agent: 'codex', source: 'github', reason: 'transport', transport: 'http' }],
  };
  return withScenario({
    config: configWithManualPreset(),
    mcpInstalls: [installedInstance()],
    responses: {
      mcp_installs: [installedInstance()],
      mcp_description_spans: [],
      mcp_update_preflight: { ok: true, missingParams: [] },
      mcp_update: updated,
    },
  });
}
