import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import type { SkillKeeperConfig } from '@/app/store';
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

/**
 * Seeds `config`/`repositories` and stubs the bridge calls the page's mount
 * effect makes (`listAvailableMcp`, via `refreshMcpPresets`) so the real store
 * action computes `mcpPresets` from these fixtures instead of throwing on the
 * unavailable Tauri bridge -- Storybook runs outside Tauri, so `invoke` is not
 * present. Mirrors `McpPage.stories.tsx`'s own `seedMcp`.
 *
 * Called directly in `render()` (not a `useEffect`) so it runs before
 * `ComponentsPage` mounts -- its own mount effect calls `refreshMcpPresets`
 * immediately, and effects fire child-before-parent.
 */
function seedMcp(config: SkillKeeperConfig, available: readonly AvailableMcp[]): void {
  (window as unknown as { skillkeeper: unknown }).skillkeeper = {
    listAvailableMcp: async () => available,
  };
  useSkillkeeperStore.setState({ repositories: REPOSITORIES, config });
}

// Tiles view (the default): manual (stdio + http-with-rules) and
// repo-discovered (http + sse) presets, as a card grid.
export const TilesView: Story = {
  render: () => {
    useSkillkeeperStore.getState().setMcpUi({ componentsView: 'tiles' });
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE);
    return <ComponentsPage />;
  },
};

// Tree view: the same presets, nested under their repository (and group).
export const TreeView: Story = {
  render: () => {
    useSkillkeeperStore.getState().setMcpUi({ componentsView: 'tree' });
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE);
    return <ComponentsPage />;
  },
};

// No presets at all: the empty-state message instead of a grid/tree.
export const Empty: Story = {
  render: () => {
    useSkillkeeperStore.getState().setMcpUi({ componentsView: 'tiles' });
    seedMcp(BASE_CONFIG, []);
    return <ComponentsPage />;
  },
};
