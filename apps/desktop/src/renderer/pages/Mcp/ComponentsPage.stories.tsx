import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore, scanMcpParams, repoMcpPresetId } from '@/app/store';
import { seedStore } from '@/app/store/storyState';
import type { SkillKeeperConfig, McpPreset } from '@/app/store';
import type { AvailableMcp, Repository } from '@/services/bridge';
import { ComponentsPage } from './ComponentsPage';

const meta: Meta<typeof ComponentsPage> = { title: 'pages/ComponentsPage', component: ComponentsPage };
export default meta;
type Story = StoryObj<typeof ComponentsPage>;

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
      {
        id: 'manual-2',
        name: 'analytics-server',
        type: 'http',
        url: 'https://mcp.analytics.example.com/v2/servers/analytics?token={api_token}',
        rules: 'Always confirm before writing.',
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
    },
    hash: 'sha256:repo-linear',
  },
  {
    repoId: 'repo-1',
    remote: 'git@github.com:acme/team-skills.git',
    def: { name: 'live-feed', type: 'sse', url: 'https://mcp.example.com/sse/stream' },
    hash: 'sha256:repo-feed',
  },
];

// This page never compares an install's hash to a preset's (no Update badge
// here -- see `ComponentsPage.tsx`'s module comment), so a fixed placeholder
// hash is enough; nothing depends on it matching or mismatching anything.
const PRESET_HASH = 'sha256:preset-fixture';

/**
 * Builds the `McpPreset[]` `refreshMcpPresets` would compute from `config`'s
 * manual servers and the repo `available` catalog -- same shape, same
 * `repoMcpPresetId`/`scanMcpParams` helpers the store uses, so preset ids
 * match what `buildMcpRepoTree` expects.
 */
function buildMcpPresets(config: SkillKeeperConfig, available: readonly AvailableMcp[]): McpPreset[] {
  const manual: McpPreset[] = config.mcp.servers.map((preset): McpPreset => {
    const { id, ...def } = preset;
    return {
      id,
      origin: 'manual',
      name: def.name,
      def,
      hash: PRESET_HASH,
      params: scanMcpParams(def),
      hasRules: def.rules !== undefined,
    };
  });
  const repo: McpPreset[] = available.map(
    (a): McpPreset => ({
      id: repoMcpPresetId(a.repoId, a.group, a.def.name),
      origin: 'repo',
      name: a.def.name,
      def: a.def,
      hash: a.hash,
      params: scanMcpParams(a.def),
      hasRules: a.def.rules !== undefined,
      repoId: a.repoId,
      remote: a.remote,
      group: a.group,
    }),
  );
  return [...manual, ...repo];
}

/**
 * Seeds `config`/`repositories`/`mcpPresets` directly with the slice
 * `refreshMcpPresets` would have computed. Storybook runs outside Tauri, so
 * `invoke` (which that action calls through the bridge client) reads a
 * `window.__TAURI_INTERNALS__` that does not exist and rejects -- before the
 * action's own `set(...)`, so seeding `mcpPresets` up front is not overwritten
 * when `ComponentsPage`'s mount effect calls it for real and it rejects the
 * same way.
 *
 * Called directly in `render()` (not a `useEffect`) so the fixtures are
 * already in the store before `ComponentsPage` mounts and fires that effect.
 */
function seedMcp(
  config: SkillKeeperConfig,
  available: readonly AvailableMcp[],
  componentsView: 'tiles' | 'tree',
): void {
  seedStore(() => {
    useSkillkeeperStore.setState({
      repositories: REPOSITORIES,
      config,
      mcpPresets: buildMcpPresets(config, available),
    });
    // Applied inside the seed: seedStore resets the store first, so a view set
    // before it would be discarded.
    useSkillkeeperStore.getState().setMcpUi({ componentsView });
  });
}

// Tiles view (the default): manual (stdio + http-with-rules) and
// repo-discovered (http + sse) presets, as a card grid.
export const TilesView: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE, 'tiles');
    return <ComponentsPage />;
  },
};

// Tree view: the same presets, nested under their repository (and group).
export const TreeView: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE, 'tree');
    return <ComponentsPage />;
  },
};

// No presets at all: the empty-state message instead of a grid/tree.
export const Empty: Story = {
  render: () => {
    seedMcp(BASE_CONFIG, [], 'tiles');
    return <ComponentsPage />;
  },
};
