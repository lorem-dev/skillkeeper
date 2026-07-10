import type { Meta, StoryObj } from '@storybook/react';
import { useSkillkeeperStore } from '@/app/store';
import type { SkillKeeperConfig } from '@/app/store';
import type { AvailableMcp, Repository } from '@/services/bridge';
import { McpPage } from './McpPage';

const meta: Meta<typeof McpPage> = { title: 'pages/McpPage', component: McpPage };
export default meta;
type Story = StoryObj<typeof McpPage>;

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
  general: { language: 'en', theme: 'system' },
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
 * Seeds `config`/`repositories` and stubs the two bridge calls the page's
 * mount effect makes (`listAvailableMcp`, `listMcpInstalls`, via
 * `refreshMcpPresets`/`refreshMcpInstalls`) so the real store actions compute
 * `mcpPresets` from these fixtures instead of throwing on the missing
 * `window.skillkeeper` -- Storybook has no Electron preload bridge. Mirrors
 * the stub in `store.test.ts`'s `refreshMcpPresets` tests.
 *
 * Called directly in `render()` (not a `useEffect`) so it runs before
 * `McpPage` mounts: its own mount effect calls `refreshMcpPresets`
 * immediately, and effects fire child-before-parent, so seeding from a
 * *parent* effect would lose that race and run against a not-yet-seeded
 * store.
 */
function seedMcp(config: SkillKeeperConfig, available: readonly AvailableMcp[]): void {
  (window as unknown as { skillkeeper: unknown }).skillkeeper = {
    listAvailableMcp: async () => available,
    listMcpInstalls: async () => [],
  };
  useSkillkeeperStore.setState({ repositories: REPOSITORIES, config });
}

// Manual (stdio + http-with-rules) and repo-discovered (http + sse) presets
// together, showing the responsive grid.
export const Grid: Story = {
  render: () => {
    seedMcp(CONFIG_WITH_MANUAL, AVAILABLE);
    return <McpPage />;
  },
};

// No presets at all: the empty-state message instead of a grid.
export const Empty: Story = {
  render: () => {
    seedMcp(BASE_CONFIG, []);
    return <McpPage />;
  },
};
