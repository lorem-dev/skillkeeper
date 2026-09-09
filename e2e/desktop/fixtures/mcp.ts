/**
 * Scenarios for the MCP pages (flows 7, 8 and 12 -- see
 * `.superpowers/sdd/2026-09-09-desktop-ui-e2e/task-8-brief.md`). All three
 * run on `nav-mcp-management` (`App.tsx`'s two-level MCP sidebar group, and
 * the only MCP page `useMcpActions`'s Install/Update badges are wired into
 * with the testids this task adds): flow 7 installs a not-yet-installed
 * repo-discovered preset; flows 8 and 12 update an already-installed
 * instance.
 *
 * Every scenario below targets the GLOBAL install scope rather than a
 * tracked project -- `applyScope('global', [])` resolves fine with zero
 * tracked projects, so no scenario here needs the Projects page's own
 * startup trio (`editors_list`/`projects_describe`/`projects_folder_state`)
 * that a scenario carrying a tracked project would (see `fixtures/skills.ts`'s
 * `projectsPageStartupResponses` for that case -- `App`'s `activeView` starts
 * at `'projects'` regardless of which page a spec navigates to afterward, so
 * a non-empty `projects` array would still need answering). Staying
 * Global-only also sidesteps a real ambiguity in `buildMcpProjectTree`: its
 * per-project repo-preset "install row" renders once per SCOPE ROOT shown
 * (Global AND every tracked project), so a tracked project alongside Global
 * would render the SAME preset name twice, each carrying the same
 * `data-mcp-name` -- `mcp-server-row`'s `.filter({ has: ... })` locator would
 * then match more than one row. See `pages/Mcp/lib/mcpTree.tsx`'s own comment
 * on the tagged leaves for the other half of that avoidance (which leaf kinds
 * carry the tag at all).
 *
 * `mcp_installs` carries no default answer in `harness/commands.ts` (like
 * `skills_list`, it is not part of `store.loadAll`'s startup round trip --
 * see that file's doc comment): `ManagementPage`'s own mount effect calls it
 * unconditionally, so every scenario here answers it explicitly.
 */
import { withScenario, defaultScenario } from '../harness/scenario.js';
import type { Scenario } from '../harness/scenario.js';
import type { Repository } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/index.js';
import type { DescriptionSpan } from '../../../apps/desktop/src/renderer/services/bridge/generated/core/DescriptionSpan.js';
import type { McpPreset as ConfigMcpPreset } from '../../../apps/desktop/src/renderer/services/bridge/generated/config/McpPreset.js';
import type {
  AvailableMcp,
  RawMcpServerDef,
  McpInstall,
  ApplyMcpResult,
  UpdateMcpResult,
} from '../../../apps/desktop/src/renderer/services/bridge/contracts.js';

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

const SERVER_DESCRIPTION_SPANS: DescriptionSpan[] = [
  { kind: 'text', text: 'Connect to ' },
  { kind: 'link', text: 'GitHub', url: 'https://github.com' },
  { kind: 'text', text: ' for issues.' },
];
const REGION_DESCRIPTION_SPANS: DescriptionSpan[] = [{ kind: 'text', text: 'Pick a region.' }];

/**
 * Flow 7: a repo-discovered preset with a server description (parsed into
 * spans, never raw `[text](url)` markup -- see
 * `features/mcpInstall/lib/descriptionRenderSites.test.ts` for the rule this
 * exercises end to end) and one option-constrained parameter. Not yet
 * installed anywhere, so it renders as exactly one `mcp-server-row` (the
 * "install this preset" row) -- no matching "installed" row exists yet to
 * collide with it.
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
    mcpAvailable,
    responses: {
      mcp_installs: [],
      mcp_description_spans: [SERVER_DESCRIPTION_SPANS, REGION_DESCRIPTION_SPANS],
      mcp_apply: applied,
    },
  });
}

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
 * scope (see this file's own doc comment for why). `hash` deliberately never
 * matches the live `hashMcpDefInRenderer(manualPreset().def)` output (an
 * unfakeable SHA-256 digest computed client-side from the CURRENT def) --
 * that mismatch is exactly what `mcpInstallHasUpdate` reads as "an update is
 * available", which is what makes the Update badge (`mcp-update-open`)
 * render at all.
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

/**
 * Flow 8: the preflight accepts the update but reports `token` (the source's
 * placeholder) missing from this instance's stored params -- the counterpart
 * to `preflightRefuses` below, exercising the SAME `McpUpdateParamsModal`
 * confirm-then-preflight-then-params sequence with an acceptance instead of a
 * refusal.
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
 * Flow 12: the preflight refuses -- the regression test for the 0.7.0 fix
 * "Updating an MCP server no longer deletes it when the new definition
 * cannot be installed". `message` is asserted verbatim by the spec, so it is
 * supplied by the caller rather than fixed here.
 */
export function preflightRefuses(message: string): Scenario {
  return withScenario({
    config: configWithManualPreset(),
    mcpInstalls: [installedInstance()],
    responses: {
      mcp_installs: [installedInstance()],
      // See `updatable()`'s identical override just above for why this is
      // never actually read.
      mcp_description_spans: [],
      mcp_update_preflight: { ok: false, error: message },
    },
  });
}
