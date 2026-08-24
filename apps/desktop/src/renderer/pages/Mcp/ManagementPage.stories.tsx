import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore, scanMcpParams, repoMcpPresetId, normalizeMcpDefFromBridge } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import type { SkillKeeperConfig, McpPreset } from '@/app/store';
import type {
  AvailableMcp,
  McpInstall,
  McpServerDef,
  Project,
  ProjectInfo,
  Repository,
} from '@/services/bridge';
import { ManagementPage } from './ManagementPage';

const meta: Meta<typeof ManagementPage> = { title: 'pages/ManagementPage', component: ManagementPage };
export default meta;
type Story = StoryObj<typeof ManagementPage>;

const REPOSITORIES: Repository[] = [
  {
    id: 'repo-1',
    name: 'Team Skills',
    url: 'git@github.com:acme/team-skills.git',
    kind: 'github',
    transport: 'ssh',
    lfs: false,
    localPath: '/tmp/team-skills',
  },
];

const PROJECTS: Project[] = [
  { id: 'project-1', name: 'Acme App', path: '/tmp/acme-app', addedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'project-2', name: 'Beta Service', path: '/tmp/beta-service', addedAt: '2026-01-02T00:00:00.000Z' },
];

const BASE_CONFIG: SkillKeeperConfig = {
  general: { language: 'en', theme: 'system', animations: 'normal' },
  updates: { mode: 'manual', intervalMinutes: 720, checkOnStartup: false },
  agents: { enabled: ['claude', 'codex', 'copilot', 'cursor', 'opencode'], overrides: {} },
  executables: { globs: [] },
  security: { hookConsentPolicy: 'always-ask' },
  notifications: { enabled: true },
  repositories: { gitPath: 'git' },
  projects: { checkIntervalMinutes: 1 },
  mcp: { servers: [] },
};

const CONFIG_WITH_MANUAL: SkillKeeperConfig = {
  ...BASE_CONFIG,
  mcp: {
    servers: [
      {
        id: 'manual-1',
        name: 'local-filesystem',
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '{root_path}'],
      },
    ],
  },
};

const AVAILABLE: AvailableMcp[] = [
  {
    repoId: 'repo-1',
    remote: 'git@github.com:acme/team-skills.git',
    group: 'devtools',
    def: {
      name: 'linear',
      type: 'http',
      url: 'https://api.linear.app/{workspace}/mcp',
      headers: { Authorization: 'Bearer {token}' },
      parameters: {},
    },
    hash: 'sha256:repo-linear',
  },
  {
    repoId: 'repo-1',
    remote: 'git@github.com:acme/team-skills.git',
    def: { name: 'live-feed', type: 'sse', url: 'https://mcp.example.com/sse/stream', parameters: {} },
    hash: 'sha256:repo-feed',
  },
  // A nested group: renders as a "platform" branch containing a "lint"
  // branch, exercising the multi-level nesting `buildMcpProjectTree` now
  // produces from a `/`-joined group path.
  {
    repoId: 'repo-1',
    remote: 'git@github.com:acme/team-skills.git',
    group: 'platform/lint',
    def: {
      name: 'rustfmt-check',
      type: 'stdio',
      command: 'rustfmt-mcp',
      args: ['--check'],
      parameters: {},
    },
    hash: 'sha256:repo-rustfmt',
  },
];

// The manual preset's "current" hash. The real thing (`hashMcpDefInRenderer`)
// is an async SHA-256 digest of the def -- not worth computing for a fixture,
// since all the Update badge needs is a preset hash that differs from an
// install's stored one. `local-filesystem_1` in INSTALLS below stores
// 'sha256:stale' on purpose so it mismatches this and drives the Update badge.
const MANUAL_HASH = 'sha256:manual-current';

/**
 * Builds the `McpPreset[]` `refreshMcpPresets` would compute from `config`'s
 * manual servers and the repo `available` catalog -- same shape, same
 * `repoMcpPresetId`/`scanMcpParams` helpers the store uses, so preset ids
 * match what `buildMcpProjectTree` expects an `McpInstall.identity` to
 * resolve against. Only the manual hash is a stand-in (see `MANUAL_HASH`);
 * the repo hash is `a.hash` verbatim, exactly as the store computes it.
 */
function buildMcpPresets(config: SkillKeeperConfig, available: readonly AvailableMcp[]): McpPreset[] {
  const manual: McpPreset[] = config.mcp.servers.map((preset): McpPreset => {
    const { id, ...rest } = preset;
    // The manual-preset editor never authors `parameters`; see the matching
    // comment in `store.ts`'s `refreshMcpPresets`.
    const def: McpServerDef = { ...rest, parameters: {} };
    return {
      id,
      origin: 'manual',
      name: def.name,
      def,
      hash: MANUAL_HASH,
      params: scanMcpParams(def),
      hasRules: def.rules !== undefined,
    };
  });
  const repo: McpPreset[] = available.map((a): McpPreset => {
    // Through the same normalizer the store uses: a def arrives over the bridge
    // with no `parameters` key at all when it has none -- see
    // `normalizeMcpDefFromBridge`.
    const def = normalizeMcpDefFromBridge(a.def);
    return {
      id: repoMcpPresetId(a.repoId, a.group, def.name),
      origin: 'repo',
      name: def.name,
      def,
      hash: a.hash,
      params: scanMcpParams(def),
      hasRules: def.rules !== undefined,
      repoId: a.repoId,
      remote: a.remote,
      group: a.group,
    };
  });
  return [...manual, ...repo];
}

// One installed instance per case the projects tree distinguishes:
//  - `local-filesystem_1` matches the manual preset by `identity.local`; its
//    stale `hash` (vs. `MANUAL_HASH` above) drives the Update badge.
//  - `linear_1` matches the repo preset by (remote, group, source), with the
//    SAME hash as `AVAILABLE[0]` so it renders with no Update badge.
//  - `legacy-server_1` matches nothing current -- unlinked, muted, Delete
//    only.
// Mirrors `McpPage.stories.tsx`'s `INSTALLS` fixture.
const INSTALLS: McpInstall[] = [
  {
    projectId: 'project-1',
    agent: 'claude',
    instanceName: 'local-filesystem_1',
    identity: { local: 'manual-1', source: 'local-filesystem' },
    hash: 'sha256:stale',
    hasParams: false,
  },
  {
    projectId: 'project-1',
    agent: 'claude',
    instanceName: 'linear_1',
    identity: { remote: 'git@github.com:acme/team-skills.git', group: 'devtools', source: 'linear' },
    hash: 'sha256:repo-linear',
    hasParams: true,
  },
  {
    projectId: 'project-1',
    agent: 'cursor',
    instanceName: 'legacy-server_1',
    identity: { source: 'legacy-server' },
    hash: 'sha256:legacy',
    hasParams: false,
  },
];

/**
 * Seeds `config`/`repositories`/`projects`/`mcpPresets`/`mcpInstalls`/
 * `projectInfo` directly with the slices `refreshMcpPresets`/
 * `refreshMcpInstalls`/`refreshProjectInfo` would have computed. Storybook
 * runs outside Tauri, so `invoke` (which every one of those actions calls
 * through the bridge client) reads a `window.__TAURI_INTERNALS__` that does
 * not exist and rejects -- before any of the three actions' own `set(...)`,
 * so seeding the slices up front is not overwritten when `ManagementPage`'s
 * mount effect calls them for real and they reject the same way.
 *
 * Called directly in `render()` (not a `useEffect`) so the fixtures are
 * already in the store before `ManagementPage` mounts and fires that effect.
 */
function seedMcp(
  config: SkillKeeperConfig,
  available: readonly AvailableMcp[],
  installs: readonly McpInstall[] = [],
  projects: readonly Project[] = [],
): void {
  const projectInfo: Record<string, ProjectInfo> = Object.fromEntries(
    projects.map((p): [string, ProjectInfo] => [p.id, { skillCount: 0, fromReposCount: 0, agentCount: 0 }]),
  );
  seedStore(() => {
    useSkillkeeperStore.setState({
      repositories: REPOSITORIES,
      projects: [...projects],
      config,
      mcpPresets: buildMcpPresets(config, available),
      mcpInstalls: [...installs],
      projectInfo,
    });
  });
}

// Two projects: one with an installed instance (Update badge), a matched
// repo instance (no Update badge), and an unlinked instance (Delete only);
// the other with nothing installed yet -- just its repo preset's install
// row. Also shows the top-level manual-preset leaf (Install badge only).
export const Default: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE, INSTALLS, PROJECTS);
    return <ManagementPage />;
  },
};

// No tracked projects and nothing installed anywhere: the tree still renders
// its always-present Global scope root (see `buildMcpProjectTree` -- an empty
// `projects` list no longer empties the tree the way it used to), just with
// no children under it. That is what "nothing yet" actually looks like now;
// the genuinely empty tree (no Global root either) only happens once a
// filter excludes everything, which `FilteredEmpty` below demonstrates.
export const GlobalRootOnly: Story = {
  render: () => {
    seedMcp(BASE_CONFIG, []);
    return <ManagementPage />;
  },
};

// An empty tree the FILTER caused, not an empty catalog: the persisted project
// filter still names a project that no longer exists, so no project root and no
// Global root survive. It must say what happened and offer the reset -- claiming
// there are no MCP servers would be a lie, and this page has no in-tree footer
// reset to fall back on. `BASE_CONFIG` deliberately has no manual preset: those
// are TOP-LEVEL leaves, so one would keep the tree non-empty on its own and this
// branch would never be reached.
export const FilteredEmpty: Story = {
  render: () => {
    seedMcp(BASE_CONFIG, AVAILABLE, INSTALLS, PROJECTS);
    useSkillkeeperStore.setState((s) => ({
      mcpUi: { ...s.mcpUi, managementProjectFilter: ['project-removed'] },
    }));
    return <ManagementPage />;
  },
};
